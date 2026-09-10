import { describe, expect, it, vi } from "vitest";
import { AgentPayments } from "./agent-payments.js";
import type { ProtocolAdapter } from "./protocols/types.js";
import type { CustomAssetDef, ResolvedConfig } from "./types.js";

const USDC: CustomAssetDef = {
  name: "USDC",
  addresses: {
    "eip155:84532": {
      address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      decimals: 6,
    },
  },
};

function buildResolvedConfig(): ResolvedConfig {
  return {
    endpoints: { "GET /paid": { price: "$0.01" } },
    payTo: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    networks: ["eip155:84532"],
    protocols: ["x402"],
    assetRegistry: { USDC },
    defaultAssets: ["USDC"],
    x402: null,
    mpp: null,
  };
}

function injectResolvedState(ap: AgentPayments, adapter: ProtocolAdapter): void {
  const internals = ap as unknown as {
    initPromise: Promise<void> | null;
    resolved: ResolvedConfig | null;
    adapters: Map<string, ProtocolAdapter>;
  };
  internals.initPromise = Promise.resolve();
  internals.resolved = buildResolvedConfig();
  internals.adapters = new Map([["x402", adapter]]);
}

describe("AgentPayments finalization hooks", () => {
  it("fires onPaymentSettled once when callers use finalize and settleAndReceipt", async () => {
    const onPaymentSettled = vi.fn();
    const adapter: ProtocolAdapter = {
      generateChallenge: vi.fn(async () => ({})),
      verifyAndSettle: vi.fn(async () => ({
        status: 200 as const,
        protocol: "x402" as const,
        payment: { protocol: "x402" as const },
        finalize: vi.fn(async () => ({
          headers: { "PAYMENT-RESPONSE": "receipt" },
          settled: true,
        })),
        settleAndReceipt: vi.fn(async (response: Response) => {
          response.headers.set("PAYMENT-RESPONSE", "receipt");
          return response;
        }),
      })),
    };
    const ap = new AgentPayments({
      payTo: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      endpoints: { "GET /paid": { price: "$0.01" } },
      hooks: { onPaymentSettled },
    });
    injectResolvedState(ap, adapter);

    const result = await ap.processRequest({
      method: "GET",
      path: "/paid",
      url: "/paid",
      headers: { "payment-signature": "signed" },
      query: {},
    });
    if (result.status !== 200) throw new Error("Expected verified payment");

    await result.finalize();
    await result.settleAndReceipt(new Response("ok"));

    expect(onPaymentSettled).toHaveBeenCalledTimes(1);
  });

  it("fires onPaymentFailed when finalize throws", async () => {
    const onPaymentFailed = vi.fn();
    const adapter: ProtocolAdapter = {
      generateChallenge: vi.fn(async () => ({})),
      verifyAndSettle: vi.fn(async () => ({
        status: 200 as const,
        protocol: "x402" as const,
        payment: { protocol: "x402" as const },
        finalize: vi.fn(async () => {
          throw new Error("settlement failed");
        }),
        settleAndReceipt: vi.fn(async (response: Response) => response),
      })),
    };
    const ap = new AgentPayments({
      payTo: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      endpoints: { "GET /paid": { price: "$0.01" } },
      hooks: { onPaymentFailed },
    });
    injectResolvedState(ap, adapter);

    const result = await ap.processRequest({
      method: "GET",
      path: "/paid",
      url: "/paid",
      headers: { "payment-signature": "signed" },
      query: {},
    });
    if (result.status !== 200) throw new Error("Expected verified payment");

    await expect(result.finalize()).rejects.toThrow("settlement failed");

    expect(onPaymentFailed).toHaveBeenCalledTimes(1);
    expect(onPaymentFailed.mock.calls[0][0].error).toEqual({ message: "settlement failed" });
  });
});
