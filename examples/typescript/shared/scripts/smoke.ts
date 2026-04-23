/**
 * Smoke test — spawns each example via its own `npm start`, probes the 402,
 * asserts protocol headers are present, tears the server down.
 *
 * Running via `npm start` (not `tsx <file>` directly) tests the same command a
 * real developer runs after copy-pasting the example. If that command breaks,
 * so does this smoke test.
 *
 * Run: pnpm smoke
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES_ROOT = resolve(HERE, "..", "..");

interface Case {
  workspace: string;
  url: string;
  method?: string;
  expectBoth: boolean;
  /**
   * Assert the decoded 402 quotes exactly this atomic amount on both
   * protocols. Catches the class of bug where an adapter double-converts
   * a human-readable price into atomic units (10^decimals over/undercharge).
   */
  expectAmount?: string;
}

interface NegativeCase {
  workspace: string;
  expectErrorSubstring: string;
}

const CASES: Case[] = [
  // $0.01 * 10^6 (USDC and pathUSD both have 6 decimals) = 10000 atomic units.
  { workspace: "01-basic-express", url: "/weather", expectBoth: true, expectAmount: "10000" },
  { workspace: "02-multi-asset", url: "/premium", expectBoth: true },
  { workspace: "03-cross-chain", url: "/weather", expectBoth: true, expectAmount: "10000" },
  { workspace: "04-dynamic-pricing", url: "/translate?tier=pro", method: "POST", expectBoth: true, expectAmount: "100000" },
  { workspace: "05-hooks", url: "/weather", expectBoth: true, expectAmount: "10000" },
];

const NEGATIVE_CASES: NegativeCase[] = [
  { workspace: "99-validation-errors", expectErrorSubstring: "non-ASCII character" },
];

const PORT = 4555;

function startWorkspace(workspace: string) {
  return spawn("npm", ["start", "--silent"], {
    cwd: resolve(EXAMPLES_ROOT, workspace),
    env: { ...process.env, PORT: String(PORT), MODE: "test" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForServer(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://localhost:${port}/__no-route__`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`Server did not come up on :${port} within ${timeoutMs}ms`);
}

async function runCase(c: Case): Promise<boolean> {
  const method = c.method ?? "GET";
  console.log(`\n=== ${c.workspace} (${method} ${c.url}) ===`);
  const child = startWorkspace(c.workspace);
  let stderrBuf = "";
  child.stderr.on("data", (d) => { stderrBuf += d.toString(); });

  try {
    await waitForServer(PORT);
    const res = await fetch(`http://localhost:${PORT}${c.url}`, { method });
    if (res.status !== 402) {
      console.error(`  FAIL: expected 402, got ${res.status}`);
      return false;
    }

    const x402Header = res.headers.get("payment-required");
    const mppHeader = res.headers.get("www-authenticate");
    const x402Ok = Boolean(x402Header);
    const mppOk = Boolean(mppHeader);

    console.log(`  402 received. PAYMENT-REQUIRED=${x402Ok} WWW-Authenticate=${mppOk}`);

    if (c.expectBoth && !(x402Ok && mppOk)) {
      console.error("  FAIL: expected both protocol headers");
      return false;
    }

    if (c.expectAmount) {
      if (!x402Header || !mppHeader) {
        console.error("  FAIL: expectAmount requires both protocol headers");
        return false;
      }

      const x402Accepts = decodeX402Accepts(x402Header);
      const mppRequest = decodeMppRequest(mppHeader);

      // The server now advertises USDC on every PayAI-supported testnet
      // (different atomic amount per-chain when decimals differ — e.g.
      // pieUSD on KiteAI testnet has 18 decimals). We assert via a canonical
      // anchor: the Base Sepolia USDC entry (6 decimals) must equal the
      // expected atomic amount for the configured $-price.
      const BASE_SEPOLIA = "eip155:84532";
      const baseEntry = x402Accepts.find((a) => a.network === BASE_SEPOLIA);
      if (!baseEntry) {
        console.error(
          `  FAIL: expected an accepts entry on ${BASE_SEPOLIA}; got networks [${x402Accepts.map((a) => a.network).join(", ")}]`,
        );
        return false;
      }
      if (baseEntry.amount !== c.expectAmount) {
        console.error(
          `  FAIL: x402 ${BASE_SEPOLIA} amount "${baseEntry.amount}" expected "${c.expectAmount}"`,
        );
        return false;
      }
      if (mppRequest?.amount !== c.expectAmount) {
        console.error(
          `  FAIL: MPP amount "${mppRequest?.amount}" expected "${c.expectAmount}"`,
        );
        return false;
      }
      // Smoke is always MODE=test → expect Tempo testnet chainId (42431).
      // Regression guard for the case where we forgot to pass chainId and
      // mppx fell back to Tempo mainnet (4217).
      const EXPECTED_CHAIN_ID = 42431;
      if (mppRequest?.methodDetails?.chainId !== EXPECTED_CHAIN_ID) {
        console.error(
          `  FAIL: MPP chainId ${mppRequest?.methodDetails?.chainId} expected ${EXPECTED_CHAIN_ID} (Tempo testnet)`,
        );
        return false;
      }
      console.log(
        `  amount ok (x402 ${BASE_SEPOLIA}=${baseEntry.amount} across ${x402Accepts.length} networks; mpp=${mppRequest.amount} chainId=${mppRequest.methodDetails?.chainId})`,
      );
    }

    console.log("  OK");
    return true;
  } catch (err) {
    console.error("  FAIL:", err);
    if (stderrBuf) console.error("  stderr:", stderrBuf);
    return false;
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => {});
  }
}

/** Decode the x402 PAYMENT-REQUIRED header and return the accepts entries. */
function decodeX402Accepts(header: string): Array<{ network: string; amount: string }> {
  const decoded = JSON.parse(Buffer.from(header.trim(), "base64").toString());
  return decoded.accepts as Array<{ network: string; amount: string }>;
}

interface MppRequestPayload {
  amount: string;
  currency: string;
  recipient: string;
  methodDetails?: { chainId?: number };
}

/** Decode the MPP WWW-Authenticate `request="..."` (base64url JSON). */
function decodeMppRequest(header: string): MppRequestPayload | undefined {
  const match = header.match(/request="([^"]+)"/);
  if (!match) return undefined;
  const b64 = match[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString()) as MppRequestPayload;
}

async function runNegativeCase(c: NegativeCase): Promise<boolean> {
  console.log(`\n=== ${c.workspace} (expecting config error) ===`);
  const child = startWorkspace(c.workspace);
  let combined = "";
  child.stderr.on("data", (d) => { combined += d.toString(); });
  child.stdout.on("data", (d) => { combined += d.toString(); });

  const [code] = (await once(child, "exit").catch(() => [0])) as [number | null];
  const sawMessage = combined.includes(c.expectErrorSubstring);
  const failedAsExpected = (code ?? 0) !== 0;

  if (failedAsExpected && sawMessage) {
    console.log(`  OK (exit=${code}, error contained "${c.expectErrorSubstring}")`);
    return true;
  }
  console.error(`  FAIL: exit=${code}, sawMessage=${sawMessage}`);
  if (!sawMessage) console.error(`  stderr/stdout excerpt:\n${combined.slice(0, 400)}`);
  return false;
}

let passed = 0;
let failed = 0;

for (const c of CASES) {
  const ok = await runCase(c);
  ok ? passed++ : failed++;
}

for (const c of NEGATIVE_CASES) {
  const ok = await runNegativeCase(c);
  ok ? passed++ : failed++;
}

console.log(`\n=== ${passed}/${passed + failed} passed ===`);
process.exit(failed === 0 ? 0 : 1);
