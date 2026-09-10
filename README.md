# PayAI Agent Payments SDK

One integration, every machine-payment protocol.

The PayAI Agent Payments SDK is a dual-protocol middleware that lets your HTTP endpoints accept both [**x402**](https://x402.org) and [**MPP**](https://paymentauth.org) payments through a single line of configuration. Drop the middleware in front of any route, set a price, and any x402 or MPP client can pay.

## Repo layout

This is the monorepo hosting all language SDKs and related tooling. **TypeScript is the only language that ships today** — Python and Go scaffolding exists but is empty.

```
agentic-payments/
├── typescript/          ← @payai/agentic-payments · Express middleware (shipping)
├── examples/typescript/ ← runnable example servers + payment clients + smoke tests
├── python/              ← placeholder
├── go/                  ← placeholder
└── README.md            ← this file
```

## Quick start (TypeScript)

```ts
import express from "express";
import { agentPayments } from "@payai/agentic-payments/express";

const app = express();

app.use(
  agentPayments({
    // Accept payments on every supported EVM chain and every Solana network
    // with a single wallet per family. Replace with your own addresses.
    payTo: {
      evm: "0xYourEvmWallet",
      solana: "ExamP1eWaLLet1111111111111111111111111111111",
    },
    endpoints: {
      "GET /weather": { price: "$0.01", description: "Current weather" },
    },
    // Default is testnet / no real funds. Set `live: true` to accept real payments.
  }),
);

app.get("/weather", (_req, res) => {
  res.json({ city: "San Francisco", temperature: 60 });
});

app.listen(4000);
```

Unauthenticated requests get a `402 Payment Required` with **both** protocol challenges in the response headers — x402 clients see `PAYMENT-REQUIRED`, MPP clients see `WWW-Authenticate: Payment ...`. Either one settles the same endpoint.

## Try it end-to-end

The [`examples/typescript/`](examples/typescript/) directory is an npm workspace with copy-pasteable example servers and a smoke-test harness that spins each one up and asserts the 402 shape.

```bash
cd examples/typescript
npm install
npm start --workspace 01-basic-express   # starts on :4000
```

Each example folder is a full, self-contained project — clone any one out of this repo and `npm install && npm start` works standalone. Copy `.env.example` to `.env` and fill in your keys.

**Decode the 402 challenges:**

```bash
cd examples/typescript/01-basic-express
./inspect-402.sh
```

The script walks through the 402 in four steps, decoding the base64 `PAYMENT-REQUIRED` header and the base64url-wrapped MPP `request=` parameter so you can read exactly which (asset × network × amount) combinations the server is accepting.

**Make a real payment against a running server:**

```bash
cd examples/typescript

# x402 — signs and settles on EVM or Solana (set EVM_PRIVATE_KEY or SVM_PRIVATE_KEY)
NETWORK=solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1 SVM_PRIVATE_KEY=<base58> npm run pay:x402

# MPP — pays on Tempo testnet (set EVM_PRIVATE_KEY)
EVM_PRIVATE_KEY=0x... npm run pay:mpp

# No signing — just verifies the server returns a well-formed 402
npm run probe
```

See [`examples/typescript/.env.example`](examples/typescript/.env.example) for all supported env vars.

## Examples

| # | Demonstrates |
|---|---|
| [01 · basic-express](examples/typescript/01-basic-express) | Minimum viable config using the `{ evm, solana }` `payTo` shorthand — one wallet per family, every supported chain enabled |
| [02 · multi-asset](examples/typescript/02-multi-asset) | Uniform pricing across tokens + per-asset price records |
| [03 · cross-chain](examples/typescript/03-cross-chain) | Explicit CAIP-2 `payTo` when you need per-chain control the shorthand can't express |
| [04 · dynamic-pricing](examples/typescript/04-dynamic-pricing) | `price(ctx)` and `payTo(ctx)` functions (tiering, marketplace per-seller recipients) |
| [05 · hooks](examples/typescript/05-hooks) | All four lifecycle hooks: `onRequest`, `onPaymentVerified`, `onPaymentSettled`, `onPaymentFailed` |
| [06 · colosseum-demo](examples/typescript/06-colosseum-demo) | CASH + USDC + pathUSD across Solana and all EVM chains; hooks log each payment to stdout |
| [99 · validation-errors](examples/typescript/99-validation-errors) | Shows how a config-time `ConfigError` surfaces (non-ASCII description with MPP enabled) |

## Feature highlights

- **Dual protocol in one middleware** — no separate code paths for x402 vs. MPP; the SDK picks the right adapter based on the client's request headers.
- **Built-in asset registry** — `assets: ["USDC"]` automatically covers sixteen EVM chains (Base, Avalanche, Polygon, Sei, IoTeX, Peaq, XLayer, Skale, KiteAI and their testnets) plus Solana mainnet and devnet with correct per-chain contract addresses, decimals, and EIP-712 domains. `assets: ["CASH"]` resolves Phantom's CASH stablecoin on Solana. Users never look up a token address.
- **Per-family `payTo` shorthand** — write `payTo: { evm, solana }` and the SDK spreads each address across every supported network in its family, using mainnet or testnet chains based on the `live` flag.
- **Safe-by-default `live` flag** — defaults to `false` (testnet, no real funds). Real payments require explicit `live: true` opt-in, matching Stripe's `livemode` convention.
- **Dynamic price and payTo** — both can be functions of the request, so marketplaces, tiered APIs, and multi-tenant deployments work out of the box.
- **Response-agnostic finalization** — direct integrations can call `result.finalize()` to get the protocol receipt headers (`PAYMENT-RESPONSE` or `Payment-Receipt`) without constructing a framework response object.
- **Lifecycle hooks** — `onRequest` can grant free access (internal keys, auth tokens), `onPaymentVerified` can reject after verification, `onPaymentSettled`/`onPaymentFailed` give you observability.
- **Response buffering for x402** — the middleware buffers `writeHead`/`write`/`end`/`flushHeaders` while the handler runs, so settlement happens only after a successful response (≥400s skip settlement). Same pattern as the reference `@x402/core/express` middleware.
- **Auto-managed MPP secret** — if you don't provide one, the SDK generates a 32-byte HMAC key and persists it to `.payai/mpp-secret` (`mode 0o600`), alongside an auto-written `.payai/.gitignore` so it can't be committed.

## Development

From the repo root:

```bash
cd typescript
npm install
npm test          # unit tests (utils, config, core, x402, mpp adapters)
npm run typecheck
npm run build     # tsup → dist/
```

Smoke tests (spins up each example, asserts 402 + amount + chainId):

```bash
cd examples/typescript
npm install
npm run smoke
```

## Design docs

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — request flow, adapter contracts, response-buffering rationale, asset model, security properties. Start here if you're contributing.
- [`typescript/src/protocols/types.ts`](typescript/src/protocols/types.ts) — the `ProtocolAdapter` interface adapters implement.

## External references

- **x402 spec** — https://x402.org (see especially https://github.com/x402-foundation/x402)
- **MPP spec** — https://paymentauth.org (draft-httpauth-payment-00 and sibling intent specs)
- **mppx (MPP TypeScript SDK)** — https://github.com/wevm/mppx

## License

MIT. See individual package licenses for details.
