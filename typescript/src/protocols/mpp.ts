import { Credential } from "mppx";
import { TEMPO_NETWORKS } from "../assets.js";
import { VerificationError } from "../errors.js";
import type {
  PaymentMetadata,
  ProcessResult200,
  ProcessResult402,
  ResolvedMppConfig,
} from "../types.js";
import { getAssetNetworkInfo } from "../utils.js";
import type { ChallengeContext, ProtocolAdapter } from "./types.js";

// mppx's Mppx type is heavily generic. This is the narrow shape we rely on.
type ComposeEntry = [methodFn: unknown, options: Record<string, unknown>];
interface MppxInstance {
  tempo: { charge: (opts: Record<string, unknown>) => unknown };
  compose: (...entries: ComposeEntry[]) => (input: Request) => Promise<MppxHandlerResult>;
}
interface MppxHandlerResult {
  status: number;
  challenge?: Response;
  withReceipt?: (response: Response) => Response;
}

export function createMppAdapter(config: ResolvedMppConfig): ProtocolAdapter {
  const mppx = config.mppx as MppxInstance;

  /**
   * Build compose entries for the given request context. mppx was pre-configured
   * with one tempo.charge({ currency }) per asset; we bind amount + recipient
   * + description here so dynamic payTo works per-request.
   */
  function buildEntries(ctx: ChallengeContext): ComposeEntry[] {
    const tempoNet = findTempoNetwork(ctx.networks);
    if (!tempoNet) return [];

    const recipient = ctx.payTo[tempoNet];
    if (!recipient) return [];

    // Extract the numeric chainId from "eip155:<id>". Passing chainId explicitly
    // avoids mppx falling back to its default client (Tempo mainnet) when we're
    // actually in testnet mode — which would quote clients the wrong chain.
    const chainId = Number(tempoNet.split(":")[1]);

    const entries: ComposeEntry[] = [];
    for (const { asset, amount } of ctx.resolvedPrices) {
      const info = getAssetNetworkInfo(asset, tempoNet);
      if (!info) continue;
      // mppx's tempo.charge expects a human-readable decimal string and
      // runs parseUnits(amount, decimals) itself. Sending atomic units here
      // would cause a 10^decimals overcharge. Pass the raw price (minus $)
      // and the asset's decimals so mppx does the conversion once.
      entries.push([
        mppx.tempo.charge,
        {
          amount: stripDollar(amount),
          chainId,
          currency: info.address,
          decimals: info.decimals,
          recipient,
          description: ctx.endpoint.description,
        },
      ]);
    }
    return entries;
  }

  function absoluteUrl(url: string): string {
    return url.startsWith("http") ? url : `https://localhost${url}`;
  }

  return {
    async generateChallenge(ctx: ChallengeContext): Promise<Record<string, string>> {
      const entries = buildEntries(ctx);
      if (entries.length === 0) return {};

      // Call composed handler with no auth header → returns 402 with WWW-Authenticate.
      const req = new Request(absoluteUrl(ctx.request.url));
      const result = await mppx.compose(...entries)(req);

      const wwwAuth = result.challenge?.headers.get("www-authenticate");
      return wwwAuth ? { "WWW-Authenticate": wwwAuth } : {};
    },

    async verifyAndSettle(
      headerValue: string,
      ctx: ChallengeContext,
    ): Promise<ProcessResult200 | ProcessResult402> {
      const entries = buildEntries(ctx);
      if (entries.length === 0) {
        return { status: 402, headers: {} };
      }

      // Let mppx verify: HMAC check, expiry, Tempo on-chain verification.
      const req = new Request(absoluteUrl(ctx.request.url), {
        headers: { Authorization: `Payment ${headerValue}` },
      });

      let result: MppxHandlerResult;
      try {
        result = await mppx.compose(...entries)(req);
      } catch (err) {
        throw new VerificationError(
          "mpp",
          `Tempo verification failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (result.status !== 200 || !result.withReceipt) {
        return { status: 402, headers: await this.generateChallenge(ctx) };
      }

      const tempoNet = findTempoNetwork(ctx.networks) ?? "tempo:mainnet";
      const withReceipt = result.withReceipt;

      return {
        status: 200,
        protocol: "mpp",
        payment: extractPayment(headerValue, tempoNet),
        async settleAndReceipt(response: Response): Promise<Response> {
          // MPP: payment settled on-chain before the credential was sent.
          // mppx's withReceipt attaches the Payment-Receipt header.
          return withReceipt(response);
        },
      };
    },
  };
}

function findTempoNetwork(networks: string[]): string | undefined {
  return networks.find((n) => n === TEMPO_NETWORKS.mainnet || n === TEMPO_NETWORKS.testnet);
}

/** Strip a leading "$" and surrounding whitespace without going through Number. */
function stripDollar(price: string): string {
  return price.replace(/^\$/, "").trim();
}

/**
 * Extract payment metadata from a verified credential. Safe to parse — the
 * composed mppx handler already verified the HMAC and on-chain settlement.
 */
function extractPayment(headerValue: string, network: string): PaymentMetadata {
  const payment: PaymentMetadata = { protocol: "mpp", network };
  try {
    const credential = Credential.deserialize(headerValue);
    const request = credential.challenge.request as Record<string, string> | undefined;
    const payload = credential.payload as Record<string, string> | undefined;
    if (credential.source) payment.payer = credential.source;
    if (request?.currency) payment.asset = request.currency;
    if (request?.amount) payment.amount = request.amount;
    if (payload?.hash) payment.transaction = payload.hash;
  } catch {
    // Metadata is best-effort; verification already succeeded.
  }
  return payment;
}
