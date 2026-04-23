import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  HTTPFacilitatorClient,
} from "@x402/core/http";
import { SettlementError, VerificationError } from "../errors.js";
import type { ProcessResult200, ProcessResult402, ResolvedX402Config } from "../types.js";
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

export function createX402Adapter(config: ResolvedX402Config): ProtocolAdapter {
  const facilitator = new HTTPFacilitatorClient({
    url: config.facilitatorUrl,
  });
  const supported = new Set(config.supportedNetworks);

  /**
   * Build the canonical `accepts` array for this request. Called from both
   * generateChallenge (to emit the 402) and verifyAndSettle (to validate
   * the client's claimed requirements against what we actually advertised).
   * One entry per (asset × network) the facilitator can settle on, skipping
   * combinations where the asset or payTo isn't configured.
   */
  function buildAccepts(ctx: ChallengeContext): AcceptsEntry[] {
    const accepts: AcceptsEntry[] = [];
    for (const { asset, amount } of ctx.resolvedPrices) {
      for (const network of ctx.networks) {
        if (!supported.has(network)) continue;
        const info = getAssetNetworkInfo(asset, network);
        const payToAddress = ctx.payTo[network];
        if (!info || !payToAddress) continue;

        // EIP-712 metadata only applies to EVM networks. Solana x402 payments
        // don't use EIP-712, so omit extra for solana:* to keep the response clean.
        const isEvm = network.startsWith("eip155:");
        const extra: Record<string, unknown> = isEvm
          ? { name: info.eip712Name, version: info.eip712Version }
          : {};

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
      const accepts = buildAccepts(ctx);
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
      const serverAccepts = buildAccepts(ctx);
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
        return {
          status: 402,
          headers: await this.generateChallenge(ctx),
        } as ProcessResult402;
      }

      // Return result with deferred settlement
      // x402 settles AFTER the handler succeeds (response buffering)
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
        async settleAndReceipt(response: Response): Promise<Response> {
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

          // Clone response and add settlement header
          const headers = new Headers(response.headers);
          headers.set("PAYMENT-RESPONSE", encodePaymentResponseHeader(settleResponse));

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
