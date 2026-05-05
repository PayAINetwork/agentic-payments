# Contributing to @payai/mercantil-agent-sdk

## Prerequisites

- Node.js 22+
- npm 10+

## Setup

```bash
cd typescript
npm install
```

## Making changes

### Branch convention

| Prefix | When to use |
|--------|-------------|
| `feat/` | New functionality |
| `fix/` | Bug fix |
| `docs/` | Documentation only |
| `chore/` | Build, config, CI, dependencies |
| `ci/` | CI workflow changes |

### Commit format

This repo uses [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): short description

# Examples
feat(mpp): add multi-challenge support
fix(x402): validate paymentPayload.accepted
docs: update quickstart guide
chore: bump dependencies
```

### Before opening a PR

Run the full check suite from `typescript/`:

```bash
npm run check   # typecheck + lint + build + publint + attw + size
npm test        # unit tests
```

### Adding a changeset

Every PR that modifies the published package (`typescript/src/**`) must include a [changeset](https://github.com/changesets/changesets). Run from `typescript/`:

```bash
cd typescript
npx changeset
```

Follow the prompts to classify the change as `patch`, `minor`, or `major` — this determines the next version bump. The command creates a file in `typescript/.changeset/`; commit it with your PR. CI rejects PRs that touch `typescript/src/` without a changeset.

Docs-only, CI-only, and example-only PRs do not need a changeset.

### Example smoke test

If your change affects any example, verify it from `examples/typescript/`:

```bash
npm run smoke
```

This starts each example server in sequence and asserts that 402 challenge headers are well-formed.

## PR expectations

- Link the relevant issue (`Closes #N`).
- Include a changeset if `typescript/src/` was modified.
- Tests and lint must pass.
- Describe the *why* in the PR body — the commit history has the what.

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the request flow, adapter contracts, response-buffering strategy, and security properties.
