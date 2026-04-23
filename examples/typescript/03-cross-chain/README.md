# 03 · Cross-Chain (explicit CAIP-2 payTo)

Most servers can just use the `{ evm, solana }` shorthand (see example 01). This example uses the **explicit CAIP-2 record** form — one address per specific network — for cases the shorthand can't express: restricting payments to a subset of chains, using a different wallet per chain, or settling each chain on its own dedicated treasury.

## Run

```bash
npm install
npm start
```

## Customize

```bash
PAY_TO_EVM=0xYourEvmWallet PAY_TO_SVM=YourSolanaAddress npm start
```

## What it demonstrates

- Explicit CAIP-2 record for `payTo`: `{ "eip155:8453": "0x...", "solana:...": "..." }`
- Mixed-family support: same request gets x402 accepts for Base + Tempo + Solana, plus an MPP challenge on Tempo.
- `assets: ["USDC", "pathUSD"]` routes the right token to each chain (USDC on Base/Solana, pathUSD on Tempo).

## See the 402

```bash
curl -i http://localhost:4000/weather
```

You'll see `PAYMENT-REQUIRED` (x402) listing multiple `(asset, network)` entries spanning EVM chains and Solana, plus `WWW-Authenticate` (MPP) covering Tempo.

## Inspect the headers in detail

```bash
./inspect-402.sh
```

Walks through the 402 in four steps and decodes the cross-chain accepts array so you can see exactly which tokens and addresses are being quoted on each network.

Requires `jq` (macOS: `brew install jq`).
