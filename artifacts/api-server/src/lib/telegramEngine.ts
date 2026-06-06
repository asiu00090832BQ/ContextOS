import { and, asc, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import {
  db,
  conversationsTable,
  conversationMessagesTable,
  telegramChatsTable,
  type Agent,
} from "@workspace/db";
import { getContext } from "./context";
import {
  listToolsForTenant,
  callTool,
  McpToolError,
  loadOwnedLongTermMemories,
  getWorkspaceStateBlock,
} from "./mcpServer";
import { resolveEndpointApiKey } from "./secretStore";
import { runToolChat, type ToolChatMessage, type ToolSpec } from "./toolChat";
import { composeBotSystemPrompt, TELEGRAM_CHANNEL_NOTE } from "./botPrompt";
import { resolveAgentModel } from "./runEngine";
import { logger } from "./logger";

const MAX_TOKENS = 8192;
// Cap the agentic tool-calling loop so a misbehaving model can never spin
// forever; each iteration is one model turn that may request tool calls.
// Matches the in-app bot loop so both surfaces behave identically.
const MAX_TOOL_ITERATIONS = 8;
// How many prior messages to load for short-term memory.
const HISTORY_LIMIT = 30;
// Telegram chat history older than this is pruned. Durable rules/tasks should be
// saved to long-term memory (the `remember` tool) so they outlive this window.
export const TELEGRAM_HISTORY_TTL_MS = 48 * 60 * 60 * 1000;
// Cap how many long-term memories we inject into the prompt to bound its size.
const LONG_TERM_INJECT_LIMIT = 50;

/**
 * Load this tenant's long-term memories (working memories not bound to a run)
 * and render them as a prompt block so the bot retains operational rules and
 * larger tasks even after the rolling 48h chat history has been pruned.
 */
export async function buildLongTermMemoryBlock(
  tenantId: string,
  botAgent: Agent,
): Promise<string> {
  // The bot reads only its OWN memory partition; when its context policy is not
  // "isolated" the tenant-shared pool (agentId IS NULL) is merged in too.
  const rows = await loadOwnedLongTermMemories(
    tenantId,
    botAgent.id,
    botAgent.contextPolicy !== "isolated",
    LONG_TERM_INJECT_LIMIT,
  );
  if (rows.length === 0) return "";
  const lines = rows.map((m) => `- [${m.type}] ${m.key}: ${m.value}`);
  return `\n\nLong-term memory (durable rules/tasks/preferences the user set; persists beyond the 48h chat window):\n${lines.join("\n")}`;
}

/**
 * Delete Telegram conversation messages older than the 48h retention window.
 * Long-term memories (working_memories with a null run id) are never touched, so
 * operational rules and larger tasks saved via the `remember` tool persist.
 * Returns the number of pruned messages.
 */
export async function pruneTelegramHistory(): Promise<number> {
  const cutoff = new Date(Date.now() - TELEGRAM_HISTORY_TTL_MS);
  const telegramConversations = db
    .select({ id: telegramChatsTable.conversationId })
    .from(telegramChatsTable);
  const deleted = await db
    .delete(conversationMessagesTable)
    .where(
      and(
        inArray(conversationMessagesTable.conversationId, telegramConversations),
        lt(conversationMessagesTable.createdAt, cutoff),
      ),
    )
    .returning({ id: conversationMessagesTable.id });
  if (deleted.length > 0) {
    logger.info(
      { count: deleted.length },
      "Pruned expired Telegram chat history",
    );
  }
  return deleted.length;
}

/**
 * Find (or create) the conversation bound to a Telegram chat so inbound
 * messages reuse the conversation tables for short-term memory.
 */
async function resolveConversation(
  tenantId: string,
  chatId: string,
  title: string,
): Promise<string> {
  const [existing] = await db
    .select()
    .from(telegramChatsTable)
    .where(
      and(
        eq(telegramChatsTable.tenantId, tenantId),
        eq(telegramChatsTable.chatId, chatId),
      ),
    );
  if (existing) return existing.conversationId;

  const [conversation] = await db
    .insert(conversationsTable)
    .values({ tenantId, title: title.slice(0, 120) })
    .returning();
  await db.insert(telegramChatsTable).values({
    tenantId,
    chatId,
    conversationId: conversation.id,
  });
  return conversation.id;
}

async function loadHistory(conversationId: string): Promise<ToolChatMessage[]> {
  const rows = await db
    .select()
    .from(conversationMessagesTable)
    .where(eq(conversationMessagesTable.conversationId, conversationId))
    .orderBy(asc(conversationMessagesTable.createdAt));

  const recent = rows.slice(-HISTORY_LIMIT);
  const messages: ToolChatMessage[] = [];
  for (const m of recent) {
    if (m.role === "user") messages.push({ role: "user", content: m.content });
    else if (m.role === "agent")
      messages.push({ role: "assistant", content: m.content });
    // System notes are not part of the Telegram thread.
  }
  return messages;
}

/**
 * Process one inbound Telegram text message: persist it, run a real
 * tool-calling loop using the ContextOS Bot agent's own model policy (the same
 * source of truth as the in-app bot) with the full ContextOS tool catalog
 * (built-in + constructed capabilities), persist the reply, and return the
 * text to send back over Telegram. Isolated from the simulated run engine.
 */
export async function handleTelegramMessage(
  tenantId: string,
  userId: string | null,
  chatId: string,
  chatTitle: string,
  userContent: string,
): Promise<string> {
  const conversationId = await resolveConversation(tenantId, chatId, chatTitle);

  await db.insert(conversationMessagesTable).values({
    tenantId,
    conversationId,
    role: "user",
    content: userContent,
  });

  const history = await loadHistory(conversationId);

  // The Telegram surface IS the ContextOS bot: orchestration + own memory only.
  const { botAgent } = await getContext();
  const caller = {
    kind: "bot" as const,
    agentId: botAgent.id,
    telegramChatId: chatId,
  };

  const catalog = await listToolsForTenant(tenantId, caller);
  const tools: ToolSpec[] = catalog.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema:
      (t.inputSchema as unknown as Record<string, unknown>) ?? {
        type: "object",
      },
  }));

  // Route EXACTLY like the in-app bot: the ContextOS Bot agent's own model
  // policy is the single source of truth, so Telegram and the in-app chat use
  // the same model, tools, memory, and base prompt.
  const { primary, temperature, maxTokens } = await resolveAgentModel(
    tenantId,
    botAgent.id,
  );
  const apiKey = resolveEndpointApiKey(primary);
  const [stateBlock, memoryBlock] = await Promise.all([
    getWorkspaceStateBlock(tenantId, { forceRefresh: true }),
    buildLongTermMemoryBlock(tenantId, botAgent),
  ]);
  const system =
    composeBotSystemPrompt(botAgent.systemPrompt, TELEGRAM_CHANNEL_NOTE) +
    stateBlock +
    memoryBlock;

  let replyText = "";
  try {
    const result = await runToolChat({
      endpoint: primary,
      apiKey,
      system,
      history,
      tools,
      temperature,
      maxTokens: maxTokens ?? MAX_TOKENS,
      maxIterations: MAX_TOOL_ITERATIONS,
      executeTool: async (name, args) => {
        try {
          const out = await callTool(tenantId, userId ?? "", name, args, caller);
          return { content: JSON.stringify(out), isError: false };
        } catch (err) {
          const message =
            err instanceof McpToolError
              ? err.message
              : err instanceof Error
                ? err.message
                : "Tool execution failed.";
          return { content: message, isError: true };
        }
      },
    });
    replyText = result.text.trim();
  } catch (err) {
    logger.error({ err, tenantId, chatId }, "Telegram model call failed");
    replyText =
      "Sorry, I couldn't reach the configured model. Check the ContextOS Bot " +
      "agent's model in ContextOS and try again.";
  }

  if (!replyText) {
    replyText = "Sorry, I couldn't produce a response. Please try again.";
  }

  await db.insert(conversationMessagesTable).values({
    tenantId,
    conversationId,
    role: "agent",
    content: replyText,
    usedStub: false,
  });
  await db
    .update(conversationsTable)
    .set({ updatedAt: new Date() })
    .where(eq(conversationsTable.id, conversationId));

  return replyText;
}

/** Resolve the owner tenant/user for unauthenticated webhook processing. */
export async function resolveOwnerTarget(): Promise<{
  tenantId: string;
  userId: string;
}> {
  const ctx = await getContext();
  return { tenantId: ctx.tenant.id, userId: ctx.user.id };
}

export { logger as telegramLogger };
