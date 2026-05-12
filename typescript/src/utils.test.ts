import { describe, expect, it } from "vitest";
import { USDC } from "./assets.js";
import type { CustomAssetDef, EndpointMap, RequestContext } from "./types.js";
import {
  buildAssetRegistry,
  expandPayTo,
  getAssetNetworkInfo,
  inferNetworks,
  isEvmAddress,
  matchEndpoint,
  parsePriceString,
  resolveAssets,
  resolvePrice,
  toAtomicUnits,
} from "./utils.js";

const EP = (desc: string) => ({ price: "$0.01", description: desc });

const CTX: RequestContext = {
  method: "GET",
  path: "/",
  url: "/",
  headers: {},
  query: {},
};

describe("matchEndpoint", () => {
  const endpoints: EndpointMap = {
    "GET /weather": EP("exact"),
    "* /health": EP("any method"),
    "GET /api/*": EP("glob"),
    "GET /marketplace/:seller": EP("param"),
    "POST /items/:id/edit": EP("param mid-path"),
  };

  it("matches exact method + path", () => {
    expect(matchEndpoint("GET", "/weather", endpoints)?.description).toBe("exact");
  });

  it("is case-insensitive on method", () => {
    expect(matchEndpoint("get", "/weather", endpoints)?.description).toBe("exact");
  });

  it("matches wildcard method with exact path", () => {
    expect(matchEndpoint("GET", "/health", endpoints)?.description).toBe("any method");
    expect(matchEndpoint("POST", "/health", endpoints)?.description).toBe("any method");
  });

  it("matches trailing glob", () => {
    expect(matchEndpoint("GET", "/api/foo", endpoints)?.description).toBe("glob");
    expect(matchEndpoint("GET", "/api/foo/bar", endpoints)?.description).toBe("glob");
  });

  it("trailing glob also matches the pattern base with no extra segment", () => {
    // "GET /api/*" matches "/api" too — * is "zero or more remaining segments".
    // This is intentional: a glob protects the whole prefix including its root.
    expect(matchEndpoint("GET", "/api", endpoints)?.description).toBe("glob");
  });

  it("matches :param segments", () => {
    expect(matchEndpoint("GET", "/marketplace/alice", endpoints)?.description).toBe("param");
    expect(matchEndpoint("POST", "/items/123/edit", endpoints)?.description).toBe("param mid-path");
  });

  it("does not match when a :param segment is missing", () => {
    expect(matchEndpoint("GET", "/marketplace", endpoints)).toBeNull();
  });

  it("does not match when trailing segments exceed the pattern", () => {
    expect(matchEndpoint("GET", "/marketplace/alice/extra", endpoints)).toBeNull();
  });

  it("returns null when method differs", () => {
    expect(matchEndpoint("POST", "/weather", endpoints)).toBeNull();
  });

  it("returns null for paths not in the map", () => {
    expect(matchEndpoint("GET", "/nowhere", endpoints)).toBeNull();
  });
});

describe("parsePriceString", () => {
  it("accepts $-prefixed USD", () => {
    expect(parsePriceString("$0.01")).toBe(0.01);
    expect(parsePriceString("$100")).toBe(100);
  });

  it("accepts bare numeric strings", () => {
    expect(parsePriceString("0.50")).toBe(0.5);
    expect(parsePriceString("1000")).toBe(1000);
  });

  it("trims whitespace", () => {
    expect(parsePriceString("  $0.01 ")).toBe(0.01);
  });

  it("throws on non-numeric input", () => {
    expect(() => parsePriceString("abc")).toThrow(/Invalid price/);
  });

  it("throws on negative values", () => {
    expect(() => parsePriceString("-1")).toThrow(/Invalid price/);
  });
});

describe("toAtomicUnits", () => {
  it("scales USD to 6-decimal atomic units (USDC/pathUSD)", () => {
    expect(toAtomicUnits("$0.01", 6)).toBe("10000");
    expect(toAtomicUnits("$1", 6)).toBe("1000000");
  });

  it("scales to 18-decimal atomic units (most EVM tokens)", () => {
    expect(toAtomicUnits("$1", 18)).toBe("1000000000000000000");
  });

  it("handles bare numeric strings", () => {
    expect(toAtomicUnits("100", 6)).toBe("100000000");
  });
});

describe("resolvePrice", () => {
  it("passes through a static price", async () => {
    await expect(resolvePrice("$0.01", CTX)).resolves.toBe("$0.01");
  });

  it("passes through a price record", async () => {
    const record = { USDC: "$0.01", pathUSD: "$0.01" };
    await expect(resolvePrice(record, CTX)).resolves.toEqual(record);
  });

  it("calls a dynamic price function with the request context", async () => {
    const price = (ctx: RequestContext) => (ctx.query.tier === "pro" ? "$0.10" : "$0.01");
    const ctx: RequestContext = { ...CTX, query: { tier: "pro" } };
    await expect(resolvePrice(price, ctx)).resolves.toBe("$0.10");
  });

  it("awaits an async dynamic price function", async () => {
    const price = async () => "$0.02";
    await expect(resolvePrice(price, CTX)).resolves.toBe("$0.02");
  });
});

describe("isEvmAddress", () => {
  it("accepts a well-formed 40-hex address", () => {
    expect(isEvmAddress("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef")).toBe(true);
  });

  it("accepts mixed case", () => {
    expect(isEvmAddress("0xAAbbCCddEEff001122334455667788990011223344".slice(0, 42))).toBe(true);
  });

  it("rejects missing 0x", () => {
    expect(isEvmAddress("742d35Cc6634C0532925a3b844Bc9e7595f8fE00")).toBe(false);
  });

  it("rejects wrong length", () => {
    expect(isEvmAddress("0x742d")).toBe(false);
  });

  it("rejects non-hex chars", () => {
    expect(isEvmAddress(`0x${"z".repeat(40)}`)).toBe(false);
  });

  it("rejects Solana-style addresses", () => {
    expect(isEvmAddress("ExamP1eWaLLet1111111111111111111111111111111")).toBe(false);
  });
});

describe("expandPayTo", () => {
  const EVM = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  const SVM = "ExamP1eWaLLet1111111111111111111111111111111";

  it("spreads an EVM address across all supported EVM mainnet networks", () => {
    const out = expandPayTo(EVM, false);
    // PayAI-supported x402 chains
    expect(out["eip155:8453"]).toBe(EVM); // Base
    expect(out["eip155:137"]).toBe(EVM); // Polygon
    expect(out["eip155:43114"]).toBe(EVM); // Avalanche
    // Tempo (MPP-only)
    expect(out["eip155:4217"]).toBe(EVM);
    // Sanity: all values are the same EVM address, no Solana keys.
    expect(Object.values(out).every((v) => v === EVM)).toBe(true);
    expect(Object.keys(out).every((k) => k.startsWith("eip155:"))).toBe(true);
  });

  it("spreads an EVM address across all supported EVM testnet networks", () => {
    const out = expandPayTo(EVM, true);
    expect(out["eip155:84532"]).toBe(EVM); // Base Sepolia
    expect(out["eip155:80002"]).toBe(EVM); // Polygon Amoy
    expect(out["eip155:43113"]).toBe(EVM); // Avalanche Fuji
    expect(out["eip155:42431"]).toBe(EVM); // Tempo testnet
    expect(Object.keys(out).every((k) => k.startsWith("eip155:"))).toBe(true);
  });

  it("spreads a Solana address across SVM networks for the env", () => {
    const testnet = expandPayTo(SVM, true);
    expect(Object.keys(testnet).every((k) => k.startsWith("solana:"))).toBe(true);
    const mainnet = expandPayTo(SVM, false);
    expect(Object.keys(mainnet).every((k) => k.startsWith("solana:"))).toBe(true);
    expect(mainnet).not.toEqual(testnet);
  });

  it("returns a CAIP-2 record unchanged", () => {
    const record = {
      "eip155:8453": EVM,
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": SVM,
    };
    expect(expandPayTo(record, false)).toBe(record);
  });

  it("expands the { evm, solana } shorthand across both families", () => {
    const out = expandPayTo({ evm: EVM, solana: SVM }, true);
    // EVM side covers every EVM testnet
    expect(out["eip155:84532"]).toBe(EVM); // Base Sepolia
    expect(out["eip155:80002"]).toBe(EVM); // Polygon Amoy
    expect(out["eip155:42431"]).toBe(EVM); // Tempo testnet
    // Solana side covers Solana devnet (the SDK's "testnet" SVM target —
    // see assets.ts SVM_NETWORKS for why devnet, not Solana's own testnet).
    expect(out["solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"]).toBe(SVM);
    // Values correctly segregated by family
    const evmKeys = Object.keys(out).filter((k) => k.startsWith("eip155:"));
    const svmKeys = Object.keys(out).filter((k) => k.startsWith("solana:"));
    expect(evmKeys.every((k) => out[k] === EVM)).toBe(true);
    expect(svmKeys.every((k) => out[k] === SVM)).toBe(true);
  });

  it("supports shorthand with only one family", () => {
    const evmOnly = expandPayTo({ evm: EVM }, true);
    expect(Object.keys(evmOnly).every((k) => k.startsWith("eip155:"))).toBe(true);
    const solanaOnly = expandPayTo({ solana: SVM }, true);
    expect(Object.keys(solanaOnly).every((k) => k.startsWith("solana:"))).toBe(true);
  });

  it("flips mainnet vs testnet on the shorthand based on the env flag", () => {
    const testnet = expandPayTo({ evm: EVM, solana: SVM }, true);
    const mainnet = expandPayTo({ evm: EVM, solana: SVM }, false);
    expect(testnet["eip155:84532"]).toBe(EVM); // testnet has Base Sepolia
    expect(testnet["eip155:8453"]).toBeUndefined();
    expect(mainnet["eip155:8453"]).toBe(EVM); // mainnet has Base
    expect(mainnet["eip155:84532"]).toBeUndefined();
  });
});

describe("inferNetworks", () => {
  it("returns the keys from an expanded payTo", () => {
    const nets = inferNetworks("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", true);
    expect(nets).toContain("eip155:84532"); // Base Sepolia
    expect(nets).toContain("eip155:42431"); // Tempo testnet
    expect(nets).toContain("eip155:80002"); // Polygon Amoy
  });
});

describe("buildAssetRegistry", () => {
  it("includes the built-in assets by default", () => {
    const reg = buildAssetRegistry();
    expect(reg.USDC).toBeDefined();
    expect(reg.USDT).toBeDefined();
    expect(reg.pathUSD).toBeDefined();
  });

  it("registers inline custom asset definitions", () => {
    const custom: CustomAssetDef = {
      name: "PAYAI",
      addresses: {
        "eip155:8453": {
          address: "0xpayai000000000000000000000000000000000000",
          decimals: 18,
        },
      },
    };
    const reg = buildAssetRegistry(["USDC", custom]);
    expect(reg.PAYAI).toEqual(custom);
    expect(reg.USDC).toBeDefined(); // still present
  });

  it("lets custom assets override a built-in by name", () => {
    const override: CustomAssetDef = {
      name: "USDC",
      addresses: {
        "eip155:8453": {
          address: "0xoverride0000000000000000000000000000000000",
          decimals: 9,
        },
      },
    };
    const reg = buildAssetRegistry([override]);
    expect(reg.USDC.addresses["eip155:8453"].decimals).toBe(9);
  });
});

describe("getAssetNetworkInfo", () => {
  it("returns undefined for unsupported networks", () => {
    expect(getAssetNetworkInfo(USDC, "eip155:99999")).toBeUndefined();
  });

  it("applies defaults when a deployment omits optional EIP-712 fields", () => {
    // Base Sepolia USDC has only address + decimals. eip712Name should fall
    // back to the asset's `name`, and eip712Version should default to "2".
    const info = getAssetNetworkInfo(USDC, "eip155:84532");
    expect(info).toEqual({
      address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      decimals: 6,
      eip712Name: "USDC", // falls back to asset.name
      eip712Version: "2",
    });
  });

  it("applies per-network eip712Name override", () => {
    const info = getAssetNetworkInfo(USDC, "eip155:8453"); // Base mainnet
    expect(info?.eip712Name).toBe("USD Coin");
    expect(info?.eip712Version).toBe("2");
  });

  it("applies per-network decimals override (pieUSD on KiteAI testnet)", () => {
    // REGRESSION GUARD: USDC on KiteAI testnet is actually pieUSD —
    // different token, different decimals. The schema MUST surface this
    // so atomic-unit math produces the right amount on the wire.
    const info = getAssetNetworkInfo(USDC, "eip155:2368");
    expect(info?.decimals).toBe(18);
    expect(info?.eip712Name).toBe("pieUSD");
    expect(info?.eip712Version).toBe("1");
    expect(info?.address).toBe("0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A");
  });

  it("applies per-network eip712Name for bridged variants", () => {
    const skaleMainnet = getAssetNetworkInfo(USDC, "eip155:1187947933");
    expect(skaleMainnet?.eip712Name).toBe("Bridged USDC (SKALE Bridge)");
    const kiteaiMainnet = getAssetNetworkInfo(USDC, "eip155:2366");
    expect(kiteaiMainnet?.eip712Name).toBe("Bridged USDC (Kite AI)");
  });
});

describe("resolveAssets", () => {
  const registry = buildAssetRegistry();

  it("returns assets from a price record's keys", () => {
    const got = resolveAssets({ USDC: "$0.01", pathUSD: "$0.01" }, undefined, registry);
    expect(got.map((a) => a.name)).toEqual(["USDC", "pathUSD"]);
  });

  it("returns assets from an explicit endpoint assets array", () => {
    const got = resolveAssets("$0.01", ["USDC", "USDT"], registry);
    expect(got.map((a) => a.name)).toEqual(["USDC", "USDT"]);
  });

  it("falls back to defaultAssets when no endpoint override", () => {
    const got = resolveAssets("$0.01", undefined, registry, ["USDC", "pathUSD"]);
    expect(got.map((a) => a.name)).toEqual(["USDC", "pathUSD"]);
  });

  it("throws on an unknown asset name", () => {
    expect(() => resolveAssets("$0.01", ["MYSTERY"], registry)).toThrow(/Unknown asset "MYSTERY"/);
  });

  it("registers an inline custom asset passed at endpoint level", () => {
    const fresh = buildAssetRegistry();
    const custom: CustomAssetDef = {
      name: "INLINE",
      addresses: {
        "eip155:8453": {
          address: "0xinline00000000000000000000000000000000000",
          decimals: 18,
        },
      },
    };
    const got = resolveAssets("$0.01", ["INLINE", custom], fresh);
    expect(got.map((a) => a.name)).toEqual(["INLINE", "INLINE"]);
    expect(fresh.INLINE).toEqual(custom);
  });
});
