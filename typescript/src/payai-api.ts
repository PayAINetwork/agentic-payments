/**
 * PayAI API client for managed mode.
 *
 * When apiKey is provided, this client fetches wallet addresses,
 * facilitator config, MPP secrets, and price overrides from the PayAI API.
 *
 * Not yet implemented — managed mode will be available in a future release.
 */

export interface PayAIApiResponse {
  payTo: Record<string, string>;
  assets: Record<string, unknown>[];
  protocols: string[];
  x402: {
    facilitatorUrl: string;
    networks: string[];
    scheme: string;
  };
  mpp: {
    secretKey: string;
    realm: string;
  };
  priceOverrides?: Record<string, string>;
}

export class PayAIApiClient {
  readonly apiKey: string;
  readonly baseUrl: string;

  constructor(apiKey: string, baseUrl = "https://api.payai.network") {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async fetchConfig(): Promise<PayAIApiResponse> {
    throw new Error(
      "PayAI API managed mode is not yet implemented. Use manual mode with payTo instead.",
    );
  }

  async registerEndpoints(_endpoints: Record<string, unknown>): Promise<void> {
    throw new Error("PayAI API endpoint registration is not yet implemented.");
  }
}
