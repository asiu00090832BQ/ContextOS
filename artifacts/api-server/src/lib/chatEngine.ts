import { and, asc, eq, isNotNull } from "drizzle-orm";
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
import { resolveEndpointApiKey } from "./secretStore";
import { runEvents, conversationEvents } from "./events";
import { serializeConversationMessage } from "./serialize";
import { getContext } from "./context";
import {
  listToolsForTenant,
  callTool,
  McpToolError,
  getWorkspaceStateBlock,
} from "./mcpServer";
import { runToolChat, type ToolChatMessage, type ToolSpec } from "./toolChat";
import { composeBotSystemPrompt } from "./botPrompt";
import { buildLongTermMemoryBlock } from "./telegramEngine";
import { logger } from "./logger";

// Agentic tool-calling loop bounds for the in-app Chat assistant (the bot).
const BOT_MAX_TOKENS = 8192;
const BOT_MAX_TOOL_ITERATIONS = 8;

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

// Canonical follow-up message text posted when a tracked run pauses for an
// approval. Kept as a constant so the durable reconciliation sweep can match
// already-posted messages and stay idempotent.
const RUN_WAITING_MESSAGE =
  "The run is paused awaiting your approval. Review and approve it on the run card above to continue.";

// Terminal run states that warrant a "run completed/failed" follow-up message.
const TERMINAL_RUN_STATUSES = ["completed", "failed"] as const;

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
  let unsubscribe: () => void = () => {};
  const finalize = (): void => {
    if (settled) return;
    settled = true;
    unsubscribe();
    void finalizeRunMessage(tenantId, conversationId, runId);
  };
  unsubscribe = runEvents.subscribe(runId, (payload) => {
    const evt = payload as { type?: string };
    if (!evt?.type) return;
    if (evt.type === "run.waiting") {
      void postWaitingMessage(tenantId, conversationId, runId);
      return;
    }
    if (evt.type === "run.completed" || evt.type === "run.failed") {
      finalize();
    }
  });
  // Tool-triggered runs (run_command / run_intent) start executing *before* we
  // subscribe, so a fast run can reach a terminal state and emit its event
  // before this listener attaches. Reconcile against the persisted run status
  // so the completion follow-up is never missed.
  void (async () => {
    const [run] = await db
      .select()
      .from(runsTable)
      .where(and(eq(runsTable.id, runId), eq(runsTable.tenantId, tenantId)));
    if (!run || settled) return;
    if (run.status === "completed" || run.status === "failed") {
      finalize();
    } else if (run.status === "waiting_approval") {
      void postWaitingMessage(tenantId, conversationId, runId);
    }
  })();
}

/**
 * Whether a run follow-up message of the given kind has already been posted to
 * the conversation. Used to keep both the in-process tracker and the startup
 * reconciliation sweep idempotent (never double-post). Matches both the
 * persisted metadata marker (new messages) and the canonical text (messages
 * written before the marker existed).
 */
async function runFollowupExists(
  conversationId: string,
  runId: string,
  kind: "final" | "waiting",
): Promise<boolean> {
  const rows = await db
    .select()
    .from(conversationMessagesTable)
    .where(
      and(
        eq(conversationMessagesTable.conversationId, conversationId),
        eq(conversationMessagesTable.runId, runId),
      ),
    );
  return rows.some((r) => {
    const marker = (r.metadataJson as { runFollowupKind?: string } | null)
      ?.runFollowupKind;
    if (marker === kind) return true;
    if (kind === "final") {
      return /^(Run completed|The run completed|The run did not finish)/.test(
        r.content,
      );
    }
    return /awaiting your approval/i.test(r.content);
  });
}

/** Post the "awaiting approval" follow-up, idempotently. */
async function postWaitingMessage(
  tenantId: string,
  conversationId: string,
  runId: string,
): Promise<void> {
  if (await runFollowupExists(conversationId, runId, "waiting")) return;
  const [row] = await db
    .insert(conversationMessagesTable)
    .values({
      tenantId,
      conversationId,
      role: "system",
      content: RUN_WAITING_MESSAGE,
      runId,
      metadataJson: { runFollowupKind: "waiting" },
    })
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
  // Idempotency guard: never post the completion follow-up twice, whether the
  // second attempt comes from a live subscription or the startup reconciliation.
  if (await runFollowupExists(conversationId, runId, "final")) return;
  const content =
    run.status === "completed"
      ? run.summary
        ? `Run completed: ${run.summary}`
        : "The run completed successfully."
      : `The run did not finish (status: ${run.status}${run.error ? ` — ${run.error}` : ""}).`;
  const [row] = await db
    .insert(conversationMessagesTable)
    .values({
      tenantId,
      conversationId,
      role: "agent",
      content,
      runId,
      metadataJson: { runFollowupKind: "final" },
    })
    .returning();
  await db
    .update(conversationsTable)
    .set({ updatedAt: new Date() })
    .where(eq(conversationsTable.id, conversationId));
  emit(conversationId, { kind: "message", message: serializeConversationMessage(row) });
}

/**
 * Durable recovery for run-driven chat follow-ups. The in-process tracker
 * (trackRunForConversation) is lost if the server restarts mid-run, so on
 * startup we sweep every conversation message that links a run and, for any run
 * that has since reached a terminal/awaiting state without its follow-up posted,
 * post it now. Idempotent via runFollowupExists, so it is safe to run on every
 * boot and never double-posts.
 */
export async function reconcileRunConversations(): Promise<void> {
  let links: {
    tenantId: string;
    conversationId: string;
    runId: string | null;
  }[];
  try {
    links = await db
      .selectDistinct({
        tenantId: conversationMessagesTable.tenantId,
        conversationId: conversationMessagesTable.conversationId,
        runId: conversationMessagesTable.runId,
      })
      .from(conversationMessagesTable)
      .where(isNotNull(conversationMessagesTable.runId));
  } catch (err) {
    logger.error({ err }, "Run/conversation reconciliation query failed");
    return;
  }

  let posted = 0;
  for (const link of links) {
    if (!link.runId) continue;
    try {
      const did = await reconcileRunConversation(
        link.tenantId,
        link.conversationId,
        link.runId,
      );
      if (did) posted += 1;
    } catch (err) {
      logger.error(
        { err, conversationId: link.conversationId, runId: link.runId },
        "Run/conversation reconciliation failed for a linked run",
      );
    }
  }
  if (posted > 0) {
    logger.info({ posted }, "Reconciled run-driven chat follow-ups on startup");
  }
}

async function reconcileRunConversation(
  tenantId: string,
  conversationId: string,
  runId: string,
): Promise<boolean> {
  const [run] = await db
    .select()
    .from(runsTable)
    .where(and(eq(runsTable.id, runId), eq(runsTable.tenantId, tenantId)));
  if (!run) return false;
  if ((TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status)) {
    if (await runFollowupExists(conversationId, runId, "final")) return false;
    await finalizeRunMessage(tenantId, conversationId, runId);
    return true;
  }
  if (run.status === "waiting_approval") {
    if (await runFollowupExists(conversationId, runId, "waiting")) return false;
    await postWaitingMessage(tenantId, conversationId, runId);
    return true;
  }
  return false;
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

/** Stream a persisted agent message to live conversation listeners. */
async function streamReply(
  conversationId: string,
  content: string,
  row: typeof conversationMessagesTable.$inferSelect,
): Promise<void> {
  emit(conversationId, { kind: "reply.start", messageId: row.id, conversationId });
  for (const chunk of chunkText(content)) {
    emit(conversationId, { kind: "reply.chunk", messageId: row.id, delta: chunk });
    await sleep(18);
  }
  emit(conversationId, {
    kind: "reply.done",
    message: serializeConversationMessage(row),
  });
}

/**
 * Run the in-app Chat assistant (the ContextOS bot) as a real agentic
 * tool-calling loop — exactly like the Telegram surface — so a command typed in
 * Chat actually executes: user message → MCP tool → platform → LLM, looping
 * until the model produces a final answer. The bot decides when to call tools
 * (it is gated to BOT_ALLOWED_TOOLS), and when it starts a run via run_command
 * / run_intent we capture the returned runId to link an inline run card and
 * post follow-up status messages, preserving the existing RunCard experience.
 */
async function generateBotToolReply(
  tenantId: string,
  conversationId: string,
  userId: string | null,
  botAgent: Agent,
  history: (typeof conversationMessagesTable.$inferSelect)[],
): Promise<void> {
  const caller = { kind: "bot" as const, agentId: botAgent.id };

  const catalog = await listToolsForTenant(tenantId, caller);
  const tools: ToolSpec[] = catalog.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema:
      (t.inputSchema as unknown as Record<string, unknown>) ?? { type: "object" },
  }));

  const toolHistory: ToolChatMessage[] = [];
  for (const m of history) {
    if (m.role === "user") toolHistory.push({ role: "user", content: m.content });
    else if (m.role === "agent")
      toolHistory.push({ role: "assistant", content: m.content });
    // System notes are not part of the model thread.
  }

  const { primary, temperature, maxTokens } = await resolveAgentModel(
    tenantId,
    botAgent.id,
  );
  const apiKey = resolveEndpointApiKey(primary);
  // Same canonical, freshness-forcing prompt the bot uses on Telegram, plus a
  // live workspace-state snapshot and long-term memory grounding, so the in-app
  // bot always reflects current state instead of answering from its weak stored
  // prompt or stale earlier-in-conversation assumptions.
  const [stateBlock, memoryBlock] = await Promise.all([
    getWorkspaceStateBlock(tenantId, { forceRefresh: true }),
    buildLongTermMemoryBlock(tenantId, botAgent),
  ]);
  const system =
    composeBotSystemPrompt(botAgent.systemPrompt) + stateBlock + memoryBlock;

  // The first run started by a tool call is linked to the reply for the inline
  // RunCard; every run we see is tracked so its terminal state posts a
  // follow-up message into the thread.
  let linkedRunId: string | null = null;
  const trackedRuns = new Set<string>();

  let content = "";
  // A live model reply attributes to its endpoint (or the managed default);
  // a failure falls back to a stub-style notice so the UI badge reflects it.
  // `usedEndpointName` is the endpoint that produced the reply (null on
  // failure); `configuredEndpointName` is what the agent has configured, so the
  // badge can show "configured endpoint failed" rather than "none configured".
  let usedStub = false;
  let usedEndpointName: string | null = primary?.name ?? "Managed Anthropic";
  const configuredEndpointName: string | null = primary?.name ?? null;

  try {
    const result = await runToolChat({
      endpoint: primary,
      apiKey,
      system,
      history: toolHistory,
      tools,
      maxTokens: maxTokens ?? BOT_MAX_TOKENS,
      maxIterations: BOT_MAX_TOOL_ITERATIONS,
      temperature,
      executeTool: async (name, args) => {
        try {
          const out = await callTool(tenantId, userId ?? "", name, args, caller);
          // Capture any run kicked off by the tool so the conversation can
          // render an inline run card and post follow-up status updates.
          const runId = (out as { runId?: unknown })?.runId;
          if (typeof runId === "string" && runId.length > 0) {
            if (!linkedRunId) linkedRunId = runId;
            if (!trackedRuns.has(runId)) {
              trackedRuns.add(runId);
              trackRunForConversation(tenantId, conversationId, runId);
            }
          }
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
    content = result.text.trim();
  } catch (err) {
    logger.error({ err, conversationId }, "Web chat tool loop failed");
    content =
      "Sorry, I couldn't reach the configured model. Check this agent's model " +
      "endpoint in ContextOS and try again.";
    usedStub = true;
    usedEndpointName = null;
  }

  if (!content) {
    content = "Sorry, I couldn't produce a response. Please try again.";
  }

  // Always record the configured endpoint (even on failure) so the badge shows
  // "configured endpoint failed" rather than implying none is configured.
  const metadataJson: Record<string, unknown> | undefined =
    usedEndpointName || configuredEndpointName
      ? { modelEndpointName: usedEndpointName, configuredEndpointName }
      : undefined;

  const [row] = await db
    .insert(conversationMessagesTable)
    .values({
      tenantId,
      conversationId,
      role: "agent",
      content,
      usedStub,
      runId: linkedRunId,
      metadataJson,
    })
    .returning();
  await db
    .update(conversationsTable)
    .set({ updatedAt: new Date() })
    .where(eq(conversationsTable.id, conversationId));

  await streamReply(conversationId, content, row);
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

    // The default in-app Chat assistant IS the ContextOS bot. Route it through a
    // real agentic tool-calling loop (same as Telegram) so typed commands
    // actually execute via MCP → platform → LLM, instead of single-shot text.
    const { botAgent } = await getContext();
    if (agent && botAgent && agent.id === botAgent.id) {
      await generateBotToolReply(tenantId, conversationId, userId, agent, history);
      return;
    }

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
        let result = await complete(primary, resolveEndpointApiKey(primary), llmReq);
        let endpoint = primary;
        if (result.usedStub && fallback) {
          const fb = await complete(fallback, resolveEndpointApiKey(fallback), llmReq);
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
