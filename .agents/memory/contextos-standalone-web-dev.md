---
name: ContextOS standalone web dev
description: Why the contextos web crashes when run by hand, and the PORT/proxy rules that keep Replit and local clones both working.
---

# ContextOS standalone web dev

- `pnpm --filter <pkg> run <script>` is a *filtered recursive* run, so a failing
  child (e.g. vite) surfaces as `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` — that error
  is just a wrapper; the real cause is in the lines printed above it.
- The contextos web's `vite.config.ts` needs `PORT` and `BASE_PATH`. The Replit
  workflow injects both, so a bare `pnpm --filter @workspace/contextos run dev`
  in a plain shell crashes on the missing vars unless defaults are provided.

**Rules (keep both environments working):**
- Do NOT gate the config on `REPL_ID`. A Replit *shell* has `REPL_ID` set but
  `PORT`/`BASE_PATH` are injected only into the *workflow* process — so gating on
  `REPL_ID` makes manual `pnpm --filter ... run dev` crash on missing PORT.
- Resolve the web port as `WEB_PORT ?? PORT ?? 5173` and never throw on a missing
  value (default instead). `WEB_PORT` is the escape hatch to avoid colliding with
  the API server's `PORT` (e.g. 8080 from `.env`) when both run in one shell.
- `BASE_PATH ?? "/"` — the workflow injects it; default to root otherwise.
- `/api` dev proxy: gate on dev mode (`NODE_ENV !== "production"`), not Replit.
  It's harmless on Replit because the platform proxy routes `/api` to the
  api-server artifact and those requests never reach Vite.

**Why:** the multi-artifact router gives each *workflow* its own injected PORT,
but those vars are absent in a plain shell — so the config must default, not
require, and must not assume "on Replit ⇒ PORT is set".

**Single-URL (beginner) mode — API serves the built web UI:**
- The api-server optionally serves the built web at its root, gated on
  `CONTEXTOS_WEB_DIR` (a dir containing `index.html`). Static middleware + an
  SPA fallback are mounted AFTER `app.use("/api", router)`, and the fallback
  skips any path starting with `/api` so API + webhook routes are never shadowed.
- The gate must stay opt-in: `CONTEXTOS_WEB_DIR` is set only by `run.sh` default
  mode. Never set it on Replit — the web is its own artifact/workflow there, and
  setting it would make the api-server double-serve the UI.
- `run.sh` is dual-mode: default builds the web (`contextos run build` →
  `dist/public`), exports `CONTEXTOS_WEB_DIR`, serves UI+API at one URL;
  `--api-only` runs the API alone for separate Vite dev. Readiness poll hits
  `/api/healthz` (NOT `/` — root only exists in single-URL mode).
- Chat over the HTTP API is async: `POST /api/conversations/:id/messages` returns
  the user's own message; the agent reply arrives via SSE
  `GET /api/conversations/:id/events` (Accept: text/event-stream) or by polling
  `GET /api/conversations/:id/messages`. README must not imply a sync reply.
