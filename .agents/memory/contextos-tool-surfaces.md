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
