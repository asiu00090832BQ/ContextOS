import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Dispatch test: the 4 Firecrawl tools must route through `callTool`, and a
// FirecrawlError thrown by the client must surface as the standard
// McpToolError (so MCP/agent/bot callers see a clean tool error).
//
// `firecrawl.ts` is fully mocked here — we only verify routing + error
// translation, not the client internals (covered in firecrawl.test.ts).
// @workspace/db is mocked so importing mcpServer never touches a real DB.
// ---------------------------------------------------------------------------
const table = (name: string) => ({ _name: name });
const db = {
  select: () => ({
    from: () => ({ where: () => ({ orderBy: () => [] }) }),
  }),
};
// Provide every table export the api-server schema defines so importing
// mcpServer (and its transitive deps) resolves without a real DB.
const TABLE_EXPORTS = [
  "actionsTable", "adaptersTable", "agentMessagesTable", "agentModelPoliciesTable",
  "agentRunsTable", "agentsTable", "apiKeysTable", "approvalRequestsTable",
  "artifactsTable", "auditRecordsTable", "capabilitiesTable", "contextFragmentsTable",
  "contextPacksTable", "conversationMessagesTable", "conversationsTable",
  "deploymentTargetsTable", "evaluationRecordsTable", "eventLogsTable",
  "generatedMcpServersTable", "integrationBlueprintsTable", "integrationTestsTable",
  "intentsTable", "linkedAccountsTable", "membershipsTable", "modelEndpointsTable",
  "observationMetricsTable", "observationsTable", "policyBundlesTable",
  "principalsTable", "runsTable", "sharedContextGrantsTable", "synthesisRunsTable",
  "synthesizedCapabilitiesTable", "telegramChatsTable", "telemetryExportsTable",
  "tenantsTable", "tracesTable", "uiViewsTable", "usersTable", "workingMemoriesTable",
];
const dbNamedExports: Record<string, unknown> = { db };
for (const name of TABLE_EXPORTS) dbNamedExports[name] = table(name);
mock.module("@workspace/db", { namedExports: dbNamedExports });

// Mocked Firecrawl client. Each tool returns a distinct sentinel so we can
// confirm `callTool` routes the right name to the right function. The mocked
// FirecrawlError class is the SAME class mcpServer imports, so the
// `instanceof FirecrawlError` check in its translation wrapper matches.
class FirecrawlError extends Error {}
const firecrawlScrape = mock.fn(async () => ({ tool: "scrape" }));
const firecrawlSearch = mock.fn(async () => ({ tool: "search" }));
const firecrawlMap = mock.fn(async () => ({ tool: "map" }));
const firecrawlCrawl = mock.fn(async () => ({ tool: "crawl" }));
mock.module("../src/lib/firecrawl", {
  namedExports: {
    FirecrawlError,
    firecrawlScrape,
    firecrawlSearch,
    firecrawlMap,
    firecrawlCrawl,
    // mcpServer also imports the availability helpers from this module; provide
    // them so importing the SUT resolves. Dispatch runs as if configured.
    isFirecrawlConfigured: () => true,
    FIRECRAWL_TOOL_NAMES: [
      "firecrawl_scrape",
      "firecrawl_search",
      "firecrawl_map",
      "firecrawl_crawl",
    ],
    FIRECRAWL_UNCONFIGURED_NOTICE: "UNAVAILABLE — web access is not configured.",
  },
});

const { callTool, McpToolError } = await import("../src/lib/mcpServer");

const allFns = [firecrawlScrape, firecrawlSearch, firecrawlMap, firecrawlCrawl];

beforeEach(() => {
  for (const f of allFns) {
    f.mock.resetCalls();
    f.mock.mockImplementation(async () => ({ ok: true }));
  }
});

describe("callTool Firecrawl dispatch", () => {
  const cases: Array<[string, () => any]> = [
    ["firecrawl_scrape", () => firecrawlScrape],
    ["firecrawl_search", () => firecrawlSearch],
    ["firecrawl_map", () => firecrawlMap],
    ["firecrawl_crawl", () => firecrawlCrawl],
  ];

  for (const [name, getFn] of cases) {
    it(`routes ${name} to its client function with the args`, async () => {
      const args = { url: "https://example.com", q: name };
      const result = await callTool("t1", "u1", name, args);

      const fn = getFn();
      assert.equal(fn.mock.callCount(), 1);
      assert.deepEqual(fn.mock.calls[0].arguments[0], args);
      assert.deepEqual(result, { ok: true });

      // Only the routed tool ran; the others stayed untouched.
      for (const other of allFns) {
        if (other !== fn) assert.equal(other.mock.callCount(), 0);
      }
    });
  }

  it("translates a FirecrawlError into an McpToolError", async () => {
    firecrawlScrape.mock.mockImplementation(async () => {
      throw new FirecrawlError("Firecrawl web tools are not configured.");
    });

    await assert.rejects(
      callTool("t1", "u1", "firecrawl_scrape", { url: "https://example.com" }),
      (err: unknown) => {
        assert.ok(err instanceof McpToolError);
        assert.match((err as Error).message, /not configured/);
        return true;
      },
    );
  });

  it("blocks the bot from running Firecrawl tools itself", async () => {
    // The bot is allow-listed for the Firecrawl tools (it can run them), so
    // routing still happens for a bot caller — confirming the allow-list path.
    await callTool("t1", "u1", "firecrawl_search", { query: "x" }, {
      kind: "bot",
      agentId: "bot-agent",
    });
    assert.equal(firecrawlSearch.mock.callCount(), 1);
  });
});
