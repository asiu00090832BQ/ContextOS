import { and, asc, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import {
  db,
  conversationsTable,
  conversationMessagesTable,
  telegramChatsTable,
  modelEndpointsTable,
  tenantsTable,
  type Agent,
  type ModelEndpoint,
} from "@workspace/db";
import { getContext } from "./context";
import {
  listToolsForTenant,
  callTool,
  McpToolError,
  loadOwnedLongTermMemories,
  buildWorkspaceStateBlock,
} from "./mcpServer";
import { resolveEndpointApiKey } from "./secretStore";
import { runToolChat, type ToolChatMessage, type ToolSpec } from "./toolChat";
import { composeBotSystemPrompt, TELEGRAM_CHANNEL_NOTE } from "./botPrompt";
import { logger } from "./logger";

const MAX_TOKENS = 8192;
// Cap the agentic tool-calling loop so a misbehaving model can never spin
// forever; each iteration is one model turn that may request tool calls.
const MAX_TOOL_ITERATIONS = 6;
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

/** Settings key (on tenants.settingsJson) holding the selected model endpoint. */
export const TELEGRAM_MODEL_SETTING = "telegramModelEndpointId";

/**
 * Resolve which model endpoint the Telegram bot should use for a tenant.
 * Returns null to mean "use the Replit-managed Anthropic integration" — that
 * is the default when nothing is selected or the selection no longer exists.
 */
export async function resolveTelegramEndpoint(
  tenantId: string,
): Promise<ModelEndpoint | null> {
  const [tenant] = await db
    .select()
    .from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId));
  const selectedId = tenant?.settingsJson?.[TELEGRAM_MODEL_SETTING];
  if (typeof selectedId !== "string" || selectedId.length === 0) return null;

  const [endpoint] = await db
    .select()
    .from(modelEndpointsTable)
    .where(
      and(
        eq(modelEndpointsTable.id, selectedId),
        eq(modelEndpointsTable.tenantId, tenantId),
      ),
    );
  if (!endpoint) {
    logger.warn(
      { tenantId, selectedId },
      "Selected Telegram model endpoint no longer exists; using managed Anthropic",
    );
    return null;
  }
  return endpoint;
}

/** Read the currently selected Telegram model endpoint id (or null). */
export async function getTelegramModelEndpointId(
  tenantId: string,
): Promise<string | null> {
  const [tenant] = await db
    .select()
    .from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId));
  const selectedId = tenant?.settingsJson?.[TELEGRAM_MODEL_SETTING];
  return typeof selectedId === "string" && selectedId.length > 0
    ? selectedId
    : null;
}

/**
 * Persist the selected Telegram model endpoint id (null clears it, reverting to
 * the managed Anthropic default). Throws if the endpoint is not owned by the
 * tenant. Returns the stored id (or null).
 */
export async function setTelegramModelEndpointId(
  tenantId: string,
  endpointId: string | null,
): Promise<string | null> {
  if (endpointId) {
    const [endpoint] = await db
      .select()
      .from(modelEndpointsTable)
      .where(
        and(
          eq(modelEndpointsTable.id, endpointId),
          eq(modelEndpointsTable.tenantId, tenantId),
        ),
      );
    if (!endpoint) {
      throw new Error("Model endpoint not found for this workspace.");
    }
  }

  const [tenant] = await db
    .select()
    .from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId));
  const settings = { ...(tenant?.settingsJson ?? {}) } as Record<
    string,
    unknown
  >;
  if (endpointId) settings[TELEGRAM_MODEL_SETTING] = endpointId;
  else delete settings[TELEGRAM_MODEL_SETTING];

  await db
    .update(tenantsTable)
    .set({ settingsJson: settings })
    .where(eq(tenantsTable.id, tenantId));
  return endpointId;
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
 * tool-calling loop against the tenant's selected model endpoint (or the
 * managed Anthropic integration) with the full ContextOS tool catalog
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

  const endpoint = await resolveTelegramEndpoint(tenantId);
  const apiKey = resolveEndpointApiKey(endpoint);
  const [stateBlock, memoryBlock] = await Promise.all([
    buildWorkspaceStateBlock(tenantId),
    buildLongTermMemoryBlock(tenantId, botAgent),
  ]);
  const system =
    composeBotSystemPrompt(botAgent.systemPrompt, TELEGRAM_CHANNEL_NOTE) +
    stateBlock +
    memoryBlock;

  let replyText = "";
  try {
    const result = await runToolChat({
      endpoint,
      apiKey,
      system,
      history,
      tools,
      maxTokens: MAX_TOKENS,
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
      "Sorry, I couldn't reach the configured model. Check the selected model " +
      "endpoint in ContextOS (Telegram settings) and try again.";
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
