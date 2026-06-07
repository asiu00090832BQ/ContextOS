import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// End-to-end exercise of the owner-facing email flow through the SAME path the
// ContextOS bot uses: `callTool` with a bot caller, dispatching to the REAL
// emailAdmin service, the REAL agentmail client, and the REAL audit logger.
//
// Only two boundaries are faked:
//   1. @workspace/db   — a tiny stateful in-memory store so we can assert that
//                        the email channel state actually changes (config row,
//                        allow-list rows) and that audit records are written.
//   2. @replit/connectors-sdk — AgentMail's NETWORK boundary. The real
//                        agentmail.ts code runs; only the proxy HTTP call is
//                        intercepted and answered with canned Responses.
//
// ./firecrawl is mocked exactly as the other api-server tests do so that
// importing mcpServer (which pulls firecrawl in transitively) resolves.
// ---------------------------------------------------------------------------

// --- (1) stateful @workspace/db -------------------------------------------
type Row = Record<string, any>;
const store: Record<string, Row[]> = {};

const table = (name: string) => ({ _name: name });
// Every DB table mcpServer's import graph references as a NAMED import must be
// exported here, or ESM resolution fails hard (see contextos-test-db-mock).
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
  // Email tables: needed because the REAL emailAdmin/audit are imported here.
  "emailConfigTable", "emailAllowedSendersTable", "emailThreadsTable",
];

function makeChain(kind: "select" | "insert" | "update" | "delete", tbl?: any) {
  let target = tbl;
  let values: any;
  let setVals: any;
  const chain: any = {
    from(t: any) {
      target = t;
      return chain;
    },
    where() {
      return chain;
    },
    orderBy() {
      return chain;
    },
    values(v: any) {
      values = v;
      return chain;
    },
    set(v: any) {
      setVals = v;
      return chain;
    },
    onConflictDoNothing() {
      return chain;
    },
    returning() {
      return chain;
    },
    then(resolve: any, reject: any) {
      try {
        const name = target?._name as string;
        const rows = (store[name] ??= []);
        let result: Row[] = [];
        if (kind === "select") {
          // `where` is intentionally ignored — the suite uses a single tenant,
          // so returning the whole table is equivalent for these reads.
          result = [...rows];
        } else if (kind === "insert") {
          const row = { id: randomUUID(), createdAt: new Date(), ...values };
          rows.push(row);
          result = [row];
        } else if (kind === "update") {
          for (const r of rows) Object.assign(r, setVals);
          result = [...rows];
        } else if (kind === "delete") {
          result = rows.splice(0, rows.length);
        }
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
  selectDistinct: () => makeChain("select"),
  insert: (t: any) => makeChain("insert", t),
  update: (t: any) => makeChain("update", t),
  delete: (t: any) => makeChain("delete", t),
};

const dbNamedExports: Record<string, unknown> = { db };
for (const name of TABLE_EXPORTS) dbNamedExports[name] = table(name);
mock.module("@workspace/db", { namedExports: dbNamedExports });

// --- firecrawl (import-resolution only) -----------------------------------
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

// --- (2) AgentMail network boundary ---------------------------------------
interface ProxyCall {
  method: string;
  path: string;
  body?: any;
}
const proxyCalls: ProxyCall[] = [];

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const INBOX = { inbox_id: "inbox_1", email: "bot@agentmail.test" };

class ReplitConnectors {
  async proxy(
    _connector: string,
    path: string,
    init?: { method?: string; body?: string },
  ): Promise<Response> {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    proxyCalls.push({ method, path, body });

    if (path === "/v0/inboxes" && method === "GET") {
      return jsonResponse({ inboxes: [INBOX] });
    }
    if (path === "/v0/webhooks" && method === "POST") {
      return jsonResponse({
        webhook_id: "wh_1",
        url: body?.url,
        secret: "whsec_dGVzdHNlY3JldA==",
        event_types: body?.event_types ?? ["message.received"],
        enabled: true,
      });
    }
    if (/^\/v0\/webhooks\/[^/]+$/.test(path) && method === "DELETE") {
      return jsonResponse({}, 200);
    }
    if (/^\/v0\/inboxes\/[^/]+\/messages$/.test(path) && method === "POST") {
      return jsonResponse({ message_id: "msg_out_1", thread_id: "thread_out_1" });
    }
    return jsonResponse({ error: { message: `unexpected ${method} ${path}` } }, 404);
  }
}
mock.module("@replit/connectors-sdk", {
  namedExports: { ReplitConnectors },
});

// mcp.module is NOT hoisted, so import the SUT only after registering mocks.
const { callTool } = await import("../src/lib/mcpServer");
// Validation failures from the shared service surface as EmailAdminError, which
// callTool propagates unwrapped.
const { EmailAdminError } = await import("../src/lib/emailAdmin");

const TENANT = "tenant-1";
const USER = "user-1";
const BOT = { kind: "bot" as const, agentId: "bot-agent-1" };

function audits(): Row[] {
  return store["auditRecordsTable"] ?? [];
}
function auditFor(action: string): Row | undefined {
  return audits().find((a) => a.action === action);
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  proxyCalls.length = 0;
});

describe("email channel end-to-end via the bot tool path", () => {
  it("connects, manages the allow-list, sends mail, and audits every step", async () => {
    // --- status (before setup): reachable network, but no inbox yet --------
    const before = (await callTool(TENANT, USER, "email_status", {}, BOT)) as any;
    assert.equal(before.connected, true, "AgentMail proxy should report connected");
    assert.equal(before.inbox, null, "no inbox configured yet");
    assert.equal(before.webhook.configured, false);
    assert.deepEqual(before.allowedSenders, []);

    // --- connect the channel (provision inbox + register webhook) ----------
    const connected = (await callTool(
      TENANT,
      USER,
      "connect_email",
      { baseUrl: "https://app.example.com" },
      BOT,
    )) as any;
    assert.equal(connected.inbox.email, INBOX.email);
    assert.equal(connected.url, "https://app.example.com/api/email/webhook");

    // The webhook was registered over the (mocked) network boundary.
    const webhookCall = proxyCalls.find(
      (c) => c.path === "/v0/webhooks" && c.method === "POST",
    );
    assert.ok(webhookCall, "createWebhook should hit the AgentMail proxy");
    assert.equal(webhookCall!.body.url, "https://app.example.com/api/email/webhook");

    // Channel state changed: a config row now exists with the webhook + secret.
    const [config] = store["emailConfigTable"];
    assert.ok(config, "email_config row persisted");
    assert.equal(config.inboxEmail, INBOX.email);
    assert.equal(config.webhookId, "wh_1");
    assert.equal(config.webhookSecret, "whsec_dGVzdHNlY3JldA==");

    // --- status (after setup): inbox + webhook now reported ----------------
    const after = (await callTool(TENANT, USER, "email_status", {}, BOT)) as any;
    assert.equal(after.inbox.email, INBOX.email);
    assert.equal(after.webhook.configured, true);
    assert.equal(after.enabled, true);

    // --- add an allowed sender --------------------------------------------
    const added = (await callTool(
      TENANT,
      USER,
      "add_allowed_email_sender",
      { address: "Alice <Alice@Example.com>" },
      BOT,
    )) as any;
    // Address is normalized to a bare, lowercased form.
    assert.equal(added.address, "alice@example.com");
    assert.equal(store["emailAllowedSendersTable"].length, 1);
    assert.equal(
      store["emailAllowedSendersTable"][0].address,
      "alice@example.com",
    );

    // The allow-list change is visible through status.
    const withSender = (await callTool(
      TENANT,
      USER,
      "email_status",
      {},
      BOT,
    )) as any;
    assert.deepEqual(
      withSender.allowedSenders.map((s: any) => s.address),
      ["alice@example.com"],
    );

    // --- send a brand-new email -------------------------------------------
    const sent = (await callTool(
      TENANT,
      USER,
      "send_email",
      { to: "bob@acme.com", subject: "Hello", text: "Hi Bob, this is the bot." },
      BOT,
    )) as any;
    assert.equal(sent.messageId, "msg_out_1");
    assert.equal(sent.to, "bob@acme.com");
    assert.equal(sent.from, INBOX.email);
    assert.equal(sent.subject, "Hello");

    // The outbound message went out over the network boundary with our args.
    const sendCall = proxyCalls.find(
      (c) =>
        /^\/v0\/inboxes\/[^/]+\/messages$/.test(c.path) && c.method === "POST",
    );
    assert.ok(sendCall, "sendMessage should hit the AgentMail proxy");
    assert.deepEqual(sendCall!.body.to, ["bob@acme.com"]);
    assert.equal(sendCall!.body.subject, "Hello");
    assert.equal(sendCall!.body.text, "Hi Bob, this is the bot.");

    // --- audit trail: every owner-facing mutation recorded as the bot ------
    const connectAudit = auditFor("email.webhook_configured");
    const allowAudit = auditFor("email.sender_allowed");
    const sentAudit = auditFor("email.sent");
    assert.ok(connectAudit, "connect was audited");
    assert.ok(allowAudit, "allow-list add was audited");
    assert.ok(sentAudit, "send was audited");
    for (const rec of [connectAudit!, allowAudit!, sentAudit!]) {
      assert.equal(rec.actorType, "agent");
      assert.equal(rec.actorId, BOT.agentId);
      assert.equal(rec.agentId, BOT.agentId);
      assert.equal(rec.tenantId, TENANT);
    }
    assert.match(sentAudit!.summary, /bob@acme\.com/);
    assert.match(allowAudit!.summary, /alice@example\.com/);
  });

  it("refuses to send before the channel is set up, and audits nothing", async () => {
    await assert.rejects(
      callTool(
        TENANT,
        USER,
        "send_email",
        { to: "bob@acme.com", text: "Hi" },
        BOT,
      ),
      (err: unknown) => {
        assert.ok(err instanceof EmailAdminError);
        assert.match((err as Error).message, /not set up/i);
        return true;
      },
    );
    // No outbound network call and no audit record for an unconfigured channel.
    assert.equal(
      proxyCalls.some((c) => c.path.includes("/messages")),
      false,
    );
    assert.equal(auditFor("email.sent"), undefined);
  });

  it("rejects an invalid recipient before reaching the network", async () => {
    // Set up the channel first so we get past the "not set up" guard.
    await callTool(
      TENANT,
      USER,
      "connect_email",
      { baseUrl: "https://app.example.com" },
      BOT,
    );
    proxyCalls.length = 0;

    await assert.rejects(
      callTool(
        TENANT,
        USER,
        "send_email",
        { to: "not-an-email", text: "Hi" },
        BOT,
      ),
      (err: unknown) => {
        assert.ok(err instanceof EmailAdminError);
        return true;
      },
    );
    assert.equal(
      proxyCalls.some((c) => c.path.includes("/messages")),
      false,
      "invalid recipient must be rejected before any network send",
    );
  });
});
