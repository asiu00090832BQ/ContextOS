---
name: Web-tool availability signalling
description: How the built-in Firecrawl web tools' configured/unconfigured state must be surfaced everywhere, not only fail at call time.
---

# Built-in web tools (Firecrawl) availability signalling

`isFirecrawlConfigured()` (from `lib/firecrawl.ts`) gates whether the built-in web
tools (`firecrawl_scrape`/`search`/`map`/`crawl`) work. When the FIRECRAWL_API_KEY
secret is missing they only failed at call time — surface the unavailable state up
front instead.

**Rule:** any change to whether web access is configured must be reflected on all
four caller-facing surfaces, because each is a separate code path:
1. Tool catalog — `listToolsForTenant` in `mcpServer.ts` appends
   `FIRECRAWL_UNCONFIGURED_NOTICE` to each web tool's description (both the bot
   branch and the full-catalog branch, via `decorateWebToolAvailability`). The run
   builder loop inherits this because it filters the same catalog.
2. Bot context — `buildWorkspaceStateBlock` adds a "Web access (Firecrawl):
   AVAILABLE/UNAVAILABLE" line to the per-turn snapshot (covers both bot paths).
3. Run agents — `builderSystemPrompt()` in `runEngine.ts` swaps its web-access
   paragraph based on config (was a static const claiming "always-available").
4. Web UI — `GET /api/web-tools/status` (`routes/contextResources.ts`, returns
   `{configured}`, raw fetch not OpenAPI) → "Web Access" card on the Settings page.

`FIRECRAWL_TOOL_NAMES` + `FIRECRAWL_UNCONFIGURED_NOTICE` are the shared source of
truth in `lib/firecrawl.ts` — reuse them, don't re-list the tool names inline.

**Why:** agents/bot otherwise burn a run discovering web access is off only when a
call fails, and keep retrying.
