# @payai/agentic-payments — TypeScript Examples

Each example directory is a **standalone npm package**. Pick one, copy it out of this repo, run `npm install && npm start`, and it just works. This directory also serves as an npm-workspaces monorepo so a single `npm install` at the root wires all examples at once for development.

## Layout

```
examples/typescript/
├── 01-basic-express/       ← each folder is a full, copy-pasteable project
├── 02-multi-asset/
├── 03-cross-chain/
├── 04-dynamic-pricing/
├── 05-hooks/
├── 06-colosseum-demo/
├── 99-validation-errors/   ← expected-failure example for config validation
├── shared/                 ← tooling: smoke test + payment clients (internal)
└── package.json            ← workspace root
```

## Run a single example

```bash
cd 01-basic-express
npm install
npm start
```

Every example has a `.env.example` showing the supported env vars. Copy to `.env` to persist your settings.

## Work on everything at once

From this directory (`examples/typescript/`):

```bash
npm install                        # installs all workspaces (one shot)
npm start --workspace 01-basic-express
npm run smoke                      # spawns each example, asserts 402 shape
npm run probe                      # probe a running example
```

## Mode toggle

All examples default to **test mode** (testnet chains, no real funds needed). Flip to **live mode** (mainnet, real payments) via env var:

```bash
MODE=live npm start
```

## Examples

| # | What it demonstrates |
|---|----------------------|
| [01 · basic-express](./01-basic-express) | Minimum config: one EVM address, one endpoint, both protocols |
| [02 · multi-asset](./02-multi-asset) | Uniform pricing across tokens, plus per-asset price records |
| [03 · cross-chain](./03-cross-chain) | Explicit CAIP-2 `payTo` covering Base + Tempo + Solana |
| [04 · dynamic-pricing](./04-dynamic-pricing) | Dynamic `price` and `payTo` functions (tiering, marketplaces) |
| [05 · hooks](./05-hooks) | All four lifecycle hooks (`onRequest`, `onPaymentVerified`, etc.) |
| [06 · colosseum-demo](./06-colosseum-demo) | CASH + USDC + pathUSD across Solana and all EVM chains; hooks log each payment to stdout |
| [99 · validation-errors](./99-validation-errors) | Surfaces a config-time `ConfigError` on non-ASCII descriptions |

## Clients (in `shared/clients/`)

Defaults to `http://localhost:4000/weather`. Override with `URL=...`.

```bash
# No signing — verifies the server returns a correct 402.
npm run probe

# x402 — signs and settles on EVM or Solana.
EVM_PRIVATE_KEY=0x... npm run pay:x402                              # picks first available network
NETWORK=solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1 SVM_PRIVATE_KEY=<base58> npm run pay:x402

# MPP — pays on Tempo (requires a funded account with pathUSD).
EVM_PRIVATE_KEY=0x... npm run pay:mpp
```

## Publishing note

Each example's `package.json` pins `"@payai/agentic-payments": "file:../../../typescript"` so the workspace links to local source during development. Before publishing this directory (or referencing it externally), those file deps will need to be swapped for the published version.
