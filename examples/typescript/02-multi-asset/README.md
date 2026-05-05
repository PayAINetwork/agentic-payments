# 02 · Multi-Asset

Accept multiple stablecoins on the same endpoint. Two patterns:

1. **Uniform pricing** — set `assets: ["USDC", "USDT", "pathUSD"]` globally and use a string `price`. Same USD amount across every asset.
2. **Per-asset pricing** — pass `price` as a record. Keys define which assets are accepted and the value per asset. `assets` is redundant for these endpoints.

## Run

```bash
npm install
npm start
```

## See the 402

With the server running, compare both endpoints in a second terminal:

```bash
curl -i http://localhost:4000/weather    # uniform $0.01 across USDC + USDT + pathUSD
curl -i http://localhost:4000/premium    # per-asset pricing record
```

## Inspect the headers in detail

```bash
./inspect-402.sh                                       # defaults to /premium
URL=http://localhost:4000/weather ./inspect-402.sh     # or /weather
```

The script decodes the x402 `PAYMENT-REQUIRED` challenge and the MPP `WWW-Authenticate` header step by step. On `/premium` the decoded `accepts` array shows a different atomic `amount` per asset, directly reflecting the price record.

Requires `jq` (macOS: `brew install jq`).
