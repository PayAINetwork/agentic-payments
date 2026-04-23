import { generateChallengeHeaders } from "./challenge.js";
import { resolveConfig } from "./config.js";
import { detectProtocol } from "./protocols/detection.js";
import { createMppAdapter } from "./protocols/mpp.js";
import type { ChallengeContext, ProtocolAdapter, ResolvedAssetPrice } from "./protocols/types.js";
import { createX402Adapter } from "./protocols/x402.js";
import type {
  AgentPaymentsConfig,
  CustomAssetDef,
  EndpointConfig,
  HookContext,
  PaymentMetadata,
  PayToValue,
  PriceValue,
  ProcessResult,
  Protocol,
  RequestContext,
  ResolvedConfig,
} from "./types.js";
import { expandPayTo, matchEndpoint, resolveAssets, resolvePrice } from "./utils.js";

export class AgentPayments {
  private readonly config: AgentPaymentsConfig;
  private resolved: ResolvedConfig | null = null;
  private readonly adapters = new Map<Protocol, ProtocolAdapter>();
  private initPromise: Promise<void> | null = null;

  constructor(config: AgentPaymentsConfig) {
    this.config = config;
  }

  private ensureInitialized(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.initialize();
    return this.initPromise;
  }

  private async initialize(): Promise<void> {
    const resolved = await resolveConfig(this.config);
    this.resolved = resolved;
    if (resolved.x402) this.adapters.set("x402", createX402Adapter(resolved.x402));
    if (resolved.mpp) this.adapters.set("mpp", createMppAdapter(resolved.mpp));
  }

  async processRequest(request: RequestContext): Promise<ProcessResult> {
    await this.ensureInitialized();
    const resolved = this.resolved as ResolvedConfig;
    const hooks = this.config.hooks;

    // --- Route matching ---
    const endpoint = matchEndpoint(request.method, request.path, resolved.endpoints);
    if (!endpoint) return { status: "passthrough" };

    // --- onRequest hook: may grant free access ---
    if (hooks?.onRequest) {
      const granted = await hooks.onRequest(buildHookContext(request, endpoint));
      if (granted?.grant) return { status: "passthrough" };
    }

    // --- Resolve per-request dynamics ---
    const resolvedPrice = await resolvePrice(endpoint.price, request);
    const resolvedAssets = resolveAssets(
      resolvedPrice,
      endpoint.assets,
      resolved.assetRegistry,
      resolved.defaultAssets,
    );
    const resolvedPrices = buildResolvedPrices(resolvedPrice, resolvedAssets);

    const rawPayTo = endpoint.payTo ?? resolved.payTo;
    const payToValue = typeof rawPayTo === "function" ? await rawPayTo(request) : rawPayTo;
    const payTo = expandPayTo(payToValue as PayToValue, !(this.config.live ?? false));

    const networks = endpoint.networks ?? resolved.networks;

    // Active adapters: intersect enabled adapters with any endpoint-level protocol restriction.
    const activeProtocols = endpoint.protocols
      ? resolved.protocols.filter((p) => endpoint.protocols?.includes(p))
      : resolved.protocols;
    const activeAdapters = activeProtocols
      .map((p) => this.adapters.get(p))
      .filter((a): a is ProtocolAdapter => a !== undefined);

    const ctx: ChallengeContext = { endpoint, resolvedPrices, networks, payTo, request };

    // --- No payment header: challenge ---
    const detected = detectProtocol(request.headers);
    if (!detected) {
      return { status: 402, headers: await generateChallengeHeaders(activeAdapters, ctx) };
    }

    // --- Wrong / unsupported protocol: re-challenge ---
    const adapter = this.adapters.get(detected.protocol);
    if (!adapter || !activeProtocols.includes(detected.protocol)) {
      return { status: 402, headers: await generateChallengeHeaders(activeAdapters, ctx) };
    }

    // --- Verify payment ---
    const result = await adapter.verifyAndSettle(detected.headerValue, ctx);

    if (result.status === 402) {
      await runHook(hooks?.onPaymentFailed, () =>
        buildHookContext(
          request,
          endpoint,
          { protocol: detected.protocol },
          {
            message: "Payment verification failed",
          },
        ),
      );
      return result;
    }

    // --- onPaymentVerified hook: may reject ---
    if (hooks?.onPaymentVerified) {
      const rejected = await hooks.onPaymentVerified(
        buildHookContext(request, endpoint, result.payment),
      );
      if (rejected?.reject) {
        return { status: 402, headers: await generateChallengeHeaders(activeAdapters, ctx) };
      }
    }

    // Wrap settleAndReceipt to fire onPaymentSettled / onPaymentFailed.
    const inner = result.settleAndReceipt.bind(result);
    result.settleAndReceipt = async (response: Response) => {
      try {
        const settled = await inner(response);
        await runHook(hooks?.onPaymentSettled, () =>
          buildHookContext(request, endpoint, result.payment),
        );
        return settled;
      } catch (err) {
        await runHook(hooks?.onPaymentFailed, () =>
          buildHookContext(request, endpoint, result.payment, {
            message: err instanceof Error ? err.message : String(err),
          }),
        );
        throw err;
      }
    };

    return result;
  }
}

function buildHookContext(
  request: RequestContext,
  endpoint: EndpointConfig,
  payment: Partial<PaymentMetadata> = {},
  error?: HookContext["error"],
): HookContext {
  return {
    request,
    endpoint,
    payment,
    ...(error ? { error } : {}),
  };
}

async function runHook<T>(
  hook: ((ctx: HookContext) => T | Promise<T>) | undefined,
  buildCtx: () => HookContext,
): Promise<void> {
  if (!hook) return;
  try {
    await hook(buildCtx());
  } catch {
    // Hook errors are never surfaced — they're advisory only.
  }
}

function buildResolvedPrices(
  resolvedPrice: PriceValue,
  assets: CustomAssetDef[],
): ResolvedAssetPrice[] {
  if (typeof resolvedPrice === "string") {
    return assets.map((asset) => ({ asset, amount: resolvedPrice }));
  }
  return assets.map((asset) => {
    const amount = resolvedPrice[asset.name];
    if (amount === undefined) {
      throw new Error(
        `Missing price for asset "${asset.name}" in price record. ` +
          `Either add an entry for it or remove it from the assets list.`,
      );
    }
    return { asset, amount };
  });
}
