/**
 * @payai/agentic-payments — Core type definitions
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

/**
 * Per-network deployment info for a token.
 *
 * Every entry carries its own address + decimals so the SDK can produce the
 * correct atomic amount on each chain, even when the same asset name (e.g.
 * `"USDC"`) wraps deployments that don't share decimals or EIP-712 metadata.
 */
export interface AssetNetworkInfo {
  /** Token contract address on this network. */
  address: string;
  /** Token decimals for this deployment. */
  decimals: number;
  /**
   * EIP-712 domain name used for payment signing. Defaults to the asset's
   * `name`. Override when the on-chain domain separator uses a different
   * string — common for bridged/wrapped variants (e.g. `"USD Coin"` vs
   * `"USDC"`, or `"Bridged USDC (SKALE Bridge)"`).
   */
  eip712Name?: string;
  /** EIP-712 domain version. Defaults to `"2"`. */
  eip712Version?: string;
}

/**
 * Custom asset definition for a fungible token.
 *
 * Most users don't need to construct this directly — built-in assets like
 * `"USDC"` already cover every PayAI-supported network. Use this when adding
 * your own token (project token, stablecoin not in the built-in registry,
 * etc.) via the `assets` config field.
 *
 * @example
 * // A project token deployed on Base + Tempo:
 * {
 *   name: "PAYAI",
 *   addresses: {
 *     "eip155:8453": { address: "0x...", decimals: 18 },
 *     "eip155:4217": { address: "0x...", decimals: 18 },
 *   },
 * }
 *
 * @example
 * // Token whose on-chain EIP-712 domain name differs from its symbol:
 * {
 *   name: "USDT",
 *   addresses: {
 *     "eip155:1": {
 *       address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
 *       decimals: 6,
 *       eip712Name: "Tether USD",   // domain separator uses this, not "USDT"
 *     },
 *   },
 * }
 */
export interface CustomAssetDef {
  /**
   * Friendly name / symbol used in `price` records and the `assets` list
   * (e.g. `"USDC"`, `"USDT"`, `"PAYAI"`). Also acts as the default EIP-712
   * domain name when a network entry doesn't set its own `eip712Name`.
   */
  name: string;
  /** Contract address + decimals + optional EIP-712 metadata per network, keyed by CAIP-2 id. */
  addresses: Record<string, AssetNetworkInfo>;
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
export type Price = PriceValue | ((ctx: RequestContext) => PriceValue | Promise<PriceValue>);

// --- PayTo ---

/**
 * Per-family wallet shorthand. Use this to accept payments on every
 * supported network in each family with a single address per family:
 *   - `evm` receives on every EVM chain the SDK supports (Base, Polygon, …,
 *     plus Tempo for MPP).
 *   - `solana` receives on every Solana network.
 * The SDK picks testnet vs mainnet networks based on the top-level `live` flag.
 *
 * @example
 * payTo: {
 *   evm: "0xYourEvmWallet",
 *   solana: "YourSolanaAddress",
 * }
 */
export interface PayToShorthand {
  evm?: string;
  solana?: string;
}

/**
 * Payment recipient address.
 * - `string`: auto-detected as EVM (0x prefix) or Solana, expanded across
 *   that family's networks for the current testnet/mainnet env.
 * - `{ evm, solana }`: per-family wallet. Each address covers every
 *   supported network in its family. See {@link PayToShorthand}.
 * - `Record<string, string>`: per-network CAIP-2 map for explicit control,
 *   e.g. `{ "eip155:8453": "0x...", "solana:5eykt...": "..." }`.
 * - function: resolved per-request (marketplace, revenue share, multi-tenant).
 */
export type PayToValue = string | PayToShorthand | Record<string, string>;
export type PayTo = PayToValue | ((ctx: RequestContext) => PayToValue | Promise<PayToValue>);

// --- Endpoint configuration ---

/**
 * Per-endpoint configuration. Every endpoint MUST set `price`; everything else
 * is optional and inherits from the top-level {@link AgentPaymentsConfig}
 * when omitted.
 *
 * ## Override priority
 *
 * When a field exists at both endpoint and root level, **the endpoint value wins**:
 *
 * | Field | Resolution (first non-nullish wins) |
 * |-------|------------------------------------|
 * | `price` | required on every endpoint; no root-level default |
 * | `description` | `endpoint.description` only |
 * | `assets` | `price` record keys (if `price` is a record) → `endpoint.assets` → `config.assets` → `["USDC"]` |
 * | `payTo` | `endpoint.payTo` → `config.payTo` |
 * | `networks` | `endpoint.networks` → `config.networks` → inferred from `config.payTo` |
 * | `protocols` | `intersect(endpoint.protocols, enabled)` → enabled set (x402 always, MPP if a Tempo network is present) |
 *
 * ## Examples
 *
 * @example
 * // Inherit everything from root config — one endpoint, one price.
 * "GET /weather": { price: "$0.01", description: "Weather" }
 *
 * @example
 * // Override payTo to route this endpoint's revenue to a different wallet.
 * "GET /premium": {
 *   price: "$0.10",
 *   payTo: "0xDifferentTreasury",
 * }
 *
 * @example
 * // Restrict to x402 only (skip MPP) and accept only Base Sepolia.
 * "GET /restricted": {
 *   price: "$1.00",
 *   networks: ["eip155:84532"],
 *   protocols: ["x402"],
 * }
 *
 * @example
 * // Per-asset pricing: keys drive which assets the endpoint accepts.
 * "GET /items": {
 *   price: { USDC: "$0.05", PAYAI: "100" },
 * }
 */
export interface EndpointConfig {
  /**
   * What the client pays.
   * - `string` — same USD/native amount across every accepted asset
   *   (e.g. `"$0.01"` or `"100"`).
   * - `Record<string, string>` — per-asset prices; keys also define the
   *   accepted assets list.
   * - `(ctx) => …` — resolved per-request from the `RequestContext`
   *   (useful for tiering, user-specific pricing, etc).
   */
  price: Price;
  /**
   * Short human-readable string describing what the client is paying for.
   * Surfaced in the 402 challenge (x402 `resource.description` and, for
   * MPP, the `description` auth-param). ASCII-only when MPP is active —
   * see ARCHITECTURE.md "Security properties" for why.
   */
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
 * Map of `"METHOD /path"` patterns to endpoint configs.
 *
 * The method prefix is REQUIRED. Supported patterns:
 *
 * - **Exact** — `"GET /weather"` matches only `GET /weather`.
 * - **Wildcard method** — `"* /health"` matches any HTTP method on `/health`.
 * - **Trailing glob** — `"GET /api/*"` matches `/api` and every sub-path under it.
 * - **Named param** — `"GET /marketplace/:seller"` matches one segment in
 *   place of `:seller` (accessible on `RequestContext.path`).
 *
 * Matching order: exact first, then wildcard-method exact, then pattern scan
 * in insertion order. First match wins.
 */
export type EndpointMap = Record<string, EndpointConfig>;

// --- Main config ---

export interface AgentPaymentsConfig {
  /** PayAI API key. Enables managed mode. */
  apiKey?: string;

  /**
   * Accept real payments. When `true`, all defaults target mainnet:
   * networks, asset contracts, x402 facilitator, MPP Tempo chain.
   * When `false` (the default), everything runs on testnets — safe for
   * local development, no real funds at stake.
   */
  live?: boolean;

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
    networks?: string[];
    scheme?: string;
  };

  /** MPP-specific config. */
  mpp?: {
    secretKey?: string;
    realm?: string;
    methods?: unknown[];
  };

  /** Lifecycle hooks for the payment flow. */
  hooks?: Hooks;
}

// --- Internal resolved config ---

/**
 * Internal normalized configuration consumed by adapters and the core class.
 * Built by `resolveConfig(userConfig)` — you shouldn't construct this directly.
 *
 * This is the "resolved defaults" that each `EndpointConfig` inherits from.
 * Every field on an `EndpointConfig` that's omitted falls back to the
 * corresponding field on this object (see {@link EndpointConfig} for the
 * full override priority table).
 */
export interface ResolvedConfig {
  /** Endpoint map passed through verbatim from user config. */
  endpoints: EndpointMap;
  /** Default payment recipient, applied when an endpoint doesn't override `payTo`. */
  payTo: PayTo;
  /** All networks the SDK considers active for this config. Adapters each filter this further. */
  networks: string[];
  /** Enabled protocols. `mpp` is only enabled when a Tempo network is present in `networks`. */
  protocols: Protocol[];
  /**
   * Merged asset registry — built-in assets (USDC, USDT, pathUSD) combined
   * with any `CustomAssetDef` entries the user registered via `config.assets`.
   */
  assetRegistry: AssetRegistry;
  /**
   * Asset names accepted by default when an endpoint doesn't override
   * via `endpoint.assets` or a per-asset `price` record.
   */
  defaultAssets: string[];
  /** Null when `x402` is not in `protocols`. */
  x402: ResolvedX402Config | null;
  /** Null when `mpp` is not enabled (no Tempo network, or explicitly disabled). */
  mpp: ResolvedMppConfig | null;
}

export interface ResolvedX402Config {
  facilitatorUrl: string;
  scheme: string;
  /** Networks the x402 adapter can actually settle on. Used to filter
   *  ctx.networks so we don't emit challenges for chains the facilitator
   *  can't handle (e.g. Tempo, which is MPP-only). */
  supportedNetworks: string[];
}

export interface ResolvedMppConfig {
  secretKey: string;
  realm: string;
  mppx: unknown;
}

export type AssetRegistry = Record<string, CustomAssetDef>;

// --- Request processing results ---

export type ProcessResult = ProcessResultPassthrough | ProcessResult402 | ProcessResult200;

export interface ProcessResultPassthrough {
  status: "passthrough";
}

export interface ProcessResult402 {
  status: 402;
  /**
   * Challenge headers to emit on the 402 response.
   *
   * A single value per key becomes one header. An array of values becomes
   * multiple header instances (via `res.appendHeader`-style emission). The
   * array form is important for `WWW-Authenticate`: RFC 9110 allows either
   * comma-separated challenges inside one header OR multiple header instances,
   * and some downstream proxies/clients parse the multi-instance form more
   * reliably. Adapters return whichever form their protocol emits naturally;
   * `challenge.ts` preserves distinct values across adapters.
   */
  headers: Record<string, string | string[]>;
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

// --- Lifecycle hooks ---

export interface HookContext {
  request: RequestContext;
  endpoint: EndpointConfig;
  /** Populated from onPaymentVerified onward. Empty during onRequest. */
  payment: Partial<PaymentMetadata>;
  /** Present only for onPaymentFailed. */
  error?: {
    message: string;
    code?: string;
  };
}

export type OnRequestResult = undefined | { grant: true };
export type OnPaymentVerifiedResult = undefined | { reject: true; reason?: string };

export interface Hooks {
  /** Before payment check — return { grant: true } to skip payment. */
  onRequest?: (ctx: HookContext) => OnRequestResult | Promise<OnRequestResult>;
  /** After verification succeeds, before handler runs. Return { reject: true } to deny. */
  onPaymentVerified?: (
    ctx: HookContext,
  ) => OnPaymentVerifiedResult | Promise<OnPaymentVerifiedResult>;
  /** After settlement completes. Informational only. */
  onPaymentSettled?: (ctx: HookContext) => void | Promise<void>;
  /** Verification or settlement failure. Informational only. */
  onPaymentFailed?: (ctx: HookContext) => void | Promise<void>;
}
