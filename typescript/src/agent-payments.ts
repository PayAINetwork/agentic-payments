import { generateChallengeHeaders } from "./challenge.js";
import { resolveConfig } from "./config.js";
import { PayAIApiClient } from "./payai-api.js";
import { detectProtocol } from "./protocols/detection.js";
import { createMppAdapter } from "./protocols/mpp.js";
import type { ChallengeContext, ProtocolAdapter, ResolvedAssetPrice } from "./protocols/types.js";
import { createX402Adapter } from "./protocols/x402.js";
import type {
  AgentPaymentsConfig,
  CustomAssetDef,
  EndpointConfig,
  HookContext,
  ManagedApiConfig,
  PaymentMetadata,
  PayToValue,
  Price,
  PriceValue,
  ProcessResult,
  Protocol,
  RequestContext,
  ResolvedConfig,
} from "./types.js";
import { expandPayTo, matchEndpoint, resolveAssets, resolvePrice } from "./utils.js";

/**
 * Framework-agnostic payment core. Takes a {@link RequestContext}, runs it
 * through route matching → hooks → protocol detection → verification →
 * settlement wiring, and returns a {@link ProcessResult} the caller (an
 * Express middleware or any other HTTP integration) turns into a response.
 *
 * Typical flow per request:
 *
 * 1. Match the request's `method + path` against configured endpoints.
 *    No match → `{ status: "passthrough" }`, caller proceeds normally.
 * 2. Fire `onRequest` hook. If it returns `{ grant: true }`, also passthrough.
 * 3. Resolve dynamic `price`, `assets`, `payTo`, `networks`, `protocols`
 *    (endpoint values override root config; see {@link EndpointConfig}).
 * 4. Detect which protocol the client is paying with (x402 or MPP).
 *    No payment header → `{ status: 402, headers }` with challenges from
 *    every active adapter.
 * 5. Call the matching adapter's `verifyAndSettle`. Failure fires
 *    `onPaymentFailed` and returns 402.
 * 6. Fire `onPaymentVerified`. A `{ reject: true }` return short-circuits to 402.
 * 7. Wrap the returned `settleAndReceipt` so `onPaymentSettled` /
 *    `onPaymentFailed` fire after the caller invokes it. Return
 *    `{ status: 200, protocol, payment, settleAndReceipt }`.
 *
 * @example
 * // Direct usage (no framework) — handy for Lambda / edge runtimes.
 * const ap = new AgentPayments({ payTo: "0x...", endpoints: { ... } });
 * const result = await ap.processRequest(requestContext);
 * if (result.status === 402) return new Response(null, { status: 402, headers: result.headers });
 * // Run your handler logic to produce a response object, then pass it to
 * // settleAndReceipt. Settlement (x402 facilitator call / MPP receipt
 * // attachment) happens inside that call — before the response reaches the
 * // client. Return the settled response; do not send anything beforehand.
 * const myResponse = await runHandler(requestContext);
 * return result.settleAndReceipt(myResponse);
 */
export class AgentPayments {
  private readonly config: AgentPaymentsConfig;
  private resolved: ResolvedConfig | null = null;
  private readonly adapters = new Map<Protocol, ProtocolAdapter>();
  private initPromise: Promise<void> | null = null;
  private managedClient: PayAIApiClient | null = null;

  /**
   * Construction is intentionally cheap and never throws. Validation and
   * normalization happen lazily on the first `processRequest`.
   *
   * **Manual mode** (`config.apiKey` unset): construction does no I/O at all.
   * Filesystem touches (auto-generating `.payai/mpp-secret`) and adapter
   * setup are deferred until the first request goes through `ensureInitialized`.
   *
   * **Managed mode** (`config.apiKey` set): construction kicks off
   * `ensureInitialized` in the background to warm the SDK config (one
   * `POST /api/v1/sdk/init` to PayAI, plus an MPP secret resolution that
   * may read or write `.payai/mpp-secret`). The first incoming request
   * awaits the same promise, so init failures don't surface here — they
   * surface at the first protected request that needs the resolved config.
   * On startup-time init failure we log a warning and let the next request
   * retry; permanent failures (bad credentials, etc.) will be reported then.
   *
   * @param config - User-facing configuration. See {@link AgentPaymentsConfig}.
   */
  constructor(config: AgentPaymentsConfig) {
    this.config = config;
    if (config.apiKey) {
      void this.ensureInitialized().catch((error) => {
        console.warn(
          "[@payai/agentic-payments] Managed mode init failed - the SDK will retry on the next incoming request. " +
            "Check PAYAI_KEY_ID / PAYAI_SK and network connectivity to the PayAI API.",
          error,
        );
      });
    }
  }

  /**
   * Idempotent init — all concurrent first requests share the same
   * initialization promise, so we never race on `resolveConfig` or
   * double-create protocol adapters.
   */
  private ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.initialize().catch((error) => {
        this.initPromise = null;
        throw error;
      });
    }
    return this.initPromise;
  }

  /**
   * One-shot initialization: normalize user config into {@link ResolvedConfig}
   * and instantiate protocol adapters for every enabled protocol.
   */
  private async initialize(): Promise<void> {
    if (this.config.apiKey) {
      this.managedClient = new PayAIApiClient({
        apiKey: this.config.apiKey,
        baseUrl: this.config.payaiApiBaseUrl,
        appUrl: this.config.appUrl,
        onConfigChanged: (managedConfig) => this.applyResolvedConfig(managedConfig),
      });
      await this.managedClient.init(this.config);
      this.managedClient.startEvents();
      return;
    }

    await this.applyResolvedConfig();
  }

  private async applyResolvedConfig(managedConfig?: ManagedApiConfig): Promise<void> {
    const resolved = await resolveConfig(this.config, { managedConfig });
    this.resolved = resolved;
    this.adapters.clear();
    if (resolved.x402) this.adapters.set("x402", createX402Adapter(resolved.x402));
    if (resolved.mpp) this.adapters.set("mpp", createMppAdapter(resolved.mpp));
  }

  /**
   * Re-publish the SDK's endpoint manifest to the PayAI dashboard.
   *
   * Use this when your set of protected routes changes at runtime — e.g.
   * a marketplace where merchants add new products, a multi-tenant app
   * where each tenant exposes its own endpoints, or a CMS-driven API.
   *
   * The new map fully replaces the previously registered endpoints (the
   * portal's stale-endpoint pruning takes care of removing routes that
   * disappear from the latest call). Pass through any other config fields
   * you want to update at the same time; otherwise the original config
   * supplied at construction is reused.
   *
   * Only effective in managed mode (when `apiKey` is set). In manual mode
   * this is a no-op, since there is no dashboard to push to.
   *
   * Unlike the constructor, this method **awaits and throws** on failure —
   * wrap it in try/catch (or attach a `.catch`) at the call site so a
   * dashboard hiccup doesn't take down a periodic refresh task.
   *
   * @example
   * const handler = agentPayments({ apiKey, endpoints: initial });
   * app.use(handler);
   *
   * setInterval(async () => {
   *   const endpoints = await loadEndpointsFromDb();
   *   try {
   *     await handler.registerEndpoints(endpoints);
   *   } catch (err) {
   *     console.error("registerEndpoints failed", err);
   *   }
   * }, 60_000);
   */
  async registerEndpoints(endpoints: AgentPaymentsConfig["endpoints"]): Promise<void> {
    this.config.endpoints = endpoints;
    await this.ensureInitialized();
    if (this.managedClient) {
      await this.managedClient.registerEndpoints(this.config);
    }
  }

  /**
   * Stop the managed-mode SSE event loop and release the underlying API
   * client. Idempotent and safe to call from `process.on("SIGTERM", …)` or
   * a Node graceful-shutdown handler.
   *
   * In manual mode this is a no-op (no managed client was ever created).
   * In managed mode it aborts the long-running `/api/v1/sdk/events` fetch
   * so the SDK doesn't leak an SSE connection across server restarts. The
   * AgentPayments instance keeps working for in-flight requests; the next
   * `processRequest` call after `shutdown()` will re-init (and reconnect
   * the event loop) lazily.
   *
   * @example
   * const handler = agentPayments({ apiKey, endpoints });
   * process.on("SIGTERM", () => handler.shutdown());
   */
  shutdown(): void {
    this.managedClient?.stopEvents();
  }

  /**
   * Process a single inbound request. See the class-level JSDoc for the
   * full 7-step flow. The return value tells the caller what to do next:
   *
   * - `{ status: "passthrough" }` — not a protected route (or a hook granted
   *   free access). Run the handler normally without attaching receipts.
   * - `{ status: 402, headers }` — client must pay. Emit headers verbatim
   *   (some values are arrays for multiple header instances — the caller's
   *   header-setter must handle both).
   * - `{ status: 200, protocol, payment, settleAndReceipt }` — payment
   *   verified. Run your handler, then call `settleAndReceipt(response)`
   *   to finalize settlement (x402) or attach a receipt (MPP).
   *
   * @param request - Normalized request context. Your framework middleware is
   *   responsible for building this from the native request object.
   */
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
    const resolvedPrice = await resolvePrice(requireResolvedPrice(endpoint.price), request);
    const resolvedAssets = resolveAssets(
      resolvedPrice,
      endpoint.assets,
      resolved.assetRegistry,
      resolved.defaultAssets,
    );
    const resolvedPrices = buildResolvedPrices(resolvedPrice, resolvedAssets);

    const rawPayTo = endpoint.payTo ?? resolved.payTo;
    const payToValue = typeof rawPayTo === "function" ? await rawPayTo(request) : rawPayTo;
    const payTo = expandPayTo(payToValue as PayToValue, !resolved.live);

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

function requireResolvedPrice(price: EndpointConfig["price"]): Price {
  if (price === undefined) {
    throw new Error("Resolved endpoint is missing a price.");
  }

  return price;
}

/**
 * Build a {@link HookContext} for passing to user-provided hooks.
 * Keeps the `error` field off the object entirely when not present so
 * the in-hook `if (ctx.error)` check reads cleanly.
 */
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

/**
 * Run a lifecycle hook if configured. Errors thrown inside a hook are
 * swallowed — hooks are advisory observability/policy bolts and MUST NOT
 * be able to break the payment flow. If a hook throws, the payment
 * continues as if the hook wasn't there.
 */
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

/**
 * Cross the price-shape gap: both a string price and a per-asset price
 * record get flattened to `{ asset, amount }[]` for adapters.
 *
 * - String price → same amount for every resolved asset.
 * - Record price → pick each asset's amount by `asset.name`. Throws if
 *   the record is missing an entry for a resolved asset, since that means
 *   the caller's `assets` and `price` keys disagree (a config bug, not a
 *   request-time failure we want to paper over with silent defaults).
 */
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
