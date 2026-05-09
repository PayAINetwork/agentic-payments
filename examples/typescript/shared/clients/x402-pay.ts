/**
 * x402-paying client — real EVM + Solana signing.
 *
 * Prints every HTTP header at each phase of the x402 payment flow:
 *   Phase 1 — bare GET → server returns 402 + PAYMENT-REQUIRED challenge
 *   Phase 2 — retry with PAYMENT-SIGNATURE header
 *   Phase 3 — server returns 200 + PAYMENT-RESPONSE receipt
 *
 * Env vars (set at least one):
 *   EVM_PRIVATE_KEY=0x...     EVM private key (hex, 32 bytes)
 *   SVM_PRIVATE_KEY=<base58>  Solana keypair (base58-encoded 64 bytes)
 *   NETWORK=<filter>          Optional CAIP-2 substring filter
 *                             e.g. "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "eip155:80002"
 *
 * Run:
 *   EVM_PRIVATE_KEY=0x... npm run pay:x402
 *   NETWORK=solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1 npm run pay:x402
 *   NETWORK=eip155:80002 npm run pay:x402
 */
import { x402Client } from "@x402/core/client";
import { x402HTTPClient, decodePaymentResponseHeader, decodePaymentRequiredHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm";
import { ExactSvmScheme, toClientSvmSigner } from "@x402/svm";
import { privateKeyToAccount } from "viem/accounts";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";
import { BASE_URL } from "../env.js";

const url = process.env.URL ?? `${BASE_URL}/weather`;
const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}` | undefined;
const svmSecretKey = process.env.SVM_PRIVATE_KEY;
const networkFilter = process.env.NETWORK?.toLowerCase();

if (!evmPrivateKey && !svmSecretKey) {
  console.error("At least one of EVM_PRIVATE_KEY or SVM_PRIVATE_KEY is required.");
  console.error("  EVM:    EVM_PRIVATE_KEY=0x... npm run pay:x402");
  console.error("  Solana: SVM_PRIVATE_KEY=<base58-keypair> npm run pay:x402");
  process.exit(1);
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const SEP = "═".repeat(60);

function printHeaders(headers: Headers): void {
  for (const [key, value] of headers.entries()) {
    const display = value.length > 120 ? `${value.slice(0, 120)}…` : value;
    console.log(`  ${key}: ${display}`);
  }
}

// ─── Phase 1: unauthenticated request ────────────────────────────────────────

console.log(`${SEP}`);
console.log("  PHASE 1 · Request (no payment)");
console.log(`${SEP}`);
console.log(`→ GET ${url}`);
console.log("  (no payment headers)\n");

const challengeRes = await fetch(url);

console.log(`← HTTP ${challengeRes.status} ${challengeRes.statusText}`);
printHeaders(challengeRes.headers);

const paymentRequiredHeader = challengeRes.headers.get("payment-required");
if (!paymentRequiredHeader) {
  console.error("\nNo PAYMENT-REQUIRED header — x402 may be disabled on this server.");
  process.exit(1);
}

const paymentRequired = decodePaymentRequiredHeader(paymentRequiredHeader);
console.log("\n  Decoded PAYMENT-REQUIRED:");
console.log(
  JSON.stringify(paymentRequired, null, 2)
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n"),
);
console.log();

// ─── Build x402 client ───────────────────────────────────────────────────────

const selector = networkFilter
  ? (_ver: number, reqs: import("@x402/core/types").PaymentRequirements[]) => {
      const match = reqs.find((r) => r.network.toLowerCase().includes(networkFilter));
      if (!match) {
        console.error(
          `No accepts entry matches NETWORK="${networkFilter}". Available: ${reqs.map((r) => r.network).join(", ")}`,
        );
        process.exit(1);
      }
      return match;
    }
  : undefined;

const coreClient = new x402Client(selector);

if (evmPrivateKey) {
  const account = privateKeyToAccount(evmPrivateKey);
  console.log(`EVM signer:    ${account.address}`);
  coreClient.register("eip155:*", new ExactEvmScheme(account));
}

if (svmSecretKey) {
  const keypairBytes = base58.decode(svmSecretKey);
  const keypairSigner = await createKeyPairSignerFromBytes(keypairBytes);
  const signer = toClientSvmSigner(keypairSigner);
  console.log(`Solana signer: ${keypairSigner.address}`);
  coreClient.register("solana:*", new ExactSvmScheme(signer));
}

const httpClient = new x402HTTPClient(coreClient);

// ─── Sign the payment payload ─────────────────────────────────────────────────

let paymentPayload: Awaited<ReturnType<typeof httpClient.createPaymentPayload>>;
try {
  paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
} catch (err) {
  console.error("\nFailed to create payment payload:", err);
  process.exit(1);
}

const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

// ─── Phase 2: retry with PAYMENT-SIGNATURE ───────────────────────────────────

console.log(`\n${SEP}`);
console.log("  PHASE 2 · Request (with payment)");
console.log(`${SEP}`);
console.log(`→ GET ${url}`);
for (const [key, value] of Object.entries(paymentHeaders)) {
  const display = value.length > 120 ? `${value.slice(0, 120)}…` : value;
  console.log(`  ${key}: ${display}`);
}

// Decode the PAYMENT-SIGNATURE to show what the client is authorizing
const sigHeader = paymentHeaders["PAYMENT-SIGNATURE"] ?? paymentHeaders["payment-signature"];
if (sigHeader) {
  const decoded = JSON.parse(Buffer.from(sigHeader, "base64").toString());
  console.log("\n  Decoded PAYMENT-SIGNATURE:");
  console.log(
    JSON.stringify(decoded, null, 2)
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n"),
  );
}
console.log();

const paidRes = await fetch(url, { headers: paymentHeaders });

// ─── Phase 3: settlement receipt ─────────────────────────────────────────────

console.log(`${SEP}`);
console.log("  PHASE 3 · Response (settlement receipt)");
console.log(`${SEP}`);
console.log(`← HTTP ${paidRes.status} ${paidRes.statusText}`);
printHeaders(paidRes.headers);

const paymentResponseHeader = paidRes.headers.get("payment-response");
if (paymentResponseHeader) {
  const receipt = decodePaymentResponseHeader(paymentResponseHeader);
  console.log("\n  Decoded PAYMENT-RESPONSE:");
  console.log(
    JSON.stringify(receipt, null, 2)
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n"),
  );
} else {
  console.log("\n  (no PAYMENT-RESPONSE header)");
}

const body = await paidRes.text();
console.log("\nBody:", body);
process.exit(paidRes.status === 200 ? 0 : 1);
