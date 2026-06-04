import { Router, type IRouter } from "express";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  db,
  conversationsTable,
  conversationMessagesTable,
  agentsTable,
} from "@workspace/db";
import {
  CreateConversationBody,
  GetConversationParams,
  GetConversationResponse,
  DeleteConversationParams,
  ListConversationMessagesParams,
  ListConversationMessagesResponse,
  PostConversationMessageParams,
  PostConversationMessageBody,
} from "@workspace/api-zod";
import {
  serializeConversation,
  serializeConversationMessage,
} from "../lib/serialize";
import { conversationEvents } from "../lib/events";
import { generateAgentReply } from "../lib/chatEngine";

const router: IRouter = Router();

async function loadConversationMeta(tenantId: string, conversationId: string) {
  const [meta] = await db
    .select({
      count: sql<number>`count(*)::int`,
      lastAt: sql<Date | null>`max(${conversationMessagesTable.createdAt})`,
    })
    .from(conversationMessagesTable)
    .where(
      and(
        eq(conversationMessagesTable.tenantId, tenantId),
        eq(conversationMessagesTable.conversationId, conversationId),
      ),
    );
  return { messageCount: meta?.count ?? 0, lastMessageAt: meta?.lastAt ?? null };
}

async function agentName(agentId: string | null): Promise<string | null> {
  if (!agentId) return null;
  const [a] = await db
    .select({ name: agentsTable.name })
    .from(agentsTable)
    .where(eq(agentsTable.id, agentId));
  return a?.name ?? null;
}

router.get("/conversations", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(conversationsTable)
    .where(eq(conversationsTable.tenantId, req.tenantId))
    .orderBy(desc(conversationsTable.updatedAt));
  const out = await Promise.all(
    rows.map(async (c) =>
      serializeConversation(c, {
        agentName: await agentName(c.agentId),
        ...(await loadConversationMeta(req.tenantId, c.id)),
      }),
    ),
  );
  res.json(out);
});

router.post("/conversations", async (req, res): Promise<void> => {
  const parsed = CreateConversationBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // Validate the agent (if provided) belongs to this tenant.
  let agentId: string | null = parsed.data.agentId ?? null;
  if (agentId) {
    const [a] = await db
      .select({ id: agentsTable.id })
      .from(agentsTable)
      .where(and(eq(agentsTable.id, agentId), eq(agentsTable.tenantId, req.tenantId)));
    if (!a) {
      res.status(400).json({ error: "Agent not found" });
      return;
    }
  }
  const [row] = await db
    .insert(conversationsTable)
    .values({
      tenantId: req.tenantId,
      title: parsed.data.title ?? "New conversation",
      agentId,
      createdBy: req.userId,
    })
    .returning();
  res.status(201).json(
    GetConversationResponse.parse(
      serializeConversation(row, {
        agentName: await agentName(row.agentId),
        messageCount: 0,
        lastMessageAt: null,
      }),
    ),
  );
});

router.get("/conversations/:id", async (req, res): Promise<void> => {
  const params = GetConversationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .select()
    .from(conversationsTable)
    .where(
      and(
        eq(conversationsTable.id, params.data.id),
        eq(conversationsTable.tenantId, req.tenantId),
      ),
    );
  if (!row) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  res.json(
    GetConversationResponse.parse(
      serializeConversation(row, {
        agentName: await agentName(row.agentId),
        ...(await loadConversationMeta(req.tenantId, row.id)),
      }),
    ),
  );
});

router.delete("/conversations/:id", async (req, res): Promise<void> => {
  const params = DeleteConversationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await db
    .delete(conversationsTable)
    .where(
      and(
        eq(conversationsTable.id, params.data.id),
        eq(conversationsTable.tenantId, req.tenantId),
      ),
    );
  res.status(204).send();
});

router.get("/conversations/:id/messages", async (req, res): Promise<void> => {
  const params = ListConversationMessagesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [owned] = await db
    .select({ id: conversationsTable.id })
    .from(conversationsTable)
    .where(
      and(
        eq(conversationsTable.id, params.data.id),
        eq(conversationsTable.tenantId, req.tenantId),
      ),
    );
  if (!owned) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const rows = await db
    .select()
    .from(conversationMessagesTable)
    .where(
      and(
        eq(conversationMessagesTable.tenantId, req.tenantId),
        eq(conversationMessagesTable.conversationId, params.data.id),
      ),
    )
    .orderBy(asc(conversationMessagesTable.createdAt));
  res.json(ListConversationMessagesResponse.parse(rows.map(serializeConversationMessage)));
});

router.post("/conversations/:id/messages", async (req, res): Promise<void> => {
  const params = PostConversationMessageParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = PostConversationMessageBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [conversation] = await db
    .select()
    .from(conversationsTable)
    .where(
      and(
        eq(conversationsTable.id, params.data.id),
        eq(conversationsTable.tenantId, req.tenantId),
      ),
    );
  if (!conversation) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const [row] = await db
    .insert(conversationMessagesTable)
    .values({
      tenantId: req.tenantId,
      conversationId: conversation.id,
      role: "user",
      content: body.data.content,
    })
    .returning();
  // First user message: title the conversation from it for nicer listings.
  if (conversation.title === "New conversation") {
    await db
      .update(conversationsTable)
      .set({ title: body.data.content.slice(0, 60), updatedAt: new Date() })
      .where(eq(conversationsTable.id, conversation.id));
  } else {
    await db
      .update(conversationsTable)
      .set({ updatedAt: new Date() })
      .where(eq(conversationsTable.id, conversation.id));
  }

  const serialized = serializeConversationMessage(row);
  // Echo the user message to live listeners, then generate the reply async.
  conversationEvents.emitConversationEvent(conversation.id, {
    kind: "message",
    message: serialized,
  });
  void generateAgentReply(
    req.tenantId,
    conversation.id,
    req.userId,
    body.data.content,
  );

  res.status(201).json(serialized);
});

router.get("/conversations/:id/events", async (req, res): Promise<void> => {
  const params = GetConversationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  // Verify tenant ownership before opening any stream — the bus is keyed only
  // by conversation id, so ownership must be checked up front.
  const [owned] = await db
    .select({ id: conversationsTable.id })
    .from(conversationsTable)
    .where(
      and(
        eq(conversationsTable.id, params.data.id),
        eq(conversationsTable.tenantId, req.tenantId),
      ),
    );
  if (!owned) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  if (req.headers.accept?.includes("text/event-stream")) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`event: ping\ndata: {}\n\n`);
    const unsubscribe = conversationEvents.subscribe(params.data.id, (payload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    });
    req.on("close", () => {
      unsubscribe();
      res.end();
    });
    return;
  }
  // Snapshot fallback: return the persisted messages.
  const rows = await db
    .select()
    .from(conversationMessagesTable)
    .where(
      and(
        eq(conversationMessagesTable.tenantId, req.tenantId),
        eq(conversationMessagesTable.conversationId, params.data.id),
      ),
    )
    .orderBy(asc(conversationMessagesTable.createdAt));
  res.json(ListConversationMessagesResponse.parse(rows.map(serializeConversationMessage)));
});

export default router;
