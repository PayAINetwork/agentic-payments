/**
 * Multi-asset pricing.
 *
 *  - /weather   uses a uniform price across USDC + USDT + pathUSD via `assets`
 *  - /premium   uses a per-asset price record; keys imply accepted assets
 *
 * Run: `npm install && npm start`
 */
import express from "express";
import { agentPayments } from "@payai/mercantil-agent-sdk/express";

const MODE = process.env.MODE ?? "test";
const PORT = Number(process.env.PORT ?? 4000);
const PAY_TO_EVM = process.env.PAY_TO_EVM ?? "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
// Unlike EVM, a Solana payTo address must have an existing USDC Associated
// Token Account (ATA) or the facilitator's settlement transaction will fail.
// The default below is a known-good address with ATAs on both devnet and mainnet.
// Set PAY_TO_SVM to your own address only after running:
//   spl-token create-account EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v <YOUR_ADDR>
const PAY_TO_SVM = process.env.PAY_TO_SVM ?? "H32YnqbzL62YkHMSCzfKcLry9yuipwwx1EMztiCSPhjb";

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
