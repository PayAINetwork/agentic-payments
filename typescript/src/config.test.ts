import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "./config.js";
import { ConfigError } from "./errors.js";
import type { AgentPaymentsConfig } from "./types.js";

const EVM = "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00";
const SVM = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const HMAC = "a".repeat(64);

/**
 * Provide MPP_SECRET_KEY from env so resolveConfig never touches the filesystem
 * to persist an auto-generated secret. Restore the prior value after each test.
 */
let prevSecret: string | undefined;
beforeEach(() => {
  prevSecret = process.env.MPP_SECRET_KEY;
  process.env.MPP_SECRET_KEY = HMAC;
});
afterEach(() => {
  if (prevSecret === undefined) delete process.env.MPP_SECRET_KEY;
  else process.env.MPP_SECRET_KEY = prevSecret;
});

const baseEndpoints = {
  "GET /weather": { price: "$0.01", description: "Current weather" },
};

describe("resolveConfig — mode detection", () => {
  it("throws if neither apiKey nor payTo is given", async () => {
    await expect(
      resolveConfig({ endpoints: baseEndpoints } as AgentPaymentsConfig),
    ).rejects.toThrow(ConfigError);
  });

  it("throws if apiKey is set (managed mode not yet implemented)", async () => {
    await expect(resolveConfig({ apiKey: "pk_test", endpoints: baseEndpoints })).rejects.toThrow(
      /Managed mode.*not yet implemented/,
    );
  });
});

describe("resolveConfig — network inference", () => {
  it("defaults to testnet — expands an EVM payTo to Base Sepolia + Tempo testnet", async () => {
    const r = await resolveConfig({ payTo: EVM, endpoints: baseEndpoints });
    expect(r.networks).toContain("eip155:84532"); // Base Sepolia
    expect(r.networks).toContain("eip155:42431"); // Tempo testnet
  });

  it("uses mainnet networks when live: true", async () => {
    const r = await resolveConfig({
      payTo: EVM,
      endpoints: baseEndpoints,
      live: true,
    });
    expect(r.networks).toContain("eip155:8453"); // Base mainnet
    expect(r.networks).toContain("eip155:4217"); // Tempo mainnet
  });

  it("respects an explicit `networks` array", async () => {
    const r = await resolveConfig({
      payTo: EVM,
      networks: ["eip155:8453"],
      endpoints: baseEndpoints,
    });
    expect(r.networks).toEqual(["eip155:8453"]);
  });

  it("falls back to all environment networks for a dynamic payTo", async () => {
    // payTo as function → no static address to infer from → use all networks.
    const r = await resolveConfig({
      payTo: () => EVM,
      endpoints: baseEndpoints,
    });
    expect(r.networks.length).toBeGreaterThan(0);
    expect(r.networks.some((n) => n.startsWith("solana:"))).toBe(true);
  });
});

describe("resolveConfig — protocol inference", () => {
  it("enables both x402 and MPP when a Tempo network is present", async () => {
    const r = await resolveConfig({ payTo: EVM, endpoints: baseEndpoints });
    expect(r.protocols).toEqual(["x402", "mpp"]);
    expect(r.x402).not.toBeNull();
    expect(r.mpp).not.toBeNull();
  });

  it("enables x402 only for an SVM-only payTo (MPP needs Tempo)", async () => {
    const r = await resolveConfig({ payTo: SVM, endpoints: baseEndpoints });
    expect(r.protocols).toEqual(["x402"]);
    expect(r.x402).not.toBeNull();
    expect(r.mpp).toBeNull();
  });

  it("honors an explicit `protocols: ['x402']` override", async () => {
    const r = await resolveConfig({
      payTo: EVM,
      endpoints: baseEndpoints,
      protocols: ["x402"],
    });
    expect(r.protocols).toEqual(["x402"]);
    expect(r.mpp).toBeNull();
  });
});

describe("resolveConfig — x402 config", () => {
  // PayAI's facilitator handles both envs via the same URL — the payment's
  // `network` field tells the facilitator which chain (and thus env) to settle.
  const PAYAI_FACILITATOR = "https://facilitator.payai.network";

  it("defaults to PayAI's facilitator", async () => {
    const r = await resolveConfig({ payTo: EVM, endpoints: baseEndpoints });
    expect(r.x402?.facilitatorUrl).toBe(PAYAI_FACILITATOR);
  });

  it("uses the same facilitator URL when live: true", async () => {
    const r = await resolveConfig({
      payTo: EVM,
      endpoints: baseEndpoints,
      live: true,
    });
    expect(r.x402?.facilitatorUrl).toBe(PAYAI_FACILITATOR);
  });

  it("respects an explicit x402.facilitatorUrl override", async () => {
    const r = await resolveConfig({
      payTo: EVM,
      endpoints: baseEndpoints,
      x402: { facilitatorUrl: "https://custom.facilitator" },
    });
    expect(r.x402?.facilitatorUrl).toBe("https://custom.facilitator");
  });

  it("defaults scheme to 'exact'", async () => {
    const r = await resolveConfig({ payTo: EVM, endpoints: baseEndpoints });
    expect(r.x402?.scheme).toBe("exact");
  });

  it("defaults supportedNetworks to all PayAI-supported x402 testnet networks", async () => {
    const r = await resolveConfig({ payTo: EVM, endpoints: baseEndpoints });
    // Default mode is testnet — spot-check a few.
    expect(r.x402?.supportedNetworks).toContain("eip155:84532"); // Base Sepolia
    expect(r.x402?.supportedNetworks).toContain("eip155:80002"); // Polygon Amoy
    expect(r.x402?.supportedNetworks).toContain("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
    // Tempo testnet is MPP-only — must NOT be in the x402 supported list.
    expect(r.x402?.supportedNetworks).not.toContain("eip155:42431");
  });

  it("uses mainnet x402 supportedNetworks when live: true", async () => {
    const r = await resolveConfig({
      payTo: EVM,
      endpoints: baseEndpoints,
      live: true,
    });
    expect(r.x402?.supportedNetworks).toContain("eip155:8453"); // Base
    expect(r.x402?.supportedNetworks).toContain("eip155:137"); // Polygon
    expect(r.x402?.supportedNetworks).toContain("eip155:43114"); // Avalanche
    expect(r.x402?.supportedNetworks).toContain("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
    // Tempo is MPP-only — must NOT be in the x402 supported list.
    expect(r.x402?.supportedNetworks).not.toContain("eip155:4217");
  });

  it("respects an explicit x402.networks override as supportedNetworks", async () => {
    const r = await resolveConfig({
      payTo: EVM,
      endpoints: baseEndpoints,
      x402: { networks: ["eip155:8453"] },
    });
    expect(r.x402?.supportedNetworks).toEqual(["eip155:8453"]);
  });
});

describe("resolveConfig — MPP config", () => {
  it("reuses the MPP_SECRET_KEY env var", async () => {
    const r = await resolveConfig({ payTo: EVM, endpoints: baseEndpoints });
    expect(r.mpp?.secretKey).toBe(HMAC);
  });

  it("prefers an explicit mpp.secretKey over the env var", async () => {
    const explicit = "b".repeat(64);
    const r = await resolveConfig({
      payTo: EVM,
      endpoints: baseEndpoints,
      mpp: { secretKey: explicit },
    });
    expect(r.mpp?.secretKey).toBe(explicit);
  });

  it("uses an explicit mpp.realm when provided", async () => {
    const r = await resolveConfig({
      payTo: EVM,
      endpoints: baseEndpoints,
      mpp: { realm: "custom.example.com" },
    });
    expect(r.mpp?.realm).toBe("custom.example.com");
  });
});

describe("resolveConfig — asset registry and defaultAssets", () => {
  it("defaults to ['USDC'] when no assets configured", async () => {
    const r = await resolveConfig({ payTo: EVM, endpoints: baseEndpoints });
    expect(r.defaultAssets).toEqual(["USDC"]);
  });

  it("uses config.assets as defaultAssets (order preserved)", async () => {
    const r = await resolveConfig({
      payTo: EVM,
      endpoints: baseEndpoints,
      assets: ["pathUSD", "USDC", "USDT"],
    });
    expect(r.defaultAssets).toEqual(["pathUSD", "USDC", "USDT"]);
  });

  it("registers inline custom asset definitions by name", async () => {
    const r = await resolveConfig({
      payTo: EVM,
      endpoints: baseEndpoints,
      assets: [
        "USDC",
        {
          name: "PAYAI",
          addresses: {
            "eip155:8453": {
              address: "0xpayai00000000000000000000000000000000000",
              decimals: 18,
            },
          },
        },
      ],
    });
    expect(r.assetRegistry.PAYAI?.addresses["eip155:8453"].decimals).toBe(18);
    expect(r.defaultAssets).toEqual(["USDC", "PAYAI"]);
  });

  it("always includes built-in assets in the registry", async () => {
    const r = await resolveConfig({ payTo: EVM, endpoints: baseEndpoints });
    expect(r.assetRegistry.USDC).toBeDefined();
    expect(r.assetRegistry.USDT).toBeDefined();
    expect(r.assetRegistry.pathUSD).toBeDefined();
  });
});

describe("resolveConfig — non-ASCII description validator", () => {
  it("accepts ASCII-only descriptions", async () => {
    await expect(
      resolveConfig({
        payTo: EVM,
        endpoints: {
          "GET /a": { price: "$0.01", description: "Plain ASCII works" },
        },
      }),
    ).resolves.toBeDefined();
  });

  it("rejects an em-dash description when MPP is active", async () => {
    await expect(
      resolveConfig({
        payTo: EVM,
        endpoints: {
          "GET /a": { price: "$0.01", description: "Bad — em dash" },
        },
      }),
    ).rejects.toThrow(/non-ASCII character/);
  });

  it("rejects smart quotes and other punctuation above 0x7E", async () => {
    await expect(
      resolveConfig({
        payTo: EVM,
        endpoints: {
          "GET /a": { price: "$0.01", description: "Curly “quote”" },
        },
      }),
    ).rejects.toThrow(/non-ASCII character/);
  });

  it("allows non-ASCII when MPP is explicitly disabled", async () => {
    await expect(
      resolveConfig({
        payTo: EVM,
        endpoints: {
          "GET /a": { price: "$0.01", description: "Non-ASCII — fine on x402" },
        },
        protocols: ["x402"],
      }),
    ).resolves.toBeDefined();
  });

  it("allows non-ASCII when no Tempo network is inferred (SVM-only payTo)", async () => {
    await expect(
      resolveConfig({
        payTo: SVM,
        endpoints: {
          "GET /a": { price: "$0.01", description: "Non-ASCII — fine on SVM" },
        },
      }),
    ).resolves.toBeDefined();
  });

  it("names the offending endpoint and character index in the error", async () => {
    await expect(
      resolveConfig({
        payTo: EVM,
        endpoints: {
          "GET /weather": { price: "$0.01", description: "OK" },
          "GET /translate": { price: "$0.01", description: "Translate — pro" },
        },
      }),
    ).rejects.toThrow(/GET \/translate/);
  });
});
