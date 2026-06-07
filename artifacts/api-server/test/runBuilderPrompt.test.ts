import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Covers the FOURTH web-access availability surface (task #44 covered the other
// three): the run-builder system prompt. builderSystemPrompt() chooses its
// web-access paragraph from the REAL isFirecrawlConfigured(), so a regression
// that reverted the unconfigured branch back to "always-available" wording
// would let run agents discover web access is off only when a call fails.
//
// firecrawl is intentionally NOT mocked — we toggle FIRECRAWL_API_KEY and call
// the real function. @workspace/db and capabilityExec are stubbed only so
// runEngine's import graph resolves (the prompt itself touches neither).
// ---------------------------------------------------------------------------
const table = (name: string) => ({ _name: name });
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
    "emailDroppedSendersTable",
  ].map((name) => [name, table(name)]),
);

function makeChain() {
  const chain: any = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    values: () => chain,
    set: () => chain,
    onConflictDoNothing: () => chain,
    onConflictDoUpdate: () => chain,
    returning: () => chain,
    then: (resolve: any) => Promise.resolve([]).then(resolve),
  };
  return chain;
}

const db = {
  select: () => makeChain(),
  selectDistinct: () => makeChain(),
  insert: () => makeChain(),
  update: () => makeChain(),
  delete: () => makeChain(),
};

mock.module("@workspace/db", { namedExports: { db, ...tables } });

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

const { builderSystemPrompt } = await import("../src/lib/runEngine");

let savedKey: string | undefined;
before(() => {
  savedKey = process.env.FIRECRAWL_API_KEY;
});
after(() => {
  if (savedKey === undefined) delete process.env.FIRECRAWL_API_KEY;
  else process.env.FIRECRAWL_API_KEY = savedKey;
});

describe("builderSystemPrompt web-access wording", () => {
  it("warns that web tools will fail when FIRECRAWL_API_KEY is unset", () => {
    delete process.env.FIRECRAWL_API_KEY;
    const prompt = builderSystemPrompt();
    assert.match(
      prompt,
      /NOT available because the FIRECRAWL_API_KEY secret is not configured/,
    );
    assert.match(prompt, /these tools will fail/);
    assert.match(prompt, /web access needs to be set up/i);
    // Must NOT claim availability when the key is missing.
    assert.ok(
      !/always-available built-in web access/.test(prompt),
      "unconfigured prompt should not promise always-available web access",
    );
  });

  it("tells the agent web access is available when FIRECRAWL_API_KEY is set", () => {
    process.env.FIRECRAWL_API_KEY = "fc-test-key";
    const prompt = builderSystemPrompt();
    assert.match(prompt, /always-available built-in web access via Firecrawl/);
    assert.match(prompt, /DEFAULT for ALL web access/);
    // Must NOT carry the "will fail" warning when the key is present.
    assert.ok(
      !/these tools will fail/.test(prompt),
      "configured prompt should not warn that tools will fail",
    );
  });
});
