#!/usr/bin/env bash
# Walk through the dynamic-pricing 402 responses in four steps.
# Compares /translate at two tiers and /marketplace for two sellers
# so you can see the `amount` and `payTo` change per request.
#
# Usage (from this directory, while `npm start` is running):
#   ./inspect-402.sh
#
# Requires: curl, jq, base64. On macOS: `brew install jq`.

set -euo pipefail

BASE="${BASE:-http://localhost:4000}"

echo
echo "══════════════════════════════════════════════════════════════"
echo "  STEP 1 · POST /translate?tier=basic  →  \$0.03"
echo "══════════════════════════════════════════════════════════════"
echo "Price is a function of ctx.query.tier. Basic tier is cheaper."
echo "Decoded x402 entries — look at 'amount': expect 30000 (6 decimals of \$0.03)."
echo
curl -s -D - -o /dev/null -X POST "$BASE/translate?tier=basic" \
  | grep -i '^PAYMENT-REQUIRED:' | sed 's/^[^:]*: *//' | tr -d '\r' \
  | base64 -d | jq '.accepts[] | {network, amount, payTo}'

echo
echo "══════════════════════════════════════════════════════════════"
echo "  STEP 2 · POST /translate?tier=pro  →  \$0.10"
echo "══════════════════════════════════════════════════════════════"
echo "Same endpoint, different tier. 'amount' jumps to 100000."
echo "This is the same dynamic price function resolved per-request."
echo
curl -s -D - -o /dev/null -X POST "$BASE/translate?tier=pro" \
  | grep -i '^PAYMENT-REQUIRED:' | sed 's/^[^:]*: *//' | tr -d '\r' \
  | base64 -d | jq '.accepts[] | {network, amount, payTo}'

echo
echo "══════════════════════════════════════════════════════════════"
echo "  STEP 3 · GET /marketplace/alice  →  payTo = alice's wallet"
echo "══════════════════════════════════════════════════════════════"
echo "payTo is a function of ctx.path. Each seller gets paid directly."
echo
curl -s -D - -o /dev/null "$BASE/marketplace/alice" \
  | grep -i '^PAYMENT-REQUIRED:' | sed 's/^[^:]*: *//' | tr -d '\r' \
  | base64 -d | jq '.accepts[] | {network, amount, payTo}'

echo
echo "══════════════════════════════════════════════════════════════"
echo "  STEP 4 · GET /marketplace/bob  →  payTo = bob's wallet"
echo "══════════════════════════════════════════════════════════════"
echo "Same route pattern, different seller. 'payTo' changes."
echo "MPP challenge's nested request also reflects the new recipient:"
echo
curl -s -D - -o /dev/null "$BASE/marketplace/bob" \
  | grep -i '^PAYMENT-REQUIRED:' | sed 's/^[^:]*: *//' | tr -d '\r' \
  | base64 -d | jq '.accepts[] | {network, amount, payTo}'

echo
echo "--- MPP 'request' payload on /marketplace/bob ---"
curl -s -D - -o /dev/null "$BASE/marketplace/bob" \
  | grep -i '^WWW-Authenticate:' \
  | grep -oE 'request="[^"]+"' | sed 's/request="//;s/"$//' \
  | tr '_-' '/+' \
  | awk '{n=length($0); pad=(4-n%4)%4; printf "%s", $0; for(i=0;i<pad;i++) printf "="}' \
  | base64 -d | jq

echo
echo "✓ done"
