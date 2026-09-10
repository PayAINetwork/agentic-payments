import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  HTTPFacilitatorClient,
} from "@x402/core/http";
import { SettlementError, VerificationError } from "../errors.js";
import type {
  PaymentFinalization,
  ProcessResult200,
  ProcessResult402,
  ResolvedX402Config,
} from "../types.js";
import { getAssetNetworkInfo, toAtomicUnits } from "../utils.js";
import type { ChallengeContext, ProtocolAdapter } from "./types.js";

interface AcceptsEntry {
  scheme: string;
  network: `${string}:${string}`;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

/** Shape of each kind in the facilitator's /supported response we care about. */
interface SupportedKind {
  x402Version: number;
  scheme: string;
  network: string;
  extra?: Record<string, unknown>;
}

/** Minimal subset of HTTPFacilitatorClient we need — keeps test mocks simple. */
interface FacilitatorClientLike {
  getSupported(): Promise<{ kinds: SupportedKind[] }>;
  verify: HTTPFacilitatorClient["verify"];
  settle: HTTPFacilitatorClient["settle"];
}

export interface CreateX402AdapterDeps {
  /**
   * Injection point for the facilitator client. Defaults to a real
   * HTTPFacilitatorClient pointed at `config.facilitatorUrl`. Tests can pass
   * a stub to avoid real network calls.
   */
  facilitator?: FacilitatorClientLike;
}

export function createX402Adapter(
  config: ResolvedX402Config,
  deps: CreateX402AdapterDeps = {},
): ProtocolAdapter {
  const facilitator: FacilitatorClientLike =
    deps.facilitator ??
    new HTTPFacilitatorClient({
      url: config.facilitatorUrl,
    });
  const supported = new Set(config.supportedNetworks);

  /**
   * Lazy cache of per-(scheme, network) `extra` fields fetched from the
   * facilitator's `/supported` endpoint. Shape of each kind in that
   * response tells clients what extra metadata they need to sign or
   * broadcast a payment (e.g. Solana needs `feePayer`; EVM `upto` scheme
   * carries a `facilitatorAddress`). We use it as the authoritative source
   * rather than hardcoding values that can drift.
   *
   * Resolved once on first use and shared across concurrent requests.
   * If the request fails, we fall back to an empty map — missing `extra`
   * fields degrade to missing-but-still-syntactically-valid challenges
   * rather than taking the whole middleware down.
   */
  let extraCache: Promise<Map<string, Record<string, unknown>>> | null = null;
  function extraByKey(): Promise<Map<string, Record<string, unknown>>> {
    if (extraCache) return extraCache;
    extraCache = facilitator
      .getSupported()
      .then((response) => {
        const map = new Map<string, Record<string, unknown>>();
        for (const kind of response.kinds) {
          // Only v2 kinds use CAIP-2 networks, which is all this SDK emits.
          if (kind.x402Version !== 2) continue;
          if (!kind.extra) continue;
          map.set(`${kind.scheme}:${kind.network}`, kind.extra);
        }
        return map;
      })
      .catch((err: unknown) => {
        if (process.env.PAYAI_DEBUG) {
          console.error("[@payai/agentic-payments] getSupported failed:", err);
        }
        // Reset the cache so a retry isn't stuck on a stale failure for the
        // process lifetime.
        extraCache = null;
        return new Map<string, Record<string, unknown>>();
      });
    return extraCache;
  }

  /**
   * Build the canonical `accepts` array for this request. Called from both
   * generateChallenge (to emit the 402) and verifyAndSettle (to validate
   * the client's claimed requirements against what we actually advertised).
   * One entry per (asset × network) the facilitator can settle on, skipping
   * combinations where the asset or payTo isn't configured.
   */
  async function buildAccepts(ctx: ChallengeContext): Promise<AcceptsEntry[]> {
    const extraMap = await extraByKey();
    const accepts: AcceptsEntry[] = [];
    for (const { asset, amount } of ctx.resolvedPrices) {
      for (const network of ctx.networks) {
        if (!supported.has(network)) continue;
        const info = getAssetNetworkInfo(asset, network);
        const payToAddress = ctx.payTo[network];
        if (!info || !payToAddress) continue;

        // `extra` carries network-specific fields the client needs to sign
        // or broadcast a payment. Two sources merged in this order:
        //   1. Facilitator-declared extras from /supported (e.g. Solana's
        //      `feePayer`, EVM `upto` scheme's `facilitatorAddress`).
        //   2. EIP-712 metadata (name + version) from the asset registry —
        //      EVM only; Solana doesn't use EIP-712.
        // EIP-712 fields can't conflict with facilitator fields in practice
        // (facilitators never set `name`/`version` per the spec), so the
        // simple spread order is correct.
        const facilitatorExtra = extraMap.get(`${config.scheme}:${network}`) ?? {};
        const isEvm = network.startsWith("eip155:");
        const extra: Record<string, unknown> = isEvm
          ? { ...facilitatorExtra, name: info.eip712Name, version: info.eip712Version }
          : { ...facilitatorExtra };

        accepts.push({
          scheme: config.scheme,
          network: network as `${string}:${string}`,
          asset: info.address,
          amount: toAtomicUnits(amount, info.decimals),
          payTo: payToAddress,
          maxTimeoutSeconds: 300,
          extra,
        });
      }
    }
    return accepts;
  }

  return {
    async generateChallenge(ctx: ChallengeContext): Promise<Record<string, string>> {
      const accepts = await buildAccepts(ctx);
      if (accepts.length === 0) return {};

      const paymentRequired = {
        x402Version: 2,
        resource: {
          url: ctx.request.url,
          description: ctx.endpoint.description,
        },
        accepts,
      };

      const encoded = encodePaymentRequiredHeader(paymentRequired);
      return { "PAYMENT-REQUIRED": encoded };
    },

    async verifyAndSettle(
      headerValue: string,
      ctx: ChallengeContext,
    ): Promise<ProcessResult200 | ProcessResult402> {
      let paymentPayload: ReturnType<typeof decodePaymentSignatureHeader>;
      try {
        paymentPayload = decodePaymentSignatureHeader(headerValue);
      } catch {
        return {
          status: 402,
          headers: await this.generateChallenge(ctx),
        } as ProcessResult402;
      }

      // SECURITY: never trust `paymentPayload.accepted`. It's attacker-controlled
      // (the client picks any requirements they want and signs them). The
      // facilitator only checks the signature matches whatever requirements we
      // pass it — it doesn't know what the server actually advertised. We must
      // rebuild our own accepts array and confirm the client's `accepted` is
      // byte-for-byte one of our entries. Then we use our own entry (not the
      // client's echo) as the `requirements` arg for verify/settle, in case any
      // mismatch-tolerant fields slipped through matching.
      const serverAccepts = await buildAccepts(ctx);
      const requirements = serverAccepts.find((entry) =>
        acceptsEntryEquals(entry, paymentPayload.accepted as AcceptsEntry),
      );

      if (!requirements) {
        return {
          status: 402,
          headers: await this.generateChallenge(ctx),
        } as ProcessResult402;
      }

      // Verify with facilitator using the server-built entry.
      let verifyResponse: Awaited<ReturnType<typeof facilitator.verify>>;
      try {
        verifyResponse = await facilitator.verify(paymentPayload, requirements);
      } catch (err) {
        throw new VerificationError(
          "x402",
          `Facilitator verify failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (!verifyResponse.isValid) {
        if (process.env.PAYAI_DEBUG) {
          console.error(
            `[@payai/agentic-payments] x402 verify rejected: ${verifyResponse.invalidReason ?? verifyResponse.invalidMessage ?? "no reason given"}`,
          );
        }
        return {
          status: 402,
          headers: await this.generateChallenge(ctx),
        } as ProcessResult402;
      }

      let finalization: Promise<PaymentFinalization> | null = null;
      const settlePayment = async (): Promise<PaymentFinalization> => {
        let settleResponse: Awaited<ReturnType<typeof facilitator.settle>>;
        try {
          settleResponse = await facilitator.settle(paymentPayload, requirements);
        } catch (err) {
          throw new SettlementError(
            "x402",
            `Facilitator settle failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        if (!settleResponse.success) {
          throw new SettlementError(
            "x402",
            settleResponse.errorMessage ?? settleResponse.errorReason ?? "Settlement failed",
          );
        }

        return {
          headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settleResponse) },
          settled: true,
        };
      };

      const finalize = async (): Promise<PaymentFinalization> => {
        finalization ??= settlePayment();
        try {
          return await finalization;
        } catch (err) {
          finalization = null;
          throw err;
        }
      };

      // Return result with deferred settlement. x402 settles AFTER the handler
      // succeeds, but callers can choose either Response-bound or header-only
      // finalization. Both paths share one settlement call.
      return {
        status: 200,
        protocol: "x402",
        payment: {
          protocol: "x402",
          payer: verifyResponse.payer,
          network: requirements.network,
          asset: requirements.asset,
          amount: requirements.amount,
        },
        finalize,
        async settleAndReceipt(response: Response): Promise<Response> {
          const finalized = await finalize();
          const headers = new Headers(response.headers);
          for (const [key, value] of Object.entries(finalized.headers)) {
            headers.set(key, value);
          }

          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        },
      } as ProcessResult200;
    },
  };
}

/**
 * Field-by-field equality for two AcceptsEntry values. Used to confirm a
 * client-submitted `accepted` matches one the server actually built.
 * Deliberately explicit (not JSON.stringify) so object-key order in `extra`
 * doesn't cause false negatives.
 */
function acceptsEntryEquals(a: AcceptsEntry, b: AcceptsEntry | undefined | null): boolean {
  if (!b || typeof b !== "object") return false;
  return (
    a.scheme === b.scheme &&
    a.network === b.network &&
    a.asset === b.asset &&
    a.amount === b.amount &&
    a.payTo === b.payTo &&
    a.maxTimeoutSeconds === b.maxTimeoutSeconds &&
    shallowStringRecordEquals(a.extra, b.extra)
  );
}

function shallowStringRecordEquals(
  a: Record<string, unknown>,
  b: Record<string, unknown> | undefined | null,
): boolean {
  if (!b || typeof b !== "object") return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!(k in b)) return false;
    if (a[k] !== b[k]) return false;
  }
  return true;
}
