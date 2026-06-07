import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// The bot's email tools must (a) be advertised in the catalog AND to a bot
// caller (BOT_ALLOWED_TOOLS), and (b) route through `callTool` to the shared
// emailAdmin service with the right args. `emailAdmin` is fully mocked here so
// the test never touches AgentMail or a real DB — we verify wiring only.
// @workspace/db and ./firecrawl are mocked so importing mcpServer resolves.
// ---------------------------------------------------------------------------
const table = (name: string) => ({ _name: name });
const db = {
  select: () => ({
    from: () => ({ where: () => ({ orderBy: () => [] }) }),
  }),
};
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

mock.module("../src/lib/firecrawl", {
  namedExports: {
    FirecrawlError: class extends Error {},
    firecrawlScrape: mock.fn(),
    firecrawlSearch: mock.fn(),
    firecrawlMap: mock.fn(),
    firecrawlCrawl: mock.fn(),
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

// Mocked shared email-admin service. Each function returns a distinct sentinel
// so we can confirm `callTool` routes the right tool name to the right function
// with the expected arguments.
const getEmailStatus = mock.fn(async () => ({ tool: "status" }));
const connectEmail = mock.fn(async () => ({ inbox: { email: "x@y.z" }, url: "u" }));
const disconnectEmail = mock.fn(async () => ({ ok: true }));
const setEmailEnabled = mock.fn(async () => ({ enabled: true }));
const listAllowedSenders = mock.fn(async () => []);
const addAllowedSender = mock.fn(async () => ({ id: "1", address: "a@b.c" }));
const removeAllowedSenderByAddress = mock.fn(async () => ({
  removed: true,
  address: "a@b.c",
}));
const sendEmail = mock.fn(async () => ({
  messageId: "m1",
  to: "bob@acme.com",
  from: "x@y.z",
  subject: "Hi",
}));
mock.module("../src/lib/emailAdmin", {
  namedExports: {
    getEmailStatus,
    connectEmail,
    disconnectEmail,
    setEmailEnabled,
    listAllowedSenders,
    addAllowedSender,
    removeAllowedSenderByAddress,
    sendEmail,
    EmailAdminError: class extends Error {},
  },
});

const { callTool, McpToolError, TOOLS, listToolsForTenant } = await import(
  "../src/lib/mcpServer"
);

const EMAIL_TOOL_NAMES = [
  "email_status",
  "connect_email",
  "disconnect_email",
  "set_email_enabled",
  "list_allowed_email_senders",
  "add_allowed_email_sender",
  "remove_allowed_email_sender",
  "send_email",
];

const allFns = [
  getEmailStatus,
  connectEmail,
  disconnectEmail,
  setEmailEnabled,
  listAllowedSenders,
  addAllowedSender,
  removeAllowedSenderByAddress,
  sendEmail,
];

beforeEach(() => {
  for (const f of allFns) f.mock.resetCalls();
});

describe("bot email tools", () => {
  it("advertises every email tool in the catalog", () => {
    const names = new Set(TOOLS.map((t) => t.name));
    for (const n of EMAIL_TOOL_NAMES) {
      assert.ok(names.has(n), `${n} missing from TOOLS`);
    }
  });

  it("exposes every email tool to a bot caller", async () => {
    const tools = await listToolsForTenant("t1", {
      kind: "bot",
      agentId: "bot-agent",
    });
    const names = new Set(tools.map((t) => t.name));
    for (const n of EMAIL_TOOL_NAMES) {
      assert.ok(names.has(n), `${n} not allow-listed for the bot`);
    }
  });

  it("routes email_status to the service", async () => {
    const result = await callTool("t1", "u1", "email_status", {});
    assert.equal(getEmailStatus.mock.callCount(), 1);
    assert.deepEqual(getEmailStatus.mock.calls[0].arguments[0], "t1");
    assert.deepEqual(result, { tool: "status" });
  });

  it("routes send_email with the recipient/subject/body", async () => {
    const bot = { kind: "bot" as const, agentId: "bot-agent" };
    await callTool(
      "t1",
      "u1",
      "send_email",
      { to: "bob@acme.com", subject: "Hi", text: "Hello there" },
      bot,
    );
    assert.equal(sendEmail.mock.callCount(), 1);
    const arg = sendEmail.mock.calls[0].arguments[0] as Record<string, unknown>;
    assert.equal(arg.tenantId, "t1");
    assert.equal(arg.to, "bob@acme.com");
    assert.equal(arg.subject, "Hi");
    assert.equal(arg.text, "Hello there");
    // Bot caller is recorded as the audit actor (agent).
    assert.deepEqual(arg.actor, {
      actorType: "agent",
      actorId: "bot-agent",
      agentId: "bot-agent",
    });
  });

  it("routes send_email with an HTML body and attachments", async () => {
    const bot = { kind: "bot" as const, agentId: "bot-agent" };
    await callTool(
      "t1",
      "u1",
      "send_email",
      {
        to: "bob@acme.com",
        subject: "Report",
        text: "See attached.",
        html: "<p>See <b>attached</b>.</p>",
        attachments: [
          {
            filename: "report.pdf",
            content: "JVBERi0=",
            contentType: "application/pdf",
          },
          { filename: "notes.txt", content: "aGVsbG8=" },
        ],
      },
      bot,
    );
    assert.equal(sendEmail.mock.callCount(), 1);
    const arg = sendEmail.mock.calls[0].arguments[0] as Record<string, unknown>;
    assert.equal(arg.html, "<p>See <b>attached</b>.</p>");
    assert.deepEqual(arg.attachments, [
      {
        filename: "report.pdf",
        content: "JVBERi0=",
        contentType: "application/pdf",
      },
      { filename: "notes.txt", content: "aGVsbG8=", contentType: undefined },
    ]);
  });

  it("omits html/attachments for a plain-text send", async () => {
    await callTool("t1", "u1", "send_email", {
      to: "bob@acme.com",
      text: "Just text",
    });
    assert.equal(sendEmail.mock.callCount(), 1);
    const arg = sendEmail.mock.calls[0].arguments[0] as Record<string, unknown>;
    assert.equal(arg.html, undefined);
    assert.equal(arg.attachments, undefined);
  });

  it("advertises html and attachments on the send_email schema", () => {
    const tool = TOOLS.find((t) => t.name === "send_email");
    assert.ok(tool, "send_email tool missing");
    const props = (tool.inputSchema as { properties: Record<string, unknown> })
      .properties;
    assert.ok(props.html, "html not advertised");
    assert.ok(props.attachments, "attachments not advertised");
  });

  it("routes allow-list add/remove by address", async () => {
    await callTool("t1", "u1", "add_allowed_email_sender", {
      address: "alice@example.com",
    });
    assert.equal(addAllowedSender.mock.callCount(), 1);
    assert.equal(
      (addAllowedSender.mock.calls[0].arguments[0] as { address: string })
        .address,
      "alice@example.com",
    );

    await callTool("t1", "u1", "remove_allowed_email_sender", {
      address: "alice@example.com",
    });
    assert.equal(removeAllowedSenderByAddress.mock.callCount(), 1);
  });

  it("rejects set_email_enabled without a boolean", async () => {
    await assert.rejects(
      callTool("t1", "u1", "set_email_enabled", {}),
      (err: unknown) => {
        assert.ok(err instanceof McpToolError);
        return true;
      },
    );
    assert.equal(setEmailEnabled.mock.callCount(), 0);
  });

  it("toggles incoming mail via set_email_enabled", async () => {
    await callTool("t1", "u1", "set_email_enabled", { enabled: false });
    assert.equal(setEmailEnabled.mock.callCount(), 1);
    assert.equal(
      (setEmailEnabled.mock.calls[0].arguments[0] as { enabled: boolean })
        .enabled,
      false,
    );
  });
});
