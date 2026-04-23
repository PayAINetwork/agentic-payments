import type { ChallengeContext, ProtocolAdapter } from "./protocols/types.js";

/**
 * Generate challenge headers from all enabled protocol adapters.
 * Runs adapters in parallel. If one fails, the other's headers are still returned
 * (graceful degradation).
 */
export async function generateChallengeHeaders(
  adapters: ProtocolAdapter[],
  ctx: ChallengeContext,
): Promise<Record<string, string>> {
  const results = await Promise.allSettled(
    adapters.map((adapter) => adapter.generateChallenge(ctx)),
  );

  const merged: Record<string, string> = {};

  for (const result of results) {
    if (result.status === "fulfilled") {
      for (const [key, value] of Object.entries(result.value)) {
        if (!value) continue;

        // WWW-Authenticate headers can have multiple values (comma-separated)
        if (key.toLowerCase() === "www-authenticate" && merged[key]) {
          merged[key] = `${merged[key]}, ${value}`;
        } else {
          merged[key] = value;
        }
      }
    } else if (process.env.PAYAI_DEBUG) {
      console.error("[@payai/mercantil-agent-sdk] challenge adapter failed:", result.reason);
    }
    // Rejected adapters are otherwise silently skipped — the other protocol still works
  }

  return merged;
}
