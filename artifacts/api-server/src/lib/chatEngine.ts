import { and, asc, eq } from "drizzle-orm";
import {
  db,
  agentsTable,
  conversationsTable,
  conversationMessagesTable,
  intentsTable,
  runsTable,
  type Agent,
} from "@workspace/db";
import { complete, type LlmMessage } from "./llm";
import { resolveAgentModel, executeRun } from "./runEngine";
import { resolveSecret } from "./secretStore";
import { runEvents, conversationEvents } from "./events";
import { serializeConversationMessage } from "./serialize";
import { getContext } from "./context";
import { logger } from "./logger";

const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful in-app assistant for ContextOS. Answer concisely and, " +
  "when the user asks you to perform a task, acknowledge that you are kicking " +
  "off a run to handle it.";

// Leading imperative verbs / phrasings that signal the user wants the agent to
// actually *do* something (kick off a run) rather than just chat. Kept simple
// and deterministic so behavior is predictable without a live model.
const ACTIONABLE_PATTERN =
  /\b(run|execute|kick ?off|start|launch|deploy|create|build|generate|fetch|sync|send|schedule|process|analy[sz]e|summari[sz]e|research|find|search|update|migrate|scrape|crawl|monitor|automate)\b/i;

const QUESTION_PREFIX = /^\s*(what|who|when|where|why|how|is|are|do|does|can|could|would|should|explain|tell me)\b/i;

export function looksActionable(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length < 8) return false;
  // Plain questions are conversational, not task requests.
  if (QUESTION_PREFIX.test(trimmed) && !/\b(run|execute|kick ?off)\b/i.test(trimmed)) {
    return false;
  }
  return ACTIONABLE_PATTERN.test(trimmed);
}

/**
 * Deterministic, natural-language chat fallback used when no live model
 * endpoint is configured (or the call fails). Unlike the run-planner stub in
 * llm.ts, this returns conversational prose suitable for a chat thread.
 */
function chatStubReply(userContent: string, agentName: string, actionable: boolean): string {
  const trimmed = userContent.trim();
  if (actionable) {
    return "Got it — I'll take care of that for you.";
  }
  if (/^\s*(hi|hello|hey|yo|greetings|good (morning|afternoon|evening))\b/i.test(trimmed)) {
    return (
      `Hi! I'm ${agentName}, your in-app assistant for ContextOS. I can answer ` +
      "questions about your agents, intents, and runs, and kick off a run when you " +
      "ask me to do something. What would you like to do?"
    );
  }
  if (/\bwhat can you do\b|\bhelp\b|\bcapabilities\b|\bwho are you\b/i.test(trimmed)) {
    return (
      `I'm ${agentName}. I can chat about your ContextOS setup, and when you ask me ` +
      'to perform a task (e.g. "run…", "summarize…", "fetch…") I\'ll kick off a run ' +
      "and let you approve any sensitive steps inline. Just tell me what you need."
    );
  }
  return (
    "I'm running in simulated mode right now (no live model endpoint is configured), " +
    "so this is a deterministic reply. Configure a model endpoint for this agent to get " +
    "live responses. In the meantime, ask me to run a task and I'll start a run for you."
  );
}

async function resolveConversationAgent(
  tenantId: string,
  agentId: string | null,
): Promise<Agent | null> {
  if (agentId) {
    const [a] = await db
      .select()
      .from(agentsTable)
      .where(and(eq(agentsTable.id, agentId), eq(agentsTable.tenantId, tenantId)));
    if (a) return a;
  }
  // No explicit agent: the in-app Chat tab IS the ContextOS assistant, so route
  // to the bot agent (whose model policy / system prompt define the assistant).
  // Fall back to a lead agent, then any active agent for the tenant.
  const { botAgent } = await getContext();
  if (botAgent && botAgent.tenantId === tenantId) return botAgent;
  const [lead] = await db
    .select()
    .from(agentsTable)
    .where(
      and(
        eq(agentsTable.tenantId, tenantId),
        eq(agentsTable.role, "lead"),
        eq(agentsTable.isActive, true),
      ),
    );
  if (lead) return lead;
  const [any] = await db
    .select()
    .from(agentsTable)
    .where(and(eq(agentsTable.tenantId, tenantId), eq(agentsTable.isActive, true)));
  return any ?? null;
}

function emit(conversationId: string, payload: Record<string, unknown>): void {
  conversationEvents.emitConversationEvent(conversationId, payload);
}

/**
 * Subscribe to a run's event bus and, when the run reaches a notable state,
 * post a follow-up message back into the conversation thread. Process-local:
 * if the server restarts while a run is mid-flight the follow-up is lost
 * (acceptable for in-app chat — the run itself still completes and is visible
 * on the linked run card).
 */
function trackRunForConversation(
  tenantId: string,
  conversationId: string,
  runId: string,
): void {
  let settled = false;
  const unsubscribe = runEvents.subscribe(runId, (payload) => {
    const evt = payload as { type?: string };
    if (!evt?.type) return;
    if (evt.type === "run.waiting") {
      void postSystemMessage(
        tenantId,
        conversationId,
        "The run is paused awaiting your approval. Review and approve it on the run card above to continue.",
        runId,
      );
      return;
    }
    if (evt.type === "run.completed" || evt.type === "run.failed") {
      if (settled) return;
      settled = true;
      unsubscribe();
      void finalizeRunMessage(tenantId, conversationId, runId);
    }
  });
}

async function postSystemMessage(
  tenantId: string,
  conversationId: string,
  content: string,
  runId: string | null,
): Promise<void> {
  const [row] = await db
    .insert(conversationMessagesTable)
    .values({ tenantId, conversationId, role: "system", content, runId })
    .returning();
  emit(conversationId, { kind: "message", message: serializeConversationMessage(row) });
}

async function finalizeRunMessage(
  tenantId: string,
  conversationId: string,
  runId: string,
): Promise<void> {
  const [run] = await db
    .select()
    .from(runsTable)
    .where(and(eq(runsTable.id, runId), eq(runsTable.tenantId, tenantId)));
  if (!run) return;
  const content =
    run.status === "completed"
      ? run.summary
        ? `Run completed: ${run.summary}`
        : "The run completed successfully."
      : `The run did not finish (status: ${run.status}${run.error ? ` — ${run.error}` : ""}).`;
  const [row] = await db
    .insert(conversationMessagesTable)
    .values({ tenantId, conversationId, role: "agent", content, runId })
    .returning();
  await db
    .update(conversationsTable)
    .set({ updatedAt: new Date() })
    .where(eq(conversationsTable.id, conversationId));
  emit(conversationId, { kind: "message", message: serializeConversationMessage(row) });
}

async function kickOffRun(
  tenantId: string,
  userId: string | null,
  agentId: string | null,
  prompt: string,
): Promise<string> {
  const [intent] = await db
    .insert(intentsTable)
    .values({
      tenantId,
      title: prompt.slice(0, 80),
      goal: prompt,
      riskTier: "L2",
      status: "ready",
      createdBy: userId,
    })
    .returning();
  const [run] = await db
    .insert(runsTable)
    .values({
      tenantId,
      intentId: intent.id,
      status: "pending",
      orchestrationMode: "static_graph",
      leadAgentId: agentId,
    })
    .returning();
  return run.id;
}

/**
 * Generate and stream an agent reply for the latest user message in a
 * conversation. Streams chunks over the conversation SSE bus, persists the
 * final message, and — when the user's request looks actionable — kicks off a
 * run and links it to the reply so the UI can render an inline run card.
 */
export async function generateAgentReply(
  tenantId: string,
  conversationId: string,
  userId: string | null,
  userContent: string,
): Promise<void> {
  try {
    const [conversation] = await db
      .select()
      .from(conversationsTable)
      .where(
        and(
          eq(conversationsTable.id, conversationId),
          eq(conversationsTable.tenantId, tenantId),
        ),
      );
    if (!conversation) return;

    const agent = await resolveConversationAgent(tenantId, conversation.agentId);
    const agentName = agent?.name ?? "Assistant";

    // Build the LLM thread from persisted history (oldest first).
    const history = await db
      .select()
      .from(conversationMessagesTable)
      .where(eq(conversationMessagesTable.conversationId, conversationId))
      .orderBy(asc(conversationMessagesTable.createdAt));

    const llmMessages: LlmMessage[] = [
      { role: "system", content: agent?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
    ];
    for (const m of history) {
      if (m.role === "user") llmMessages.push({ role: "user", content: m.content });
      else if (m.role === "agent") llmMessages.push({ role: "assistant", content: m.content });
      else llmMessages.push({ role: "system", content: m.content });
    }

    const actionable = looksActionable(userContent);
    let runId: string | null = null;
    if (actionable) {
      runId = await kickOffRun(tenantId, userId, conversation.agentId, userContent);
      // Subscribe before starting so no terminal event is missed.
      trackRunForConversation(tenantId, conversationId, runId);
      void executeRun(tenantId, runId);
    }

    // Resolve the agent's model and complete, falling back to the deterministic
    // stub when no live endpoint is configured or the call fails.
    let content: string;
    let usedStub = true;
    // Endpoint actually used to produce a live reply (null when stubbed), and
    // the endpoint configured for the agent (so the UI can show what was
    // attempted even when the live call fell through to the stub).
    let usedEndpointName: string | null = null;
    let configuredEndpointName: string | null = null;
    const llmReq = { messages: llmMessages, temperature: undefined as number | undefined, maxTokens: undefined as number | undefined };
    if (agent) {
      const { primary, fallback, temperature, maxTokens } = await resolveAgentModel(
        tenantId,
        agent.id,
      );
      configuredEndpointName = primary?.name ?? null;
      llmReq.temperature = temperature;
      llmReq.maxTokens = maxTokens;
      if (primary) {
        let result = await complete(primary, resolveSecret(primary.apiKeyRef), llmReq);
        let endpoint = primary;
        if (result.usedStub && fallback) {
          const fb = await complete(fallback, resolveSecret(fallback.apiKeyRef), llmReq);
          if (!fb.usedStub) {
            result = fb;
            endpoint = fallback;
          }
        }
        content = result.usedStub
          ? chatStubReply(userContent, agentName, actionable)
          : result.content;
        usedStub = result.usedStub;
        if (!usedStub) usedEndpointName = endpoint.name;
      } else {
        content = chatStubReply(userContent, agentName, actionable);
        usedStub = true;
      }
    } else {
      content = chatStubReply(userContent, agentName, actionable);
      usedStub = true;
    }

    // Record endpoint info on the message so the Chat UI can show which model
    // endpoint produced the reply (or that none was reached).
    const metadataJson: Record<string, unknown> | undefined =
      usedEndpointName || configuredEndpointName
        ? { modelEndpointName: usedEndpointName, configuredEndpointName }
        : undefined;

    if (actionable && runId) {
      content = `${content.trim()}\n\nI've started a run to handle this — you can track its progress and approve any required steps on the card below.`;
    }

    // Persist the reply (source of truth) then stream it to live listeners.
    const [row] = await db
      .insert(conversationMessagesTable)
      .values({ tenantId, conversationId, role: "agent", content, usedStub, runId, metadataJson })
      .returning();
    await db
      .update(conversationsTable)
      .set({ updatedAt: new Date() })
      .where(eq(conversationsTable.id, conversationId));

    emit(conversationId, { kind: "reply.start", messageId: row.id, conversationId });
    for (const chunk of chunkText(content)) {
      emit(conversationId, { kind: "reply.chunk", messageId: row.id, delta: chunk });
      await sleep(18);
    }
    emit(conversationId, {
      kind: "reply.done",
      message: serializeConversationMessage(row),
    });
  } catch (err) {
    logger.error({ err, conversationId }, "Failed to generate agent reply");
    emit(conversationId, {
      kind: "reply.error",
      message: "The assistant failed to respond. Please try again.",
    });
  }
}

function chunkText(text: string): string[] {
  // Split into word-ish chunks so the client renders a natural token stream.
  const parts = text.match(/\S+\s*/g);
  return parts ?? [text];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
