import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// End-to-end exercise of the INBOUND email flow: an external person emails the
// bot's inbox, AgentMail POSTs a Svix-signed `message.received` event to
// /api/email/webhook, and the REAL emailWebhookRouter decides whether to answer
// (allow-listed sender) or silently ignore it (everyone else / loop / bad sig).
//
// What is REAL: the webhook router, signature verification, the loop guard, and
// the whole `handleEmailMessage` engine (conversation/message persistence, tool
// catalog, memory block, prompt composition) — so we assert real side effects.
//
// What is faked at a boundary:
//   1. @workspace/db          — a stateful in-memory store (same pattern as
//                               emailFlow.test) so message/conversation rows and
//                               the seeded config are observable.
//   2. @replit/connectors-sdk — AgentMail's NETWORK boundary. The real
//                               agentmail.ts runs; only the proxy HTTP call is
//                               intercepted, so a sent reply shows up as a
//                               /reply POST in `proxyCalls`.
//   3. ../src/lib/toolChat    — `runToolChat` is mocked to a fixed reply so the
//                               model call is deterministic (no network, no key).
//   4. ../src/lib/emailEngine — re-exported REAL, with ONLY `isSenderAllowed`
//                               overridden by a controllable allow-list set, so
//                               the allow-list decision is deterministic without
//                               depending on the where-ignoring db mock.
//   5. ./firecrawl            — stubbed for import resolution (as other tests do).
// ---------------------------------------------------------------------------

// --- (1) stateful @workspace/db -------------------------------------------
type Row = Record<string, any>;
const store: Record<string, Row[]> = {};

const table = (name: string) => ({ _name: name });
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
  "emailConfigTable", "emailAllowedSendersTable", "emailThreadsTable",
  "emailDroppedSendersTable",
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
    limit() {
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
    onConflictDoUpdate() {
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
    // In-thread reply to a received message.
    if (
      /^\/v0\/inboxes\/[^/]+\/messages\/[^/]+\/reply$/.test(path) &&
      method === "POST"
    ) {
      return jsonResponse({ message_id: "msg_reply_1", thread_id: "thread_in_1" });
    }
    return jsonResponse({ error: { message: `unexpected ${method} ${path}` } }, 404);
  }
}
mock.module("@replit/connectors-sdk", {
  namedExports: { ReplitConnectors },
});

// --- (3) deterministic model call -----------------------------------------
// Keep every other toolChat export REAL (llm.ts and others import constants like
// MANAGED_ANTHROPIC_MODEL from here) — override ONLY the model call.
const realToolChat = await import("../src/lib/toolChat");
const FIXED_REPLY = "Thanks for reaching out — here is your answer.";
const runToolChat = mock.fn(async () => ({
  text: FIXED_REPLY,
  modelLabel: "test-model",
}));
mock.module("../src/lib/toolChat", {
  namedExports: { ...realToolChat, runToolChat },
});

// --- (4) controllable allow-list -------------------------------------------
// Import the REAL emailEngine (binds to the mocks above), then re-export it with
// ONLY isSenderAllowed overridden so the allow-list decision is deterministic.
const realEmailEngine = await import("../src/lib/emailEngine");
const allowedSenders = new Set<string>();
const isSenderAllowed = mock.fn(async (_tenantId: string, from: string) =>
  allowedSenders.has(realEmailEngine.normalizeAddress(from)),
);
mock.module("../src/lib/emailEngine", {
  namedExports: { ...realEmailEngine, isSenderAllowed },
});

// mock.module is NOT hoisted — import the SUT only after every mock is set up.
const express = (await import("express")).default;
const request = (await import("supertest")).default;
const { emailWebhookRouter } = await import("../src/routes/email");

// --- webhook secret + Svix signing ----------------------------------------
const WEBHOOK_SECRET = "whsec_" + Buffer.from("inbound-test-key").toString("base64");

function sign(
  secret: string,
  id: string,
  timestamp: string,
  rawBody: string,
): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest("base64");
  return `v1,${sig}`;
}

function makeApp() {
  const app = express();
  // Mirror app.ts: stash the byte-exact raw body for Svix verification.
  app.use(
    express.json({
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use("/api", emailWebhookRouter);
  return app;
}

interface DeliverOpts {
  signature?: string; // override the signature header (e.g. tamper)
  timestamp?: string; // override the svix-timestamp (e.g. stale)
}

function buildEvent(opts: {
  from?: string;
  eventType?: string;
  subject?: string;
  text?: string;
  inboxId?: string;
  // Drop required message fields to simulate a malformed/misrouted delivery.
  omit?: Array<"from" | "thread_id" | "message_id">;
}): Record<string, unknown> {
  const omit = new Set(opts.omit ?? []);
  const message: Record<string, unknown> = {
    inbox_id: opts.inboxId ?? INBOX.inbox_id,
    thread_id: "thread_in_1",
    message_id: "msg_in_1",
    from: opts.from ?? "alice@example.com",
    subject: opts.subject ?? "A question",
    text: opts.text ?? "Hello bot, can you help me?",
  };
  for (const field of omit) delete message[field];
  return {
    type: "event",
    event_type: opts.eventType ?? "message.received",
    event_id: "evt_" + randomUUID(),
    message,
  };
}

async function deliver(
  event: Record<string, unknown>,
  deliverOpts: DeliverOpts = {},
) {
  const raw = JSON.stringify(event);
  const id = "msg_" + randomUUID();
  const timestamp =
    deliverOpts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = deliverOpts.signature ?? sign(WEBHOOK_SECRET, id, timestamp, raw);
  return request(makeApp())
    .post("/api/email/webhook")
    .set("content-type", "application/json")
    .set("svix-id", id)
    .set("svix-timestamp", timestamp)
    .set("svix-signature", signature)
    .send(raw);
}

// The webhook acks (200) BEFORE processing the message out of band, so wait for
// the side effects (or for a quiet period) before asserting.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 1500): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await sleep(5);
  }
  return pred();
}

function replyCalls(): ProxyCall[] {
  return proxyCalls.filter((c) => /\/reply$/.test(c.path) && c.method === "POST");
}
function messageRows(): Row[] {
  return store["conversationMessagesTable"] ?? [];
}

function seedConfig(over: Partial<Row> = {}): void {
  (store["emailConfigTable"] ??= []).push({
    id: randomUUID(),
    tenantId: "tenant-1",
    inboxId: INBOX.inbox_id,
    inboxEmail: INBOX.email,
    webhookId: "wh_1",
    webhookSecret: WEBHOOK_SECRET,
    enabled: true,
    createdAt: new Date(),
    ...over,
  });
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  proxyCalls.length = 0;
  allowedSenders.clear();
  runToolChat.mock.resetCalls();
  isSenderAllowed.mock.resetCalls();
});

describe("inbound email webhook end-to-end", () => {
  it("answers an allow-listed sender in-thread and persists the exchange", async () => {
    seedConfig();
    allowedSenders.add("alice@example.com");

    const res = await deliver(
      buildEvent({ from: "Alice <alice@example.com>", text: "What is ContextOS?" }),
    );
    // Valid signature → acknowledged immediately.
    assert.equal(res.status, 200);

    // The bot replied in-thread over the (mocked) AgentMail network boundary.
    const replied = await waitFor(() => replyCalls().length === 1);
    assert.ok(replied, "an in-thread reply should be sent");
    const reply = replyCalls()[0];
    assert.match(
      reply.path,
      /^\/v0\/inboxes\/inbox_1\/messages\/msg_in_1\/reply$/,
      "reply must target the received message in its inbox",
    );
    assert.equal(reply.body.text, FIXED_REPLY);

    // The deterministic model call ran exactly once.
    assert.equal(runToolChat.mock.callCount(), 1);

    // The exchange was persisted: inbound user message + the agent's reply.
    const rows = messageRows();
    const user = rows.find((r) => r.role === "user");
    const agent = rows.find((r) => r.role === "agent");
    assert.ok(user, "the inbound message was stored");
    assert.match(user!.content, /What is ContextOS\?/);
    assert.ok(agent, "the reply was stored");
    assert.equal(agent!.content, FIXED_REPLY);
    // A conversation row was created and bound to the AgentMail thread.
    assert.equal((store["conversationsTable"] ?? []).length, 1);
    assert.equal((store["emailThreadsTable"] ?? []).length, 1);
  });

  it("silently ignores a non-allow-listed sender (no reply, no processing)", async () => {
    seedConfig();
    // allow-list is empty → stranger@evil.com is not approved.

    const res = await deliver(buildEvent({ from: "stranger@evil.com" }));
    assert.equal(res.status, 200, "still acked so AgentMail does not retry");

    // Give any async processing a chance to (not) happen.
    await sleep(60);
    assert.equal(isSenderAllowed.mock.callCount(), 1, "the allow-list was checked");
    assert.equal(replyCalls().length, 0, "no reply to a stranger");
    assert.equal(runToolChat.mock.callCount(), 0, "the model was never called");
    assert.equal(messageRows().length, 0, "nothing was persisted");

    // But the drop IS recorded so the owner can see who tried to reach the bot.
    const recorded = await waitFor(
      () => (store["emailDroppedSendersTable"] ?? []).length === 1,
    );
    assert.ok(recorded, "the dropped sender was recorded for owner visibility");
    const drop = (store["emailDroppedSendersTable"] ?? [])[0];
    assert.equal(drop.address, "stranger@evil.com");
    assert.equal(drop.lastSubject, "A question");
  });

  it("rejects a tampered signature with 401 and never processes it", async () => {
    seedConfig();
    allowedSenders.add("alice@example.com");

    const res = await deliver(
      buildEvent({ from: "alice@example.com" }),
      { signature: "v1,not-a-real-signature" },
    );
    assert.equal(res.status, 401);

    await sleep(60);
    assert.equal(isSenderAllowed.mock.callCount(), 0);
    assert.equal(runToolChat.mock.callCount(), 0);
    assert.equal(replyCalls().length, 0);
    assert.equal(messageRows().length, 0);
  });

  it("rejects a stale (replayed) timestamp with 401", async () => {
    seedConfig();
    allowedSenders.add("alice@example.com");

    // Sign correctly, but with a timestamp well outside the ±5min window.
    const staleTs = String(Math.floor(Date.now() / 1000) - 60 * 60);
    const res = await deliver(buildEvent({ from: "alice@example.com" }), {
      timestamp: staleTs,
    });
    assert.equal(res.status, 401);

    await sleep(60);
    assert.equal(runToolChat.mock.callCount(), 0);
    assert.equal(replyCalls().length, 0);
    assert.equal(messageRows().length, 0);
  });

  it("loop-guards the bot's own inbox address (no self-reply)", async () => {
    seedConfig();
    // Even if the bot's own address were somehow allow-listed, the loop guard
    // must short-circuit before the allow-list is ever consulted.
    allowedSenders.add(INBOX.email);

    const res = await deliver(
      buildEvent({ from: `ContextOS Bot <${INBOX.email}>` }),
    );
    assert.equal(res.status, 200);

    await sleep(60);
    assert.equal(
      isSenderAllowed.mock.callCount(),
      0,
      "loop guard short-circuits before the allow-list check",
    );
    assert.equal(runToolChat.mock.callCount(), 0);
    assert.equal(replyCalls().length, 0, "the bot must never reply to itself");
    assert.equal(messageRows().length, 0);
  });

  for (const variant of [
    "message.received.spam",
    "message.received.blocked",
    "message.received.unauthenticated",
  ]) {
    it(`ignores ${variant} even from an allow-listed sender`, async () => {
      seedConfig();
      // Allow-list the sender so the ONLY reason to ignore is the event variant.
      allowedSenders.add("alice@example.com");

      const res = await deliver(
        buildEvent({ from: "alice@example.com", eventType: variant }),
      );
      // Signature is valid → still acked so AgentMail does not retry.
      assert.equal(res.status, 200);

      await sleep(60);
      assert.equal(
        isSenderAllowed.mock.callCount(),
        0,
        "the variant is dropped before the allow-list is consulted",
      );
      assert.equal(runToolChat.mock.callCount(), 0, "the model was never called");
      assert.equal(replyCalls().length, 0, "no reply to a non-received variant");
      assert.equal(messageRows().length, 0, "nothing was persisted");
    });
  }

  it("drops inbound mail when the channel is disabled, even from an allow-listed sender", async () => {
    seedConfig({ enabled: false });
    allowedSenders.add("alice@example.com");

    const res = await deliver(buildEvent({ from: "alice@example.com" }));
    // Signature is valid → acked, but processing stops because the channel is off.
    assert.equal(res.status, 200);

    await sleep(60);
    assert.equal(
      isSenderAllowed.mock.callCount(),
      0,
      "a disabled channel short-circuits before the allow-list check",
    );
    assert.equal(runToolChat.mock.callCount(), 0, "the model was never called");
    assert.equal(replyCalls().length, 0, "a disabled channel never replies");
    assert.equal(messageRows().length, 0, "nothing was persisted");
  });

  for (const field of ["from", "thread_id", "message_id"] as const) {
    it(`drops a malformed message missing \`${field}\` (no reply, no processing)`, async () => {
      seedConfig();
      // Allow-list the sender so the ONLY reason to drop is the missing field.
      allowedSenders.add("alice@example.com");

      const res = await deliver(
        buildEvent({ from: "alice@example.com", omit: [field] }),
      );
      // Signature is valid → still acked so AgentMail does not retry.
      assert.equal(res.status, 200);

      await sleep(60);
      assert.equal(
        isSenderAllowed.mock.callCount(),
        0,
        "a missing required field drops before the allow-list check",
      );
      assert.equal(runToolChat.mock.callCount(), 0, "the model was never called");
      assert.equal(replyCalls().length, 0, "no reply to a malformed message");
      assert.equal(messageRows().length, 0, "nothing was persisted");
      assert.equal(
        (store["emailDroppedSendersTable"] ?? []).length,
        0,
        "a malformed message is not recorded as a dropped sender",
      );
    });
  }

  it("drops mail addressed to a different inbox_id (defense-in-depth)", async () => {
    seedConfig();
    // Allow-list the sender so the ONLY reason to drop is the foreign inbox.
    allowedSenders.add("alice@example.com");

    const res = await deliver(
      buildEvent({ from: "alice@example.com", inboxId: "inbox_somebody_else" }),
    );
    // Signature is valid → still acked so AgentMail does not retry.
    assert.equal(res.status, 200);

    await sleep(60);
    assert.equal(
      isSenderAllowed.mock.callCount(),
      0,
      "a foreign inbox_id drops before the allow-list check",
    );
    assert.equal(runToolChat.mock.callCount(), 0, "the model was never called");
    assert.equal(replyCalls().length, 0, "no reply for a foreign inbox");
    assert.equal(messageRows().length, 0, "nothing was persisted");
  });

  for (const [label, text] of [
    ["empty", ""],
    ["whitespace-only", "   \n\t  "],
  ] as const) {
    it(`drops a message with a ${label} body (no reply, no processing)`, async () => {
      seedConfig();
      // Allow-list the sender so we DO reach the empty-body guard.
      allowedSenders.add("alice@example.com");

      const res = await deliver(buildEvent({ from: "alice@example.com", text }));
      // Signature is valid → still acked so AgentMail does not retry.
      assert.equal(res.status, 200);

      await sleep(60);
      assert.equal(
        isSenderAllowed.mock.callCount(),
        1,
        "the allow-list is consulted before the empty-body guard",
      );
      assert.equal(runToolChat.mock.callCount(), 0, "the model was never called");
      assert.equal(replyCalls().length, 0, "an empty message earns no reply");
      assert.equal(messageRows().length, 0, "nothing was persisted");
      assert.equal(
        (store["emailDroppedSendersTable"] ?? []).length,
        0,
        "an allow-listed sender is never recorded as dropped",
      );
    });
  }

  it("returns 503 and never processes when the channel is not configured", async () => {
    // No seedConfig() → no email_config row / webhook secret exists yet.
    allowedSenders.add("alice@example.com");

    const res = await deliver(buildEvent({ from: "alice@example.com" }));
    assert.equal(res.status, 503, "an unconfigured channel reports unavailable");

    await sleep(60);
    assert.equal(isSenderAllowed.mock.callCount(), 0);
    assert.equal(runToolChat.mock.callCount(), 0, "the model was never called");
    assert.equal(replyCalls().length, 0, "nothing is sent");
    assert.equal(messageRows().length, 0, "nothing was persisted");
  });
});
