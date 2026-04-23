#!/usr/bin/env bash
# Walk through a 402 response in four steps, explaining what each
# command does and decoding the base64 / base64url payloads so you
# can see the full picture.
#
# Usage (from this directory, while `npm start` is running in another terminal):
#   ./inspect-402.sh
#   URL=http://localhost:5000/weather ./inspect-402.sh
#
# Requires: curl, jq, base64. On macOS: `brew install jq`.

set -euo pipefail

URL="${URL:-http://localhost:4000/weather}"

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
echo "Clients pick one entry and sign a payment matching it."
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
