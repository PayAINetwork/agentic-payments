import express from "express";
import { agentPayments } from "@payai/agentic-payments/express";

const keyId = process.env.PAYAI_KEY_ID;
const secret = process.env.PAYAI_SK;

if (!keyId || !secret) {
  console.error("PAYAI_KEY_ID and PAYAI_SK are required for managed mode");
  process.exit(1);
}

const app = express();

const handler = agentPayments({
  apiKey: { keyId, secret },
  payaiApiBaseUrl: process.env.PAYAI_API_URL ?? "http://localhost:3000",
  hooks: {
    onPaymentSettled({ payment }) {
      console.log(`\n  settled  ${payment.protocol}  ${payment.network}`);
    },
    onPaymentFailed({ error }) {
      console.log(`\n  failed   ${error?.message}`);
    },
  },
});

app.use(handler);

app.get("/weather", (_req, res) => {
  res.json({ city: "San Francisco", weather: "foggy", temperature: 60 });
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  const apiUrl = process.env.PAYAI_API_URL ?? "https://merchant.payai.network";
  const appUrl = process.env.SERVER_URL;
  console.log(`listening on :${port}  mode=managed`);
  console.log(`  portal : ${apiUrl}`);
  console.log(`  keyId  : ${keyId}`);
  if (appUrl) {
    console.log(`  appUrl : ${appUrl}`);
  } else {
    console.warn(
      `  appUrl : (not set) — set SERVER_URL to your public server URL so the portal\n` +
      `           can prefill the Server URL field in the Endpoints onboarding step.\n` +
      `           See .env.example for details.`,
    );
  }
});

process.on("SIGTERM", () => handler.shutdown());
