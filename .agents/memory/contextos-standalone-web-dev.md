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
- Detect Replit via `REPL_ID`. On Replit the platform injects a *per-artifact*
  PORT — it is authoritative, must be used as-is.
- Standalone, do NOT reuse `PORT`: `.env` sets `PORT=8080` for the API server,
  so the web inheriting it collides. Use a dedicated `WEB_PORT` (default 5173).
- `/api` dev proxy must be gated to non-Replit only. On Replit the platform
  proxy routes `/api` to the api-server artifact and vite never sees it; turning
  the vite proxy on there would point at the wrong port.

**Why:** the multi-artifact router gives each artifact its own injected PORT, but
a shared `.env` PORT for the API leaks into any artifact run by hand.
