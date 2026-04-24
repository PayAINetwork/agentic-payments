import { describe, expect, it, vi } from "vitest";
import type { CustomAssetDef, ResolvedMppConfig } from "../types.js";
import { createMppAdapter } from "./mpp.js";
import type { ChallengeContext } from "./types.js";

/**
 * pathUSD definition matching the SDK's built-in registry.
 * Tempo testnet address, 6 decimals — same as mppx's own tempo default.
 */
const PATH_USD: CustomAssetDef = {
  name: "pathUSD",
  addresses: {
    "eip155:42431": {
      address: "0x20c0000000000000000000000000000000000000",
      decimals: 6,
    },
  },
};

const TEMPO_TESTNET = "eip155:42431";
const RECIPIENT = "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00";

/**
 * Build a ResolvedMppConfig with a mock mppx whose `compose` records every
 * call's entries and returns a minimal 402 response. This lets us assert the
 * exact arguments the adapter hands to mppx without running a real server.
 */
function buildConfig() {
  const composeCalls: Array<Array<[unknown, Record<string, unknown>]>> = [];
  const mppx = {
    tempo: { charge: vi.fn(() => "tempo-charge-handler") },
    compose: vi.fn((...entries: Array<[unknown, Record<string, unknown>]>) => {
      composeCalls.push(entries);
      return async () => ({
        status: 402,
        challenge: new Response(null, {
          headers: { "www-authenticate": 'Payment realm="test"' },
        }),
      });
    }),
  };
  const config: ResolvedMppConfig = {
    secretKey: "x".repeat(64),
    realm: "test",
    mppx,
  };
  return { config, composeCalls };
}

function buildContext(overrides: Partial<ChallengeContext> = {}): ChallengeContext {
  return {
    endpoint: { price: "$0.01", description: "Unit test endpoint" },
    resolvedPrices: [{ asset: PATH_USD, amount: "$0.01" }],
    networks: [TEMPO_TESTNET],
    payTo: { [TEMPO_TESTNET]: RECIPIENT },
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

describe("MPP adapter — amount handling", () => {
  it("sends human-readable decimal amount to mppx (not atomic units)", async () => {
    const { config, composeCalls } = buildConfig();
    const adapter = createMppAdapter(config);

    await adapter.generateChallenge(buildContext());

    // One compose call with one entry for pathUSD.
    expect(composeCalls).toHaveLength(1);
    expect(composeCalls[0]).toHaveLength(1);

    const [, options] = composeCalls[0][0];
    // REGRESSION GUARD: this is the bug that once shipped. mppx runs
    // parseUnits(amount, decimals) internally, so we MUST pass the
    // human-readable decimal ("0.01"), never atomic units ("10000").
    expect(options.amount).toBe("0.01");
    expect(options.amount).not.toBe("10000");
  });

  it("strips the leading $ from USD-notation prices", async () => {
    const { config, composeCalls } = buildConfig();
    const adapter = createMppAdapter(config);

    await adapter.generateChallenge(
      buildContext({
        resolvedPrices: [{ asset: PATH_USD, amount: "$12.34" }],
      }),
    );

    expect(composeCalls[0][0][1].amount).toBe("12.34");
  });

  it("passes non-$ amounts through as-is (e.g. native token units)", async () => {
    const { config, composeCalls } = buildConfig();
    const adapter = createMppAdapter(config);

    await adapter.generateChallenge(
      buildContext({
        resolvedPrices: [{ asset: PATH_USD, amount: "500" }],
      }),
    );

    expect(composeCalls[0][0][1].amount).toBe("500");
  });

  it("passes asset decimals explicitly so mppx doesn't fall back to its default", async () => {
    const { config, composeCalls } = buildConfig();
    const adapter = createMppAdapter(config);

    const customAsset: CustomAssetDef = {
      name: "BIGCOIN",
      addresses: {
        [TEMPO_TESTNET]: {
          address: "0xbigc0000000000000000000000000000000000000",
          decimals: 18,
        },
      },
    };

    await adapter.generateChallenge(
      buildContext({
        resolvedPrices: [{ asset: customAsset, amount: "$0.01" }],
      }),
    );

    expect(composeCalls[0][0][1].decimals).toBe(18);
  });

  it("populates currency, recipient, and description per entry", async () => {
    const { config, composeCalls } = buildConfig();
    const adapter = createMppAdapter(config);

    await adapter.generateChallenge(buildContext());

    const options = composeCalls[0][0][1];
    expect(options.currency).toBe(PATH_USD.addresses[TEMPO_TESTNET].address);
    expect(options.recipient).toBe(RECIPIENT);
    expect(options.description).toBe("Unit test endpoint");
  });

  it("passes chainId parsed from the CAIP-2 tempo network (testnet)", async () => {
    // REGRESSION GUARD: if we don't pass chainId, mppx's default client
    // resolves to Tempo mainnet (4217) even in testnet mode. Clients would
    // broadcast to the wrong chain and payments would never settle.
    const { config, composeCalls } = buildConfig();
    const adapter = createMppAdapter(config);

    await adapter.generateChallenge(buildContext());

    expect(composeCalls[0][0][1].chainId).toBe(42431); // Tempo testnet
  });

  it("passes chainId parsed from the CAIP-2 tempo network (mainnet)", async () => {
    const { config, composeCalls } = buildConfig();
    const adapter = createMppAdapter(config);

    const PATH_USD_MAINNET: CustomAssetDef = {
      name: "pathUSD",
      addresses: {
        "eip155:4217": {
          address: "0x20c0000000000000000000000000000000000000",
          decimals: 6,
        },
      },
    };

    await adapter.generateChallenge(
      buildContext({
        resolvedPrices: [{ asset: PATH_USD_MAINNET, amount: "$0.01" }],
        networks: ["eip155:4217"],
        payTo: { "eip155:4217": RECIPIENT },
      }),
    );

    expect(composeCalls[0][0][1].chainId).toBe(4217); // Tempo mainnet
  });
});

describe("MPP adapter — entry selection", () => {
  it("emits no compose call when no Tempo network is in the context", async () => {
    const { config, composeCalls } = buildConfig();
    const adapter = createMppAdapter(config);

    const headers = await adapter.generateChallenge(
      buildContext({
        networks: ["eip155:8453"], // Base mainnet only, no Tempo
      }),
    );

    expect(composeCalls).toHaveLength(0);
    expect(headers).toEqual({});
  });

  it("emits no compose call when payTo has no entry for the Tempo network", async () => {
    const { config, composeCalls } = buildConfig();
    const adapter = createMppAdapter(config);

    const headers = await adapter.generateChallenge(
      buildContext({
        payTo: { "eip155:8453": RECIPIENT }, // wrong network
      }),
    );

    expect(composeCalls).toHaveLength(0);
    expect(headers).toEqual({});
  });

  it("skips assets that have no Tempo address", async () => {
    const { config, composeCalls } = buildConfig();
    const adapter = createMppAdapter(config);

    const usdcBaseOnly: CustomAssetDef = {
      name: "USDC",
      addresses: {
        "eip155:8453": {
          address: "0xusdc00000000000000000000000000000000",
          decimals: 6,
        },
      },
      // No Tempo address — should be skipped.
    };

    await adapter.generateChallenge(
      buildContext({
        resolvedPrices: [
          { asset: usdcBaseOnly, amount: "$0.01" },
          { asset: PATH_USD, amount: "$0.01" },
        ],
      }),
    );

    // One entry emitted (pathUSD), USDC silently skipped.
    expect(composeCalls).toHaveLength(1);
    expect(composeCalls[0]).toHaveLength(1);
    const [, options] = composeCalls[0][0];
    expect(options.currency).toBe(PATH_USD.addresses[TEMPO_TESTNET].address);
  });
});

describe("MPP adapter — WWW-Authenticate multi-challenge", () => {
  /**
   * mppx internally `append`s one `WWW-Authenticate` per method handler,
   * then returns a Response. WHATWG `Headers.get()` coalesces those into a
   * single comma-joined string — which our adapter splits back into
   * individual challenges so the middleware emits them as distinct
   * `WWW-Authenticate` header lines. That multi-line form matches the
   * MPP spec's Appendix B.4 example:
   *
   *   WWW-Authenticate: Payment id="a", realm="…", …
   *   WWW-Authenticate: Payment id="b", realm="…", …
   */
  function buildConfigWithChallenges(wwwAuthValue: string) {
    const mppx = {
      tempo: { charge: vi.fn(() => "tempo-charge-handler") },
      compose: vi.fn(() => async () => ({
        status: 402,
        challenge: new Response(null, { headers: { "www-authenticate": wwwAuthValue } }),
      })),
    };
    return {
      secretKey: "x".repeat(64),
      realm: "test",
      mppx,
    } satisfies ResolvedMppConfig;
  }

  it("splits mppx's comma-joined output into an array so the middleware emits separate WWW-Authenticate lines", async () => {
    // REGRESSION GUARD: the MPP spec's Appendix B.4 example uses multiple
    // WWW-Authenticate header lines (one per challenge). If we regress to
    // emitting a single comma-joined header, clients that only parse the
    // first challenge would see reduced payment options.
    const compound =
      'Payment id="a", realm="test", method="tempo", intent="charge", request="A", ' +
      'Payment id="b", realm="test", method="tempo", intent="charge", request="B"';
    const adapter = createMppAdapter(buildConfigWithChallenges(compound));

    const headers = await adapter.generateChallenge({
      endpoint: { price: "$0.01", description: "multi" },
      resolvedPrices: [{ asset: PATH_USD, amount: "$0.01" }],
      networks: ["eip155:42431"],
      payTo: { "eip155:42431": "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00" },
      request: { method: "GET", path: "/x", url: "/x", headers: {}, query: {} },
    });

    const value = headers["WWW-Authenticate"];
    expect(Array.isArray(value)).toBe(true);
    expect(value).toHaveLength(2);
    expect((value as string[])[0]).toMatch(/^Payment id="a"/);
    expect((value as string[])[1]).toMatch(/^Payment id="b"/);
  });

  it("returns a single string when there's only one challenge", async () => {
    const single = 'Payment id="solo", realm="test", method="tempo", intent="charge", request="S"';
    const adapter = createMppAdapter(buildConfigWithChallenges(single));

    const headers = await adapter.generateChallenge({
      endpoint: { price: "$0.01", description: "single" },
      resolvedPrices: [{ asset: PATH_USD, amount: "$0.01" }],
      networks: ["eip155:42431"],
      payTo: { "eip155:42431": "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00" },
      request: { method: "GET", path: "/x", url: "/x", headers: {}, query: {} },
    });

    // One challenge → string, not a single-element array. Keeps the emitted
    // header count consistent with what the adapter actually received.
    expect(typeof headers["WWW-Authenticate"]).toBe("string");
    expect(headers["WWW-Authenticate"]).toBe(single);
  });
});
