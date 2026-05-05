# 05 · Lifecycle Hooks

Lifecycle hooks let you run your own code at each stage of the payment flow: grant free access to trusted callers before payment is checked, reject verified payments that fail your own business rules, record successful settlements, or log failures for alerting. All four hooks are wired with `console.log` so you can see exactly when each one fires.

| Hook | When | Can modify flow? |
|------|------|------------------|
| `onRequest` | Before payment is checked | Yes — return `{ grant: true }` to skip payment |
| `onPaymentVerified` | After verify, before your handler | Yes — return `{ reject: true, reason }` to deny |
| `onPaymentSettled` | After settlement succeeds | No — informational |
| `onPaymentFailed` | Verification or settlement fails | No — 402 already returning |

## Run

```bash
npm install
npm start
```

## See the 402 and the grant path

```bash
# Normal 402 flow (onRequest sees no internal key → payment required)
curl -i http://localhost:4000/weather

# onRequest hook grants free access — handler runs, returns 200 with no challenge headers
curl -i -H 'x-internal-key: secret' http://localhost:4000/weather
```

Watch the server console in the other terminal to see the `[hooks] onRequest → internal key, granting free access` log line on the second request.

## Inspect the headers in detail

```bash
./inspect-402.sh                          # both the 402 flow and the grant flow
INTERNAL_KEY=mysecret ./inspect-402.sh    # override if you changed INTERNAL_KEY
```

Requires `jq` (macOS: `brew install jq`).
