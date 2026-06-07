import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Shared mock of @workspace/db. node:test `mock.module` is NOT hoisted, so the
// mock state is plain module-scope state and the system-under-test is imported
// dynamically *after* the mocks are registered (see the await import below).
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
const tables = {
  conversationsTable: table("conversations"),
  conversationMessagesTable: table("conversation_messages"),
  intentsTable: table("intents"),
  runsTable: table("runs"),
  agentsTable: table("agents"),
  telegramChatsTable: table("telegram_chats"),
};

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

const resolveAgentModel = mock.fn(async () => ({
  primary: null,
  fallback: null,
  temperature: 0.7,
  maxTokens: 2048,
}));
const executeRun = mock.fn(async () => {});
mock.module("../src/lib/runEngine", {
  namedExports: { resolveAgentModel, executeRun },
});

const complete = mock.fn(async () => ({ content: "", usedStub: true }));
mock.module("../src/lib/llm", { namedExports: { complete } });

const resolveEndpointApiKey = mock.fn(() => null);
mock.module("../src/lib/secretStore", {
  namedExports: { resolveEndpointApiKey },
});

const getContext = mock.fn(async () => ({ botAgent: null }));
mock.module("../src/lib/context", { namedExports: { getContext } });

const listToolsForTenant = mock.fn(async () => []);
const callTool = mock.fn(async () => ({}));
const loadOwnedLongTermMemories = mock.fn(async () => []);
class McpToolError extends Error {}
mock.module("../src/lib/mcpServer", {
  namedExports: {
    listToolsForTenant,
    callTool,
    McpToolError,
    loadOwnedLongTermMemories,
  },
});

const runToolChat = mock.fn(async () => ({ text: "" }));
const toToolExecutionResult = mock.fn((out: unknown) => ({
  content: JSON.stringify(out),
  isError: false,
}));
mock.module("../src/lib/toolChat", {
  namedExports: { runToolChat, toToolExecutionResult },
});

const { looksActionable, generateAgentReply, reconcileRunConversations } =
  await import("../src/lib/chatEngine");

const allFns = [
  resolveAgentModel,
  executeRun,
  complete,
  resolveEndpointApiKey,
  getContext,
  listToolsForTenant,
  callTool,
  runToolChat,
];

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

function calledWith(fn: any, ...expected: any[]): boolean {
  return fn.mock.calls.some((c: any) => {
    try {
      assert.deepEqual(c.arguments, expected);
      return true;
    } catch {
      return false;
    }
  });
}

beforeEach(() => {
  for (const f of allFns) f.mock.resetCalls();
  resetRegistry();
});

describe("looksActionable", () => {
  it("treats plain questions as conversational, not actionable", () => {
    assert.equal(looksActionable("What is an agent?"), false);
    assert.equal(looksActionable("How do I create an agent?"), false);
    assert.equal(looksActionable("Who can help me here?"), false);
  });

  it("treats imperative task requests as actionable", () => {
    assert.equal(looksActionable("run the daily sync now"), true);
    assert.equal(looksActionable("Please summarize the latest run"), true);
    assert.equal(looksActionable("deploy the new server build"), true);
  });

  it("ignores trivially short input", () => {
    assert.equal(looksActionable("run"), false);
    assert.equal(looksActionable("hi"), false);
  });

  it("still fires for explicit run/execute even after a question word", () => {
    assert.equal(looksActionable("Can you run the import job?"), true);
  });
});

describe("generateAgentReply", () => {
  it("uses the deterministic stub when no live endpoint exists and kicks off a run for actionable input", async () => {
    const inserted: any[] = [];
    registry.select.conversations = () => [
      { id: "conv-1", tenantId: "t1", agentId: "agent-1", title: "x" },
    ];
    registry.select.agents = () => [
      {
        id: "agent-1",
        tenantId: "t1",
        name: "Helper",
        role: "lead",
        isActive: true,
        systemPrompt: "sys",
      },
    ];
    registry.select.conversation_messages = () => [];
    registry.select.runs = () => [
      { id: "run-1", tenantId: "t1", status: "pending" },
    ];
    registry.insert.intents = () => [{ id: "intent-1" }];
    registry.insert.runs = () => [{ id: "run-1", status: "pending" }];
    registry.insert.conversation_messages = (v) => {
      const row = {
        id: `msg-${inserted.length + 1}`,
        createdAt: new Date(),
        ...v,
      };
      inserted.push(row);
      return [row];
    };
    registry.update.conversations = () => [];

    await generateAgentReply("t1", "conv-1", "u1", "run the daily sync now");

    // A run was kicked off and executed for the actionable request.
    assert.ok(calledWith(executeRun, "t1", "run-1"));

    // The persisted agent reply used the stub (no endpoint) and links the run.
    const agentMsg = inserted.find((r) => r.role === "agent");
    assert.ok(agentMsg);
    assert.equal(agentMsg.usedStub, true);
    assert.equal(agentMsg.runId, "run-1");
  });

  it("does not kick off a run for a plain question", async () => {
    const inserted: any[] = [];
    registry.select.conversations = () => [
      { id: "conv-1", tenantId: "t1", agentId: "agent-1", title: "x" },
    ];
    registry.select.agents = () => [
      {
        id: "agent-1",
        tenantId: "t1",
        name: "Helper",
        role: "lead",
        isActive: true,
        systemPrompt: "sys",
      },
    ];
    registry.select.conversation_messages = () => [];
    registry.insert.conversation_messages = (v) => {
      const row = {
        id: `msg-${inserted.length + 1}`,
        createdAt: new Date(),
        ...v,
      };
      inserted.push(row);
      return [row];
    };
    registry.update.conversations = () => [];

    await generateAgentReply("t1", "conv-1", "u1", "What is an agent?");

    assert.equal(executeRun.mock.callCount(), 0);
    const agentMsg = inserted.find((r) => r.role === "agent");
    assert.equal(agentMsg.usedStub, true);
    assert.equal(agentMsg.runId, null);
  });
});

describe("reconcileRunConversations", () => {
  it("posts a completion follow-up exactly once for a terminal run linked to a conversation", async () => {
    // The conversation already has the kickoff agent message linking the run,
    // but no completion follow-up (simulating a restart mid-run).
    const stored: any[] = [
      {
        id: "kickoff",
        conversationId: "conv-1",
        runId: "run-1",
        role: "agent",
        content: "I've started a run to handle this.",
        metadataJson: null,
      },
    ];
    registry.selectDistinct.conversation_messages = () => [
      { tenantId: "t1", conversationId: "conv-1", runId: "run-1" },
    ];
    registry.select.conversation_messages = () => stored;
    registry.select.runs = () => [
      {
        id: "run-1",
        tenantId: "t1",
        status: "completed",
        summary: "Did the thing",
      },
    ];
    registry.insert.conversation_messages = (v) => {
      const row = { id: `final-${stored.length}`, createdAt: new Date(), ...v };
      stored.push(row);
      return [row];
    };
    registry.update.conversations = () => [];

    await reconcileRunConversations();

    const finals = stored.filter(
      (m) => (m.metadataJson as any)?.runFollowupKind === "final",
    );
    assert.equal(finals.length, 1);
    assert.ok(finals[0].content.includes("Run completed: Did the thing"));

    // A second sweep must not double-post (idempotent).
    await reconcileRunConversations();
    const finalsAfter = stored.filter(
      (m) => (m.metadataJson as any)?.runFollowupKind === "final",
    );
    assert.equal(finalsAfter.length, 1);
  });

  it("posts an awaiting-approval follow-up exactly once for a run paused on approval", async () => {
    const stored: any[] = [
      {
        id: "kickoff",
        conversationId: "conv-1",
        runId: "run-1",
        role: "agent",
        content: "I've started a run to handle this.",
        metadataJson: null,
      },
    ];
    registry.selectDistinct.conversation_messages = () => [
      { tenantId: "t1", conversationId: "conv-1", runId: "run-1" },
    ];
    registry.select.conversation_messages = () => stored;
    registry.select.runs = () => [
      { id: "run-1", tenantId: "t1", status: "waiting_approval", summary: null },
    ];
    registry.insert.conversation_messages = (v) => {
      const row = { id: `wait-${stored.length}`, createdAt: new Date(), ...v };
      stored.push(row);
      return [row];
    };
    registry.update.conversations = () => [];

    await reconcileRunConversations();

    const waiting = stored.filter(
      (m) => (m.metadataJson as any)?.runFollowupKind === "waiting",
    );
    assert.equal(waiting.length, 1);
    assert.match(waiting[0].content, /awaiting your approval/i);

    // A second sweep must not double-post (idempotent).
    await reconcileRunConversations();
    const waitingAfter = stored.filter(
      (m) => (m.metadataJson as any)?.runFollowupKind === "waiting",
    );
    assert.equal(waitingAfter.length, 1);
  });

  it("does nothing for a run that is still in flight", async () => {
    const stored: any[] = [
      {
        id: "kickoff",
        conversationId: "conv-1",
        runId: "run-1",
        role: "agent",
        content: "I've started a run.",
        metadataJson: null,
      },
    ];
    registry.selectDistinct.conversation_messages = () => [
      { tenantId: "t1", conversationId: "conv-1", runId: "run-1" },
    ];
    registry.select.conversation_messages = () => stored;
    registry.select.runs = () => [
      { id: "run-1", tenantId: "t1", status: "running" },
    ];
    registry.insert.conversation_messages = (v) => {
      const row = { id: "x", createdAt: new Date(), ...v };
      stored.push(row);
      return [row];
    };

    await reconcileRunConversations();
    assert.equal(stored.length, 1);
  });
});
