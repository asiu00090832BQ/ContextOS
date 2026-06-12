---
name: ContextOS pnpm cross-platform install
description: Why a clone failed to build on macOS/Windows, and the two pnpm-config traps (platform-strip overrides + the dead package.json pnpm field).
---

# ContextOS pnpm cross-platform install

Two traps made `git clone` + `./run.sh` work on Replit (linux-x64) but fail on
macOS/Windows. Both live in pnpm config, not app code.

## 1. Do not strip non-Linux native binaries with overrides
- A previous "replit uses linux-x64 only" optimization listed every non-linux
  native optional dep in `pnpm-workspace.yaml` `overrides:` as `"<pkg>>@.../...": "-"`
  (esbuild, rollup, lightningcss, @tailwindcss/oxide, expo ngrok bins).
- **Why this breaks other platforms:** those binaries are normal
  optionalDependencies already gated by npm `os`/`cpu` fields, so pnpm installs
  ONLY the current platform's binary by default. Forcing them to `"-"` removes
  even the host's own binary on macOS/Windows → vite build (esbuild/rollup/
  lightningcss/tailwind) and `ERR_PNPM_IGNORED_BUILDS: esbuild` failures.
- **Rule:** don't strip platform binaries for "size". Let the lockfile list all
  platforms; pnpm only materializes the current one. Removing the strip block is
  the correct cross-platform fix and does not change what installs on Replit.

## 2. pnpm 10.x ignores the `pnpm` field in package.json (in a workspace)
- pnpm >=10.26 prints `The "pnpm" field in package.json is no longer read ...
  "pnpm.overrides"` and silently ignores it. Overrides/settings must live in
  `pnpm-workspace.yaml`.
- **Trap:** the `qs` security pin (`overrides.qs: ^6.15.2`, prototype-pollution
  fix) lived ONLY in package.json, so the upgrade silently dropped it. Keep the
  qs override in `pnpm-workspace.yaml overrides:` instead. Verify with
  `pnpm why qs -r` (expect a single resolved 6.15.x).
- `onlyBuiltDependencies` (incl. `esbuild`) already lives in the workspace yaml,
  so esbuild's postinstall runs once the host's binary actually installs.

## 2b. pnpm 11 removed `onlyBuiltDependencies` -> use `allowBuilds` (keep both)
- pnpm >=11 dropped `onlyBuiltDependencies`/`neverBuiltDependencies`/
  `ignoredBuiltDependencies` in favor of `allowBuilds` (a name->bool map) and now
  defaults `strictDepBuilds: true`. So a dep with a build script that isn't in
  `allowBuilds` is BLOCKED and fails install with `ERR_PNPM_IGNORED_BUILDS`.
- **Symptom:** clone builds on Replit (pnpm 10.26.1) but a contributor on pnpm
  11.x gets `ERR_PNPM_IGNORED_BUILDS: esbuild@<v>` because v11 silently ignores
  our `onlyBuiltDependencies` list.
- **Fix:** declare BOTH keys in `pnpm-workspace.yaml` — the list for pnpm 10 and
  an `allowBuilds:` map (`esbuild: true`, `@swc/core: true`, `msw: true`,
  `unrs-resolver: true`) for pnpm 11+. pnpm 10 ignores the unknown `allowBuilds`
  key; pnpm 11 ignores the removed list. No version pinning needed; keep the two
  in sync when adding a built dep.
- **One-off local unblock** on an already-installed pnpm-11 clone: `pnpm
  approve-builds` (approve esbuild) writes the allowBuilds entry itself.

## 3. CI guards this regression class now
- A GitHub Actions matrix job (Linux/macOS/Windows) reproduces the README
  clone-and-run (`cp .env.example .env` → `pnpm install` → web build) and fails
  loudly on: the dead package.json `pnpm` field warning, `ERR_PNPM_IGNORED_BUILDS`,
  a missing host-platform native binary, or a failed web build.
- The native-binary check is a standalone Node ESM script (no deps) that scans
  `node_modules/.pnpm` for the host's esbuild/rollup/lightningcss/oxide package by
  matching os+arch tokens (libc/abi-agnostic), so it works on all 3 platforms.
- **If you touch pnpm-workspace.yaml overrides or native optional deps, expect
  this CI to catch a platform strip; don't "fix" it by deleting the check.**
