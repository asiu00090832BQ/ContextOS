import { and, asc, eq, inArray, lt } from "drizzle-orm";
import {
  db,
  conversationsTable,
  conversationMessagesTable,
  emailThreadsTable,
  emailAllowedSendersTable,
} from "@workspace/db";
import { getContext } from "./context";
import { listToolsForTenant, callTool, McpToolError } from "./mcpServer";
import { resolveEndpointApiKey } from "./secretStore";
import {
  runToolChat,
  toToolExecutionResult,
  type ToolChatMessage,
  type ToolSpec,
} from "./toolChat";
import { composeBotSystemPrompt, EMAIL_CHANNEL_NOTE } from "./botPrompt";
import { normalizeAddress } from "./emailUtils";
import { buildLongTermMemoryBlock } from "./telegramEngine";
import { resolveAgentModel } from "./runEngine";
import { logger } from "./logger";

const MAX_TOKENS = 8192;
// Cap the agentic tool-calling loop, matching the in-app and Telegram bots so
// every channel behaves identically.
const MAX_TOOL_ITERATIONS = 8;
const HISTORY_LIMIT = 30;
// Email thread history older than this is pruned, mirroring Telegram. Durable
// rules/tasks should be saved to long-term memory (the `remember` tool).
export const EMAIL_HISTORY_TTL_MS = 48 * 60 * 60 * 1000;

export { normalizeAddress };

/** Whether an inbound sender is on this tenant's approved allow-list. */
export async function isSenderAllowed(
  tenantId: string,
  fromAddress: string,
): Promise<boolean> {
  const address = normalizeAddress(fromAddress);
  const [row] = await db
    .select({ id: emailAllowedSendersTable.id })
    .from(emailAllowedSendersTable)
    .where(
      and(
        eq(emailAllowedSendersTable.tenantId, tenantId),
        eq(emailAllowedSendersTable.address, address),
      ),
    );
  return Boolean(row);
}

/**
 * Delete email conversation messages older than the 48h retention window.
 * Long-term memories are never touched. Returns the number of pruned messages.
 */
export async function pruneEmailHistory(): Promise<number> {
  const cutoff = new Date(Date.now() - EMAIL_HISTORY_TTL_MS);
  const emailConversations = db
    .select({ id: emailThreadsTable.conversationId })
    .from(emailThreadsTable);
  const deleted = await db
    .delete(conversationMessagesTable)
    .where(
      and(
        inArray(conversationMessagesTable.conversationId, emailConversations),
        lt(conversationMessagesTable.createdAt, cutoff),
      ),
    )
    .returning({ id: conversationMessagesTable.id });
  if (deleted.length > 0) {
    logger.info({ count: deleted.length }, "Pruned expired email thread history");
  }
  return deleted.length;
}

/**
 * Find (or create) the conversation bound to an AgentMail thread so inbound
 * emails reuse the conversation tables for short-term memory.
 */
async function resolveConversation(
  tenantId: string,
  threadKey: string,
  title: string,
): Promise<string> {
  const [existing] = await db
    .select()
    .from(emailThreadsTable)
    .where(
      and(
        eq(emailThreadsTable.tenantId, tenantId),
        eq(emailThreadsTable.threadKey, threadKey),
      ),
    );
  if (existing) return existing.conversationId;

  const [conversation] = await db
    .insert(conversationsTable)
    .values({ tenantId, title: title.slice(0, 120) })
    .returning();
  // Race-safe bind: two concurrent first deliveries for the same thread must not
  // both create a conversation. Insert the mapping with onConflictDoNothing; if
  // we lost the race, drop our orphan conversation and reuse the winner's.
  const [bound] = await db
    .insert(emailThreadsTable)
    .values({ tenantId, threadKey, conversationId: conversation.id })
    .onConflictDoNothing()
    .returning();
  if (bound) return bound.conversationId;

  await db
    .delete(conversationsTable)
    .where(eq(conversationsTable.id, conversation.id));
  const [winner] = await db
    .select()
    .from(emailThreadsTable)
    .where(
      and(
        eq(emailThreadsTable.tenantId, tenantId),
        eq(emailThreadsTable.threadKey, threadKey),
      ),
    );
  return winner.conversationId;
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
  }
  return messages;
}

export interface InboundEmail {
  tenantId: string;
  userId: string | null;
  threadKey: string;
  fromAddress: string;
  subject: string;
  text: string;
}

/**
 * Process one inbound email: persist it, run the same tool-calling loop the
 * Telegram and in-app bots use (the ContextOS Bot agent's own model, tools,
 * memory, and orchestration-only guardrails), persist the reply, and return the
 * text to send back. Email is just another inbox into the SAME bot.
 */
export async function handleEmailMessage(input: InboundEmail): Promise<string> {
  const { tenantId, userId, threadKey, fromAddress, subject, text } = input;
  const title = subject.trim() || `Email from ${normalizeAddress(fromAddress)}`;
  const conversationId = await resolveConversation(tenantId, threadKey, title);

  // Prefix the subject so the model has it as part of the user's message.
  const userContent = subject.trim()
    ? `Subject: ${subject.trim()}\n\n${text}`
    : text;
  await db.insert(conversationMessagesTable).values({
    tenantId,
    conversationId,
    role: "user",
    content: userContent,
  });

  const history = await loadHistory(conversationId);

  // The email surface IS the ContextOS bot: orchestration + own memory only.
  const { botAgent } = await getContext();
  const caller = {
    kind: "bot" as const,
    agentId: botAgent.id,
    emailThreadId: threadKey,
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

  const { primary, temperature, maxTokens } = await resolveAgentModel(
    tenantId,
    botAgent.id,
  );
  const apiKey = resolveEndpointApiKey(primary);
  const memoryBlock = await buildLongTermMemoryBlock(tenantId, botAgent);
  const system =
    composeBotSystemPrompt(botAgent.systemPrompt, EMAIL_CHANNEL_NOTE) +
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
          return toToolExecutionResult(out);
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
    logger.error({ err, tenantId, threadKey }, "Email model call failed");
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
