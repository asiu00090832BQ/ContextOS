import { and, asc, eq } from "drizzle-orm";
import {
  db,
  conversationsTable,
  conversationMessagesTable,
  telegramChatsTable,
  modelEndpointsTable,
  tenantsTable,
  type ModelEndpoint,
} from "@workspace/db";
import { getContext } from "./context";
import { listToolsForTenant, callTool, McpToolError } from "./mcpServer";
import { resolveSecret } from "./secretStore";
import { runToolChat, type ToolChatMessage, type ToolSpec } from "./toolChat";
import { logger } from "./logger";

const MAX_TOKENS = 8192;
// Cap the agentic tool-calling loop so a misbehaving model can never spin
// forever; each iteration is one model turn that may request tool calls.
const MAX_TOOL_ITERATIONS = 6;
// How many prior messages to load for short-term memory.
const HISTORY_LIMIT = 30;

const SYSTEM_PROMPT =
  "You are ContextOS, a helpful assistant reachable over Telegram. You can " +
  "operate the user's ContextOS workspace and call any of the provided tools to " +
  "answer questions or take actions on their behalf. Prefer using tools to get " +
  "real data instead of guessing. Keep replies concise and friendly — they are " +
  "shown in a Telegram chat, so avoid markdown tables and very long output. " +
  "When you build a new web tool with add_web_mcp_tool or import_openapi_tools, " +
  "first dry-run it with test_web_tool using sample arguments and only rely on " +
  "it once it succeeds — if it fails, fix the path/query/headers/auth and test again.";

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

  const catalog = await listToolsForTenant(tenantId);
  const tools: ToolSpec[] = catalog.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema:
      (t.inputSchema as unknown as Record<string, unknown>) ?? {
        type: "object",
      },
  }));

  const endpoint = await resolveTelegramEndpoint(tenantId);
  const apiKey = endpoint ? resolveSecret(endpoint.apiKeyRef) : null;

  let replyText = "";
  try {
    const result = await runToolChat({
      endpoint,
      apiKey,
      system: SYSTEM_PROMPT,
      history,
      tools,
      maxTokens: MAX_TOKENS,
      maxIterations: MAX_TOOL_ITERATIONS,
      executeTool: async (name, args) => {
        try {
          const out = await callTool(tenantId, userId ?? "", name, args);
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
