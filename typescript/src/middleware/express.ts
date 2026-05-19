import type { NextFunction, Request, RequestHandler, Response } from "express";
import { AgentPayments } from "../agent-payments.js";
import type { AgentPaymentsConfig, ProcessResult200, RequestContext } from "../types.js";

export { AgentPayments } from "../agent-payments.js";
export type { AgentPaymentsConfig } from "../types.js";

/**
 * Express RequestHandler returned by {@link agentPayments}, augmented with
 * runtime control hooks. The handler still works as a drop-in middleware
 * (`app.use(agentPayments({...}))`); the extra members let callers refresh
 * the endpoint manifest dynamically and reach the underlying
 * {@link AgentPayments} instance for advanced use cases.
 */
export interface AgentPaymentsHandler extends RequestHandler {
  /** Underlying {@link AgentPayments} — exposed for tests and advanced control. */
  agentPayments: AgentPayments;
  /**
   * Re-publish the endpoint manifest to the PayAI dashboard.
   * Useful for marketplaces/CMS-style apps where routes change at runtime.
   * See {@link AgentPayments.registerEndpoints}.
   */
  registerEndpoints: (endpoints: AgentPaymentsConfig["endpoints"]) => Promise<void>;
  /**
   * Stop the managed-mode SSE event loop. Wire this into your server's
   * SIGTERM handler so the SDK doesn't leak the long-lived connection on
   * graceful shutdown. See {@link AgentPayments.shutdown}.
   */
  shutdown: () => void;
}

/**
 * Express middleware for x402 + MPP payments.
 *
 * - Unprotected routes pass through.
 * - Protected routes without valid payment return 402 with challenge headers.
 * - After verification, the downstream handler runs behind a response buffer.
 *   On a successful response (status < 400), the payment is settled and
 *   receipt headers are attached before the buffered output is flushed.
 *   On a failed response, no settlement occurs and the original output flushes.
 *
 * The buffering strategy records `[methodName, args]` tuples and replays them
 * verbatim — the same pattern used by @x402/core's Express middleware.
 */
export function agentPayments(config: AgentPaymentsConfig): AgentPaymentsHandler {
  const ap = new AgentPayments(config);

  const handler = (async (req: Request, res: Response, next: NextFunction) => {
    let result: import("../types.js").ProcessResult;
    try {
      result = await ap.processRequest(buildRequestContext(req));
    } catch (err) {
      return next(err);
    }

    if (result.status === "passthrough") return next();

    if (result.status === 402) {
      for (const [key, value] of Object.entries(result.headers)) {
        res.setHeader(key, value);
      }
      res.status(402).json({
        error: "Payment Required",
        message: "This endpoint requires payment. See response headers for payment options.",
      });
      return;
    }

    await runWithSettlement(result, req, res, next);
  }) as AgentPaymentsHandler;

  // Expose runtime controls on the handler itself. Express only ever invokes
  // the function as middleware; the additional properties let callers do:
  //   const handler = agentPayments({...});
  //   app.use(handler);
  //   await handler.registerEndpoints(newRoutes);
  handler.agentPayments = ap;
  handler.registerEndpoints = (endpoints) => ap.registerEndpoints(endpoints);
  handler.shutdown = () => ap.shutdown();

  return handler;
}

export const payai = agentPayments;

type BufferedCall =
  | ["writeHead", Parameters<Response["writeHead"]>]
  | ["write", Parameters<Response["write"]>]
  | ["end", Parameters<Response["end"]>]
  | ["flushHeaders", []];

async function runWithSettlement(
  result: ProcessResult200,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Expose payment metadata to downstream handlers
  (req as unknown as { payment: unknown }).payment = result.payment;

  const originalWriteHead = res.writeHead.bind(res);
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  const originalFlushHeaders = res.flushHeaders.bind(res);

  let buffered: BufferedCall[] = [];
  let settled = false;
  let endCalled!: () => void;
  const endPromise = new Promise<void>((resolve) => {
    endCalled = resolve;
  });

  res.writeHead = ((...args: Parameters<typeof originalWriteHead>) => {
    if (settled) return originalWriteHead(...args);
    buffered.push(["writeHead", args]);
    return res;
  }) as typeof originalWriteHead;

  res.write = ((...args: Parameters<typeof originalWrite>) => {
    if (settled) return originalWrite(...args);
    buffered.push(["write", args]);
    return true;
  }) as typeof originalWrite;

  res.end = ((...args: Parameters<typeof originalEnd>) => {
    if (settled) return originalEnd(...args);
    buffered.push(["end", args]);
    endCalled();
    return res;
  }) as typeof originalEnd;

  res.flushHeaders = () => {
    if (settled) return originalFlushHeaders();
    buffered.push(["flushHeaders", []]);
  };

  next();
  await endPromise;

  const restore = () => {
    settled = true;
    res.writeHead = originalWriteHead;
    res.write = originalWrite;
    res.end = originalEnd;
    res.flushHeaders = originalFlushHeaders;
  };

  const replay = () => {
    for (const [method, args] of buffered) {
      if (method === "writeHead")
        originalWriteHead(...(args as Parameters<typeof originalWriteHead>));
      else if (method === "write") originalWrite(...(args as Parameters<typeof originalWrite>));
      else if (method === "end") originalEnd(...(args as Parameters<typeof originalEnd>));
      else originalFlushHeaders();
    }
    buffered = [];
  };

  // Handler failed → skip settlement, flush the handler's response as-is.
  if (res.statusCode >= 400) {
    restore();
    replay();
    return;
  }

  try {
    const body = Buffer.concat(
      buffered.flatMap(([m, args]) =>
        (m === "write" || m === "end") && args[0] ? [toBuffer(args[0])] : [],
      ),
    );
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.getHeaders())) {
      if (v != null) headers[k] = String(v);
    }

    const settledResponse = await result.settleAndReceipt(
      new globalThis.Response(body, { status: res.statusCode, headers }),
    );

    // Apply settlement headers (receipt / PAYMENT-RESPONSE) onto the real response.
    // Set them via res.setHeader before replaying writeHead so they ride along.
    settledResponse.headers.forEach((value, key) => {
      if (!isContentHeader(key)) res.setHeader(key, value);
    });
  } catch (err) {
    // Settlement failed: do NOT flush the paid content.
    // Drop buffered output and return a 402 error.
    buffered = [];
    restore();
    res.status(402).json({
      error: "Settlement Failed",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  restore();
  replay();
}

function isContentHeader(key: string): boolean {
  const k = key.toLowerCase();
  return k === "content-length" || k === "content-type" || k === "transfer-encoding";
}

function toBuffer(value: unknown): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(String(value));
}

function buildRequestContext(req: Request): RequestContext {
  return {
    method: req.method,
    path: req.path,
    url: req.originalUrl || req.url,
    headers: req.headers as Record<string, string | string[] | undefined>,
    query: (req.query ?? {}) as Record<string, string>,
  };
}
