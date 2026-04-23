#!/usr/bin/env bash
# Walk through a 402 response in four steps, decoding the x402 and MPP
# challenges so you can see the cross-chain accepts array end-to-end.
#
# Usage (from this directory, while `npm start` is running):
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
echo "Base64-encoded JSON. Expect multiple 'accepts' entries spanning"
echo "Base, Solana, and other PayAI-supported EVM networks — one per"
echo "(asset × network) the server can take payment on."
echo
curl -s -D - -o /dev/null "$URL" \
  | grep -i '^PAYMENT-REQUIRED:' | sed 's/^[^:]*: *//' | tr -d '\r' \
  | base64 -d | jq

echo
echo "══════════════════════════════════════════════════════════════"
echo "  STEP 3 · Show the raw MPP WWW-Authenticate header"
echo "══════════════════════════════════════════════════════════════"
echo "MPP is Tempo-specific — this challenge covers Tempo only even"
echo "though x402 above covers multiple chains. Standard auth-param"
echo "syntax; the 'request=' parameter is base64url JSON (next step)."
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
