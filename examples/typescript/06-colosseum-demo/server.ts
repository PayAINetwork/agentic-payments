import express from "express";
import { agentPayments } from "@payai/mercantil-agent-sdk/express";

const app = express();

app.use(
  agentPayments({
    live: process.env.MODE === "live",
    payTo: {
      evm: process.env.PAY_TO_EVM,
      solana: process.env.PAY_TO_SVM,
    },
    assets: ["CASH", "USDC", "pathUSD"],
    endpoints: {
      "GET /weather": { price: "$0.01", description: "Current weather" },
    },
    hooks: {
      onPaymentSettled({ payment }) {
        console.log(`\n  settled  ${payment.protocol}  ${payment.network}`);
      },
      onPaymentFailed({ error }) {
        console.log(`\n  failed   ${error?.message}`);
      },
    },
  }),
);

app.get("/weather", (_req, res) => {
  res.json({ city: "San Francisco", weather: "foggy", temperature: 60 });
});

const port = Number(process.env.PORT ?? 4000);
const mode = process.env.MODE === "live" ? "live" : "test";

app.listen(port, () => {
  console.log(`listening on :${port}  mode=${mode}`);
  console.log(`  assets : CASH · USDC · pathUSD`);
});
