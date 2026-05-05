/**
 * Lifecycle hooks — all four wired to console logs.
 *
 *  onRequest           Runs before payment check. Can grant free access.
 *  onPaymentVerified   Runs after verification, before the handler.
 *                       Can reject the payment.
 *  onPaymentSettled    Runs after settlement succeeds. Informational.
 *  onPaymentFailed     Runs on verification or settlement failure. Informational.
 *
 * Run: `npm install && npm start`
 */
import express from "express";
import { agentPayments } from "@payai/mercantil-agent-sdk/express";

const MODE = process.env.MODE ?? "test";
const PORT = Number(process.env.PORT ?? 4000);
const PAY_TO_EVM = process.env.PAY_TO_EVM ?? "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const PAY_TO_SVM = process.env.PAY_TO_SVM ?? "ExamP1eWaLLet1111111111111111111111111111111";
const INTERNAL_KEY = process.env.INTERNAL_KEY ?? "secret";

const app = express();

app.use(
  agentPayments({
    live: MODE === "live",
    payTo: { evm: PAY_TO_EVM, solana: PAY_TO_SVM },
    assets: ["USDC", "pathUSD"],
    endpoints: {
      "GET /weather": { price: "$0.01", description: "Weather with hooks" },
    },
    hooks: {
      onRequest: (ctx) => {
        if (ctx.request.headers["x-internal-key"] === INTERNAL_KEY) {
          console.log("[hooks] onRequest -> internal key, granting free access");
          return { grant: true };
        }
      },
      onPaymentVerified: (ctx) => {
        console.log("[hooks] onPaymentVerified", ctx.payment);
      },
      onPaymentSettled: (ctx) => {
        console.log("[hooks] onPaymentSettled", ctx.payment);
      },
      onPaymentFailed: (ctx) => {
        console.log("[hooks] onPaymentFailed", {
          payment: ctx.payment,
          error: ctx.error,
        });
      },
    },
  }),
);

app.get("/weather", (_req, res) => {
  res.json({ city: "SF", temperature: 60 });
});

app.listen(PORT, () => {
  console.log(`[05-hooks] listening on :${PORT} (mode=${MODE})`);
});
