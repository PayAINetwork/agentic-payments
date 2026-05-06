/**
 * Minimum viable Express server with x402 + MPP payments.
 *
 * Accepts payments on both EVM and Solana via the { evm, solana } shorthand:
 * each address covers every network in its family for the current env.
 * Run: `npm install && npm start`
 */
import express from "express";
import { agentPayments } from "@payai/agentic-payments/express";

const MODE = process.env.MODE ?? "test"; // "test" or "live"
const PORT = Number(process.env.PORT ?? 4000);
const PAY_TO_EVM = process.env.PAY_TO_EVM ?? "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const PAY_TO_SVM = process.env.PAY_TO_SVM ?? "ExamP1eWaLLet1111111111111111111111111111111";

const app = express();

app.use(
  agentPayments({
    // `live: true` routes payments through mainnet chains + facilitators.
    // Default (omitted / false) is testnet — safe for local development.
    live: MODE === "live",
    // Per-family shorthand: one EVM wallet covers every supported EVM chain,
    // one Solana wallet covers every Solana network. SDK picks mainnet vs
    // testnet based on `live`.
    payTo: { evm: PAY_TO_EVM, solana: PAY_TO_SVM },
    // USDC pays x402 on EVM + Solana; pathUSD pays MPP on Tempo.
    // With both listed, the 402 response advertises both protocols.
    assets: ["USDC", "pathUSD"],
    endpoints: {
      "GET /weather": { price: "$0.01", description: "Current weather" },
    },
  }),
);

app.get("/weather", (_req, res) => {
  res.json({ city: "San Francisco", weather: "foggy", temperature: 60 });
});

app.listen(PORT, () => {
  console.log(
    `[01-basic-express] listening on :${PORT} (mode=${MODE}, evm=${PAY_TO_EVM}, solana=${PAY_TO_SVM})`,
  );
});
