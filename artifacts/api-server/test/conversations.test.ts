import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// Shared mock of @workspace/db (see chatEngine.test.ts for the same chainable-
// builder approach). node:test `mock.module` is not hoisted, so the SUT (the
// conversations router) is imported dynamically after the mocks are registered.
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
  agentsTable: table("agents"),
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

// The reply generator is exercised in chatEngine.test.ts; here we only assert
// the route invokes it (and in the right order relative to the user echo).
const generateAgentReply = mock.fn(async () => {});
mock.module("../src/lib/chatEngine", {
  namedExports: { generateAgentReply },
});

const express = (await import("express")).default;
const request = (await import("supertest")).default;
const convRouter = (await import("../src/routes/conversations")).default;
const { conversationEvents } = await import("../src/lib/events");

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.tenantId = "t1";
    req.userId = "u1";
    next();
  });
  app.use("/api", convRouter);
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
  generateAgentReply.mock.resetCalls();
  generateAgentReply.mock.mockImplementation(async () => {});
  resetRegistry();
});

describe("POST /conversations", () => {
  it("creates a conversation targeting the chosen agent", async () => {
    registry.select.agents = () => [{ id: "agent-1", name: "Helper" }];
    registry.insert.conversations = (v) => [
      {
        id: "conv-1",
        title: v.title ?? "New conversation",
        agentId: v.agentId,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    const res = await request(makeApp())
      .post("/api/conversations")
      .send({ agentId: "agent-1" });

    assert.equal(res.status, 201);
    assert.equal(res.body.id, "conv-1");
    assert.equal(res.body.agentId, "agent-1");
    assert.equal(res.body.agentName, "Helper");
  });

  it("rejects an agent that does not belong to the tenant", async () => {
    registry.select.agents = () => []; // not found

    const res = await request(makeApp())
      .post("/api/conversations")
      .send({ agentId: "nope" });

    assert.equal(res.status, 400);
  });
});

describe("POST /conversations/:id/messages", () => {
  it("persists the user message and triggers reply generation", async () => {
    registry.select.conversations = () => [
      { id: "conv-1", tenantId: "t1", title: "New conversation" },
    ];
    registry.insert.conversation_messages = (v) => [
      {
        id: "msg-1",
        conversationId: "conv-1",
        role: v.role,
        content: v.content,
        usedStub: null,
        runId: null,
        metadataJson: null,
        createdAt: new Date(),
      },
    ];
    registry.update.conversations = () => [];

    const res = await request(makeApp())
      .post("/api/conversations/conv-1/messages")
      .send({ content: "hello there" });

    assert.equal(res.status, 201);
    assert.equal(res.body.role, "user");
    assert.equal(res.body.content, "hello there");
    assert.ok(
      calledWith(generateAgentReply, "t1", "conv-1", "u1", "hello there"),
    );
  });

  it("echoes the user message on the SSE bus before generating the reply", async () => {
    const order: string[] = [];
    const unsubscribe = conversationEvents.subscribe(
      "conv-1",
      (payload: any) => {
        if (payload.kind === "message") order.push(`echo:${payload.message.role}`);
      },
    );
    generateAgentReply.mock.mockImplementation(async () => {
      order.push("reply-invoked");
    });

    registry.select.conversations = () => [
      { id: "conv-1", tenantId: "t1", title: "Existing" },
    ];
    registry.insert.conversation_messages = (v) => [
      {
        id: "msg-1",
        conversationId: "conv-1",
        role: v.role,
        content: v.content,
        usedStub: null,
        runId: null,
        metadataJson: null,
        createdAt: new Date(),
      },
    ];
    registry.update.conversations = () => [];

    await request(makeApp())
      .post("/api/conversations/conv-1/messages")
      .send({ content: "ping" });

    unsubscribe();
    assert.deepEqual(order, ["echo:user", "reply-invoked"]);
  });

  it("returns 404 for an unknown conversation", async () => {
    registry.select.conversations = () => [];

    const res = await request(makeApp())
      .post("/api/conversations/missing/messages")
      .send({ content: "hi" });

    assert.equal(res.status, 404);
  });
});

describe("conversation event bus ordering", () => {
  it("delivers events to subscribers in emission order", () => {
    const received: string[] = [];
    const unsubscribe = conversationEvents.subscribe("conv-x", (p: any) =>
      received.push(p.kind),
    );

    conversationEvents.emitConversationEvent("conv-x", { kind: "reply.start" });
    conversationEvents.emitConversationEvent("conv-x", { kind: "reply.chunk" });
    conversationEvents.emitConversationEvent("conv-x", { kind: "reply.done" });

    unsubscribe();
    assert.deepEqual(received, ["reply.start", "reply.chunk", "reply.done"]);
  });
});
