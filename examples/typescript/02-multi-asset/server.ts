/**
 * Multi-asset pricing.
 *
 *  - /weather   uses a uniform price across USDC + USDT + pathUSD via `assets`
 *  - /premium   uses a per-asset price record; keys imply accepted assets
 *
 * Run: `npm install && npm start`
 */
import express from "express";
import { agentPayments } from "@payai/agentic-payments/express";

const MODE = process.env.MODE ?? "test";
const PORT = Number(process.env.PORT ?? 4000);
const PAY_TO_EVM = process.env.PAY_TO_EVM ?? "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const PAY_TO_SVM = process.env.PAY_TO_SVM ?? "ExamP1eWaLLet1111111111111111111111111111111";

const app = express();

app.use(
  agentPayments({
    live: MODE === "live",
    // Shorthand: evm address covers every EVM chain, solana address covers
    // every Solana network. SDK handles mainnet/testnet selection.
    payTo: { evm: PAY_TO_EVM, solana: PAY_TO_SVM },
    assets: ["USDC", "USDT", "pathUSD"],
    endpoints: {
      "GET /weather": {
        price: "$0.01",
        description: "Weather (pay in USDC, USDT or pathUSD at $0.01)",
      },
      "GET /premium": {
        // Per-asset pricing. Keys decide which assets are accepted.
        // Include pathUSD so MPP has something to charge on Tempo.
        price: { USDC: "$0.10", USDT: "$0.12", pathUSD: "$0.10" },
        description: "Premium data with per-asset pricing",
      },
    },
  }),
);

app.get("/weather", (_req, res) => {
  res.json({ city: "SF", temperature: 60 });
});

app.get("/premium", (_req, res) => {
  res.json({ results: ["gold-1", "gold-2", "gold-3"] });
});

app.listen(PORT, () => {
  console.log(`[02-multi-asset] listening on :${PORT} (mode=${MODE})`);
});
