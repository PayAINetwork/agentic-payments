/**
 * Validation error: non-ASCII description with MPP enabled.
 *
 * The SDK rejects non-ASCII endpoint descriptions at config-resolution time
 * when MPP is active. The MPP spec (paymentauth.org, draft-httpauth-payment-00)
 * allows UTF-8 descriptions but does not specify how to encode non-ASCII in
 * the WWW-Authenticate header, and Node's fetch rejects non-ASCII header
 * values. The SDK fails loud rather than silently dropping the MPP challenge.
 *
 * Expected: first request returns a 500 whose server logs include a ConfigError.
 * Fix by replacing the em dash with "-" (or disabling MPP for this endpoint
 * via `protocols: ["x402"]`).
 *
 * Run: `npm install && npm start`
 */
import express from "express";
import { agentPayments } from "@payai/mercantil-agent-sdk/express";

const MODE = process.env.MODE ?? "test";
const PORT = Number(process.env.PORT ?? 4000);
const PAY_TO_EVM = process.env.PAY_TO_EVM ?? "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const PAY_TO_SVM = process.env.PAY_TO_SVM ?? "ExamP1eWaLLet1111111111111111111111111111111";

const app = express();

app.use(
  agentPayments({
    live: MODE === "live",
    payTo: { evm: PAY_TO_EVM, solana: PAY_TO_SVM },
    assets: ["USDC", "pathUSD"],
    endpoints: {
      "GET /weather": {
        price: "$0.01",
        // Em dash at index 8 triggers the validator.
        description: "Weather — real-time",
      },
    },
  }),
);

app.get("/weather", (_req, res) => res.json({ ok: true }));

// Explicit error handler — writes ConfigError.message to stderr so the smoke
// test can detect it in process output regardless of Node/Express version.
// Without this, Express's default handler sends the error only in the HTTP
// response body, which the smoke test doesn't capture on the server side.
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err.message);
  res.status(500).json({ error: err.message });
});

const server = app.listen(PORT, () => {
  console.log(
    `[99-validation-errors] listening on :${PORT} - first request should surface a ConfigError.`,
  );
  // Self-probe so you see the error without any extra client tooling.
  fetch(`http://localhost:${PORT}/weather`).catch(() => {});
});

// If the validator somehow does NOT fire within a second, bail - that's a regression.
setTimeout(() => {
  console.error("FAIL: expected ConfigError from first request");
  server.close();
  process.exit(2);
}, 1500);
