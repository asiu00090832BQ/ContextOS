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

**Bot long-term memory IS syncable; match by `key`** (row ids differ). Only the
bot's curated long-term partition has read+write routes; upsert by key, never
delete. Run-scoped short-term memories are deliberately excluded (they belong to a
run that doesn't exist in the other env).

**What CANNOT be synced via the API (would need new endpoints + a republish):**
- **Conversation history.** Posting a message *generates a live LLM reply* and only
  accepts `role:"user"` — so importing history would re-run the model, cost tokens,
  and fabricate different assistant turns. There is no faithful bulk-import path.
- **Agent-level (non-bot) working memories.** No write endpoint exists; only the bot
  has memory POST/PUT.

**Managed Claude does not work in a deployment out of the box.** Its endpoint key is
a sentinel `managed://replit-anthropic` set only by *seeding* (not settable via the
API — the create/patch `apiKey` field is always wrapped into a `secret://` ref), and
it relies on Replit's AI integration which isn't wired into the deployment. Verify
prod endpoints with `POST /api/model-endpoints/:id/test`. OpenRouter works in prod
via the `OPENROUTER_API_KEY` env-secret fallback; anthropic's fallback is
`ANTHROPIC_API_KEY` (not set).

**Intentional bot-model divergence (footgun):** the dev bot may be on Claude while
the **prod bot must stay on OpenRouter** (Claude can't run in the deployment). The
helper *mirrors* dev→prod, so a plain `push-prod --apply` will re-point the prod bot
at Claude and silently break it. After any full sync, re-set the prod bot's
model-policy to the OpenRouter endpoint (or sync with `--only` excluding the bot).
