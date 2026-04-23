/**
 * MPP-paying client.
 *
 * Uses mppx/client to auto-handle the 402 → sign → broadcast → retry flow.
 * Requires a funded Tempo account. Set PRIVATE_KEY to run a real payment.
 *
 * Run:
 *   PRIVATE_KEY=0x... URL=http://localhost:4000/weather pnpm pay:mpp
 */
import { Mppx, tempo } from "mppx/client";
import { privateKeyToAccount } from "viem/accounts";
import { BASE_URL } from "../env.js";

const url = process.env.URL ?? `${BASE_URL}/weather`;
const privateKey = process.env.PRIVATE_KEY;

if (!privateKey) {
  console.error("PRIVATE_KEY required to pay. Set PRIVATE_KEY=0x... and retry.");
  console.error("For a no-signing probe, run: pnpm probe");
  process.exit(1);
}

const account = privateKeyToAccount(privateKey as `0x${string}`);

console.log(`Paying as ${account.address} → ${url}`);

const mppx = Mppx.create({
  methods: [tempo.charge({ account })],
  polyfill: false,
});

const res = await mppx.fetch(url);

console.log(`\nResponse: ${res.status}`);
console.log("Payment-Receipt:", res.headers.get("payment-receipt") ?? "MISSING");

const body = await res.text();
console.log("Body:", body);

process.exit(res.status === 200 ? 0 : 1);
