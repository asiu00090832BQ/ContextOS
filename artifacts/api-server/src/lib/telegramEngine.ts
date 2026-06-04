import { and, asc, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import {
  db,
  conversationsTable,
  conversationMessagesTable,
  telegramChatsTable,
} from "@workspace/db";
import { getContext } from "./context";
import { listToolsForTenant, callTool, McpToolError } from "./mcpServer";
import { logger } from "./logger";

const MODEL = "claude-sonnet-4-6";
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
  "shown in a Telegram chat, so avoid markdown tables and very long output.";

/** Telegram tool names must match ^[a-zA-Z0-9_-]{1,64}$. */
function sanitizeToolName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "tool";
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

async function loadHistory(
  conversationId: string,
): Promise<Anthropic.MessageParam[]> {
  const rows = await db
    .select()
    .from(conversationMessagesTable)
    .where(eq(conversationMessagesTable.conversationId, conversationId))
    .orderBy(asc(conversationMessagesTable.createdAt));

  const recent = rows.slice(-HISTORY_LIMIT);
  const messages: Anthropic.MessageParam[] = [];
  for (const m of recent) {
    if (m.role === "user") {
      messages.push({ role: "user", content: m.content });
    } else if (m.role === "agent") {
      messages.push({ role: "assistant", content: m.content });
    }
    // System notes are not part of the Telegram thread.
  }
  return messages;
}

/**
 * Process one inbound Telegram text message: persist it, run a real
 * Anthropic tool-calling loop with the tenant's full ContextOS tool catalog
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

  const messages = await loadHistory(conversationId);

  // Build the Anthropic tool catalog from the tenant's tools, keeping a map
  // from the sanitized tool name back to the real ContextOS tool name.
  const catalog = await listToolsForTenant(tenantId);
  const nameMap = new Map<string, string>();
  const tools: Anthropic.Tool[] = [];
  for (const t of catalog) {
    let safe = sanitizeToolName(t.name);
    while (nameMap.has(safe)) safe = `${safe}_`.slice(0, 64);
    nameMap.set(safe, t.name);
    tools.push({
      name: safe,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    });
  }

  let replyText = "";

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages,
      ...(tools.length > 0 ? { tools } : {}),
    });

    const textParts: string[] = [];
    const toolUses: Anthropic.ToolUseBlock[] = [];
    for (const block of response.content) {
      if (block.type === "text") textParts.push(block.text);
      else if (block.type === "tool_use") toolUses.push(block);
    }
    if (textParts.length > 0) replyText = textParts.join("\n").trim();

    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      break;
    }

    // Echo the assistant's tool-use turn, then run each tool and feed results
    // back so the model can compose a final answer.
    messages.push({ role: "assistant", content: response.content });
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const realName = nameMap.get(use.name) ?? use.name;
      const args = (use.input as Record<string, unknown>) ?? {};
      let resultText: string;
      let isError = false;
      try {
        const out = await callTool(tenantId, userId ?? "", realName, args);
        resultText = JSON.stringify(out).slice(0, 20_000);
      } catch (err) {
        isError = true;
        resultText =
          err instanceof McpToolError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Tool execution failed.";
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: resultText,
        ...(isError ? { is_error: true } : {}),
      });
    }
    messages.push({ role: "user", content: toolResults });

    if (iter === MAX_TOOL_ITERATIONS - 1 && !replyText) {
      replyText =
        "I gathered some information but ran out of steps before composing a " +
        "final answer. Please try rephrasing or narrowing your request.";
    }
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
