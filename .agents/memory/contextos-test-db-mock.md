---
name: api-server test @workspace/db mock table list
description: Why adding a new DB table can break unrelated api-server tests, and the mcpServer import-graph fragility behind it.
---

Several api-server tests (e.g. `firecrawlDispatch.test.ts`, `webToolsAvailability.test.ts`) `mock.module("@workspace/db", ...)` with a **hardcoded list of every table export**. Importing `mcpServer` pulls its whole transitive graph, so if `mcpServer` (directly or transitively) starts importing a module that reads a new table, every such test fails with `does not provide an export named '<table>Table'` until that table name is appended to each test's list.

**Why:** the mock only provides the names it enumerates; a missing one is a hard ESM resolution error, not a soft undefined.

**How to apply:** when you add a DB table that becomes reachable from `mcpServer`'s import graph, grep the test dir for the table-export lists and add the new table to each. To avoid dragging heavy/transitive modules into `mcpServer` at all, keep shared helpers (e.g. pure address normalization) in a tiny leaf module rather than re-importing a big engine module — this also prevents accidental import cycles (`mcpServer → service → engine → mcpServer`). Such cycles are runtime-safe only while no cycle edge is dereferenced at module top-level; prefer extracting a leaf util over relying on that.
