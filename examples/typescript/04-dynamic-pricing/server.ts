/**
 * Dynamic pricing and dynamic payTo.
 *
 * Both `price` and `payTo` can be functions resolved per-request. Useful for:
 *   - Tiering via query params
 *   - Marketplaces (per-seller recipient)
 *   - Geo / time / user experiments
 *
 * Run: `npm install && npm start`
 */
import express from "express";
import { agentPayments } from "@payai/agentic-payments/express";

const MODE = process.env.MODE ?? "test";
const PORT = Number(process.env.PORT ?? 4000);
const PAY_TO_EVM = process.env.PAY_TO_EVM ?? "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const PAY_TO_SVM = process.env.PAY_TO_SVM ?? "ExamP1eWaLLet1111111111111111111111111111111";

// Fake seller directory for the marketplace route.
const SELLERS: Record<string, string> = {
  alice: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  bob: "0x8bA1f109551bD432803012645Ac136ddd64DBA72",
};

const app = express();

app.use(
  agentPayments({
    live: MODE === "live",
    // Default: EVM + Solana via shorthand. Endpoints can override with a
    // dynamic function below.
    payTo: { evm: PAY_TO_EVM, solana: PAY_TO_SVM },
    assets: ["USDC", "pathUSD"],
    endpoints: {
      "POST /translate": {
        price: (ctx) => (ctx.query.tier === "pro" ? "$0.10" : "$0.03"),
        description: "Translate - pro tier costs more",
      },
      "GET /marketplace/:seller": {
        price: "$0.05",
        description: "Pay the seller directly",
        payTo: (ctx) => {
          const seller = ctx.path.split("/").pop() ?? "";
          const addr = SELLERS[seller];
          if (!addr) throw new Error(`Unknown seller: ${seller}`);
          return addr;
        },
      },
    },
  }),
);

app.post("/translate", express.json(), (req, res) => {
  res.json({ translated: `[${req.query.tier ?? "basic"}] hola` });
});

app.get("/marketplace/:seller", (req, res) => {
  res.json({ seller: req.params.seller, item: "widget" });
});

app.listen(PORT, () => {
  console.log(`[04-dynamic-pricing] listening on :${PORT} (mode=${MODE})`);
});
