# 99 · Validation Errors

A server that deliberately misconfigures itself so you can see how the SDK surfaces problems. Currently covers one case: a non-ASCII character in an endpoint `description` with MPP enabled.

## Run

```bash
npm install
npm start
```

You'll see a `ConfigError` in the server logs on the first request. The server exits non-zero after ~1.5s if the error does NOT fire — that makes this useful in CI as a regression check.

## Inspect

Unlike the other examples, this one does NOT reach a 402 — the validator fires before any challenge can be built. A curl against it returns an Express default 500 error page. What matters is the server-side log output:

```bash
# In one terminal:
npm start

# In another:
curl -i http://localhost:4000/weather
```

The interesting output is in the server terminal — a full `ConfigError` stack trace explaining exactly which endpoint triggered the rejection, what character index, and how to fix it.

## Why it errors

The MPP draft (`paymentauth.org/draft-httpauth-payment-00`) says `description` "may contain localized text" (UTF-8), but it doesn't specify how non-ASCII is transmitted in the `WWW-Authenticate` header. Node's fetch enforces ByteString on header values, so an em dash (`—`) would crash header encoding at request time. The SDK validates descriptions at config load time instead — fail loud, not silent.

## Fix it

Either:

```diff
- description: "Weather — real-time",
+ description: "Weather - real-time",
```

or disable MPP for just this endpoint:

```diff
  "GET /weather": {
    price: "$0.01",
    description: "Weather — real-time",
+   protocols: ["x402"],   // x402 base64-wraps its challenge, non-ASCII is fine
  },
```
