// TODO: Implement protocol detection from request headers
// See PLAN.md for design

import type { Protocol } from "../types.js";

export interface DetectedPayment {
  protocol: Protocol;
  headerValue: string;
}

/**
 * Inspects request headers to determine which payment protocol is being used.
 *
 * x402: PAYMENT-SIGNATURE header
 * MPP:  Authorization: Payment ... header
 */
export function detectProtocol(
  _headers: Record<string, string | string[] | undefined>,
): DetectedPayment | null {
  // TODO
  return null;
}
