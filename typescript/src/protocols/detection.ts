import type { Protocol } from "../types.js";

export interface DetectedPayment {
  protocol: Protocol;
  headerValue: string;
}

/**
 * Inspects request headers to determine which payment protocol is being used.
 *
 * x402: PAYMENT-SIGNATURE header (base64 PaymentPayload)
 * MPP:  Authorization: Payment ... header (base64url Credential)
 */
export function detectProtocol(
  headers: Record<string, string | string[] | undefined>,
): DetectedPayment | null {
  // x402: check for PAYMENT-SIGNATURE header (case-insensitive)
  const paymentSig = getHeader(headers, "payment-signature");
  if (paymentSig) {
    return { protocol: "x402", headerValue: paymentSig };
  }

  // MPP: check for Authorization: Payment ... header
  const auth = getHeader(headers, "authorization");
  if (auth?.startsWith("Payment ")) {
    return { protocol: "mpp", headerValue: auth.slice("Payment ".length) };
  }

  return null;
}

/** Get a header value as a single string, case-insensitive. */
function getHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  // Try exact, then lowercase (Express normalizes to lowercase)
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}
