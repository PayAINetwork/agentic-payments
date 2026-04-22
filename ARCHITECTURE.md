# Architecture

This document describes how the TypeScript SDK handles a payment-gated HTTP request end-to-end. It's aimed at contributors — if you're integrating the SDK into your server, the root [README](README.md) and per-example READMEs are the right starting points.

## Request flow

```
 ┌──────────────┐
 │ HTTP request │
 └──────┬───────┘
        │
        ▼
 ┌────────────────────────────────────────────────────────┐
 │ express middleware (middleware/express.ts)             │
 │  1. Build RequestContext from req                      │
 │  2. Delegate to AgentPayments.processRequest(ctx)      │
 └──────┬─────────────────────────────────────────────────┘
        │
        ▼
 ┌────────────────────────────────────────────────────────┐
 │ AgentPayments.processRequest (agent-payments.ts)       │
 │                                                        │
 │  a. Lazy init — resolveConfig() on first request       │
 │  b. matchEndpoint(method, path, endpoints)             │
 │        └─ no match → { passthrough }                   │
 │  c. onRequest hook                                     │
 │        └─ { grant: true } → { passthrough }            │
 │  d. resolve dynamic price, assets, payTo, networks     │
 │  e. detectProtocol(headers)                            │
 │        └─ no header → 402 + challenge from adapters    │
 │  f. adapter.verifyAndSettle(headerValue, ctx)          │
 │        └─ fail → onPaymentFailed, 402                  │
 │  g. onPaymentVerified hook                             │
 │        └─ { reject } → 402                             │
 │  h. wrap settleAndReceipt to fire Settled/Failed hooks │
 │  i. return ProcessResult200                            │
 └──────┬─────────────────────────────────────────────────┘
        │  ProcessResult200
        ▼
 ┌────────────────────────────────────────────────────────┐
 │ express middleware — runWithSettlement                 │
 │  1. Buffer res.writeHead / write / end / flushHeaders  │
 │  2. next()  — downstream handler runs                  │
 │  3. On res.end:                                        │
 │       · status < 400 → settleAndReceipt(response),     │
 │                        copy receipt headers onto res,  │
 │                        replay buffered calls           │
 │       · status ≥ 400 → skip settlement, replay as-is   │
 │       · settlement throws → drop buffer, 402 error     │
 └────────────────────────────────────────────────────────┘
```

## Key components

### Core class — `AgentPayments` (`src/agent-payments.ts`)

Framework-agnostic. `processRequest(ctx)` returns one of three shapes:

- `{ status: "passthrough" }` — route not protected, or a hook granted free access.
- `{ status: 402, headers }` — client didn't pay or paid incorrectly; headers contain the protocol challenges.
- `{ status: 200, protocol, payment, settleAndReceipt }` — payment verified, handler may run. Caller invokes `settleAndReceipt(response)` once the handler has produced a successful response.

### Protocol adapters (`src/protocols/*.ts`)

Both adapters implement the same shape from `protocols/types.ts`:

```ts
interface ProtocolAdapter {
  generateChallenge(ctx: ChallengeContext): Promise<Record<string, string>>;
  verifyAndSettle(
    headerValue: string,
    ctx: ChallengeContext,
  ): Promise<ProcessResult200 | ProcessResult402>;
}
```

**x402 adapter** (`protocols/x402.ts`) wraps `@x402/core/http`. Settlement is **deferred** — `verifyAndSettle` only verifies the payment signature with the facilitator; the returned `settleAndReceipt` function calls `facilitator.settle` later, after the handler runs successfully. This lets the server avoid settling payments for responses that ultimately error.

The adapter filters `ctx.networks` against `config.supportedNetworks` before emitting any `accepts` entries. This prevents us from advertising payment options on chains the configured facilitator can't actually settle.

Per-request `accepts` entries include `extra: { name, version }` carrying the EIP-712 domain metadata the client needs to sign payment authorizations — sourced from the per-network `AssetNetworkInfo` in the asset registry.

**MPP adapter** (`protocols/mpp.ts`) wraps `mppx/server`. Tempo payments settle on-chain **before** the client sends the credential, so `verifyAndSettle` performs the full verification path (HMAC check, expiry, on-chain transaction check via mppx's `compose()(req)`) and the returned `settleAndReceipt` simply attaches the `Payment-Receipt` header — no additional network call needed.

The adapter parses `chainId` explicitly from the CAIP-2 network identifier (`eip155:42431` → `42431`) and passes it to mppx per-request; without this, mppx's internal client resolution would fall back to Tempo mainnet even in testnet mode.

### Configuration resolution (`src/config.ts`)

`resolveConfig(config)` normalizes a user-facing `AgentPaymentsConfig` into a `ResolvedConfig` that adapters consume. Responsibilities:

- Mode detection (managed via `apiKey` vs. manual via `payTo`).
- Network inference — single-string EVM/SVM addresses expand to every supported network in their family for the current `testnet` flag.
- Protocol inference — enables MPP only when a Tempo network is present.
- Asset registry merging — built-in `USDC`/`USDT`/`pathUSD` plus any user-provided `CustomAssetDef` entries.
- x402 `supportedNetworks` default — every PayAI-facilitator-supported chain for the environment.
- MPP HMAC secret resolution — config → `MPP_SECRET_KEY` env var → persisted `.payai/mpp-secret` → auto-generate (with `.payai/.gitignore` written first).
- Ascii validation on endpoint descriptions when MPP is active (the MPP spec doesn't pin on-wire encoding for non-ASCII header params).

### Express middleware + response buffering (`src/middleware/express.ts`)

For x402, the SDK must run the handler, then settle only if the handler succeeded. The handler may call `res.writeHead`/`write`/`end`/`flushHeaders` synchronously, so the middleware swaps those methods with no-op buffers that record their arguments as `[methodName, args]` tuples. Once `res.end` fires, the middleware:

1. If `res.statusCode >= 400` — restore the originals and replay every buffered call verbatim. No settlement.
2. Otherwise — reconstruct a WHATWG `Response`, call `result.settleAndReceipt(response)`, copy any new headers onto `res` via `res.setHeader`, restore the originals, replay.
3. If settlement throws — drop the buffered content entirely and send `402` with the settlement error. Paid-for content is never leaked without successful settlement.

This mirrors the pattern used by `@x402/core/express`. See [`@x402/core/express/src/index.ts`](https://github.com/x402-foundation/x402/blob/main/typescript/packages/http/express/src/index.ts) for the reference implementation.

### Lifecycle hooks (`src/agent-payments.ts`)

Four hooks, each wrapped in `runHook` which swallows errors silently (hooks are advisory; they must never break the payment flow):

| Hook | Fires | Can modify flow? |
|------|-------|------------------|
| `onRequest` | Before payment is checked | Yes — `{ grant: true }` short-circuits to passthrough |
| `onPaymentVerified` | After verify, before handler | Yes — `{ reject: true, reason }` forces a 402 |
| `onPaymentSettled` | After settlement succeeds | No — informational |
| `onPaymentFailed` | Verification OR settlement fails | No — informational |

`onPaymentFailed` is wired at both call sites: verification failure fires it synchronously in `processRequest`; settlement failure fires it inside the wrapped `settleAndReceipt` so it works transparently for every framework middleware.

## Asset model

A `CustomAssetDef` has one `name` (the developer-facing symbol, e.g. `"USDC"`) and a `Record<string, AssetNetworkInfo>` of per-network deployments. Each `AssetNetworkInfo` carries:

- `address` — contract address on that network
- `decimals` — required, single source of truth (no top-level fallback)
- `eip712Name` — optional, defaults to the asset's `name`
- `eip712Version` — optional, defaults to `"2"`

This shape lets a single built-in `USDC` entry cover every PayAI-supported chain, including deployments that diverge in EIP-712 domain name (`"USD Coin"` on Base mainnet, `"Bridged USDC (SKALE Bridge)"` on Skale) or decimals (`pieUSD` on KiteAI testnet uses 18 decimals). Developers never look up a stablecoin address per-chain; they write `assets: ["USDC"]` and the SDK resolves the right deployment automatically.

## Security properties

- **MPP HMAC secret** is 32 bytes from `crypto.randomBytes`, persisted with mode `0o600`. The `.payai/` directory gets an auto-written `.gitignore` (contents: `*`) before the secret file is created, so the key can't be accidentally committed even if the user's repo-level gitignore doesn't cover `.payai/`.
- **Non-ASCII descriptions** with MPP enabled are rejected at config load with a `ConfigError` naming the offending endpoint + character index. The MPP draft allows UTF-8 descriptions but doesn't specify on-wire encoding in `WWW-Authenticate`, and Node's fetch enforces ByteString on header values — failing loud at startup beats silently dropping the MPP challenge at request time.
- **Response buffering** ensures paid-for content is never served without corresponding settlement: any failure in the `settleAndReceipt` path drops the buffered response body before sending `402`.

## Known sharp edges

- **x402 payment-requirements match** — the adapter currently trusts the client's `paymentPayload.accepted` and passes it directly to `facilitator.verify`/`settle`. The reference `@x402/core` server validates `accepted` deep-equals one of the server's `generateChallenge` outputs before calling the facilitator. See the open security-review finding for the remediation plan.
- **Managed mode** (`apiKey`) throws `ConfigError` today — the PayAI API client is a stub. Manual mode (`payTo`) is fully supported.
- **Python and Go SDKs** are placeholder directories. Only the TypeScript SDK ships today.

## Testing

- **Unit tests** — 97 tests across `utils.test.ts`, `config.test.ts`, `protocols/x402.test.ts`, `protocols/mpp.test.ts`. Run with `npm test` in `typescript/`. Vitest, ~350ms.
- **Smoke tests** — `examples/typescript/npm run smoke` spawns each example via its own `npm start`, probes the 402 response, decodes the x402 `accepts` and MPP `request` payloads, and asserts canonical amounts + chainId + presence of both protocol headers. CI-ready.

Relevant test files for specific invariants:

- **MPP amount double-conversion** — `src/protocols/mpp.test.ts` asserts the adapter sends human-readable decimal strings (not atomic units) to mppx.
- **x402 per-network decimals** — `src/protocols/x402.test.ts` asserts pieUSD on KiteAI testnet resolves to the correct 18-decimal atomic amount while USDC on every other chain stays at 6.
- **Config non-ASCII validation** — `src/config.test.ts` covers both the positive path (ASCII accepted, SVM-only configs allow non-ASCII) and the error path (em-dash rejected with endpoint name in the message).
