---
name: Pushing dev config to prod
description: How (and why) ContextOS config is copied from dev into a published prod deployment.
---

# Dev → prod config sync

**There is no continuous/automatic data sync.** Publishing syncs **code + schema
only**, never row data, and tooling has read-only access to the prod DB. So config
parity is achieved either by treating the published prod app as the single source
of truth, or by running an on-demand push helper.

**Why the helper is HTTP-to-HTTP** (reads dev API, writes prod API) rather than
DB-to-DB: the prod DB is read-only to tooling, and the public API auto-bootstraps
the owner tenant with no auth, so POST/PUT against the published URL is the only
writable path.

**Durable design decisions** (so future changes stay consistent):
- Match agents + model endpoints **by name** — row IDs differ across envs. Because
  names have no DB unique constraint, the helper must fail fast on duplicate names
  rather than silently picking one.
- **Never copy secrets (API keys).** Endpoints are matched by name; a missing one
  can be created as a *shell* only, and its key must be set in prod afterward.
- The reserved `ContextOS Bot` is **never created/renamed** — its policy/model go
  through the dedicated bot route, not the generic agent create path.
- **Additive, never destructive:** prod-only agents are left untouched and model
  policies are never cleared (warn instead). Default to a dry run; writes are opt-in.

**Gotcha:** the agent *list* endpoint omits `modelPolicy`; you must fetch each
agent by id to read its model assignment.
