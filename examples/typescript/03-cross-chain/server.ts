/**
 * Cross-chain via explicit CAIP-2 payTo record.
 *
 * To accept on both EVM and Solana, pass a per-network map. The SDK uses the
 * addresses verbatim without auto-expansion — you get precise control.
 *
 * Run: `npm install && npm start`
 */
import express from "express";
import { agentPayments } from "@payai/agentic-payments/express";

const MODE = process.env.MODE ?? "test";
const LIVE = MODE === "live";
const PORT = Number(process.env.PORT ?? 4000);
const PAY_TO_EVM =
  process.env.PAY_TO_EVM ?? "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const PAY_TO_SVM =
  process.env.PAY_TO_SVM ?? "ExamP1eWaLLet1111111111111111111111111111111";

const BASE_NETWORK = LIVE ? "eip155:8453" : "eip155:84532";
const TEMPO_NETWORK = LIVE ? "eip155:4217" : "eip155:42431";
const SOLANA_NETWORK = LIVE
  ? "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" // mainnet-beta
  : "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"; // devnet

const app = express();

app.use(
  agentPayments({
    live: LIVE,
    payTo: {
      [BASE_NETWORK]: PAY_TO_EVM,
      [TEMPO_NETWORK]: PAY_TO_EVM,
      [SOLANA_NETWORK]: PAY_TO_SVM,
    },
    assets: ["USDC", "pathUSD"],
    endpoints: {
      "GET /weather": { price: "$0.01", description: "Cross-chain weather" },
    },
  }),
);

app.get("/weather", (_req, res) => {
  res.json({ city: "SF", temperature: 60 });
});

app.listen(PORT, () => {
  console.log(
    `[03-cross-chain] listening on :${PORT} (mode=${MODE}, evm=${PAY_TO_EVM}, svm=${PAY_TO_SVM})`,
  );
});
