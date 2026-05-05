# 01 · Basic Express

Minimum viable config: one EVM wallet, one Solana wallet, one endpoint — both payment protocols (x402 + MPP) and both address families auto-enabled via the `{ evm, solana }` `payTo` shorthand.

## Run

```bash
npm install
npm start
```

Server listens on `http://localhost:4000` in test mode by default — no real funds needed.

## See the 402

While the server is running, send an unauthenticated request:

```bash
curl -i http://localhost:4000/weather
```

You'll get a `402 Payment Required` response with two headers carrying the payment challenges:

- `PAYMENT-REQUIRED: <base64>` — the x402 challenge (base64-encoded JSON, a list of `(asset × network × amount)` combinations the server accepts)
- `WWW-Authenticate: Payment id="…", …` — the MPP challenge (standard HTTP auth-param syntax; its `request=` parameter is base64url-encoded JSON describing the Tempo charge)

## Inspect the headers in detail

Want a walkthrough that decodes both challenges? Run the inspection script in a second terminal while the server is up:

```bash
./inspect-402.sh
```

It walks through the response in four steps — raw 402, decoded x402 challenge, raw MPP header, decoded MPP `request` — with banners explaining what each step is showing.

Override the URL to point at another example:

```bash
URL=http://localhost:5000/premium ./inspect-402.sh
```

Requires `jq` (macOS: `brew install jq` · Debian/Ubuntu: `apt install jq`).

## Customize

Copy `.env.example` to `.env` and edit, or pass env vars inline:

```bash
PAY_TO_EVM=0xYourWallet PAY_TO_SVM=YourSolanaAddr npm start
MODE=live npm start
```

## What it demonstrates

- **`payTo: { evm, solana }` shorthand** — one EVM wallet covers every supported EVM chain (Base, Polygon, Avalanche, …, plus Tempo for MPP); one Solana wallet covers every Solana network. SDK picks mainnet vs testnet based on `live`.
- Default asset list `["USDC", "pathUSD"]` lets each protocol charge the right token on the right chain.
- No facilitator config needed — defaults to the public x402 facilitator and auto-generates an MPP secret in `.payai/`.
