import { Router, type IRouter } from "express";
import { eq, and, desc, inArray, or } from "drizzle-orm";
import {
  db,
  agentsTable,
  workingMemoriesTable,
  conversationsTable,
  conversationMessagesTable,
  telegramChatsTable,
} from "@workspace/db";
import {
  GetBotResponse,
  UpdateBotPolicyBody,
  UpdateBotPolicyResponse,
  ListBotMemoriesResponse,
  CreateBotMemoryBody,
  UpdateBotMemoryParams,
  UpdateBotMemoryBody,
  UpdateBotMemoryResponse,
  DeleteBotMemoryParams,
  ListBotShortTermResponse,
} from "@workspace/api-zod";
import { serializeAgent, serializeMemory, serializeConversationMessage } from "../lib/serialize";
import { getBotAgentId, loadOwnedLongTermMemories } from "../lib/mcpServer";
import { clearContextCache } from "../lib/context";

const CONTEXT_POLICIES = [
  "isolated",
  "shared_summary",
  "shared_readonly",
  "shared_full",
  "brokered",
] as const;
type ContextPolicy = (typeof CONTEXT_POLICIES)[number];
const MEMORY_TYPES = ["working", "episodic", "semantic", "procedural"] as const;
type MemoryType = (typeof MEMORY_TYPES)[number];

const SHORT_TERM_LIMIT = 50;

const router: IRouter = Router();

/** Resolve the reserved ContextOS Bot agent row for this tenant, or 404. */
async function loadBot(tenantId: string) {
  const id = await getBotAgentId(tenantId);
  if (!id) return null;
  const [row] = await db
    .select()
    .from(agentsTable)
    .where(and(eq(agentsTable.id, id), eq(agentsTable.tenantId, tenantId)));
  return row ?? null;
}

router.get("/bot", async (req, res): Promise<void> => {
  const bot = await loadBot(req.tenantId);
  if (!bot) {
    res.status(404).json({ error: "Bot agent not found" });
    return;
  }
  res.json(GetBotResponse.parse(serializeAgent(bot)));
});

router.put("/bot/policy", async (req, res): Promise<void> => {
  const parsed = UpdateBotPolicyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (
    parsed.data.contextPolicy !== undefined &&
    !CONTEXT_POLICIES.includes(parsed.data.contextPolicy as ContextPolicy)
  ) {
    res.status(400).json({ error: `Invalid contextPolicy: ${parsed.data.contextPolicy}` });
    return;
  }
  const bot = await loadBot(req.tenantId);
  if (!bot) {
    res.status(404).json({ error: "Bot agent not found" });
    return;
  }
  const [row] = await db
    .update(agentsTable)
    .set({
      ...(parsed.data.contextPolicy !== undefined
        ? { contextPolicy: parsed.data.contextPolicy as ContextPolicy }
        : {}),
      ...(parsed.data.systemPrompt !== undefined
        ? { systemPrompt: parsed.data.systemPrompt }
        : {}),
    })
    .where(and(eq(agentsTable.id, bot.id), eq(agentsTable.tenantId, req.tenantId)))
    .returning();
  // The owner context caches botAgent (incl. contextPolicy/systemPrompt), which
  // Telegram reads when building the bot's long-term memory block. Invalidate so
  // the next message re-bootstraps with the freshly saved policy.
  clearContextCache();
  res.json(UpdateBotPolicyResponse.parse(serializeAgent(row)));
});

router.get("/bot/memories", async (req, res): Promise<void> => {
  const bot = await loadBot(req.tenantId);
  if (!bot) {
    res.status(404).json({ error: "Bot agent not found" });
    return;
  }
  // The bot's curated long-term partition only (agentId = bot, runId IS NULL).
  const rows = await loadOwnedLongTermMemories(req.tenantId, bot.id, false, 500);
  res.json(ListBotMemoriesResponse.parse(rows.map(serializeMemory)));
});

router.post("/bot/memories", async (req, res): Promise<void> => {
  const parsed = CreateBotMemoryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const bot = await loadBot(req.tenantId);
  if (!bot) {
    res.status(404).json({ error: "Bot agent not found" });
    return;
  }
  const [row] = await db
    .insert(workingMemoriesTable)
    .values({
      tenantId: req.tenantId,
      agentId: bot.id,
      type: (parsed.data.type as MemoryType) ?? "semantic",
      key: parsed.data.key,
      value: parsed.data.value,
      tags: ["long_term"],
      metadataJson: { source: "bot_memory_ui" },
    })
    .returning();
  res.status(201).json(UpdateBotMemoryResponse.parse(serializeMemory(row)));
});

router.put("/bot/memories/:id", async (req, res): Promise<void> => {
  const params = UpdateBotMemoryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateBotMemoryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const bot = await loadBot(req.tenantId);
  if (!bot) {
    res.status(404).json({ error: "Bot agent not found" });
    return;
  }
  const [row] = await db
    .update(workingMemoriesTable)
    .set({
      ...(parsed.data.key !== undefined ? { key: parsed.data.key } : {}),
      ...(parsed.data.value !== undefined ? { value: parsed.data.value } : {}),
      ...(parsed.data.type !== undefined
        ? { type: parsed.data.type as MemoryType }
        : {}),
    })
    .where(
      and(
        eq(workingMemoriesTable.id, params.data.id),
        eq(workingMemoriesTable.tenantId, req.tenantId),
        eq(workingMemoriesTable.agentId, bot.id),
      ),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Bot memory not found" });
    return;
  }
  res.json(UpdateBotMemoryResponse.parse(serializeMemory(row)));
});

router.delete("/bot/memories/:id", async (req, res): Promise<void> => {
  const params = DeleteBotMemoryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const bot = await loadBot(req.tenantId);
  if (!bot) {
    res.status(404).json({ error: "Bot agent not found" });
    return;
  }
  const [row] = await db
    .delete(workingMemoriesTable)
    .where(
      and(
        eq(workingMemoriesTable.id, params.data.id),
        eq(workingMemoriesTable.tenantId, req.tenantId),
        eq(workingMemoriesTable.agentId, bot.id),
      ),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Bot memory not found" });
    return;
  }
  res.sendStatus(204);
});

router.get("/bot/short-term", async (req, res): Promise<void> => {
  const bot = await loadBot(req.tenantId);
  if (!bot) {
    res.status(404).json({ error: "Bot agent not found" });
    return;
  }
  // Short-term memory = the bot's recent chat window across its surfaces:
  // Telegram-bound conversations + any web conversation owned by the bot agent.
  const telegramConvos = db
    .select({ id: telegramChatsTable.conversationId })
    .from(telegramChatsTable)
    .where(eq(telegramChatsTable.tenantId, req.tenantId));
  const botConvoRows = await db
    .select({ id: conversationsTable.id })
    .from(conversationsTable)
    .where(
      and(
        eq(conversationsTable.tenantId, req.tenantId),
        or(
          eq(conversationsTable.agentId, bot.id),
          inArray(conversationsTable.id, telegramConvos),
        ),
      ),
    );
  const convoIds = botConvoRows.map((c) => c.id);
  if (convoIds.length === 0) {
    res.json(ListBotShortTermResponse.parse([]));
    return;
  }
  const rows = await db
    .select()
    .from(conversationMessagesTable)
    .where(
      and(
        eq(conversationMessagesTable.tenantId, req.tenantId),
        inArray(conversationMessagesTable.conversationId, convoIds),
      ),
    )
    .orderBy(desc(conversationMessagesTable.createdAt))
    .limit(SHORT_TERM_LIMIT);
  res.json(ListBotShortTermResponse.parse(rows.map(serializeConversationMessage)));
});

export default router;
