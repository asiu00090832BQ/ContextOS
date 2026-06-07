---
name: ContextOS tool surfaces & agent tool path
description: Where built-in tools become callable across /mcp, bot, and run agents — and the non-obvious gate that run agents can only call tools on a single allow-list.
---

# Tool surfaces in ContextOS

A built-in tool (defined in the `TOOLS` array in `mcpServer.ts`) is reachable on
three distinct surfaces, and each has its OWN gate. Adding a tool to `TOOLS`
alone only covers agents-with-the-full-catalog; it does **not** automatically
reach the bot or run agents.

- **/mcp + Telegram/web bot**: gated by `BOT_ALLOWED_TOOLS` (a Set in
  `mcpServer.ts`). `listToolsForTenant(caller=bot)` filters `TOOLS` by this set,
  and `callTool` rejects bot calls outside it. To expose a tool to Gerald, add
  its name here.

- **Run agents (runEngine)**: the ONLY tool-calling path in `runEngine.ts` is the
  "builder" loop (`runBuilderCompletion` → `runToolChat`), entered only when the
  agent has `canBuildIntegrations` and a live model endpoint. That loop offers and
  enforces tools via the `BUILDER_TOOL_NAMES` allow-list. Agents without
  `canBuildIntegrations` do a plain `complete()` with NO tools at all.

**Why:** This bit caused a task to initially miss its goal — built-in Firecrawl
web tools were added to `TOOLS` + `BOT_ALLOWED_TOOLS` but run agents still
couldn't call them, because the builder loop filters by `BUILDER_TOOL_NAMES`, a
separate list. "Add to TOOLS" is necessary but not sufficient.

**How to apply:** When adding any built-in tool that run agents should be able to
use, add its name to `BUILDER_TOOL_NAMES` (and mention it in
`BUILDER_SYSTEM_PROMPT` so the model knows it exists). For the bot, add it to
`BOT_ALLOWED_TOOLS`. There is no general per-agent tool-calling loop beyond the
builder loop — don't assume one exists.

# External (live) MCP server tools are a FOURTH surface

Tools discovered from a connected external MCP server ("Connect existing server",
e.g. screen/computer-control) have NO stored recipe (`executionJson` is null) and
their adapter `transport !== "constructed"` with an http(s) `endpointUrl`. They
are NOT in `TOOLS`, `BUILDER_TOOL_NAMES`, or `BOT_ALLOWED_TOOLS`. They become
callable by being surfaced dynamically per-tenant, not by editing any allow-list:
- `capabilityExec.ts`: `isExternalMcpAdapter`, `listExternalMcpToolCapabilities`,
  `resolveExternalMcpCapability` identify them (filter: type==="tool", no recipe,
  external adapter).
- `mcpServer.ts`: `listToolsForTenant` (agent branch) advertises them; `callTool`
  default case, after `executeNamedCapability` returns null, invokes them live via
  `callMcpTool(endpointUrl, name, args)` and returns `{source:"external_mcp",
  content, media, structured}`.
- `runEngine.ts`: builder loop offers them alongside `BUILDER_TOOL_NAMES`, runs
  read-only ones directly, and REFUSES full-control (L3+/humanReviewRequired) ones
  with a "requires approval" message — the actual approval request is created by
  the deterministic `proposeActionsNode` (which also executes non-gated external
  read tools, storing only media *metadata*, never base64, in the DB).

**Why:** the task goal was "paste a hosted screen-control MCP endpoint and its
tools just work with zero onboarding / no manual allow-list edits"; full-control
actions must still route through the existing L3 approval policy, not be dropped.

**How to apply:** never add external MCP tool names to a static allow-list. The
risk tier comes from `discoverAdapter`/`mapToolToCapability` annotations
(destructiveHint→L3+humanReviewRequired, readOnlyHint→L1, else L2). Run-action
approval threshold is `RUN_APPROVAL_THRESHOLD="L3"` (module scope, runEngine.ts);
`RISK_RANK` is also module-scope there.

# MCP image/audio media must be forwarded, never stringified

External tool results carry image/audio content blocks (screenshots). The bridge
is `toToolExecutionResult(out)` in `toolChat.ts` (passes `media` through when
`source==="external_mcp"`, else `JSON.stringify` as before). EVERY tool-calling
loop must use it instead of `JSON.stringify(out)`: builder loop (runEngine), web
bot (chatEngine), telegram bot (telegramEngine). `routes/mcp.ts` tools/call
re-emits media as real MCP image/audio content blocks. `runToolChat` wires media
into all 3 provider paths (Anthropic image blocks, OpenAI image_url follow-up,
Google inlineData); audio degrades to a placeholder text line everywhere.

**Why:** without this, a screenshot reaches the LLM as a useless stringified
base64 blob. Any new tool-calling loop or provider path must thread media too.

# Where to OBSERVE that a built-in/firecrawl tool actually fired

Builder-loop and bot tool calls are recorded in `event_logs`, NOT the
`observations` table. Look for `event_logs.type='agent.tool_call'` (e.g.
"tester2 called firecrawl_scrape") and `agent.builder.started`. The
`observations` table's `tool_call` rows only cover the deterministic
`proposeActionsNode` path, which executes pre-existing DB capabilities and never
offers firecrawl.

**Why:** Verifying "did the agent use firecrawl?" by querying `observations`
returns nothing and looks like a failure even when it worked. A real run reading
a web page logged `agent.tool_call: ... firecrawl_scrape` in `event_logs` while
`observations` only showed an unrelated `get_todo_by_id` from
`proposeActionsNode`. The two paths are independent: the LLM agent's web read
(builder loop) and the run's separate deterministic "actions" do not share a
tool surface.
