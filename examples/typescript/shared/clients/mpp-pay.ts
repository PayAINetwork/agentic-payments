/**
 * MPP-paying client.
 *
 * Prints every HTTP header at each phase of the MPP payment flow:
 *   Phase 1 — bare GET → server returns 402 + WWW-Authenticate challenge
 *   Phase 2 — retry with Authorization: Payment <credential>
 *   Phase 3 — server returns 200 + Payment-Receipt header
 *
 * Requires a funded Tempo testnet account with pathUSD (chainId 42431).
 *
 * Run:
 *   EVM_PRIVATE_KEY=0x... URL=http://localhost:4000/weather npm run pay:mpp
 */
import { Mppx, tempo } from "mppx/client";
import { privateKeyToAccount } from "viem/accounts";
import { BASE_URL } from "../env.js";

const url = process.env.URL ?? `${BASE_URL}/weather`;
const privateKey = process.env.EVM_PRIVATE_KEY;

if (!privateKey) {
  console.error("EVM_PRIVATE_KEY required. Set EVM_PRIVATE_KEY=0x... and retry.");
  process.exit(1);
}

const account = privateKeyToAccount(privateKey as `0x${string}`);
console.log(`Paying as ${account.address} → ${url}\n`);

// ─── helpers ─────────────────────────────────────────────────────────────────

const SEP = "═".repeat(60);

// Payment receipt headers are never truncated — they're the proof of payment.
const FULL_VALUE_HEADERS = new Set(["www-authenticate", "payment-required", "payment-receipt"]);

function printHeaders(headers: Headers): void {
  for (const [key, value] of headers.entries()) {
    const full = FULL_VALUE_HEADERS.has(key.toLowerCase());
    const display = !full && value.length > 120 ? `${value.slice(0, 120)}…` : value;
    console.log(`  ${key}: ${display}`);
  }
}

function decodeBase64Json(b64: string): unknown {
  return JSON.parse(Buffer.from(b64, "base64").toString());
}

function decodeMppRequest(wwwAuth: string): unknown | null {
  const m = wwwAuth.match(/request="([^"]+)"/);
  if (!m) return null;
  const padded = m[1].replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (padded.length % 4)) % 4;
  return JSON.parse(Buffer.from(padded + "=".repeat(pad), "base64").toString());
}

// ─── logging fetch passed to mppx ────────────────────────────────────────────
// mppx calls this for every outbound request, giving us visibility into
// both the initial (unauthenticated) GET and the payment retry.

let phase = 0;

async function loggingFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  phase++;

  // ── Request ──────────────────────────────────────────────────────────────
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const reqUrl = input instanceof URL ? input.href : input instanceof Request ? input.url : input;
  const reqHeaders = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );

  console.log(`${SEP}`);
  console.log(`  PHASE ${phase} · Request`);
  console.log(`${SEP}`);
  console.log(`→ ${method} ${reqUrl}`);
  if ([...reqHeaders.entries()].length > 0) {
    printHeaders(reqHeaders);
  } else {
    console.log("  (no explicit request headers)");
  }

  // Decode the Authorization: Payment header if present
  const auth = reqHeaders.get("authorization");
  if (auth?.startsWith("Payment ")) {
    const credential = auth.slice("Payment ".length);
    try {
      const decoded = JSON.parse(Buffer.from(credential, "base64").toString());
      console.log("\n  Decoded Authorization credential:");
      console.log(
        JSON.stringify(decoded, null, 2)
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n"),
      );
    } catch {
      // credential is not plain base64 JSON — print raw
      console.log(`\n  Authorization credential (raw): ${credential.slice(0, 80)}…`);
    }
  }

  // ── Response ─────────────────────────────────────────────────────────────
  const res = await globalThis.fetch(input, init);

  console.log(`\n← HTTP ${res.status} ${res.statusText}`);
  printHeaders(res.headers);

  // Decode payment-specific response headers
  const wwwAuth = res.headers.get("www-authenticate");
  if (wwwAuth) {
    console.log("\n  Decoded WWW-Authenticate request param:");
    const req = decodeMppRequest(wwwAuth);
    console.log(
      JSON.stringify(req, null, 2)
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n"),
    );
  }

  const receipt = res.headers.get("payment-receipt");
  if (receipt) {
    console.log("\n  Decoded Payment-Receipt:");
    console.log(
      JSON.stringify(decodeBase64Json(receipt), null, 2)
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n"),
    );
  }

  console.log();
  return res;
}

// ─── run ─────────────────────────────────────────────────────────────────────

const mppx = Mppx.create({
  methods: [tempo.charge({ account })],
  polyfill: false,
  fetch: loggingFetch,
});

const res = await mppx.fetch(url);
const body = await res.text();
console.log("Body:", body);
process.exit(res.status === 200 ? 0 : 1);
