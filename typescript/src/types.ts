/**
 * @payai/agent-payments — Core type definitions
 *
 * See PLAN.md at repo root for full design rationale.
 */

export type Protocol = "x402" | "mpp";

// --- Request context for dynamic pricing / payTo ---

export interface RequestContext {
  method: string;
  path: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string>;
}

// --- Asset / Token configuration ---

/** Built-in registry covers: "USDC", "USDT". PayAI API extends in managed mode. */
export type AssetName = string;

/** Custom asset definition for non-standard tokens */
export interface CustomAssetDef {
  name: string;
  decimals: number;
  /** Contract address per network (CAIP-2 → address) */
  addresses: Record<string, string>;
}

/**
 * An asset is either:
 * - A friendly name referencing built-in or previously-defined custom token
 * - A full definition that registers + selects a custom token in one shot
 */
export type Asset = AssetName | CustomAssetDef;

// --- Price ---

/**
 * Price can be:
 * - string: uniform price for all assets ("$0.01")
 * - Record<string, string>: per-asset prices ({ USDC: "$0.01", PAYAI: "100" })
 *     Keys are asset names. Implies which assets are accepted.
 * - function: dynamic pricing returning either format
 */
export type PriceValue = string | Record<string, string>;
export type Price =
  | PriceValue
  | ((ctx: RequestContext) => PriceValue | Promise<PriceValue>);

// --- PayTo ---

/**
 * Payment recipient address.
 * - string: same address for all networks
 * - Record: per-network map { "eip155:8453": "0x...", "solana:mainnet": "..." }
 * - function: resolved per-request (for multi-tenant, marketplace, revenue share)
 */
export type PayToValue = string | Record<string, string>;
export type PayTo =
  | PayToValue
  | ((ctx: RequestContext) => PayToValue | Promise<PayToValue>);

// --- Endpoint configuration ---

export interface EndpointConfig {
  /** Price in USD notation, per-asset map, or dynamic function */
  price: Price;
  /** Human-readable description for the 402 challenge */
  description?: string;
  /**
   * Which assets to accept. Default: global assets or ["USDC"].
   * Only needed when `price` is a string (uniform price).
   * When `price` is a Record, the keys define the accepted assets.
   */
  assets?: Asset[];
  /** Per-endpoint: override payment recipient */
  payTo?: PayTo;
  /** Per-endpoint: restrict to specific networks */
  networks?: string[];
  /** Per-endpoint: restrict to specific protocols */
  protocols?: Protocol[];
}

/**
 * Map of "METHOD /path" patterns to endpoint configs.
 * Method prefix is REQUIRED: "GET /weather", "POST /api/*", "* /health"
 */
export type EndpointMap = Record<string, EndpointConfig>;

// --- Main config ---

export interface AgentPaymentsConfig {
  /** PayAI API key. Enables managed mode. */
  apiKey?: string;

  /**
   * Testnet mode. Flips all defaults to testnet equivalents:
   * networks, asset addresses, facilitator, MPP chain.
   * Default: false (production).
   */
  testnet?: boolean;

  /** Endpoints to protect. Code is source of truth. */
  endpoints: EndpointMap;

  /**
   * Global payment recipient. Maps to x402 payTo and MPP recipient.
   * Cascade: per-endpoint payTo → global payTo → PayAI API.
   */
  payTo?: PayTo;

  /**
   * Global accepted assets. Default: ["USDC"].
   * Strings = built-in. Objects = custom token definitions.
   */
  assets?: Asset[];

  /** Which blockchain networks to accept on. Default: all supported. */
  networks?: string[];

  /** Which protocols to enable. Default: both. */
  protocols?: Protocol[];

  /** x402-specific config. */
  x402?: {
    facilitatorUrl?: string;
    scheme?: string;
  };

  /** MPP-specific config. */
  mpp?: {
    secretKey?: string;
    realm?: string;
    methods?: unknown[];
  };
}

// --- Internal resolved config ---

export interface ResolvedConfig {
  endpoints: EndpointMap;
  payTo: PayTo;
  networks: string[];
  protocols: Protocol[];
  assetRegistry: AssetRegistry;
  x402: ResolvedX402Config | null;
  mpp: ResolvedMppConfig | null;
}

export interface ResolvedX402Config {
  facilitatorUrl: string;
  scheme: string;
}

export interface ResolvedMppConfig {
  secretKey: string;
  realm: string;
  mppx: unknown;
}

export type AssetRegistry = Record<string, CustomAssetDef>;

// --- Request processing results ---

export type ProcessResult =
  | ProcessResultPassthrough
  | ProcessResult402
  | ProcessResult200;

export interface ProcessResultPassthrough {
  status: "passthrough";
}

export interface ProcessResult402 {
  status: 402;
  headers: Record<string, string>;
}

export interface ProcessResult200 {
  status: 200;
  protocol: Protocol;
  /** Settle payment and attach receipt headers to a Response */
  settleAndReceipt(response: Response): Promise<Response>;
  /** Payment metadata */
  payment: PaymentMetadata;
}

export interface PaymentMetadata {
  protocol: Protocol;
  payer?: string;
  transaction?: string;
  network?: string;
  asset?: string;
  amount?: string;
}
