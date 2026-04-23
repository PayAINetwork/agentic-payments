#!/usr/bin/env bash
# Walk through the hooks-example 402 response in four steps, then show
# what happens when the onRequest hook grants free access.
#
# Usage (from this directory, while `npm start` is running):
#   ./inspect-402.sh
#   URL=http://localhost:5000/weather ./inspect-402.sh
#   INTERNAL_KEY=mysecret ./inspect-402.sh
#
# Watch the server's terminal at the same time — you'll see the hook
# console.logs fire (onRequest grant path + nothing else for that path).
#
# Requires: curl, jq, base64. On macOS: `brew install jq`.

set -euo pipefail

URL="${URL:-http://localhost:4000/weather}"
INTERNAL_KEY="${INTERNAL_KEY:-secret}"

echo
echo "══════════════════════════════════════════════════════════════"
echo "  STEP 1 · Normal 402 flow (no hook intervention)"
echo "══════════════════════════════════════════════════════════════"
echo "Without the internal-key header, the onRequest hook returns"
echo "nothing and payment is required as usual."
echo
echo "\$ curl -i $URL"
curl -sSi "$URL"

echo
echo
echo "══════════════════════════════════════════════════════════════"
echo "  STEP 2 · Decode the x402 PAYMENT-REQUIRED header"
echo "══════════════════════════════════════════════════════════════"
curl -s -D - -o /dev/null "$URL" \
  | grep -i '^PAYMENT-REQUIRED:' | sed 's/^[^:]*: *//' | tr -d '\r' \
  | base64 -d | jq

echo
echo "══════════════════════════════════════════════════════════════"
echo "  STEP 3 · Decode the MPP 'request' parameter"
echo "══════════════════════════════════════════════════════════════"
curl -s -D - -o /dev/null "$URL" \
  | grep -i '^WWW-Authenticate:' \
  | grep -oE 'request="[^"]+"' | sed 's/request="//;s/"$//' \
  | tr '_-' '/+' \
  | awk '{n=length($0); pad=(4-n%4)%4; printf "%s", $0; for(i=0;i<pad;i++) printf "="}' \
  | base64 -d | jq

echo
echo "══════════════════════════════════════════════════════════════"
echo "  STEP 4 · Hook intervention: onRequest grants free access"
echo "══════════════════════════════════════════════════════════════"
echo "The onRequest hook inspects the x-internal-key header and, if it"
echo "matches, returns { grant: true } — which short-circuits payment."
echo "The handler runs and returns 200 without any challenge headers."
echo
echo "\$ curl -i -H 'x-internal-key: $INTERNAL_KEY' $URL"
curl -sSi -H "x-internal-key: $INTERNAL_KEY" "$URL"

echo
echo "✓ done — check the server terminal for the [hooks] log lines"
