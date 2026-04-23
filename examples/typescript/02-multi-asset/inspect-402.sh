#!/usr/bin/env bash
# Walk through a 402 response in four steps, decoding the x402 and MPP
# challenges so you can read them at a glance. Works against any example
# that emits both protocol headers.
#
# Usage (from this directory, while `npm start` is running):
#   ./inspect-402.sh                                  # defaults to /premium
#   URL=http://localhost:4000/weather ./inspect-402.sh
#
# Requires: curl, jq, base64. On macOS: `brew install jq`.

set -euo pipefail

URL="${URL:-http://localhost:4000/premium}"

echo
echo "══════════════════════════════════════════════════════════════"
echo "  STEP 1 · Hit a protected route with no payment"
echo "══════════════════════════════════════════════════════════════"
echo "Server returns 402 Payment Required. Two response headers carry"
echo "the two payment protocol challenges a client can use to pay:"
echo "  - PAYMENT-REQUIRED  (x402, base64 JSON)"
echo "  - WWW-Authenticate  (MPP, HTTP auth-param syntax)"
echo
echo "\$ curl -i $URL"
curl -sSi "$URL"

echo
echo
echo "══════════════════════════════════════════════════════════════"
echo "  STEP 2 · Decode the x402 PAYMENT-REQUIRED header"
echo "══════════════════════════════════════════════════════════════"
echo "Base64-encoded JSON. Each 'accepts' entry is one"
echo "(asset × network × amount) the server will accept payment in."
echo "On /premium you should see different amounts per asset because"
echo "the price is a per-asset record (USDC \$0.10, USDT \$0.12, pathUSD \$0.10)."
echo
curl -s -D - -o /dev/null "$URL" \
  | grep -i '^PAYMENT-REQUIRED:' | sed 's/^[^:]*: *//' | tr -d '\r' \
  | base64 -d | jq

echo
echo "══════════════════════════════════════════════════════════════"
echo "  STEP 3 · Show the raw MPP WWW-Authenticate header"
echo "══════════════════════════════════════════════════════════════"
echo "Standard HTTP auth-challenge syntax (RFC 9110 auth-param)."
echo "The 'request=' parameter holds the opaque payment details —"
echo "it's base64url-encoded JSON, decoded in the next step."
echo
curl -s -D - -o /dev/null "$URL" \
  | grep -i '^WWW-Authenticate:' | sed 's/^[^:]*: *//' | tr -d '\r'

echo
echo
echo "══════════════════════════════════════════════════════════════"
echo "  STEP 4 · Decode the MPP 'request' parameter"
echo "══════════════════════════════════════════════════════════════"
echo "The exact Tempo charge a client must broadcast on-chain:"
echo "  amount     - in atomic units (6 decimals for pathUSD)"
echo "  currency   - token contract address"
echo "  recipient  - payTo wallet on Tempo"
echo "  chainId    - 4217 = Tempo mainnet, 42431 = Tempo testnet"
echo
curl -s -D - -o /dev/null "$URL" \
  | grep -i '^WWW-Authenticate:' \
  | grep -oE 'request="[^"]+"' | sed 's/request="//;s/"$//' \
  | tr '_-' '/+' \
  | awk '{n=length($0); pad=(4-n%4)%4; printf "%s", $0; for(i=0;i<pad;i++) printf "="}' \
  | base64 -d | jq

echo
echo "✓ done"
