# `@payai/agent-payments` — Package Design Plan

## Context

PayAI is evolving from an x402 facilitator into a protocol-agnostic machine payments abstraction layer. Phase 1 of the [Notion buildout plan](https://www.notion.so/3298b686d244815598c7cd1961319c9f) calls for shipping the first dual-protocol middleware — the first SDK that accepts both x402 and MPP payments through a single integration. The marketing moment is "one line of code, every machine payment protocol."

This plan covers the TypeScript package design: file structure, types, consumer-facing API, internal architecture, and build configuration. We start with Express middleware, then extend to Hono, Next.js, and Elysia.

---

## Consumer API

### Express (primary target)

```typescript
import { agentPayments } from "@payai/agent-payments/express";

// Mode 1: Managed — PayAI handles wallets, facilitators, everything
app.use(agentPayments({
  apiKey: "payai_xxx",
  endpoints: {
    "GET /weather": { price: "$0.01", description: "Weather data" },
    "POST /translate": { price: "$0.05", description: "Translation" },
  },
}));

// Mode 2: Advanced — no PayAI backend, bring your own config
app.use(agentPayments({
  endpoints: {
    "GET /weather": { price: "$0.01", description: "Weather data" },
  },
  x402: {
    facilitatorUrl: "https://x402.org/facilitator",
    payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00",
    networks: ["eip155:8453"],
  },
  mpp: {
    secretKey: "my-hmac-secret",
    methods: [tempo({ currency: USDC, recipient: "0x..." })],
  },
}));

// Mode 3: Managed + overrides — API key for defaults, override specific values
app.use(agentPayments({
  apiKey: "payai_xxx",

  // Cross-protocol config
  payTo: "0xMerchantWallet",
  networks: ["eip155:8453", "tempo:mainnet"],
  assets: [
    "USDC",                    // Built-in
    "USDT",                    // Built-in
    {                          // Custom — defined + registered in one shot
      name: "PAYAI",
      decimals: 18,
      addresses: {
        "eip155:8453": "0xPayAITokenOnBase",
        "tempo:mainnet": "0xPayAIOnTempo",
      },
    },
  ],

  endpoints: {
    // Simplest: one price, default assets (USDC, USDT, PAYAI from above)
    "GET /weather": { price: "$0.01", description: "Weather data" },

    // Multiple assets, different prices per asset
    "GET /premium": {
      price: { USDC: "$0.10", PAYAI: "500" },
      description: "Premium content",
    },

    // Dynamic pricing
    "POST /translate": {
      price: (ctx) => ctx.query.tier === "pro" ? "$0.10" : "$0.03",
      description: "Translation",
    },

    // Per-endpoint overrides
    "GET /restricted": {
      price: "$1.00",
      networks: ["eip155:8453"],       // Only Base
      protocols: ["x402"],             // Only x402
      payTo: "0xDifferentWallet",      // Different recipient
    },

    // Dynamic payTo
    "GET /marketplace/:seller": {
      price: "$0.05",
      payTo: (ctx) => lookupSellerWallet(ctx),
    },
  },

  // Protocol-specific overrides
  x402: { facilitatorUrl: "https://my-facilitator.com" },
  mpp: { realm: "api.custom-domain.com" },
}));
```

### Manual mode (no middleware)

```typescript
import { AgentPayments } from "@payai/agent-payments";

const ap = new AgentPayments(config);

// In any custom handler:
const result = await ap.processRequest({
  method: req.method,
  path: req.path,
  url: req.url,
  headers: req.headers,
});

if (result.status === 402) {
  return new Response(null, { status: 402, headers: result.headers });
}

// Serve your content, then attach receipt
const response = Response.json({ data: "paid content" });
return await result.settleAndReceipt(response);
```

### Other frameworks (same config, different import)

```typescript
// Hono
import { agentPayments } from "@payai/agent-payments/hono";
app.use(agentPayments(config));

// Next.js App Router
import { withAgentPayments } from "@payai/agent-payments/next";
export const GET = withAgentPayments(handler, config);

// Elysia
import { agentPayments } from "@payai/agent-payments/elysia";
app.use(agentPayments(config));
```

---

## Config Architecture

### Three modes, one type

All three modes use the same `AgentPaymentsConfig` type. The presence of `apiKey` triggers managed mode. Protocol-specific fields (`x402`, `mpp`) serve as overrides when `apiKey` is present, or as full config when it's not.

### What the PayAI API provides (managed mode)

| Value | Level | Description |
|-------|-------|-------------|
| `payTo` | Cross-protocol | Wallet addresses per network (provisioned by PayAI) |
| `assets` | Cross-protocol | Additional supported assets beyond built-in registry |
| `protocols` | Cross-protocol | Which protocols are enabled |
| `x402.networks` | x402-specific | Which chains have provisioned wallets |
| `x402.facilitatorUrl` | x402-specific | PayAI facilitator/router URL |
| `x402.scheme` | x402-specific | Payment scheme (usually "exact") |
| `mpp.secretKey` | MPP-specific | Per-merchant HMAC secret |
| `mpp.realm` | MPP-specific | Merchant's registered domain |

All of these are overridable by passing the corresponding field in the SDK config.

### Merge strategy

Shallow merge per section. If you provide `x402.networks`, it replaces the API-provided value entirely. If you provide `x402` but omit `payTo`, the API-provided `payTo` is still used.

### Endpoint source of truth: code-first

- **Endpoints are always defined in code.** The code is the source of truth for which routes exist, their descriptions, and their default prices.
- **On startup** (managed mode): SDK registers its endpoint definitions with the PayAI API, so the dashboard can display them.
- **Dashboard can override prices** without redeployment. The API returns price overrides that are merged on top of code-defined defaults.
- **Dynamic pricing functions in code take precedence** over dashboard overrides — if `price` is a function, dashboard overrides are ignored for that endpoint.

---

## Repository Structure

Monorepo holding all language SDKs. Phase 1 ships TypeScript only.

```
payai-agent-payments/
├── typescript/               # @payai/agent-payments (Phase 1)
│   ├── package.json
│   ├── tsconfig.json
│   ├── tsup.config.ts
│   └── src/                  # (see below)
├── python/                   # payai-agent-payments (future)
├── go/                       # payai-agent-payments (future)
├── e2e/                      # Cross-language live E2E tests (future)
├── examples/                 # Integration examples per language
├── .github/                  # CI workflows
├── LICENSE
└── README.md
```

## TypeScript Source Structure

```
typescript/src/
├── index.ts                     # Core entry: AgentPayments, types
├── types.ts                     # All shared type definitions
├── errors.ts                    # Error classes
├── assets.ts                    # Built-in asset registry (USDC, USDT per network)
├── config.ts                    # Config normalization (managed → resolved)
├── payai-api.ts                 # PayAI API client (managed mode)
├── agent-payments.ts            # Core class (framework-agnostic)
├── challenge.ts                 # Dual-challenge generation
├── utils.ts                     # Route matching, price parsing
├── protocols/
│   ├── types.ts                 # ProtocolAdapter interface
│   ├── detection.ts             # Header inspection → x402 | mpp | null
│   ├── x402.ts                  # x402 adapter (wraps @x402/core)
│   └── mpp.ts                   # MPP adapter (wraps mppx)
└── middleware/
    ├── express.ts               # Express middleware
    ├── hono.ts                  # Hono middleware
    ├── next.ts                  # Next.js wrapper
    └── elysia.ts                # Elysia hook
```

### `src/assets.ts` — Built-in Asset Registry

Ships with contract addresses for common tokens across supported networks. Merged with `customAssets` from config and additional assets from PayAI API at resolution time.

```typescript
// Built-in registry (ships with SDK)
const BUILT_IN_ASSETS: Record<string, CustomAsset> = {
  USDC: {
    name: "USDC",
    decimals: 6,
    addresses: {
      "eip155:8453":  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base
      "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
      "solana:mainnet": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "tempo:mainnet":  "0x20C000000000000000000000b9537d11c60E8b50",
      // ... more networks
    },
  },
  USDT: {
    name: "USDT",
    decimals: 6,
    addresses: {
      "eip155:8453": "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", // Base
      // ... more networks
    },
  },
};
```

---

## Core Types (`src/types.ts`)

```typescript
export type Protocol = "x402" | "mpp";

// --- Request context for dynamic pricing ---

export interface RequestContext {
  method: string;
  path: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string>;
}

// --- Asset / Token configuration ---

/** Built-in registry covers: "USDC", "USDT". PayAI API extends in managed mode. */
type AssetName = string;

/** Custom asset definition for non-standard tokens */
interface CustomAssetDef {
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
type Asset = AssetName | CustomAssetDef;

// --- Endpoint configuration ---

/**
 * Price can be:
 * - string: uniform price for all assets ("$0.01")
 * - Record<string, string>: per-asset prices ({ USDC: "$0.01", PAYAI: "100" })
 *     Keys are asset names. Implies which assets are accepted.
 * - function: dynamic pricing returning either format
 */
type PriceValue = string | Record<string, string>;
type Price = PriceValue | ((ctx: RequestContext) => PriceValue | Promise<PriceValue>);

/**
 * Payment recipient address.
 * - string: same address for all networks
 * - Record: per-network map { "eip155:8453": "0x...", "solana:mainnet": "..." }
 * - function: resolved per-request (for multi-tenant, marketplace, revenue share)
 */
type PayToValue = string | Record<string, string>;
type PayTo = PayToValue | ((ctx: RequestContext) => PayToValue | Promise<PayToValue>);

export interface EndpointConfig {
  /** Price in USD notation, per-asset map, or dynamic function */
  price: Price;
  /** Human-readable description for the 402 challenge */
  description?: string;
  /**
   * Which assets to accept. Default: ["USDC"].
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

export type EndpointMap = Record<string, EndpointConfig>;
// Keys: "METHOD /path" format. Method prefix is REQUIRED.
// Examples: "GET /weather", "POST /api/*", "* /health" (wildcard method)

// --- Config ---

export interface AgentPaymentsConfig {
  /** PayAI API key. Enables managed mode — fetches wallets, facilitator, MPP config. */
  apiKey?: string;

  /**
   * Testnet mode. Flips all defaults to testnet equivalents:
   * - Networks → testnet chains (Base Sepolia, etc.)
   * - Assets → testnet contract addresses
   * - x402 facilitator → testnet facilitator
   * - MPP → testnet Tempo chain
   * In managed mode: overrides the dashboard's test/live toggle.
   * Default: false (production).
   */
  testnet?: boolean;

  /** Endpoints to protect. Code is source of truth; dashboard can override prices. */
  endpoints: EndpointMap;

  /**
   * Global payment recipient. Maps to x402 payTo and MPP recipient.
   * In managed mode: optional (PayAI API provides per-network wallets).
   * In advanced mode: required here or per-endpoint.
   * Cascade: per-endpoint payTo → global payTo → PayAI API.
   */
  payTo?: PayTo;

  /**
   * Global accepted assets. Default: ["USDC"].
   * Strings reference built-in registry. Objects define + register custom tokens.
   * Custom tokens defined here can be referenced by name in endpoints.
   */
  assets?: Asset[];

  /** Which protocols to enable. Default: both. */
  protocols?: Protocol[];

  /** x402-specific config. Overrides API values when apiKey is present. */
  x402?: {
    facilitatorUrl?: string;
    networks?: string[];
    scheme?: string;
  };

  /** MPP-specific config. Overrides API values when apiKey is present. */
  mpp?: {
    secretKey?: string;
    realm?: string;
    methods?: any[];          // mppx server methods (advanced)
  };
}

// --- Internal resolved config ---

export interface ResolvedConfig {
  endpoints: EndpointMap;
  payTo: PayTo;
  networks: string[];
  protocols: Protocol[];
  assetRegistry: AssetRegistry;  // Merged: built-in + custom (from assets) + API-provided
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
  mppx: any;  // Mppx instance from mppx/server
}

/** Maps friendly names → { decimals, addresses per network } */
type AssetRegistry = Record<string, CustomAssetDef>;

// --- Request processing results ---

export type ProcessResult = ProcessResultPassthrough | ProcessResult402 | ProcessResult200;

export interface ProcessResultPassthrough { status: "passthrough" }

export interface ProcessResult402 {
  status: 402;
  headers: Record<string, string>;
}

export interface ProcessResult200 {
  status: 200;
  protocol: Protocol;
  /** Settle payment (x402) and/or attach receipt headers to a Response */
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
```

### Key type decisions

- **Single `AgentPaymentsConfig` interface** — `apiKey` being optional naturally creates the managed/advanced split.
- **Cross-protocol fields** (`payTo`, `assets`, `networks`, `protocols`) live at config root — the PayAI abstraction layer. Protocol sections (`x402`, `mpp`) only hold protocol-specific knobs.
- **`Price` type** — `string | Record<string, string> | function`. When a string, it's a uniform price for all assets. When a record, keys are asset names and values are prices in that asset's denomination. Functions can return either.
- **`PayTo` type** — `string | Record<string, string> | function`. Same flexibility as Price. Cascade: per-endpoint → global → PayAI API.
- **`assets` field** — One field, two purposes. Strings select built-in tokens ("USDC"). Objects define + register custom tokens. Custom tokens defined at root are referenceable by name in any endpoint. No separate `customAssets` needed.
- **`assets` vs `price` record** — Two ways to specify multiple tokens. `assets: ["USDC", "USDT"]` with a string `price` means same USD price for both. `price: { USDC: "$0.01", PAYAI: "100" }` means different prices per asset and implicitly selects which assets are accepted.
- **Per-endpoint overrides** (`networks`, `protocols`, `payTo`, `assets`) let merchants customize per route.
- **`testnet` flag** — one boolean flips all defaults to testnet equivalents (chains, asset addresses, facilitator). In managed mode, the dashboard toggle controls this; `testnet` in code overrides.
- **"Everything on" defaults** — both protocols, all supported networks, USDC. Merchant opts OUT, not IN. Minimum managed config is `{ apiKey, endpoints }`. Minimum advanced config is `{ payTo, endpoints }`.

### How multi-asset maps to each protocol

| Config | x402 | MPP |
|--------|------|-----|
| `assets: ["USDC", "USDT"]` | Multiple entries in `accepts` array (one per asset × network) | Multiple `compose()` entries (one per currency) |
| `price: { USDC: "$0.01", PAYAI: "100" }` | Multiple `accepts` with different `asset`/`amount` per entry | Multiple `compose()` with different `currency`/`amount` |
| Client receives | One `PAYMENT-REQUIRED` header with all options | Multiple `WWW-Authenticate` headers |
| Client picks | One `accepted` requirement | One challenge to fulfill |

---

## Protocol Adapter Interface (`src/protocols/types.ts`)

```typescript
/** Resolved price for a specific asset — ready for protocol adapters */
interface ResolvedAssetPrice {
  asset: CustomAsset;     // Full asset definition with addresses
  amount: string;         // Human-readable price (e.g., "$0.01" or "100")
}

export interface ProtocolAdapter {
  generateChallenge(
    endpoint: EndpointConfig,
    resolvedPrices: ResolvedAssetPrice[],  // One per accepted asset
    networks: string[],                     // Resolved networks for this endpoint
    request: RequestContext,
  ): Promise<Record<string, string>>;
  // x402 returns { "PAYMENT-REQUIRED": "..." } with all asset×network combos
  // MPP returns { "WWW-Authenticate": "Payment ..." } with multiple challenges

  verifyAndSettle(
    headerValue: string,
    endpoint: EndpointConfig,
    resolvedPrices: ResolvedAssetPrice[],
    request: RequestContext,
  ): Promise<ProcessResult200 | ProcessResult402>;
}
```

Price + asset resolution happens in the core class before calling adapters:
1. Resolve `price` (call function if dynamic)
2. Determine assets (from `price` record keys, or `assets` array, or global default)
3. Look up each asset in the registry → `ResolvedAssetPrice[]`
4. Pass to protocol adapters, which expand into protocol-specific entries

---

## Critical Implementation Detail: Settlement Timing

The two protocols have fundamentally different settlement flows:

**MPP (Tempo)**: Verification IS settlement. The client signs and broadcasts the transaction before sending the credential. By the time the server receives `Authorization: Payment`, the payment is already on-chain. The server just verifies the tx hash. → Simple: verify, then serve.

**x402**: Verification confirms the payment authorization is valid (signature check, balance check). Settlement (actually broadcasting the tx) happens AFTER the server confirms the response is successful. → Complex: verify, buffer handler response, if handler succeeds then settle via facilitator, then replay response with receipt headers.

This means `settleAndReceipt()` in `ProcessResult200`:
- For MPP: just attaches `Payment-Receipt` header (no-op settlement)
- For x402: calls facilitator `/settle`, waits for tx confirmation, then attaches `PAYMENT-RESPONSE` header

The Express middleware handles this by using x402's response buffering pattern (intercept `writeHead`/`write`/`end`, wait for handler completion, settle if status < 400, then replay).

---

## Key Implementation Files to Reference

| What | Where | Why |
|------|-------|-----|
| x402 Express response buffering | `contributing/x402/typescript/packages/http/express/src/index.ts:200-348` | Response interception pattern we need to replicate |
| mppx Express middleware | `contributing/mpp/mppx/src/middlewares/express.ts` | Lightweight wrapper pattern for MPP |
| mppx Mppx.create + compose | `contributing/mpp/mppx/src/server/Mppx.ts` | How to generate MPP challenges and verify credentials |
| x402 header encoding | `contributing/x402/typescript/packages/core/src/http/` | PAYMENT-REQUIRED / PAYMENT-SIGNATURE encoding |
| x402 facilitator client | `contributing/x402/typescript/packages/core/src/http/httpFacilitatorClient.ts` | How to talk to facilitators |
| mppx tempo server charge | `contributing/mpp/mppx/src/tempo/server/Charge.ts` | Tempo verification logic |
| x402 route matching | `contributing/x402/typescript/packages/core/src/http/x402HTTPResourceServer.ts` | Route pattern matching |

---

## Dependencies

```json
{
  "dependencies": {
    "@x402/core": "^2.7.0",
    "mppx": "latest"
  },
  "peerDependencies": {
    "express": "^4.0.0 || ^5.0.0",
    "hono": ">=4",
    "next": ">=14",
    "elysia": ">=1",
    "viem": ">=2.39.0"
  },
  "peerDependenciesMeta": {
    "express": { "optional": true },
    "hono": { "optional": true },
    "next": { "optional": true },
    "elysia": { "optional": true },
    "viem": { "optional": true }
  }
}
```

**Rationale**: `@x402/core` and `mppx` are direct deps (not peer) because consumers never import from them directly — our SDK wraps them entirely. Framework packages are optional peers. `viem` is optional peer because it's needed for MPP Tempo but not for x402-only setups.

---

## Subpath Exports (`package.json`)

```json
{
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./express": { "types": "./dist/middleware/express.d.ts", "default": "./dist/middleware/express.js" },
    "./hono": { "types": "./dist/middleware/hono.d.ts", "default": "./dist/middleware/hono.js" },
    "./next": { "types": "./dist/middleware/next.d.ts", "default": "./dist/middleware/next.js" },
    "./elysia": { "types": "./dist/middleware/elysia.d.ts", "default": "./dist/middleware/elysia.js" }
  }
}
```

ESM-only. Build with `tsup`.

---

## Build Order

1. `src/types.ts` — types first, everything depends on them
2. `src/errors.ts` — error classes
3. `src/assets.ts` — built-in asset registry (USDC, USDT addresses per network)
4. `src/utils.ts` — route matching, price parsing, asset resolution
5. `src/protocols/detection.ts` — header inspection
6. `src/protocols/types.ts` — ProtocolAdapter interface
7. `src/protocols/x402.ts` — x402 adapter wrapping @x402/core
8. `src/protocols/mpp.ts` — MPP adapter wrapping mppx
9. `src/challenge.ts` — dual-challenge generation (parallel, graceful degradation)
10. `src/payai-api.ts` — PayAI API client with 5-min TTL cache
11. `src/config.ts` — config normalization (managed → resolved, merge assets + overrides)
12. `src/agent-payments.ts` — core class
13. `src/index.ts` — core exports
14. `src/middleware/express.ts` — Express middleware (Phase 1 target)
15. Remaining middleware adapters

---

## Verification Plan

1. **Unit tests**: Route matching, price parsing (static + dynamic + per-asset), protocol detection, config resolution (all 3 modes), asset registry merging, payTo resolution (string / record / function)
2. **Integration test**: Spin up Express server with `agentPayments()`, send request with no payment header → verify 402 with both `PAYMENT-REQUIRED` and `WWW-Authenticate` headers present
3. **Multi-asset test**: Configure endpoint with `assets: ["USDC", "USDT"]` → verify 402 contains multiple payment options in both protocol headers
4. **x402 flow test**: Send request with `PAYMENT-SIGNATURE` header → verify facilitator is called → verify `PAYMENT-RESPONSE` header on success
5. **MPP flow test**: Send request with `Authorization: Payment` header → verify Tempo verification → verify `Payment-Receipt` header on success
6. **Response buffering test**: Handler returns 500 → verify no settlement occurs
7. **Dynamic pricing test**: Verify price function is called with correct RequestContext
8. **Dynamic payTo test**: Verify payTo function is called and address is routed correctly per-protocol
9. **Manual mode test**: Use `AgentPayments` class directly without middleware

## Future Work (Fast Follow)

- **CLI init tool**: `npx @payai/agent-payments init` — detects framework, scans routes, generates starter config. Shipped as `bin` entry in package.json.
- **Additional framework middleware**: Hono, Next.js, Elysia (Phase 1 targets Express)
- **Dashboard price overrides**: SDK registers endpoints with PayAI API on startup, fetches price overrides
- **E2E test suite**: Comprehensive end-to-end tests against live infrastructure — real testnet chains, real facilitators, real merchant wallets. Covers full payment flows for both protocols (x402 verify+settle, MPP Tempo charge), multi-asset payments, dynamic pricing, dynamic payTo, response buffering, cross-chain scenarios, and error/recovery paths. Should be runnable in CI with testnet credentials.
