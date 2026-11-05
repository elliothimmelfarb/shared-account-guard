# shared-account-guard

A TypeScript library and guide for running several apps on one Stripe or Resend account. Start with `README.md`, then `docs/failure-modes.md`.

## Layout

- `src/stripe.ts`, `src/resend.ts`: tagging, classification, signature checks and guards.
- `src/registry.ts`: the registry type and its checks.
- `src/common.ts`: shared types and HMAC helpers.
- `test/`: Vitest. Payloads are signed with the real `stripe` and `svix` packages.
- `examples/registry.example.json`: the sample registry.

## Commands

- `npm ci`, `npm test`, `npm run typecheck`, `npm run build`.

## Rules

- Use fictional apps and example domains only (`fernbank`, `tidepool`, `lanternworks`, `.example`). Never add a real project name, account, ID, domain or key. Run `gitleaks detect --source .` before pushing.
- `src/` has no runtime dependencies and imports no Node modules. It uses Web Crypto so it runs on edge runtimes. `stripe` and `svix` are for tests only.
- Guards verify, then parse, then classify, in that order. Never reorder this.
- A foreign result never carries the event payload.
- An unproven owner is `untagged` and is never `ours`.
- Use test-driven development, and add only tests that would catch a real bug. Inject the bug to prove it.
- A claim about Stripe or Resend behavior goes in `docs/failure-modes.md`, and its entry under "What was checked" says how it was checked. Re-check against current docs when you change one.
- Secrets in tests are built at runtime, so nothing secret-shaped sits in the repository.
- Write plain sentences. No em dashes and no slogans.
