// TODO: Implement ProtocolAdapter interface
// See PLAN.md for design

import type {
  EndpointConfig,
  RequestContext,
  ProcessResult200,
  ProcessResult402,
  CustomAssetDef,
} from "../types.js";

/** Resolved price for a specific asset — ready for protocol adapters */
export interface ResolvedAssetPrice {
  asset: CustomAssetDef;
  amount: string;
}

export interface ProtocolAdapter {
  generateChallenge(
    endpoint: EndpointConfig,
    resolvedPrices: ResolvedAssetPrice[],
    networks: string[],
    request: RequestContext,
  ): Promise<Record<string, string>>;

  verifyAndSettle(
    headerValue: string,
    endpoint: EndpointConfig,
    resolvedPrices: ResolvedAssetPrice[],
    request: RequestContext,
  ): Promise<ProcessResult200 | ProcessResult402>;
}
