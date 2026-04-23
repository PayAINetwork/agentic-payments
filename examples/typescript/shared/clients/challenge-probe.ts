/**
 * Unauthenticated probe — no signing required.
 *
 * Sends a GET without any payment header, verifies the server returned a 402
 * with both PAYMENT-REQUIRED (x402) and WWW-Authenticate (MPP) headers, and
 * prints the decoded challenge payloads.
 *
 * Use for: smoke testing that middleware is wired correctly, CI health checks,
 * debugging new endpoint configs.
 *
 * Run: URL=http://localhost:4000/weather pnpm probe
 */
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { BASE_URL } from "../env.js";

const url = process.env.URL ?? `${BASE_URL}/weather`;

const res = await fetch(url);

console.log(`GET ${url} → ${res.status}`);

if (res.status !== 402) {
  console.error(`Expected 402, got ${res.status}`);
  process.exit(1);
}

const x402Header = res.headers.get("payment-required");
const mppHeader = res.headers.get("www-authenticate");

console.log("\n--- Headers ---");
console.log("PAYMENT-REQUIRED:", x402Header ? "present" : "MISSING");
console.log("WWW-Authenticate:", mppHeader ? "present" : "MISSING");

if (x402Header) {
  try {
    const decoded = decodePaymentRequiredHeader(x402Header);
    console.log("\n--- x402 PAYMENT-REQUIRED ---");
    console.log(JSON.stringify(decoded, null, 2));
  } catch (err) {
    console.error("Failed to decode PAYMENT-REQUIRED:", err);
    process.exit(1);
  }
}

if (mppHeader) {
  console.log("\n--- MPP WWW-Authenticate ---");
  console.log(mppHeader);
}

const bothPresent = Boolean(x402Header && mppHeader);
console.log(`\nResult: ${bothPresent ? "OK (both protocols)" : "PARTIAL"}`);
process.exit(bothPresent ? 0 : 1);
