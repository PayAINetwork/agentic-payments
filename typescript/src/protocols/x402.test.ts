import { decodePaymentRequiredHeader } from "@x402/core/http";
import { describe, expect, it } from "vitest";
import type { CustomAssetDef, ResolvedX402Config } from "../types.js";
import type { ChallengeContext } from "./types.js";
import { createX402Adapter } from "./x402.js";

const CONFIG: ResolvedX402Config = {
  facilitatorUrl: "https://testnet.x402.org/facilitator",
  scheme: "exact",
  // Include both Base Sepolia and Tempo testnet so existing tests can exercise
  // multiple networks without being gated by the supportedNetworks filter.
  supportedNetworks: ["eip155:84532", "eip155:42431", "eip155:80002", "eip155:8453"],
};

const USDC: CustomAssetDef = {
  name: "USDC",
  addresses: {
    "eip155:84532": {
      address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
      decimals: 6,
    },
  },
};

const PATH_USD: CustomAssetDef = {
  name: "pathUSD",
  addresses: {
    "eip155:42431": {
      address: "0x20c0000000000000000000000000000000000000", // Tempo testnet
      decimals: 6,
    },
  },
};

const RECIPIENT = "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00";

function buildContext(overrides: Partial<ChallengeContext> = {}): ChallengeContext {
  return {
    endpoint: { price: "$0.01", description: "x402 unit test" },
    resolvedPrices: [{ asset: USDC, amount: "$0.01" }],
    networks: ["eip155:84532"],
    payTo: { "eip155:84532": RECIPIENT },
    request: {
      method: "GET",
      path: "/weather",
      url: "/weather",
      headers: {},
      query: {},
    },
    ...overrides,
  };
}

/** Helper — run generateChallenge and return the decoded PAYMENT-REQUIRED. */
async function decode(ctx: ChallengeContext) {
  const adapter = createX402Adapter(CONFIG);
  const headers = await adapter.generateChallenge(ctx);
  if (!headers["PAYMENT-REQUIRED"]) return null;
  return decodePaymentRequiredHeader(headers["PAYMENT-REQUIRED"]);
}

describe("x402 adapter — generateChallenge", () => {
  it("emits a base64 PAYMENT-REQUIRED header when prices resolve", async () => {
    const adapter = createX402Adapter(CONFIG);
    const headers = await adapter.generateChallenge(buildContext());
    expect(headers["PAYMENT-REQUIRED"]).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("converts price to atomic units on the wire", async () => {
    // REGRESSION GUARD: mirror of the MPP bug. x402 wants atomic units
    // on the wire; the adapter must run toAtomicUnits itself (no double
    // conversion downstream, no human-readable strings).
    const decoded = await decode(buildContext());
    expect(decoded?.accepts[0].amount).toBe("10000"); // $0.01 * 10^6
  });

  it("builds one accepts entry per (asset × network) combination", async () => {
    const decoded = await decode(
      buildContext({
        resolvedPrices: [
          { asset: USDC, amount: "$0.01" },
          { asset: PATH_USD, amount: "$0.01" },
        ],
        networks: ["eip155:84532", "eip155:42431"],
        payTo: {
          "eip155:84532": RECIPIENT,
          "eip155:42431": RECIPIENT,
        },
      }),
    );

    expect(decoded?.accepts).toHaveLength(2);

    const usdcEntry = decoded?.accepts.find((a) => a.network === "eip155:84532");
    const pathEntry = decoded?.accepts.find((a) => a.network === "eip155:42431");

    expect(usdcEntry?.asset).toBe(USDC.addresses["eip155:84532"].address);
    expect(pathEntry?.asset).toBe(PATH_USD.addresses["eip155:42431"].address);
  });

  it("skips combinations where the asset has no address on the network", async () => {
    // USDC has no Tempo address — adding Tempo to networks shouldn't produce
    // a USDC-on-Tempo entry.
    const decoded = await decode(
      buildContext({
        networks: ["eip155:84532", "eip155:42431"],
        payTo: { "eip155:84532": RECIPIENT, "eip155:42431": RECIPIENT },
      }),
    );
    expect(decoded?.accepts).toHaveLength(1);
    expect(decoded?.accepts[0].network).toBe("eip155:84532");
  });

  it("skips networks that have no payTo entry", async () => {
    // Tempo is in networks but payTo only covers Base. Tempo is dropped.
    const decoded = await decode(
      buildContext({
        resolvedPrices: [
          { asset: USDC, amount: "$0.01" },
          { asset: PATH_USD, amount: "$0.01" },
        ],
        networks: ["eip155:84532", "eip155:42431"],
        payTo: { "eip155:84532": RECIPIENT }, // no Tempo
      }),
    );
    expect(decoded?.accepts).toHaveLength(1);
    expect(decoded?.accepts[0].network).toBe("eip155:84532");
  });

  it("returns an empty object when no accepts entries can be built", async () => {
    const adapter = createX402Adapter(CONFIG);
    const headers = await adapter.generateChallenge(
      buildContext({
        networks: ["eip155:8453"], // Base mainnet — USDC has no address for it in our test setup
        payTo: { "eip155:8453": RECIPIENT },
      }),
    );
    expect(headers).toEqual({});
  });

  it("uses the configured scheme for every entry", async () => {
    const adapter = createX402Adapter({ ...CONFIG, scheme: "custom-scheme" });
    const headers = await adapter.generateChallenge(buildContext());
    const decoded = decodePaymentRequiredHeader(headers["PAYMENT-REQUIRED"]);
    expect(decoded.accepts.every((a) => a.scheme === "custom-scheme")).toBe(true);
  });

  it("populates extra.name + extra.version from per-network EIP-712 metadata (EVM)", async () => {
    // Asset with an EIP-712 override per-network (e.g. "Bridged USDC").
    const BRIDGED: CustomAssetDef = {
      name: "USDC",
      addresses: {
        "eip155:84532": {
          address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          decimals: 6,
          eip712Name: "Custom Name",
          eip712Version: "3",
        },
      },
    };
    const decoded = await decode(
      buildContext({ resolvedPrices: [{ asset: BRIDGED, amount: "$0.01" }] }),
    );
    expect(decoded?.accepts[0].extra).toEqual({
      name: "Custom Name",
      version: "3",
    });
  });

  it("leaves extra empty for Solana networks (no EIP-712)", async () => {
    const SOLANA_NET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
    const USDC_SVM: CustomAssetDef = {
      name: "USDC",
      addresses: {
        [SOLANA_NET]: {
          address: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
          decimals: 6,
        },
      },
    };
    const adapter = createX402Adapter({
      ...CONFIG,
      supportedNetworks: [SOLANA_NET],
    });
    const headers = await adapter.generateChallenge(
      buildContext({
        resolvedPrices: [{ asset: USDC_SVM, amount: "$0.01" }],
        networks: [SOLANA_NET],
        payTo: { [SOLANA_NET]: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" },
      }),
    );
    const decoded = decodePaymentRequiredHeader(headers["PAYMENT-REQUIRED"]);
    expect(decoded.accepts[0].extra).toEqual({});
  });

  it("uses per-network decimals when computing atomic amount", async () => {
    // REGRESSION GUARD: pieUSD (KiteAI testnet) has 18 decimals.
    // $0.01 * 10^18 = 10000000000000000, not 10000.
    const PIE: CustomAssetDef = {
      name: "USDC",
      addresses: {
        "eip155:2368": {
          address: "0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A",
          decimals: 18,
          eip712Name: "pieUSD",
          eip712Version: "1",
        },
      },
    };
    const adapter = createX402Adapter({
      ...CONFIG,
      supportedNetworks: ["eip155:2368"],
    });
    const headers = await adapter.generateChallenge(
      buildContext({
        resolvedPrices: [{ asset: PIE, amount: "$0.01" }],
        networks: ["eip155:2368"],
        payTo: { "eip155:2368": RECIPIENT },
      }),
    );
    const decoded = decodePaymentRequiredHeader(headers["PAYMENT-REQUIRED"]);
    expect(decoded.accepts[0].amount).toBe("10000000000000000"); // 10^16
  });

  it("filters out networks that are not in supportedNetworks", async () => {
    // REGRESSION GUARD: x402 must not emit accepts for chains its facilitator
    // can't settle on (e.g. Tempo, which is MPP-only). Even if an asset has
    // an address on that chain and payTo covers it, the entry must be dropped.
    const narrowConfig: ResolvedX402Config = {
      ...CONFIG,
      supportedNetworks: ["eip155:84532"], // Base Sepolia only — Tempo excluded
    };
    const adapter = createX402Adapter(narrowConfig);
    const headers = await adapter.generateChallenge(
      buildContext({
        resolvedPrices: [
          { asset: USDC, amount: "$0.01" },
          { asset: PATH_USD, amount: "$0.01" },
        ],
        networks: ["eip155:84532", "eip155:42431"], // both, but only Base is supported
        payTo: {
          "eip155:84532": RECIPIENT,
          "eip155:42431": RECIPIENT,
        },
      }),
    );
    const decoded = decodePaymentRequiredHeader(headers["PAYMENT-REQUIRED"]);
    expect(decoded.accepts).toHaveLength(1);
    expect(decoded.accepts[0].network).toBe("eip155:84532");
  });

  it("sets resource.url + resource.description from the request context", async () => {
    const decoded = await decode(
      buildContext({
        endpoint: { price: "$0.01", description: "Described endpoint" },
        request: {
          method: "GET",
          path: "/foo",
          url: "/foo?x=1",
          headers: {},
          query: { x: "1" },
        },
      }),
    );
    expect(decoded?.resource).toEqual({
      url: "/foo?x=1",
      description: "Described endpoint",
    });
  });
});
