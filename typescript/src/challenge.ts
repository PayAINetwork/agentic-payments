import type { ChallengeContext, ProtocolAdapter } from "./protocols/types.js";

/**
 * Generate challenge headers from all enabled protocol adapters.
 *
 * Runs adapters in parallel via `Promise.allSettled` so a failure in one
 * adapter never blocks the other — if x402 throws, the client still gets
 * MPP's `WWW-Authenticate`, and vice versa.
 *
 * When two adapters produce the same header name (realistically only
 * `WWW-Authenticate`), their values are preserved as an array so the
 * Express middleware can emit distinct header instances. Single values
 * are returned as strings. This matches RFC 9110: multiple auth-challenges
 * are valid as either comma-joined inside one header or as separate
 * instances; the multi-instance form parses more reliably across proxies
 * and clients that don't fully implement RFC 9110 auth-param handling.
 *
 * @param adapters - Enabled protocol adapters to query.
 * @param ctx - Shared ChallengeContext passed to every adapter.
 * @returns Header map where each value is either one string (one header)
 *   or an array of strings (one header per element).
 */
export async function generateChallengeHeaders(
  adapters: ProtocolAdapter[],
  ctx: ChallengeContext,
): Promise<Record<string, string | string[]>> {
  const results = await Promise.allSettled(
    adapters.map((adapter) => adapter.generateChallenge(ctx)),
  );

  const merged: Record<string, string | string[]> = {};

  for (const result of results) {
    if (result.status === "fulfilled") {
      for (const [key, value] of Object.entries(result.value)) {
        if (value === undefined || value === null) continue;
        const incoming = Array.isArray(value) ? value : [value];
        if (incoming.length === 0) continue;

        const existing = merged[key];
        if (existing === undefined) {
          // Preserve whatever shape the adapter returned.
          merged[key] = Array.isArray(value) ? [...incoming] : incoming[0];
        } else {
          // Two adapters returned the same header name. Combine into an array
          // so the downstream middleware emits distinct header instances.
          const combined = Array.isArray(existing) ? existing : [existing];
          merged[key] = [...combined, ...incoming];
        }
      }
    } else if (process.env.PAYAI_DEBUG) {
      console.error("[@payai/agentic-payments] challenge adapter failed:", result.reason);
    }
    // Rejected adapters are otherwise silently skipped — the other protocol still works
  }

  return merged;
}
