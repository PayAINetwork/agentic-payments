import type {
  CustomAssetDef,
  EndpointConfig,
  ProcessResult200,
  ProcessResult402,
  RequestContext,
} from "../types.js";

/** Resolved price for a specific asset — ready for protocol adapters */
export interface ResolvedAssetPrice {
  asset: CustomAssetDef;
  /** Human-readable price string (e.g., "$0.01" or "100") */
  amount: string;
}

/** Resolved payTo as a CAIP-2 network → address map */
export type ResolvedPayTo = Record<string, string>;

export interface ChallengeContext {
  endpoint: EndpointConfig;
  resolvedPrices: ResolvedAssetPrice[];
  networks: string[];
  payTo: ResolvedPayTo;
  request: RequestContext;
}

export interface ProtocolAdapter {
  /** Generate 402 challenge headers for this protocol */
  generateChallenge(ctx: ChallengeContext): Promise<Record<string, string>>;

  /**
   * Verify a payment from the client.
   * Returns ProcessResult200 on success (with settleAndReceipt for deferred settlement),
   * or ProcessResult402 if verification fails.
   */
  verifyAndSettle(
    headerValue: string,
    ctx: ChallengeContext,
  ): Promise<ProcessResult200 | ProcessResult402>;
}
