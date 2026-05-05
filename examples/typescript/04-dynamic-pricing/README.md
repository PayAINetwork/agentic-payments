# 04 · Dynamic Pricing & PayTo

`price` and `payTo` can both be functions resolved per-request. The function receives a `RequestContext` with method, path, url, headers, and query.

## Run

```bash
npm install
npm start
```

## See the 402

Each request resolves price and payTo dynamically:

```bash
# Price depends on the `tier` query param
curl -i -X POST 'http://localhost:4000/translate?tier=basic'
curl -i -X POST 'http://localhost:4000/translate?tier=pro'

# payTo depends on the `:seller` path param
curl -i http://localhost:4000/marketplace/alice
curl -i http://localhost:4000/marketplace/bob
```

## Inspect the headers in detail

```bash
./inspect-402.sh
```

Runs both `/translate` tiers and both marketplace sellers side-by-side, printing just the `{network, amount, payTo}` projection from each decoded `accepts` array so you can see the `amount` and `payTo` move with the request.

Requires `jq` (macOS: `brew install jq`).

## What it demonstrates

- Dynamic `price(ctx) => string` function that reads query params.
- Dynamic `payTo(ctx) => string` function that resolves a different wallet per request. Useful for marketplaces, revenue sharing, multi-tenant APIs.
- Both features work with either protocol (x402 + MPP) transparently.
