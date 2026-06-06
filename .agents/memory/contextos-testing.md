---
name: ContextOS api-server testing
description: Why api-server tests use node:test (not vitest) and how the runner is wired.
---

# api-server test runner

`vitest` is **firewall-blocked** in this environment — every version's tarball
returns 403 from `package-firewall.replit.local` ("No authorization header"),
and leaving it in `package.json` breaks `pnpm install` for the whole workspace.

**Decision:** api-server tests run on Node's built-in `node:test` + `node:assert`
(zero install). The `test` script is:
`node --experimental-test-module-mocks --import ./test/register-resolve.mjs --test test/*.test.ts`

**Why each flag:**
- `--experimental-test-module-mocks` — enables `mock.module(spec, { namedExports })`,
  the replacement for vitest `vi.mock`. Node 24 supports it.
- `--import ./test/register-resolve.mjs` — registers `test/ts-resolve.mjs`, a resolve
  hook that appends `.ts`/`/index.ts` to extensionless relative imports. The source
  uses `moduleResolution: bundler` (extensionless), which esbuild resolves at build
  time; Node's raw ESM loader cannot, so the hook is required. It must chain BENEATH
  the mock loader so mocked specifiers still resolve to the same URL keys.
- Node 24 strips TS types natively, so `.ts` test files run directly (no tsx/esbuild step).

**How to apply:** New api-server tests go in `test/*.test.ts`. Use `mock.module` (not
hoisted — register mocks, then `await import()` the SUT). Do NOT re-add vitest; it will
not install. The DB mock is a chainable `then`-able builder keyed by table `_name`.
