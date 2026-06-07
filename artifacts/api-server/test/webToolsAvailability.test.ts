import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Verifies the UNCONFIGURED branch of the Firecrawl web-tool availability
// signalling. This environment normally has FIRECRAWL_API_KEY set, so the
// "not configured" path could previously only be reasoned about, never tested.
//
// We delete FIRECRAWL_API_KEY for the duration of this file (the real
// isFirecrawlConfigured / FIRECRAWL_UNCONFIGURED_NOTICE from lib/firecrawl are
// used — firecrawl is intentionally NOT mocked) and assert all three surfaces
// react: the tool catalog (listToolsForTenant), the bot's per-turn workspace
// snapshot (buildWorkspaceStateBlock), and the GET /web-tools/status route.
//
// @workspace/db is mocked with the same chainable-builder approach as
// chatEngine.test.ts / conversations.test.ts; capabilityExec is stubbed so the
// non-bot catalog path resolves to zero constructed tools without a DB.
// ---------------------------------------------------------------------------
type Row = Record<string, any>;
type Handler = (vals?: any) => Row[];
const registry: {
  select: Record<string, Handler>;
  selectDistinct: Record<string, Handler>;
  insert: Record<string, Handler>;
  update: Record<string, Handler>;
  delete: Record<string, Handler>;
} = { select: {}, selectDistinct: {}, insert: {}, update: {}, delete: {} };

const table = (name: string) => ({ _name: name });
// Every *Table export referenced anywhere in this package's source, so the
// modules transitively imported by mcpServer / contextResources all resolve.
const tables: Record<string, { _name: string }> = Object.fromEntries(
  [
    "actionsTable",
    "adaptersTable",
    "agentMessagesTable",
    "agentModelPoliciesTable",
    "agentRunsTable",
    "agentsTable",
    "apiKeysTable",
    "approvalRequestsTable",
    "artifactsTable",
    "auditRecordsTable",
    "capabilitiesTable",
    "contextFragmentsTable",
    "contextPacksTable",
    "conversationMessagesTable",
    "conversationsTable",
    "deploymentTargetsTable",
    "evaluationRecordsTable",
    "eventLogsTable",
    "generatedMcpServersTable",
    "intentsTable",
    "linkedAccountsTable",
    "membershipsTable",
    "modelEndpointsTable",
    "observationMetricsTable",
    "observationsTable",
    "policyBundlesTable",
    "principalsTable",
    "runsTable",
    "sharedContextGrantsTable",
    "telegramChatsTable",
    "telemetryExportsTable",
    "tenantsTable",
    "tracesTable",
    "uiViewsTable",
    "usersTable",
    "workingMemoriesTable",
    "emailConfigTable",
    "emailAllowedSendersTable",
    "emailThreadsTable",
  ].map((name) => [name, table(name)]),
);

function makeChain(kind: keyof typeof registry) {
  let tbl: any;
  let values: any;
  const chain: any = {
    from(t: any) {
      tbl = t;
      return chain;
    },
    where() {
      return chain;
    },
    orderBy() {
      return chain;
    },
    limit() {
      return chain;
    },
    values(v: any) {
      values = v;
      return chain;
    },
    set() {
      return chain;
    },
    returning() {
      return chain;
    },
    then(resolve: any, reject: any) {
      try {
        const handler = registry[kind][tbl?._name];
        const result = handler ? handler(values) : [];
        return Promise.resolve(result).then(resolve, reject);
      } catch (err) {
        return Promise.reject(err).then(resolve, reject);
      }
    },
  };
  return chain;
}

const db = {
  select: () => makeChain("select"),
  selectDistinct: () => makeChain("selectDistinct"),
  insert: (t: any) => {
    const c = makeChain("insert");
    c.from(t);
    return c;
  },
  update: (t: any) => {
    const c = makeChain("update");
    c.from(t);
    return c;
  },
  delete: (t: any) => {
    const c = makeChain("delete");
    c.from(t);
    return c;
  },
};

mock.module("@workspace/db", { namedExports: { db, ...tables } });

// Stub the constructed-capability layer so the full (non-bot) catalog path in
// listToolsForTenant resolves to zero dynamic tools without touching a DB.
mock.module("../src/lib/capabilityExec", {
  namedExports: {
    executeNamedCapability: mock.fn(async () => ({})),
    executeCapabilityRow: mock.fn(async () => ({})),
    resolveNamedCapability: mock.fn(async () => null),
    recordCapabilityTest: mock.fn(async () => {}),
    lastTestOf: mock.fn(() => null),
    listExecutableCapabilities: mock.fn(async () => []),
    listExternalMcpToolCapabilities: mock.fn(async () => []),
    resolveExternalMcpCapability: mock.fn(async () => null),
    isExternalMcpAdapter: mock.fn(() => false),
    smokeTestImportedTools: mock.fn(async () => {}),
    retestServerTools: mock.fn(async () => {}),
  },
});

const { listToolsForTenant, buildWorkspaceStateBlock } = await import(
  "../src/lib/mcpServer"
);
const { FIRECRAWL_UNCONFIGURED_NOTICE, FIRECRAWL_TOOL_NAMES } = await import(
  "../src/lib/firecrawl"
);

const express = (await import("express")).default;
const request = (await import("supertest")).default;
const contextResourcesRouter = (await import("../src/routes/contextResources"))
  .default;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.tenantId = "t1";
    req.userId = "u1";
    next();
  });
  app.use("/api", contextResourcesRouter);
  return app;
}

function resetRegistry() {
  for (const kind of [
    "select",
    "selectDistinct",
    "insert",
    "update",
    "delete",
  ] as const) {
    registry[kind] = {};
  }
}

const FIRECRAWL_NAMES = new Set<string>(FIRECRAWL_TOOL_NAMES);
let savedKey: string | undefined;

before(() => {
  savedKey = process.env.FIRECRAWL_API_KEY;
  delete process.env.FIRECRAWL_API_KEY;
});

after(() => {
  if (savedKey === undefined) {
    delete process.env.FIRECRAWL_API_KEY;
  } else {
    process.env.FIRECRAWL_API_KEY = savedKey;
  }
});

beforeEach(() => {
  resetRegistry();
  // Confirm the precondition for every test: the key really is unset.
  delete process.env.FIRECRAWL_API_KEY;
});

describe("web-tool availability when FIRECRAWL_API_KEY is unset", () => {
  it("appends the UNCONFIGURED notice to every firecrawl_* tool in the bot catalog", async () => {
    const tools = await listToolsForTenant("t1", {
      kind: "bot",
      agentId: "bot-1",
    });

    const webTools = tools.filter((t) => FIRECRAWL_NAMES.has(t.name));
    // All four built-in web tools are exposed to the bot.
    assert.equal(webTools.length, FIRECRAWL_TOOL_NAMES.length);
    for (const t of webTools) {
      assert.ok(
        t.description.includes(FIRECRAWL_UNCONFIGURED_NOTICE),
        `expected ${t.name} description to carry the unconfigured notice`,
      );
    }
    // Non-web tools must NOT be decorated with the notice.
    const nonWeb = tools.filter((t) => !FIRECRAWL_NAMES.has(t.name));
    for (const t of nonWeb) {
      assert.ok(!t.description.includes(FIRECRAWL_UNCONFIGURED_NOTICE));
    }
  });

  it("appends the UNCONFIGURED notice to firecrawl_* tools in the full agent catalog", async () => {
    const tools = await listToolsForTenant("t1");

    const webTools = tools.filter((t) => FIRECRAWL_NAMES.has(t.name));
    assert.equal(webTools.length, FIRECRAWL_TOOL_NAMES.length);
    for (const t of webTools) {
      assert.ok(
        t.description.includes(FIRECRAWL_UNCONFIGURED_NOTICE),
        `expected ${t.name} description to carry the unconfigured notice`,
      );
    }
  });

  it("emits the UNAVAILABLE web-access line in the workspace-state snapshot", async () => {
    const block = await buildWorkspaceStateBlock("t1");
    assert.match(block, /Web access \(Firecrawl\): UNAVAILABLE/);
    assert.match(block, /FIRECRAWL_API_KEY secret is not/);
    // Must not claim availability when the key is missing.
    assert.ok(!/Web access \(Firecrawl\): AVAILABLE/.test(block));
  });

  it("reports configured:false from GET /web-tools/status", async () => {
    const res = await request(makeApp()).get("/api/web-tools/status");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { configured: false });
  });
});
