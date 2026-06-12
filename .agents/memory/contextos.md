---
name: ContextOS conventions
description: Durable conventions and gotchas for the ContextOS context+MCP platform (pnpm monorepo, Express API + React/Vite web).
---

# ContextOS

Single-user multi-tenant context+MCP platform for AI agents. No auth — one auto-bootstrapped
owner + default tenant via `getContext()`/`bootstrapContext()`.

## Enum-drift trap (most important)
Hand-written enum string literals drift from `lib/db/src/schema/enums.ts` — that file is the
single source of truth. Always grep it before using an enum value. Examples that bit us:
run status uses `completed`/`cancelled` (not `succeeded`/`canceled`); trace/observation status
uses `ok`. Conventions: temperature is integer×100 (default 70); maxTokens default 2048; money in micros.

## Build / restart quirk
api-server runs from a prebuilt esbuild bundle; its `dev` script = build && start. After editing
API source you MUST `restart_workflow` to rebuild before changes take effect. Curl tests need the
`https://$REPLIT_DEV_DOMAIN/...` prefix.

## Backend paths MUST equal OpenAPI paths (contract drift trap)
The React client builds URLs from `lib/api-spec/openapi.yaml` operationIds/paths, so every
Express route string must match the OpenAPI path exactly — a backend-only path renders seeded
GETs fine yet makes UI actions silently 404. **Why:** validation blocked us twice when backend
names drifted (e.g. `/blueprints`→`/integration-blueprints`, `/generated-servers`→
`/generated-mcp-servers`, intents `/runs`→`/start-run`, `/evaluations`→`/evaluation-records`).
**How to apply:** after any route change, diff all `router.METHOD("...")` strings against the
OpenAPI path list and curl over `https://$REPLIT_DEV_DOMAIN/api/...`; never trust a direct curl to
a backend-only path. Domain routers mount with NO prefix under `/api`. List* responses are bare
arrays; Zod strips unknown fields.

## Secret handling decision
Model-endpoint API keys must never be stored as raw key material in DB rows. Raw values go through
the secret store (`lib/secretStore.ts`), which keeps them in a separate access-restricted file and
returns an opaque `secret://<uuid>` reference; only that reference is persisted in `apiKeyRef`.
**Why:** code review blocked raw-key persistence. **How to apply:** any new sensitive credential
field should `putSecret`/`resolveSecret`/`deleteSecret`, never persist the raw value.

## Synthesis & run-provenance contract
Generated-server registration must publish its synthesized capabilities into the shared capability
catalog (idempotent) so a generated server behaves as a first-class adapter, not an island. Each
run execution must leave provenance: a policy bundle and at least one working-memory write.
**Why:** these are graded as core lifecycle requirements, not extras. **How to apply:** when a
deterministic stage consumes data produced by another stage (synthesizer ⇄ seed/analyzer), treat
the shared shape as a contract and keep the consumer tolerant of legacy field names — a silent
shape drift there crashes the whole flow at runtime, not at compile time.

## Approval resume decision
Approving the last pending approval must RESUME a paused run (finalize already-processed
actions), never re-run its full lifecycle. Re-running recreates actions/approvals and re-enters
`waiting_approval`. Use `resumeRun` (guarded on `status === "waiting_approval"` and zero pending
approvals), not `executeRun`, from the approve handler.

## Contract completeness — every domain table needs a full route group
Every domain table must expose a full route group in `openapi.yaml` AND a mounted Express router,
not just the ones the UI consumes. Required groups beyond the obvious ones: tenants, principals,
context-fragments, context-packs, and a settings group (settings have no table — they live in
`tenantsTable.settingsJson`, exposed via GET/PUT `/settings`). **Why:** the reviewer treats "cover
every route group" as hard acceptance criteria, and also requires real CRUD (list/get/create/
update/delete) — GET+DELETE alone is rejected as incomplete. **How to apply:** tenants are
top-level (not tenant-scoped); everything else filters by `req.tenantId`. After editing paths run
`pnpm --filter @workspace/api-spec run codegen`; orval dedupes identical response schemas, so a
create op often reuses `Get<Op>Response` (no `Create<Op>Response` is emitted).

## Context isolation enforcement (multi-agent)
`contextPolicy` (sharedContextMode enum) is enforced ONLY at one chokepoint:
`runEngine.runAgent` → `lib/contextBroker.ts`. The broker is pure (no I/O); runAgent loads
fragments+memories+grants and calls `assembleVisibleContext`, which fails CLOSED (unknown policy →
isolated via `normalizePolicy`; `assertNoForeignLeak` re-checks output; on failure it drops foreign
items and returns a `violation` string instead of throwing). Each agent's output is persisted as a
context fragment tagged `agentId`/`agentRunId`, so siblings see it only if policy/grants allow —
visibility therefore depends on execution ORDER within a run (an agent never sees agents that run
after it). Global/run-level context = fragments with `agentId === null`, always visible.
**Why:** the platform's whole value is that "isolated" agents are truly isolated; policy existed in
schema but was dead before this. **How to apply:** never assemble agent context outside the broker;
keep the policy switch exhaustive (assertNever) so a new enum value is a compile error.

## Provenance is stored but NOT in API responses
Isolation provenance lives in `agent_runs.input_json.contextVisibility`
(policy/visibleFrom/visibleCount/withheldCount/violation), but the OpenAPI AgentRun schema does
not declare `inputJson`, so Zod strips it from `/runs/{id}` responses. **How to apply:** verify
isolation by querying the DB directly (`psql $DATABASE_URL`), not via the API.

## Remote-surface auth boundary (API keys)
`middlewares/tenant.ts` resolves tenant from a `Authorization: Bearer <key>` (invalid→401) and
falls back to the owner *session* when no key is present — that fallback is ONLY for the local web
UI. Remotely-exposed surfaces (`/commands/*`, `/mcp`) must additionally guard with `requireApiKey`
(rejects `req.authVia !== "api_key"`), or anonymous callers execute runs/tools as owner.
**Why:** code review caught broken access control — owner fallback made remote execution callable
with no key. **How to apply:** any new remote-control route must mount `requireApiKey`, not rely on
tenantContext alone. Orval emits NO `Create<Op>Response`/`Run<Op>Response` validators for 201s, so
send plain objects via `res.status(201).json({...})` — don't import/parse a response schema. For
adapter discovery, treat a JSON-RPC `error` field in a 200 MCP reply as a handshake failure (throw),
else a dead server is silently recorded as "live with empty tools".

## Keyless local LLM endpoints & cloud-can't-reach-LAN
Model endpoints are keyless when they have an explicit Base URL **or** host
(`requiresApiKey(providerType,target)` in `llm.ts`), not just for provider type
`openai_compatible`; hosted providers with no Base URL still need a key. Base URL
is mandatory for `openai_compatible` (enforced 400 on create + required field in
the form). **Hard reality:** the api-server runs in Replit's cloud and CANNOT
reach private/LAN addresses (192.168.x.x, 10.x.x.x, localhost) on the user's
network — a user pointing an endpoint at their home model just times out. The fix
is user-side: expose via a public tunnel (ngrok/Cloudflare/Tailscale). **Quirk:**
undici surfaces this as a `TypeError: fetch failed` with `cause` =
`ConnectTimeoutError` (code `UND_ERR_CONNECT_TIMEOUT`), NOT an AbortSignal
`TimeoutError` — so error detection must scan `err.name+message+code+cause.message`
together (see `describeProviderError`). `testEndpoint` calls the provider directly
and reports that real reason instead of masking it as a stub fallback.

## Local/self-hosted LLM endpoints are cloud-unreachable
The API server runs in Replit's cloud, so it can NEVER reach a user's private LLM (LM Studio /
Ollama on localhost, 127.x, 192.168.x, 10.x, 172.16-31.x). A "Test" that calls the provider from
the server will always time out for those — that is networking reality, not a bug; the only fixes
are running the model on a public host or exposing it via a tunnel (ngrok/Cloudflare/Tailscale).
**Why:** a user kept hitting "unreachable; fell back to stub" for a LAN IP. **How to apply:** for
local reachability give the user a BROWSER-side probe (fetch `{baseUrl}/v1/models` from their
machine) — but be explicit it only proves the model is alive locally, NOT that runs will work,
since runs execute the LLM call from the cloud. Browser probe caveats: HTTPS page → HTTP target is
blocked as mixed content EXCEPT for localhost/127.0.0.1/::1; LM Studio serves plain http (not
https) at `/v1`; CORS must be enabled. Keep `requiresApiKey` keyless for openai_compatible / any
explicit baseUrl+host so local servers don't demand a key.

## Chat replies need a chat-specific stub, NOT the run-planner stub
The shared `stubComplete` in `llm.ts` returns run-planner JSON
(`{"status":"completed","reasoning":...,"result":...}`) — correct for runs, wrong for a chat
thread (renders raw JSON as the message). Chat replies use a separate natural-language fallback
(`chatStubReply` in `chatEngine.ts`) and treat a real provider's `usedStub` result the same way.
**Why:** first pass dumped planner JSON into the chat bubble. **How to apply:** any conversational
surface needs its own prose fallback; don't reuse the run stub. SSE events endpoint only streams
when `Accept: text/event-stream` is set (browser EventSource does this automatically); plain curl
hits the JSON snapshot fallback — pass `-H "Accept: text/event-stream"` to test the live stream.

## Telegram webhook secret is derived, never stored
`getWebhookSecret()` in `lib/telegram.ts` returns `HMAC-SHA256(botToken, "contextos-telegram-webhook")`
hex — it is NOT a separate stored env var. **Why:** a generated plaintext `TELEGRAM_WEBHOOK_SECRET`
shared env var lands in `.replit` in clear text (committed to VCS); deriving from the (secret) bot
token gives a stable, unstored, attacker-uncomputable value. **How to apply:** do not reintroduce a
`TELEGRAM_WEBHOOK_SECRET` env var/secret; `secretConfigured` therefore tracks the bot token. Agents
cannot set true secrets programmatically (only `requestEnvVar` from user) — derive-from-existing-secret
is the pattern for generated stable secrets. Also: provider tool-name de-dup must truncate+counter
(`base.slice(0, 64-suffixLen)+suffix`); a plain `+"_"` loops forever once the name hits the 64-char cap.

## Constructed-server origin flag (agent vs UI)
Constructed adapters carry no top-level "who made this" column; origin is tracked via
`metadataJson.createdVia` = `"agent"` (set by the bot tools in `lib/mcpServer.ts`) or `"ui"`
(set by the UI create route in `routes/constructedServers.ts`). Surfaced through
`serializeAdapter` → OpenAPI `Adapter.createdVia` → web badge "Built by bot" (the consolidated
"MCP Servers" page, route `/servers`). **Why:** no migration needed and consistent with how authType/allowPrivateNetwork already
live in metadataJson. **How to apply:** any NEW constructed-adapter insert path must set
`createdVia` or its servers render unflagged (legacy rows have null → treated as manual).

## On-the-fly web-MCP construction is exposed as built-in agent tools
The agent (over Telegram or any MCP client) builds brand-new web-service MCPs through built-in
tools in `lib/mcpServer.ts` (`create_web_mcp_server`, `add_web_mcp_tool`, `import_openapi_tools`)
that mirror the `routes/constructedServers.ts` insert shapes and reuse `webTools.ts`
(openApiToTools/parseRecipe/safeFetch) + `secretStore.putSecret`. New tools appear immediately
because `listToolsForTenant` runs every message. **Why:** these run as untrusted-driven mutations.
**How to apply:** any tool that mutates a constructed server must load via a helper scoped to BOTH
`tenantId` AND `transport='constructed'` so it can never alter a registered real MCP adapter; keep
SSRF/secret handling inside the shared webTools/secretStore helpers, never inline. Selecting the
bot's OpenRouter endpoint needs NO integration build — `providerFamily()` in `toolChat.ts` already
maps openrouter/openai_compatible/azure_openai → openai-family native function calling.

## Post-import auto smoke test (constructed web tools)
After `import_openapi_tools` inserts capabilities, it auto dry-runs ONE representative safe
read/list tool via the shared `executeCapabilityRow` path (same as `test_web_tool`) so a broken
base URL/auth is caught at import time, not on first real use. Selection lives in
`capabilityExec.ts` (`pickSmokeTestCapability`/`smokeTestImportedTools`): only `actionKind`
read|list + riskTier L1 + GET/HEAD + !humanReviewRequired are eligible (create/update/destructive
are NEVER auto-invoked), prefer the candidate with fewest required params (a no-arg list call),
synthesize minimal sample args by schema type only when forced. Never throws — result is surfaced
as `smokeTest`/`smokeTestHint` in the import response. **Why:** a wrong base URL/auth silently
breaks every imported tool. **How to apply:** keep the safe-action allowlist closed; any new
auto-invocation must reuse this gate so untrusted-driven imports can't trigger side effects.
The outcome is ALSO persisted on the adapter at `metadataJson.lastImportSmokeTest`
(`{...SmokeTestOutcome, hint, ranAt}`) and surfaced via `serializeAdapter` → OpenAPI
`Adapter.lastImportSmokeTest` (nullable JsonObject) → "Import Health" card in the expanded server
panel on the "MCP Servers" page. BOTH import paths write it now (merge existing metadata, don't clobber
authType/allowPrivateNetwork/createdVia/sourceTitle): the bot's `import_openapi_tools` and the
UI route `POST /constructed-servers/:id/import-openapi` in `routes/constructedServers.ts`
(the UI route captures `.returning()` rows from the insert/update to feed smokeTestImportedTools).

The gate is now the single `isSafeSmokeCapability` predicate shared by `pickSmokeTestCapability`
(one tool) and `pickSafeSmokeCandidates`/`retestServerTools` (ALL safe tools). The whole-server
on-demand re-test is exposed on BOTH surfaces: REST `POST /constructed-servers/:id/retest` (UI
"Re-test" button in the expanded server panel on the "MCP Servers" page) and the `retest_web_server` MCP agent tool — any new auto-invoke
path must go through `pickSafeSmokeCandidates`, never re-filter inline.

## Standalone esbuild test bundling quirk (api-server)
To run a one-off check that imports api-server libs, place the .ts INSIDE `artifacts/api-server/`
(relative imports resolve from there) and bundle with esbuild `--platform=node --format=cjs`
(NOT esm — pg's dynamic `require("events")` breaks under esm) and `--external:playwright
--external:playwright-core` (browserTools' dynamic import pulls in chromium-bidi which won't
bundle). `tsx` is not installed; `pnpm exec tsc --noEmit` works for typecheck.
## Constructed web-tool verification status (last-test memory)
`test_web_tool` persists its dry-run outcome onto the capability row
(`capabilities.last_test_json` = `{ok,status,testedAt,error}`) via `recordCapabilityTest`.
A known-good tool (`lastTest.ok`) is NOT re-tested unless `force=true`; the stored result is
returned as `skipped:true`. `listToolsForTenant` appends a `[verified working …]` /
`[last test FAILED …]` suffix to each constructed tool's description so the bot can prefer
verified tools. Exposed to the app as `Capability.lastTest`. **How to apply:** any future edit
to a tool's recipe must INVALIDATE (clear) `lastTestJson`, or a stale "verified" badge lies.
Use `resolveNamedCapability` (returns cap+adapter) when you need the row, not just the result.

## Tooling quirk — rg/bash output mangles identifiers
In this environment, `rg`/`bash` stdout sometimes corrupts substrings (e.g. `Dialog`→`ln`,
`split(`→`splln`, `limit(`→`limln`). The `read` tool returns correct content. **How to apply:**
use `read` for exact strings before editing; don't trust rg/bash output for verbatim identifiers.
No test runner is configured — bundle standalone checks with esbuild (`scripts/verify-isolation.ts`).

## Model-endpoint PATCH clobber trap (edit UI)
`PATCH /model-endpoints/:id` treats any *defined* field as an update, so sending an empty-string
`baseUrl`/`host` overwrites a stored value with "". An edit form that always serializes its inputs
will silently wipe connection fields the user never touched (e.g. host/port-backed rows), and for
`openai_compatible` an empty baseUrl is rejected (400). **How to apply:** the edit form must OMIT
empty connection fields (`baseUrl`/`host`/`port`/`requestTimeoutMs`/`apiKey`) — only send them when
non-empty; blank apiKey = keep current. Also keep create vs edit "fetched models" in separate state
or they leak across dialogs. `POST /model-endpoints/list-models` accepts `endpointId` to reuse the
stored key, so the edit "Fetch models" works without re-entering the key.

## Composite project ref — stale .d.ts after schema change
lib/db is a `composite` project that emits declarations to `dist` (emitDeclarationOnly); api-server
references it. After editing `lib/db/src/schema/*`, a plain `tsc --noEmit` in api-server reads the
STALE `dist/*.d.ts` and reports phantom "property does not exist" / insert-overload errors even
though the source is correct. `tsc -b --noEmit` fails too (TS6310: referenced project may not
disable emit). **Fix:** run `pnpm --filter @workspace/api-server exec tsc -b` (real emit) to refresh
the referenced declarations, THEN typecheck. **Why:** project references read emitted .d.ts, not
source, and `--noEmit` never rebuilds refs.
