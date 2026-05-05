/**
 * x402-paying client — stub.
 *
 * Paying the x402 challenge requires a registered scheme (e.g. `exact` on
 * an EVM chain) plus a viem signer. The actual scheme packages are not
 * published under @x402/core yet — the scheme implementation lives in the
 * x402 monorepo's separate packages. For now this client:
 *
 *   1. Fetches the 402 response
 *   2. Decodes PAYMENT-REQUIRED and prints the accepted options
 *   3. Documents what a real payer would do next
 *
 * Swap in a real signer once the scheme packages are available in this repo.
 *
 * Run: URL=http://localhost:4000/weather pnpm pay:x402
 */
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { BASE_URL } from "../env.js";

const url = process.env.URL ?? `${BASE_URL}/weather`;

const res = await fetch(url);
if (res.status !== 402) {
  console.error(`Expected 402, got ${res.status}`);
  process.exit(1);
}

const header = res.headers.get("payment-required");
if (!header) {
  console.error("Server did not return PAYMENT-REQUIRED — x402 may be disabled.");
  process.exit(1);
}

const required = decodePaymentRequiredHeader(header);
console.log("x402 PAYMENT-REQUIRED:");
console.log(JSON.stringify(required, null, 2));

console.log("\nNext steps for a real payer:");
console.log("  1. Select one `accepts` entry (pick a network + asset)");
console.log("  2. Build a SchemeNetworkClient (e.g. exact-evm) with your viem account");
console.log("  3. Call x402HTTPClient.createPaymentPayload(required)");
console.log("  4. Retry GET with the PAYMENT-SIGNATURE header");
console.log("  5. Read PAYMENT-RESPONSE header from the 200 response");
