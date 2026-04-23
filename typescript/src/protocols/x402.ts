import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  HTTPFacilitatorClient,
} from "@x402/core/http";
import { SettlementError, VerificationError } from "../errors.js";
import type { ProcessResult200, ProcessResult402, ResolvedX402Config } from "../types.js";
import { getAssetNetworkInfo, toAtomicUnits } from "../utils.js";
import type { ChallengeContext, ProtocolAdapter } from "./types.js";

export function createX402Adapter(config: ResolvedX402Config): ProtocolAdapter {
  const facilitator = new HTTPFacilitatorClient({
    url: config.facilitatorUrl,
  });
  const supported = new Set(config.supportedNetworks);

  return {
    async generateChallenge(ctx: ChallengeContext): Promise<Record<string, string>> {
      // Build accepts array: one entry per asset × network combination,
      // restricted to networks the facilitator can actually settle on.
      const accepts: Array<{
        scheme: string;
        network: `${string}:${string}`;
        asset: string;
        amount: string;
        payTo: string;
        maxTimeoutSeconds: number;
        extra: Record<string, unknown>;
      }> = [];

      for (const { asset, amount } of ctx.resolvedPrices) {
        for (const network of ctx.networks) {
          if (!supported.has(network)) continue;
          const info = getAssetNetworkInfo(asset, network);
          const payToAddress = ctx.payTo[network];

          // Skip combinations where the asset or payTo isn't available on this network
          if (!info || !payToAddress) continue;

          // EIP-712 metadata only applies to EVM networks. Solana x402 payments
          // don't use EIP-712, so omit extra for solana:* to keep the response clean.
          const isEvm = network.startsWith("eip155:");
          const extra: Record<string, unknown> = isEvm
            ? { name: info.eip712Name, version: info.eip712Version }
            : {};

          accepts.push({
            scheme: config.scheme,
            network: network as `${string}:${string}`,
            asset: info.address,
            amount: toAtomicUnits(amount, info.decimals),
            payTo: payToAddress,
            maxTimeoutSeconds: 300,
            extra,
          });
        }
      }

      if (accepts.length === 0) {
        return {};
      }

      const paymentRequired = {
        x402Version: 2,
        resource: {
          url: ctx.request.url,
          description: ctx.endpoint.description,
        },
        accepts,
      };

      const encoded = encodePaymentRequiredHeader(paymentRequired);
      return { "PAYMENT-REQUIRED": encoded };
    },

    async verifyAndSettle(
      headerValue: string,
      ctx: ChallengeContext,
    ): Promise<ProcessResult200 | ProcessResult402> {
      let paymentPayload: ReturnType<typeof decodePaymentSignatureHeader>;
      try {
        paymentPayload = decodePaymentSignatureHeader(headerValue);
      } catch {
        return {
          status: 402,
          headers: await this.generateChallenge(ctx),
        } as ProcessResult402;
      }

      const requirements = paymentPayload.accepted;

      // Verify with facilitator
      let verifyResponse: Awaited<ReturnType<typeof facilitator.verify>>;
      try {
        verifyResponse = await facilitator.verify(paymentPayload, requirements);
      } catch (err) {
        throw new VerificationError(
          "x402",
          `Facilitator verify failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (!verifyResponse.isValid) {
        return {
          status: 402,
          headers: await this.generateChallenge(ctx),
        } as ProcessResult402;
      }

      // Return result with deferred settlement
      // x402 settles AFTER the handler succeeds (response buffering)
      return {
        status: 200,
        protocol: "x402",
        payment: {
          protocol: "x402",
          payer: verifyResponse.payer,
          network: requirements.network,
          asset: requirements.asset,
          amount: requirements.amount,
        },
        async settleAndReceipt(response: Response): Promise<Response> {
          let settleResponse: Awaited<ReturnType<typeof facilitator.settle>>;
          try {
            settleResponse = await facilitator.settle(paymentPayload, requirements);
          } catch (err) {
            throw new SettlementError(
              "x402",
              `Facilitator settle failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }

          if (!settleResponse.success) {
            throw new SettlementError(
              "x402",
              settleResponse.errorMessage ?? settleResponse.errorReason ?? "Settlement failed",
            );
          }

          // Clone response and add settlement header
          const headers = new Headers(response.headers);
          headers.set("PAYMENT-RESPONSE", encodePaymentResponseHeader(settleResponse));

          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        },
      } as ProcessResult200;
    },
  };
}
