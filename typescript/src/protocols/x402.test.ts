import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { describe, expect, it, vi } from "vitest";
import type { CustomAssetDef, ResolvedX402Config } from "../types.js";
import type { ChallengeContext } from "./types.js";
import { type CreateX402AdapterDeps, createX402Adapter } from "./x402.js";

type X402Facilitator = NonNullable<CreateX402AdapterDeps["facilitator"]>;

/**
 * Build a stub facilitator client whose `getSupported()` returns the given
 * kinds. `verify` and `settle` are unused in generate-challenge tests and
 * throw if accidentally called — keeps tests honest about their scope.
 */
function stubFacilitator(
  kinds: Array<{ scheme: string; network: string; extra?: Record<string, unknown> }> = [],
): CreateX402AdapterDeps["facilitator"] {
  return {
    getSupported: vi.fn(async () => ({
      kinds: kinds.map((k) => ({ x402Version: 2, ...k })),
    })),
    verify: vi.fn(async () => {
      throw new Error("verify should not be called in this test");
    }),
    settle: vi.fn(async () => {
      throw new Error("settle should not be called in this test");
    }),
  } as NonNullable<CreateX402AdapterDeps["facilitator"]>;
}

const CONFIG: ResolvedX402Config = {
  facilitatorUrl: "https://facilitator.payai.network",
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

const RECIPIENT = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

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

/**
 * Narrow PAYMENT-REQUIRED from the widened `string | string[]` Record. The
 * x402 adapter always emits a single string for this header (base64 JSON),
 * so any array would be a regression — throw fast with a descriptive
 * message instead of carrying a `!` non-null assertion through the tests.
 */
function requirePaymentRequired(headers: Record<string, string | string[]>): string {
  const value = headers["PAYMENT-REQUIRED"];
  if (value === undefined) {
    throw new Error("Expected PAYMENT-REQUIRED header to be present");
  }
  if (Array.isArray(value)) {
    throw new Error("Expected PAYMENT-REQUIRED to be a single string, got array");
  }
  return value;
}

/** Helper — run generateChallenge and return the decoded PAYMENT-REQUIRED. */
async function decode(ctx: ChallengeContext) {
  const adapter = createX402Adapter(CONFIG, { facilitator: stubFacilitator() });
  const headers = await adapter.generateChallenge(ctx);
  if (headers["PAYMENT-REQUIRED"] === undefined) return null;
  return decodePaymentRequiredHeader(requirePaymentRequired(headers));
}

describe("x402 adapter — generateChallenge", () => {
  it("emits a base64 PAYMENT-REQUIRED header when prices resolve", async () => {
    const adapter = createX402Adapter(CONFIG, { facilitator: stubFacilitator() });
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

  it("builds one accepts entry per (scheme × asset × network) combination", async () => {
    // scheme is fixed to config.scheme — all entries share it. If multi-scheme
    // support is added, config.scheme would become an array and each scheme
    // would get its own entry per (asset × network).
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

    // Every entry carries the configured scheme.
    expect(usdcEntry?.scheme).toBe(CONFIG.scheme);
    expect(pathEntry?.scheme).toBe(CONFIG.scheme);
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
    const adapter = createX402Adapter(CONFIG, { facilitator: stubFacilitator() });
    const headers = await adapter.generateChallenge(
      buildContext({
        networks: ["eip155:8453"], // Base mainnet — USDC has no address for it in our test setup
        payTo: { "eip155:8453": RECIPIENT },
      }),
    );
    expect(headers).toEqual({});
  });

  it("uses the configured scheme for every entry", async () => {
    const adapter = createX402Adapter(
      { ...CONFIG, scheme: "custom-scheme" },
      { facilitator: stubFacilitator() },
    );
    const headers = await adapter.generateChallenge(buildContext());
    const decoded = decodePaymentRequiredHeader(requirePaymentRequired(headers));
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

  it("emits Solana feePayer (no EIP-712) in extra for Solana networks", async () => {
    // Solana x402 payments don't use EIP-712, so `extra` skips name/version.
    // But PayAI's facilitator requires `extra.feePayer` on Solana entries so
    // the client knows which address will pay SOL fees for the transaction.
    // The value comes from NETWORK_X402_EXTRA in assets.ts (sourced from
    // facilitator's /kinds endpoint).
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
    // Facilitator declares the Solana feePayer via /supported. Adapter reads it.
    const facilitator = stubFacilitator([
      {
        scheme: "exact",
        network: SOLANA_NET,
        extra: { feePayer: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4" },
      },
    ]);
    const adapter = createX402Adapter(
      { ...CONFIG, supportedNetworks: [SOLANA_NET] },
      { facilitator },
    );
    const headers = await adapter.generateChallenge(
      buildContext({
        resolvedPrices: [{ asset: USDC_SVM, amount: "$0.01" }],
        networks: [SOLANA_NET],
        payTo: { [SOLANA_NET]: "ExamP1eWaLLet1111111111111111111111111111111" },
      }),
    );
    const decoded = decodePaymentRequiredHeader(requirePaymentRequired(headers));
    expect(decoded.accepts[0].extra).toEqual({
      feePayer: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4",
    });
    // No EIP-712 fields on Solana.
    expect(decoded.accepts[0].extra).not.toHaveProperty("name");
    expect(decoded.accepts[0].extra).not.toHaveProperty("version");
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
    const adapter = createX402Adapter(
      {
        ...CONFIG,
        supportedNetworks: ["eip155:2368"],
      },
      { facilitator: stubFacilitator() },
    );
    const headers = await adapter.generateChallenge(
      buildContext({
        resolvedPrices: [{ asset: PIE, amount: "$0.01" }],
        networks: ["eip155:2368"],
        payTo: { "eip155:2368": RECIPIENT },
      }),
    );
    const decoded = decodePaymentRequiredHeader(requirePaymentRequired(headers));
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
    const adapter = createX402Adapter(narrowConfig, { facilitator: stubFacilitator() });
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
    const decoded = decodePaymentRequiredHeader(requirePaymentRequired(headers));
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

describe("x402 adapter — verifyAndSettle requirements validation", () => {
  /**
   * Build a PAYMENT-SIGNATURE header containing arbitrary `accepted`
   * requirements. Used to exercise the server-side validation of what
   * the client claims its payment is for.
   */
  function signatureHeaderWithAccepted(accepted: Record<string, unknown>) {
    // Minimal signed-permit-ish payload. The facilitator would normally
    // verify this against `accepted`, but our validation rejects the
    // request before we ever call the facilitator when accepted doesn't
    // match our own advertised requirements, so the payload contents
    // don't matter for the tests below.
    const payload = {
      x402Version: 2,
      accepted,
      payload: { signature: "0xdeadbeef", authorization: {} },
    } as unknown as Parameters<typeof encodePaymentSignatureHeader>[0];
    return encodePaymentSignatureHeader(payload);
  }

  const ctx = buildContext({
    resolvedPrices: [{ asset: USDC, amount: "$0.01" }],
    networks: ["eip155:84532"],
    payTo: { "eip155:84532": RECIPIENT },
  });

  it("rejects a PAYMENT-SIGNATURE whose `accepted.payTo` doesn't match any server entry", async () => {
    // REGRESSION GUARD (payment bypass). An attacker could craft a
    // PAYMENT-SIGNATURE with `accepted.payTo = <attacker address>` and
    // self-sign a dust payment to their own wallet. If we forwarded
    // paymentPayload.accepted directly to facilitator.verify/settle,
    // the facilitator would accept it (signature matches requirements)
    // and the server would serve the paid content. The adapter MUST
    // rebuild its own accepts array and only accept a client echo that
    // matches one of our entries byte-for-byte.
    const adapter = createX402Adapter(CONFIG, { facilitator: stubFacilitator() });
    const header = signatureHeaderWithAccepted({
      scheme: "exact",
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      amount: "10000",
      payTo: "0xBAD0000000000000000000000000000000000000", // ← attacker-chosen
      maxTimeoutSeconds: 300,
      extra: { name: "USDC", version: "2" },
    });
    const result = await adapter.verifyAndSettle(header, ctx);
    expect(result.status).toBe(402);
  });

  it("rejects when the network is not one we advertised", async () => {
    const adapter = createX402Adapter(CONFIG, { facilitator: stubFacilitator() });
    const header = signatureHeaderWithAccepted({
      scheme: "exact",
      network: "eip155:137", // mainnet Polygon — not in the testnet ctx
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      amount: "10000",
      payTo: RECIPIENT,
      maxTimeoutSeconds: 300,
      extra: { name: "USDC", version: "2" },
    });
    const result = await adapter.verifyAndSettle(header, ctx);
    expect(result.status).toBe(402);
  });

  it("rejects when the amount is smaller than what the server quoted", async () => {
    const adapter = createX402Adapter(CONFIG, { facilitator: stubFacilitator() });
    const header = signatureHeaderWithAccepted({
      scheme: "exact",
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      amount: "1", // ← dust, vs. server's "10000"
      payTo: RECIPIENT,
      maxTimeoutSeconds: 300,
      extra: { name: "USDC", version: "2" },
    });
    const result = await adapter.verifyAndSettle(header, ctx);
    expect(result.status).toBe(402);
  });

  it("rejects when the extra.name (EIP-712 domain) is spoofed", async () => {
    // If the client signs against the wrong EIP-712 domain, the resulting
    // signature is valid for *that* domain — but not for the one the
    // server is actually expecting. Let the validation catch it.
    const adapter = createX402Adapter(CONFIG, { facilitator: stubFacilitator() });
    const header = signatureHeaderWithAccepted({
      scheme: "exact",
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      amount: "10000",
      payTo: RECIPIENT,
      maxTimeoutSeconds: 300,
      extra: { name: "Not USDC", version: "2" },
    });
    const result = await adapter.verifyAndSettle(header, ctx);
    expect(result.status).toBe(402);
  });

  it("rejects a malformed PAYMENT-SIGNATURE header outright", async () => {
    const adapter = createX402Adapter(CONFIG, { facilitator: stubFacilitator() });
    const result = await adapter.verifyAndSettle("not-a-real-header", ctx);
    expect(result.status).toBe(402);
  });
});

describe("x402 adapter — finalization", () => {
  async function signatureForServerAccepts(
    adapter: ReturnType<typeof createX402Adapter>,
    ctx: ChallengeContext,
  ): Promise<string> {
    const headers = await adapter.generateChallenge(ctx);
    const required = decodePaymentRequiredHeader(requirePaymentRequired(headers));
    return encodePaymentSignatureHeader({
      x402Version: 2,
      accepted: required.accepts[0],
      payload: { signature: "0xdeadbeef", authorization: {} },
    });
  }

  function payableFacilitator(
    settle: X402Facilitator["settle"] = vi.fn(
      async () =>
        ({
          success: true,
          payer: "0xpayer",
          transaction: "0xsettled",
          network: "eip155:84532",
        }) as Awaited<ReturnType<X402Facilitator["settle"]>>,
    ),
  ): X402Facilitator {
    return {
      getSupported: vi.fn(async () => ({ kinds: [] })),
      verify: vi.fn(async () => ({ isValid: true, payer: "0xpayer" })),
      settle,
    } as X402Facilitator;
  }

  it("finalize settles payment and returns a PAYMENT-RESPONSE header", async () => {
    const facilitator = payableFacilitator();
    const adapter = createX402Adapter(CONFIG, { facilitator });
    const ctx = buildContext();
    const header = await signatureForServerAccepts(adapter, ctx);

    const result = await adapter.verifyAndSettle(header, ctx);
    if (result.status !== 200) throw new Error("Expected verified payment");

    const finalized = await result.finalize();

    expect(finalized.settled).toBe(true);
    expect(Object.keys(finalized.headers)).toEqual(["PAYMENT-RESPONSE"]);
    expect(decodePaymentResponseHeader(finalized.headers["PAYMENT-RESPONSE"])).toMatchObject({
      success: true,
      transaction: "0xsettled",
      network: "eip155:84532",
    });
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it("shares one settlement between finalize and settleAndReceipt", async () => {
    const facilitator = payableFacilitator();
    const adapter = createX402Adapter(CONFIG, { facilitator });
    const ctx = buildContext();
    const header = await signatureForServerAccepts(adapter, ctx);

    const result = await adapter.verifyAndSettle(header, ctx);
    if (result.status !== 200) throw new Error("Expected verified payment");

    const finalized = await result.finalize();
    const response = await result.settleAndReceipt(new Response("ok"));

    expect(response.headers.get("PAYMENT-RESPONSE")).toBe(finalized.headers["PAYMENT-RESPONSE"]);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it("throws SettlementError when finalize receives a failed settlement", async () => {
    const facilitator = payableFacilitator(
      vi.fn(async () => ({
        success: false,
        errorReason: "insufficient funds",
        transaction: "",
        network: "eip155:84532",
      })) as X402Facilitator["settle"],
    );
    const adapter = createX402Adapter(CONFIG, { facilitator });
    const ctx = buildContext();
    const header = await signatureForServerAccepts(adapter, ctx);

    const result = await adapter.verifyAndSettle(header, ctx);
    if (result.status !== 200) throw new Error("Expected verified payment");

    await expect(result.finalize()).rejects.toThrow("insufficient funds");
  });
});
