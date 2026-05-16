# Contributing

Thanks for improving the PayAI Agent Payments SDK. This repo currently ships the TypeScript package; Python and Go directories are placeholders unless a maintainer says otherwise.

## Local setup

Use Node.js 18 or newer.

```bash
cd typescript
npm install
npm test
npm run check
```

`npm run check` is the full package gate: typecheck, lint, build, package export validation, type-resolution validation, and bundle-size checks.

If you touch example behavior, also run the example smoke suite:

```bash
cd examples/typescript
npm install
npm run smoke
```

## Branches and commits

Use short, descriptive branches with conventional prefixes:

- `fix/...` for bug fixes
- `feat/...` for new SDK behavior
- `docs/...` for documentation-only changes
- `chore/...` for maintenance

Use conventional commit subjects when possible, for example `fix: avoid double x402 settlement`.

## Pull requests

Before opening a PR:

- Link the issue or explain the user-visible problem.
- Keep the scope narrow enough to review in one pass.
- Add or update tests for behavior changes.
- Update README, example docs, or architecture notes when public behavior changes.
- Include the exact verification commands you ran.
- Do not commit private keys, wallet seeds, API keys, facilitator credentials, `.env` files, or `.payai/` contents.

## Payment and network safety

The default SDK mode is testnet. Do not run mainnet examples in CI or from shared wallets unless a maintainer explicitly asks for it. Mainnet E2E workflows are manual/release-only and use repository secrets.

For x402 and MPP changes, prefer tests that prove the no-payment `402` shape, header encoding, settlement timing, and receipt behavior without spending real funds.
