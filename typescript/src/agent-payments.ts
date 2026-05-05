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

  /**
   * @param config - User-facing configuration. Validated + normalized lazily
   *   on the first `processRequest` call so construction itself never throws,
   *   never touches the filesystem, and never blocks on network work (e.g.
   *   the managed-mode API client, once implemented).
   */
  constructor(config: AgentPaymentsConfig) {
    this.config = config;
  }

  /**
   * Idempotent init — all concurrent first requests share the same
   * initialization promise, so we never race on `resolveConfig` or
   * double-create protocol adapters.
   */
  private ensureInitialized(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.initialize();
    return this.initPromise;
  }

  /**
   * One-shot initialization: normalize user config into {@link ResolvedConfig}
   * and instantiate protocol adapters for every enabled protocol.
   */
  private async initialize(): Promise<void> {
    const resolved = await resolveConfig(this.config);
    this.resolved = resolved;
    if (resolved.x402) this.adapters.set("x402", createX402Adapter(resolved.x402));
    if (resolved.mpp) this.adapters.set("mpp", createMppAdapter(resolved.mpp));
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
