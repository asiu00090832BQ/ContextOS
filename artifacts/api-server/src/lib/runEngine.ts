import { eq, and, or, isNull } from "drizzle-orm";
import {
  db,
  runsTable,
  intentsTable,
  agentsTable,
  agentRunsTable,
  agentMessagesTable,
  actionsTable,
  approvalRequestsTable,
  contextFragmentsTable,
  contextPacksTable,
  artifactsTable,
  eventLogsTable,
  auditRecordsTable,
  observationsTable,
  capabilitiesTable,
  policyBundlesTable,
  workingMemoriesTable,
  modelEndpointsTable,
  agentModelPoliciesTable,
  sharedContextGrantsTable,
  type Run,
  type Intent,
  type ModelEndpoint,
} from "@workspace/db";
import { runEvents } from "./events";
import {
  startTrace,
  recordObservation,
  finalizeTrace,
} from "./observability";
import { complete, stubComplete, type LlmResult } from "./llm";
import { resolveEndpointApiKey } from "./secretStore";
import { parseRecipe } from "./webTools";
import { sendMessage } from "./telegram";
import { executeCapabilityRow } from "./capabilityExec";
import {
  runToolChat,
  MANAGED_ANTHROPIC_REF,
  type ToolSpec,
} from "./toolChat";
import { listToolsForTenant, callTool, McpToolError } from "./mcpServer";
import { adaptersTable, type Adapter } from "@workspace/db";
import {
  assembleVisibleContext,
  normalizePolicy,
  normalizeFragment,
  normalizeMemory,
} from "./contextBroker";
import { logger } from "./logger";
import { StateGraph, Annotation, START, END } from "@langchain/langgraph";

/**
 * Resolve the configured model for an agent: its model policy plus the primary
 * and fallback endpoints. Used so runs invoke the real configured providers.
 */
export async function resolveAgentModel(
  tenantId: string,
  agentId: string,
): Promise<{
  primary: ModelEndpoint | null;
  fallback: ModelEndpoint | null;
  temperature: number | undefined;
  maxTokens: number | undefined;
}> {
  const [policy] = await db
    .select()
    .from(agentModelPoliciesTable)
    .where(
      and(
        eq(agentModelPoliciesTable.tenantId, tenantId),
        eq(agentModelPoliciesTable.agentId, agentId),
      ),
    );
  if (!policy) {
    return { primary: null, fallback: null, temperature: undefined, maxTokens: undefined };
  }
  let primary: ModelEndpoint | null = null;
  let fallback: ModelEndpoint | null = null;
  if (policy.primaryEndpointId) {
    [primary] = await db
      .select()
      .from(modelEndpointsTable)
      .where(eq(modelEndpointsTable.id, policy.primaryEndpointId));
  }
  if (policy.fallbackEndpointId) {
    [fallback] = await db
      .select()
      .from(modelEndpointsTable)
      .where(eq(modelEndpointsTable.id, policy.fallbackEndpointId));
  }
  return {
    primary: primary ?? null,
    fallback: fallback ?? null,
    // Policy temperature is stored as an integer (×100); the driver wants 0..1.
    temperature: policy.temperature / 100,
    maxTokens: policy.maxTokens,
  };
}

async function logEvent(
  tenantId: string,
  runId: string,
  type: string,
  message: string,
  level = "info",
  extra?: { agentId?: string | null; agentRunId?: string | null; data?: Record<string, unknown> },
): Promise<void> {
  const [event] = await db
    .insert(eventLogsTable)
    .values({
      tenantId,
      runId,
      type,
      level,
      message,
      agentId: extra?.agentId ?? null,
      agentRunId: extra?.agentRunId ?? null,
      dataJson: extra?.data ?? null,
    })
    .returning();
  runEvents.emitRunEvent(runId, {
    id: event.id,
    type,
    level,
    message,
    createdAt: event.createdAt,
  });
}

/**
 * The run lifecycle, expressed as a LangGraph `StateGraph` for readability:
 *
 *   START -> loadRun --(abort?)--> END
 *                   \--> assembleContext -> orchestrateAgents -> proposeActions
 *                          --(pendingApproval?)--> pauseForApproval -> END
 *                          \--------------------> finalize ---------> END
 *
 * Each node wraps the existing logic (context broker, agent runs, MCP tools,
 * policy bundles, DB writes) unchanged — the graph only makes the lifecycle
 * explicit. State flows through the typed channels below.
 *
 * Durability note: a run is started fire-and-forget in the background and may
 * be resumed by a *separate* HTTP request minutes later (possibly after a
 * process restart). The durable checkpoint is therefore the database itself
 * (the run's `waiting_approval` status plus its already-created actions and
 * approval requests), NOT an in-memory LangGraph checkpointer that would be
 * lost on restart. Resuming is modelled as a distinct graph re-entry
 * (`resumeGraph`) that reconstructs what it needs from the DB and finalizes.
 */
const RunState = Annotation.Root({
  tenantId: Annotation<string>,
  runId: Annotation<string>,
  started: Annotation<number>,
  run: Annotation<Run | null>,
  intent: Annotation<Intent | null>,
  traceId: Annotation<string>,
  rootObs: Annotation<string>,
  totalTokens: Annotation<number>,
  totalCost: Annotation<number>,
  obsCount: Annotation<number>,
  pendingApproval: Annotation<boolean>,
  abort: Annotation<boolean>,
});
type RunStateT = typeof RunState.State;

/**
 * Node 1 — load the run + intent, start the trace, mark the run running, and
 * record the root observation. A missing run/intent aborts silently (no status
 * change), mirroring the original early-return behavior.
 */
async function loadRunNode(state: RunStateT): Promise<Partial<RunStateT>> {
  const { tenantId, runId } = state;
  const [run] = await db
    .select()
    .from(runsTable)
    .where(and(eq(runsTable.id, runId), eq(runsTable.tenantId, tenantId)));
  if (!run) return { abort: true };

  const [intent] = await db
    .select()
    .from(intentsTable)
    .where(eq(intentsTable.id, run.intentId));
  if (!intent) return { abort: true };

  const trace = await startTrace({
    tenantId,
    name: `Run: ${intent.title}`,
    rootType: "run",
    runId,
    riskTier: intent.riskTier,
    initiatedBy: "owner",
  });

  await db
    .update(runsTable)
    .set({ status: "running", startedAt: new Date(), traceId: trace.id })
    .where(eq(runsTable.id, runId));

  const rootObs = await recordObservation({
    tenantId,
    traceId: trace.id,
    type: "run",
    name: `Run ${intent.title}`,
    layer: "orchestration",
    input: { goal: intent.goal },
  });

  await logEvent(tenantId, runId, "run.started", `Run started for intent "${intent.title}"`);

  return {
    run,
    intent,
    traceId: trace.id,
    rootObs,
    totalTokens: 0,
    totalCost: 0,
    obsCount: 1,
  };
}

/**
 * Node 2 — assemble the context pack from the intent's fragments, record the
 * assembly observation, and seed working memory with the objective.
 */
async function assembleContextNode(state: RunStateT): Promise<Partial<RunStateT>> {
  const { tenantId, runId, traceId, rootObs } = state;
  const intent = state.intent!;

  const fragments = buildFragments(intent);
  const fragmentRows = await db
    .insert(contextFragmentsTable)
    .values(fragments.map((f) => ({ tenantId, runId, traceId, ...f })))
    .returning();
  const selected = fragmentRows.filter((f) => f.selected);
  const packTokens = selected.reduce((s, f) => s + f.tokens, 0);
  await db.insert(contextPacksTable).values({
    tenantId,
    runId,
    traceId,
    name: "Primary context pack",
    fragmentIds: selected.map((f) => f.id),
    totalTokens: packTokens,
    strategy: "relevance",
    summary: `Assembled ${selected.length} of ${fragmentRows.length} fragments (${packTokens} tokens) by relevance.`,
  });
  await recordObservation({
    tenantId,
    traceId,
    parentObservationId: rootObs,
    type: "context_assembly",
    name: "Assemble context pack",
    layer: "context",
    output: { selected: selected.length, total: fragmentRows.length, tokens: packTokens },
    durationMs: 60,
    metrics: { latencyMs: 60, totalTokens: packTokens },
  });
  await logEvent(tenantId, runId, "context.assembled", `Context pack assembled: ${selected.length} fragments, ${packTokens} tokens`);

  // Working memory: persist the objective so it is available to downstream
  // agents and visible in the run's memory provenance.
  await db.insert(workingMemoriesTable).values({
    tenantId,
    runId,
    type: "working",
    key: "objective",
    value: intent.goal,
    sensitivity: "internal",
    tags: ["intent", intent.riskTier],
    metadataJson: { source: "context_assembly", fragmentsSelected: selected.length },
  });

  return { obsCount: state.obsCount + 1 };
}

/**
 * Node 3 — multi-agent orchestration: a lead agent plans and coordinates, then
 * delegates sub-tasks to up to two worker agents. Each `runAgent` call enforces
 * context isolation through the broker (the single fail-closed chokepoint).
 */
async function orchestrateAgentsNode(state: RunStateT): Promise<Partial<RunStateT>> {
  const { tenantId, runId, traceId, rootObs } = state;
  const intent = state.intent!;
  let totalTokens = state.totalTokens;
  let totalCost = state.totalCost;
  let obsCount = state.obsCount;

  const agents = await db
    .select()
    .from(agentsTable)
    .where(and(eq(agentsTable.tenantId, tenantId), eq(agentsTable.isActive, true)))
    .orderBy(agentsTable.createdAt, agentsTable.id);

  // The QA/verifier agent never participates as a lead or worker. Instead it
  // exclusively reviews the work the run's CODING agents produce (those flagged
  // `canBuildIntegrations`), finding bugs and proposing changes — a strict QA
  // pass over every coding agent's output. It is selected by its "verifier"
  // role; when none is configured QA review is simply skipped.
  const qaAgent = agents.find((a) => a.role === "verifier");
  // The ContextOS bot is a pure concierge: it delegates work to other agents and
  // must NEVER execute work itself. It is excluded from the run workforce so it can
  // never be selected as lead (incl. the `workforce[0]` fallback, where the bot —
  // being the earliest-created agent — would otherwise land) or as a worker.
  const isSystemBot = (a: (typeof agents)[number]): boolean =>
    (a.metadataJson as { isSystemBot?: boolean } | null)?.isSystemBot === true;
  const workforce = agents.filter(
    (a) => a.id !== qaAgent?.id && !isSystemBot(a),
  );

  // Run the QA agent against one coding agent's output. The producer's work is
  // handed to QA through the SANCTIONED context broker — an explicit, per-
  // producer `shared_context_grant` — instead of injecting raw output into the
  // prompt, so the isolation chokepoint still applies (sensitivity ceilings hold
  // and redacted material never crosses). The QA call runs under a "brokered"
  // policy so it sees exactly the granted producer work and nothing else.
  // Findings are recorded as an agent message (QA -> producer), an episodic
  // working memory, and a run event so the critique is visible in the
  // transcript. No-op for non-coding agents (only `canBuildIntegrations` agents
  // are QA-gated) or when no QA agent exists.
  const reviewWithQA = async (
    producer: (typeof agents)[number],
    producerAgentRunId: string,
  ): Promise<void> => {
    if (!qaAgent || !producer.canBuildIntegrations) return;
    // Grant QA visibility of this producer's run fragments (its output plus
    // build/verify steps), capped at "internal" sensitivity. The broker enforces
    // the ceiling and drops anything redacted, grant or not.
    await db.insert(sharedContextGrantsTable).values({
      tenantId,
      runId,
      fromAgentId: producer.id,
      toAgentId: qaAgent.id,
      mode: "shared_full",
      maxSensitivity: "internal",
      note: `QA review of ${producer.name}`,
    });
    const review = await runAgent({
      tenantId,
      runId,
      traceId,
      parentObsId: rootObs,
      agentId: qaAgent.id,
      agentName: qaAgent.name,
      role: qaAgent.role,
      task:
        `Strict QA review. The coding agent "${producer.name}" produced work ` +
        `for the goal "${intent.goal}", shared into your context above. Perform ` +
        `rigorous QA and critique testing: identify bugs, correctness and ` +
        `edge-case issues, and list concrete, actionable change suggestions. If ` +
        `the work is solid, say so explicitly.`,
      systemPrompt: qaAgent.systemPrompt,
      contextPolicy: "brokered",
      parentAgentRunId: producerAgentRunId,
      canBuildIntegrations: false,
      actorUserId: intent.createdBy ?? "",
    });
    totalTokens += review.tokensUsed;
    totalCost += review.costUsdMicros;
    obsCount++;
    await db.insert(agentMessagesTable).values({
      tenantId,
      runId,
      fromAgentId: qaAgent.id,
      toAgentId: producer.id,
      fromAgentRunId: review.agentRunId,
      toAgentRunId: producerAgentRunId,
      messageType: "qa_review",
      content: review.content,
    });
    await db.insert(workingMemoriesTable).values({
      tenantId,
      runId,
      type: "episodic",
      key: `qa.review.${producerAgentRunId}`,
      value: `QA agent "${qaAgent.name}" reviewed work by coding agent "${producer.name}" and recorded bug/change findings.`,
      sensitivity: "internal",
      tags: ["qa", "review", producer.role],
      metadataJson: {
        qaAgentId: qaAgent.id,
        qaAgentRunId: review.agentRunId,
        reviewedAgentId: producer.id,
        reviewedAgentRunId: producerAgentRunId,
      },
    });
    await logEvent(tenantId, runId, "qa.review", `${qaAgent.name} QA-reviewed work by ${producer.name}`, "info", { agentId: qaAgent.id });
  };

  const lead = workforce.find((a) => a.role === "lead") ?? workforce[0];

  if (lead) {
    await db.update(runsTable).set({ leadAgentId: lead.id }).where(eq(runsTable.id, runId));
    const leadResult = await runAgent({
      tenantId,
      runId,
      traceId,
      parentObsId: rootObs,
      agentId: lead.id,
      agentName: lead.name,
      role: lead.role,
      task: `Plan and coordinate: ${intent.goal}`,
      systemPrompt: lead.systemPrompt,
      contextPolicy: lead.contextPolicy,
      canBuildIntegrations: lead.canBuildIntegrations,
      actorUserId: intent.createdBy ?? "",
    });
    totalTokens += leadResult.tokensUsed;
    totalCost += leadResult.costUsdMicros;
    obsCount++;

    // Working memory: record the lead agent's coordination plan as episodic
    // memory for this run.
    await db.insert(workingMemoriesTable).values({
      tenantId,
      runId,
      type: "episodic",
      key: "lead.plan",
      value: `Lead agent "${lead.name}" produced a coordination plan for "${intent.title}".`,
      sensitivity: "internal",
      tags: ["plan", lead.role],
      metadataJson: { agentId: lead.id, agentRunId: leadResult.agentRunId },
    });

    // QA reviews the lead's output when the lead is itself a coding agent.
    await reviewWithQA(lead, leadResult.agentRunId);

    const workers = workforce.filter((a) => a.id !== lead.id).slice(0, 2);
    for (const w of workers) {
      const wr = await runAgent({
        tenantId,
        runId,
        traceId,
        parentObsId: rootObs,
        agentId: w.id,
        agentName: w.name,
        role: w.role,
        task: `Execute sub-task for: ${intent.goal}`,
        systemPrompt: w.systemPrompt,
        contextPolicy: w.contextPolicy,
        parentAgentRunId: leadResult.agentRunId,
        canBuildIntegrations: w.canBuildIntegrations,
        actorUserId: intent.createdBy ?? "",
      });
      totalTokens += wr.tokensUsed;
      totalCost += wr.costUsdMicros;
      obsCount++;
      await db.insert(agentMessagesTable).values({
        tenantId,
        runId,
        fromAgentId: lead.id,
        toAgentId: w.id,
        fromAgentRunId: leadResult.agentRunId,
        toAgentRunId: wr.agentRunId,
        messageType: "delegation",
        content: `Delegating sub-task to ${w.name}: ${intent.goal}`,
      });
      await logEvent(tenantId, runId, "agent.message", `${lead.name} delegated to ${w.name}`, "info", { agentId: lead.id });

      // QA reviews each worker's output when that worker is a coding agent.
      await reviewWithQA(w, wr.agentRunId);
    }
  }

  return { totalTokens, totalCost, obsCount };
}

/**
 * Node 4 — propose actions for the run's capabilities. A policy bundle gives
 * each decision explicit provenance; capabilities at/above the approval
 * threshold (or flagged for human review) are gated behind an approval request,
 * while non-gated capabilities carrying an executable recipe are really invoked.
 * Sets `pendingApproval` so the graph can branch to pause vs. finalize.
 */
async function proposeActionsNode(state: RunStateT): Promise<Partial<RunStateT>> {
  const { tenantId, runId, traceId, rootObs } = state;
  const intent = state.intent!;
  let obsCount = state.obsCount;

  const caps = await db
    .select()
    .from(capabilitiesTable)
    .where(eq(capabilitiesTable.tenantId, tenantId))
    .limit(4);

  // Policy bundle: assemble the effective policy for this run so its approval
  // decisions have explicit, queryable provenance. Capabilities at or above
  // the approval threshold (or flagged for human review) require sign-off.
  const RISK_RANK = { L1: 1, L2: 2, L3: 3, L4: 4 } as const;
  const [policyBundle] = await db
    .insert(policyBundlesTable)
    .values({
      tenantId,
      runId,
      name: `Policy bundle for "${intent.title}"`,
      rulesJson: {
        requireApprovalAtOrAbove: "L3",
        deniedSystems: intent.deniedSystems ?? [],
      },
      allowedCapabilities: caps.map((c) => c.name),
      deniedCapabilities: [],
      approvalThreshold: "L3",
    })
    .returning();
  await logEvent(tenantId, runId, "policy.bundle.assembled", `Policy bundle assembled (approval required at or above ${policyBundle.approvalThreshold})`);

  const adapterCache = new Map<string, Adapter | undefined>();
  const loadAdapter = async (
    adapterId: string,
  ): Promise<Adapter | undefined> => {
    if (adapterCache.has(adapterId)) return adapterCache.get(adapterId);
    const [a] = await db
      .select()
      .from(adaptersTable)
      .where(eq(adaptersTable.id, adapterId));
    adapterCache.set(adapterId, a);
    return a;
  };

  let pendingApproval = false;
  for (const cap of caps) {
    const needsApproval =
      cap.humanReviewRequired ||
      RISK_RANK[cap.riskTier] >= RISK_RANK[policyBundle.approvalThreshold];

    // Real execution: a non-gated capability that carries an executable recipe
    // is actually invoked against its web service. Everything else (gated, or
    // discovery-only) stays simulated.
    const recipe = needsApproval ? null : parseRecipe(cap.executionJson);
    const actionInput = { query: intent.goal.slice(0, 80) };
    let executed = false;
    let execOutput: Record<string, unknown> = { ok: true, simulated: true };
    let execOk = true;
    let execDuration = 45;
    if (recipe) {
      const adapter = await loadAdapter(cap.adapterId);
      if (adapter) {
        const result = await executeCapabilityRow(cap, adapter, {});
        executed = true;
        execOk = result.ok;
        execDuration = result.durationMs;
        execOutput = {
          ok: result.ok,
          status: result.status ?? null,
          extracted: result.extracted ?? null,
          body: result.body ?? null,
          error: result.error ?? null,
        };
      }
    }

    const [action] = await db
      .insert(actionsTable)
      .values({
        tenantId,
        runId,
        capabilityId: cap.id,
        traceId,
        name: cap.name,
        kind: cap.actionKind,
        riskTier: cap.riskTier,
        status: needsApproval
          ? "awaiting_approval"
          : execOk
            ? "completed"
            : "failed",
        inputJson: actionInput,
        outputJson: needsApproval ? null : execOutput,
        policyDecisionJson: {
          decision: needsApproval ? "require_approval" : "allow",
          riskTier: cap.riskTier,
        },
        completedAt: needsApproval ? null : new Date(),
      })
      .returning();
    const toolObs = await recordObservation({
      tenantId,
      traceId,
      parentObservationId: rootObs,
      type: "tool_call",
      name: cap.name,
      layer: "tools",
      capabilityId: cap.id,
      status: needsApproval ? "blocked" : execOk ? "ok" : "error",
      input: actionInput,
      output: needsApproval
        ? { gated: true }
        : { ok: execOk, executed },
      durationMs: execDuration,
      metrics: { latencyMs: execDuration },
    });
    obsCount++;
    await recordObservation({
      tenantId,
      traceId,
      parentObservationId: toolObs,
      type: "policy_check",
      name: `Policy: ${cap.name}`,
      layer: "policy",
      status: "ok",
      output: { decision: needsApproval ? "require_approval" : "allow" },
      durationMs: 5,
      metrics: { latencyMs: 5 },
    });
    obsCount++;
    if (needsApproval) {
      pendingApproval = true;
      await db.insert(approvalRequestsTable).values({
        tenantId,
        runId,
        actionId: action.id,
        traceId,
        riskTier: cap.riskTier,
        status: "pending",
        reason: `Action "${cap.name}" is ${cap.riskTier} and requires human approval.`,
      });
      await logEvent(tenantId, runId, "approval.requested", `Approval required for "${cap.name}" (${cap.riskTier})`, "warn");
    } else {
      await logEvent(tenantId, runId, "action.succeeded", `Executed "${cap.name}"`);
    }
  }

  return { obsCount, pendingApproval };
}

/**
 * Terminal node — finalize a run with no outstanding approvals: emit the result
 * artifact, mark the run completed, write the audit record, and close the trace.
 */
async function finalizeNode(state: RunStateT): Promise<Partial<RunStateT>> {
  const { tenantId, runId, traceId, started, totalTokens, totalCost, obsCount } = state;
  const intent = state.intent!;

  await db.insert(artifactsTable).values({
    tenantId,
    runId,
    traceId,
    name: `${intent.title} — result`,
    type: "document",
    contentType: "text/markdown",
    content: `# ${intent.title}\n\n${intent.goal}\n\nCompleted deterministically across ${obsCount} observations.`,
    sizeBytes: 256,
    sensitivity: "internal",
  });

  await db
    .update(runsTable)
    .set({
      status: "completed",
      summary: `Completed "${intent.title}" using ${totalTokens} tokens.`,
      tokensUsed: totalTokens,
      costUsdMicros: totalCost,
      completedAt: new Date(),
    })
    .where(eq(runsTable.id, runId));
  await db.insert(auditRecordsTable).values({
    tenantId,
    runId,
    actorType: "agent",
    action: "run.completed",
    resourceType: "run",
    resourceId: runId,
    summary: `Run completed for intent "${intent.title}"`,
    riskTier: intent.riskTier,
  });
  await finalizeTrace(traceId, "ok", { tokens: totalTokens, costUsdMicros: totalCost, durationMs: Date.now() - started }, obsCount);
  await logEvent(tenantId, runId, "run.completed", `Run completed (${totalTokens} tokens)`);
  return {};
}

/**
 * Terminal node — pause a run that has at least one gated action: persist the
 * `waiting_approval` status (the durable checkpoint) and close the trace. The
 * run is later continued by `resumeRun` once every approval is granted.
 */
async function pauseForApprovalNode(state: RunStateT): Promise<Partial<RunStateT>> {
  const { tenantId, runId, traceId, started, totalTokens, totalCost, obsCount } = state;
  await db
    .update(runsTable)
    .set({
      status: "waiting_approval",
      tokensUsed: totalTokens,
      costUsdMicros: totalCost,
    })
    .where(eq(runsTable.id, runId));
  await finalizeTrace(traceId, "ok", { tokens: totalTokens, costUsdMicros: totalCost, durationMs: Date.now() - started }, obsCount);
  await logEvent(tenantId, runId, "run.waiting", "Run paused awaiting human approval");
  return {};
}

/** Compiled run-lifecycle graph (see the diagram on `RunState`). */
const runGraph = new StateGraph(RunState)
  .addNode("loadRun", loadRunNode)
  .addNode("assembleContext", assembleContextNode)
  .addNode("orchestrateAgents", orchestrateAgentsNode)
  .addNode("proposeActions", proposeActionsNode)
  .addNode("finalize", finalizeNode)
  .addNode("pauseForApproval", pauseForApprovalNode)
  .addEdge(START, "loadRun")
  .addConditionalEdges(
    "loadRun",
    (s: RunStateT) => (s.abort ? END : "assembleContext"),
    { [END]: END, assembleContext: "assembleContext" },
  )
  .addEdge("assembleContext", "orchestrateAgents")
  .addEdge("orchestrateAgents", "proposeActions")
  .addConditionalEdges(
    "proposeActions",
    (s: RunStateT) => (s.pendingApproval ? "pauseForApproval" : "finalize"),
    { pauseForApproval: "pauseForApproval", finalize: "finalize" },
  )
  .addEdge("finalize", END)
  .addEdge("pauseForApproval", END)
  .compile();

/**
 * Execute a run deterministically by driving the run-lifecycle graph: assemble
 * context, plan a task graph, dispatch agent sub-runs, propose actions (gating
 * risky ones behind approvals), and record a full trace tree. Runs in the
 * background. Any uncaught failure marks the run failed.
 */
export async function executeRun(tenantId: string, runId: string): Promise<void> {
  try {
    await runGraph.invoke({ tenantId, runId, started: Date.now() });
  } catch (err) {
    logger.error({ err, runId }, "Run execution failed");
    await db
      .update(runsTable)
      .set({ status: "failed", error: String(err), completedAt: new Date() })
      .where(eq(runsTable.id, runId));
    await logEvent(tenantId, runId, "run.failed", `Run failed: ${String(err)}`, "error");
  }
  // If this run originated from a Telegram chat (the bot delegated it), report
  // the terminal outcome back to that chat so delegated work never goes silent.
  await notifyTelegramOfRunOutcome(tenantId, runId);
}

/**
 * Push a run's terminal outcome back to its originating Telegram chat, if any.
 * Runs created via the bot (`run_command` / `run_intent`) carry `telegramChatId`;
 * runs started from the web UI have it null and are skipped. Best-effort: a
 * delivery failure must never fail or re-fail the run.
 */
export async function notifyTelegramOfRunOutcome(
  tenantId: string,
  runId: string,
): Promise<void> {
  try {
    const [run] = await db
      .select()
      .from(runsTable)
      .where(and(eq(runsTable.id, runId), eq(runsTable.tenantId, tenantId)));
    if (!run?.telegramChatId) return;

    const [intent] = await db
      .select({ title: intentsTable.title })
      .from(intentsTable)
      .where(eq(intentsTable.id, run.intentId));
    const title = intent?.title ?? "your task";

    let text: string;
    if (run.status === "completed") {
      text = `Done with "${title}".\n${run.summary ?? "The delegated run finished."}`;
    } else if (run.status === "failed") {
      text = `The delegated task "${title}" failed.${run.error ? `\n${run.error}` : ""}`;
    } else if (run.status === "waiting_approval") {
      text = `The task "${title}" is paused and needs your approval before it can continue. Open ContextOS to review and approve it.`;
    } else if (run.status === "cancelled") {
      text = `The delegated task "${title}" was cancelled.`;
    } else {
      return;
    }
    await sendMessage(run.telegramChatId, text);
  } catch (err) {
    logger.error(
      { err, runId },
      "Failed to notify Telegram of run outcome",
    );
  }
}

/**
 * Resume graph state. Resume reconstructs everything it needs from the DB, so
 * its only inputs are the identifiers plus the resume start time.
 */
const ResumeState = Annotation.Root({
  tenantId: Annotation<string>,
  runId: Annotation<string>,
  startedResume: Annotation<number>,
  run: Annotation<Run | null>,
  intent: Annotation<Intent | null>,
  intentTitle: Annotation<string>,
  claimed: Annotation<boolean>,
});
type ResumeStateT = typeof ResumeState.State;

/**
 * Resume guard node — only finalize a still-paused run with no remaining
 * pending approvals, and claim it via a conditional update so concurrent
 * approve callbacks race on a single winner (idempotent: never duplicates
 * artifacts/audit records). `claimed` drives the branch to finalize vs. END.
 */
async function resumeGuardNode(state: ResumeStateT): Promise<Partial<ResumeStateT>> {
  const { tenantId, runId } = state;
  const [run] = await db
    .select()
    .from(runsTable)
    .where(and(eq(runsTable.id, runId), eq(runsTable.tenantId, tenantId)));
  if (!run || run.status !== "waiting_approval") return { claimed: false };

  // Guard: only finalize when there are no remaining pending approvals.
  const stillPending = await db
    .select({ id: approvalRequestsTable.id })
    .from(approvalRequestsTable)
    .where(and(eq(approvalRequestsTable.runId, runId), eq(approvalRequestsTable.status, "pending")));
  if (stillPending.length > 0) return { claimed: false };

  const [intent] = await db
    .select()
    .from(intentsTable)
    .where(eq(intentsTable.id, run.intentId));
  const intentTitle = intent?.title ?? "Run";

  // Transition the run out of waiting_approval first, conditionally on it
  // still being paused. This makes resume idempotent: concurrent approve
  // callbacks race on this single update and only the winner finalizes,
  // so we never create duplicate artifacts/audit records.
  const [claimed] = await db
    .update(runsTable)
    .set({
      status: "completed",
      summary: `Completed "${intentTitle}" after human approval using ${run.tokensUsed} tokens.`,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(runsTable.id, runId),
        eq(runsTable.tenantId, tenantId),
        eq(runsTable.status, "waiting_approval"),
      ),
    )
    .returning();
  if (!claimed) return { claimed: false };

  return { claimed: true, run, intent: intent ?? null, intentTitle };
}

/**
 * Resume finalize node — emit the result artifact, write the audit record, and
 * close the trace for a run that was completed after approval. Uses the
 * pre-claim `run` row for the token/cost/trace provenance.
 */
async function resumeFinalizeNode(state: ResumeStateT): Promise<Partial<ResumeStateT>> {
  const { tenantId, runId, intent, intentTitle, startedResume } = state;
  const run = state.run!;

  await db.insert(artifactsTable).values({
    tenantId,
    runId,
    traceId: run.traceId,
    name: `${intentTitle} — result`,
    type: "document",
    contentType: "text/markdown",
    content: `# ${intentTitle}\n\n${intent?.goal ?? ""}\n\nCompleted after all required approvals were granted.`,
    sizeBytes: 256,
    sensitivity: "internal",
  });

  await db.insert(auditRecordsTable).values({
    tenantId,
    runId,
    actorType: "agent",
    action: "run.completed",
    resourceType: "run",
    resourceId: runId,
    summary: `Run completed for intent "${intentTitle}" after approval`,
    riskTier: intent?.riskTier ?? "L1",
  });

  if (run.traceId) {
    const obs = await db
      .select({ id: observationsTable.id })
      .from(observationsTable)
      .where(eq(observationsTable.traceId, run.traceId));
    await finalizeTrace(
      run.traceId,
      "ok",
      { tokens: run.tokensUsed, costUsdMicros: run.costUsdMicros, durationMs: Date.now() - startedResume },
      obs.length,
    );
  }
  await logEvent(tenantId, runId, "run.completed", `Run completed after approval (${run.tokensUsed} tokens)`);
  await notifyTelegramOfRunOutcome(tenantId, runId);
  return {};
}

/** Compiled resume graph: guard/claim, then finalize-only (never re-runs the lifecycle). */
const resumeGraph = new StateGraph(ResumeState)
  .addNode("resumeGuard", resumeGuardNode)
  .addNode("resumeFinalize", resumeFinalizeNode)
  .addEdge(START, "resumeGuard")
  .addConditionalEdges(
    "resumeGuard",
    (s: ResumeStateT) => (s.claimed ? "resumeFinalize" : END),
    { resumeFinalize: "resumeFinalize", [END]: END },
  )
  .addEdge("resumeFinalize", END)
  .compile();

/**
 * Resume a run that was paused at `waiting_approval` once all of its approvals
 * have been granted. This continues from the paused point — it finalizes the
 * already-processed actions into a completed run and does NOT re-run the
 * lifecycle or recreate any actions/approvals.
 */
export async function resumeRun(tenantId: string, runId: string): Promise<void> {
  try {
    await resumeGraph.invoke({ tenantId, runId, startedResume: Date.now() });
  } catch (err) {
    logger.error({ err, runId }, "Run resume failed");
    await db
      .update(runsTable)
      .set({ status: "failed", error: String(err), completedAt: new Date() })
      .where(eq(runsTable.id, runId));
    await logEvent(tenantId, runId, "run.failed", `Run resume failed: ${String(err)}`, "error");
  }
  await notifyTelegramOfRunOutcome(tenantId, runId);
}

function buildFragments(intent: Intent) {
  return [
    {
      type: "user" as const,
      source: "intent.goal",
      content: intent.goal,
      tokens: Math.ceil(intent.goal.length / 4),
      relevanceScore: 98,
      selected: true,
      sensitivity: "internal" as const,
      redacted: false,
    },
    {
      type: "memory" as const,
      source: "working_memory",
      content: "Prior run resolved a similar objective successfully.",
      tokens: 24,
      relevanceScore: 71,
      selected: true,
      sensitivity: "internal" as const,
      redacted: false,
    },
    {
      type: "retrieval" as const,
      source: "knowledge_base",
      content: "Reference material related to the objective domain.",
      tokens: 180,
      relevanceScore: 64,
      selected: true,
      sensitivity: "internal" as const,
      redacted: false,
    },
    {
      type: "retrieval" as const,
      source: "knowledge_base",
      content: "Low-relevance document excluded from the pack.",
      tokens: 140,
      relevanceScore: 22,
      selected: false,
      rejectionReason: "Below relevance threshold (0.4)",
      sensitivity: "internal" as const,
      redacted: false,
    },
    {
      type: "system" as const,
      source: "linked_account",
      content: "[redacted credential reference]",
      tokens: 8,
      relevanceScore: 50,
      selected: true,
      sensitivity: "restricted" as const,
      redacted: true,
    },
  ];
}

// Builder agents may invoke ONLY these meta-tools during a run: the MCP
// build/import tools plus their verification counterparts and a few read-only
// discovery tools. Arbitrary (possibly destructive) constructed capabilities
// are never exposed here — the loop is for building & verifying integrations.
// NOTE: `test_web_tool` is deliberately EXCLUDED. It executes any named
// capability via executeCapabilityRow with no risk gate, so an autonomous
// agent could invoke a create/update/destructive tool through it without
// approval. Verification instead goes through `retest_web_server`, which only
// dry-runs safe read/list tools and skips destructive ones, and through
// `import_openapi_tools`, whose post-import smoke test is likewise safe-gated.
const BUILDER_TOOL_NAMES = new Set([
  "create_web_mcp_server",
  "register_mcp_server",
  "add_web_mcp_tool",
  "import_openapi_tools",
  "retest_web_server",
  "list_adapters",
  "list_capabilities",
  "list_intents",
]);

const BUILDER_MAX_ITERATIONS = 8;

const BUILDER_SYSTEM_PROMPT =
  "You are an autonomous integration builder running inside a ContextOS run. " +
  "To accomplish the task you may build new MCP servers and web tools using ONLY these tools: " +
  "create_web_mcp_server, register_mcp_server, add_web_mcp_tool, import_openapi_tools, retest_web_server, " +
  "plus list_adapters / list_capabilities / list_intents to inspect what already exists. " +
  "Prefer reusing an existing server or tool over creating a duplicate. " +
  "After you create or import web tools, verify them with retest_web_server, which dry-runs the server's safe read/list tools and reports a per-tool pass/fail; " +
  "if a tool fails, correct the path/query/headers/auth and retest. " +
  "Only safe read/list operations are auto-invoked during verification — write or destructive tools are NEVER executed autonomously and require explicit user approval before use. " +
  "When you are done, briefly summarize which servers/tools you built or reused and their verification status.";

/**
 * A model endpoint is "live" (will not produce a deterministic stub) when it is
 * the managed Anthropic endpoint, has a resolvable API key, or targets a
 * keyless/explicit endpoint. Mirrors the stub decision in llm.complete().
 */
function endpointIsLive(
  endpoint: ModelEndpoint | null,
  apiKey: string | null,
): boolean {
  if (!endpoint) return false;
  if (endpoint.apiKeyRef === MANAGED_ANTHROPIC_REF) return true;
  if (apiKey) return true;
  if (endpoint.providerType === "openai_compatible") return true;
  if (endpoint.baseUrl?.trim() || endpoint.host?.trim()) return true;
  return false;
}

/** A single builder tool invocation outcome, surfaced in the run transcript. */
interface BuilderToolCall {
  name: string;
  ok: boolean;
  summary: string;
}

/**
 * Summarize a builder tool result for the transcript WITHOUT leaking secrets.
 * Only a small allowlist of non-sensitive identifier/status fields is surfaced;
 * everything else is reduced to its shape so credentials in tool output can
 * never reach a run-visible context fragment.
 */
function summarizeBuilderResult(out: unknown): string {
  if (out == null) return "ok";
  if (typeof out !== "object") return String(out).slice(0, 200);
  const o = out as Record<string, unknown>;
  const safeKeys = [
    "adapterId",
    "name",
    "tested",
    "ok",
    "status",
    "count",
    "created",
    "imported",
    "skipped",
    "summary",
  ];
  const picked: string[] = [];
  for (const k of safeKeys) {
    if (k in o && o[k] != null && typeof o[k] !== "object") {
      picked.push(`${k}=${String(o[k]).slice(0, 80)}`);
    }
  }
  return picked.length > 0 ? picked.join(", ") : "completed";
}

/**
 * Run an agentic tool-calling loop that lets a builder agent construct and
 * verify MCP servers/tools during a run. Returns an LlmResult-shaped value so
 * the surrounding runAgent bookkeeping (agent run, fragment, observations) is
 * unchanged. Each tool call is logged to the run transcript.
 */
async function runBuilderCompletion(args: {
  tenantId: string;
  runId: string;
  agentId: string;
  agentName: string;
  actorUserId: string;
  endpoint: ModelEndpoint;
  apiKey: string | null;
  task: string;
  systemPrompt: string | null;
  sharedBlock: string;
  temperature: number | undefined;
  maxTokens: number | undefined;
}): Promise<{ result: LlmResult; toolCalls: BuilderToolCall[] }> {
  const start = Date.now();
  const toolCalls: BuilderToolCall[] = [];
  const catalog = await listToolsForTenant(args.tenantId);
  const tools: ToolSpec[] = catalog
    .filter((t) => BUILDER_TOOL_NAMES.has(t.name))
    .map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema:
        (t.inputSchema as unknown as Record<string, unknown>) ?? {
          type: "object",
        },
    }));

  const system =
    (args.systemPrompt ? `${args.systemPrompt}\n\n` : "") +
    BUILDER_SYSTEM_PROMPT +
    (args.sharedBlock
      ? `\n\nContext available to you:\n${args.sharedBlock}`
      : "");

  const result = await runToolChat({
    endpoint: args.endpoint,
    apiKey: args.apiKey,
    system,
    history: [{ role: "user", content: args.task }],
    tools,
    maxTokens: args.maxTokens ?? 4096,
    maxIterations: BUILDER_MAX_ITERATIONS,
    // resolveAgentModel already returns temperature in the 0..1 range.
    temperature: args.temperature,
    executeTool: async (name, toolArgs) => {
      // Defense in depth: even though the model is only offered builder tools,
      // refuse anything outside the allowlist so a hallucinated tool name can
      // never reach an arbitrary (possibly destructive) constructed capability.
      if (!BUILDER_TOOL_NAMES.has(name)) {
        return {
          content: `Tool "${name}" is not permitted for an autonomous builder agent.`,
          isError: true,
        };
      }
      try {
        const out = await callTool(
          args.tenantId,
          args.actorUserId,
          name,
          toolArgs as Record<string, unknown>,
        );
        await logEvent(
          args.tenantId,
          args.runId,
          "agent.tool_call",
          `${args.agentName} called ${name}`,
          "info",
          // Log only the argument NAMES, never their values — builder tool args
          // can carry credentials (e.g. create_web_mcp_server.secret) that must
          // stay out of the event log / secret-store isolation boundary.
          {
            agentId: args.agentId,
            data: { tool: name, argKeys: Object.keys(toolArgs ?? {}) },
          },
        );
        toolCalls.push({
          name,
          ok: true,
          summary: summarizeBuilderResult(out),
        });
        return { content: JSON.stringify(out), isError: false };
      } catch (err) {
        const message =
          err instanceof McpToolError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Tool execution failed.";
        await logEvent(
          args.tenantId,
          args.runId,
          "agent.tool_call",
          `${args.agentName} call to ${name} failed: ${message}`,
          "warn",
          {
            agentId: args.agentId,
            data: { tool: name, argKeys: Object.keys(toolArgs ?? {}) },
          },
        );
        toolCalls.push({ name, ok: false, summary: message.slice(0, 200) });
        return { content: message, isError: true };
      }
    },
  });

  const latencyMs = Date.now() - start;
  const content = result.text || "(builder agent produced no summary)";
  const promptTokens = Math.ceil((system.length + args.task.length) / 4);
  const completionTokens = Math.max(1, Math.ceil(content.length / 4));
  return {
    result: {
      content,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      costUsdMicros: 0,
      finishReason: "stop",
      usedStub: false,
      latencyMs,
      timeToFirstTokenMs: Math.min(latencyMs, 80),
    },
    toolCalls,
  };
}

interface RunAgentArgs {
  tenantId: string;
  runId: string;
  traceId: string;
  parentObsId: string;
  agentId: string;
  agentName: string;
  role:
    | "lead"
    | "specialist"
    | "verifier"
    | "executor"
    | "summarizer"
    | "router"
    | "memory_manager";
  task: string;
  systemPrompt: string | null;
  contextPolicy?: string | null;
  parentAgentRunId?: string;
  canBuildIntegrations?: boolean;
  actorUserId?: string;
}

async function runAgent(args: RunAgentArgs): Promise<{
  agentRunId: string;
  tokensUsed: number;
  costUsdMicros: number;
  content: string;
}> {
  // Context isolation: assemble ONLY what this agent's policy permits it to see
  // from other agents in the run. This is the single enforcement chokepoint —
  // the broker fails closed and an independent invariant re-checks its output.
  const policy = normalizePolicy(args.contextPolicy);
  const [fragRows, memRows, grantRows] = await Promise.all([
    db
      .select()
      .from(contextFragmentsTable)
      .where(
        and(
          eq(contextFragmentsTable.tenantId, args.tenantId),
          eq(contextFragmentsTable.runId, args.runId),
        ),
      ),
    db
      .select()
      .from(workingMemoriesTable)
      .where(
        and(
          eq(workingMemoriesTable.tenantId, args.tenantId),
          eq(workingMemoriesTable.runId, args.runId),
        ),
      ),
    db
      .select()
      .from(sharedContextGrantsTable)
      .where(
        and(
          eq(sharedContextGrantsTable.tenantId, args.tenantId),
          or(
            eq(sharedContextGrantsTable.runId, args.runId),
            isNull(sharedContextGrantsTable.runId),
          ),
        ),
      ),
  ]);
  const contextItems = [
    ...fragRows.map(normalizeFragment),
    ...memRows.map(normalizeMemory),
  ];
  const assembled = assembleVisibleContext(
    policy,
    args.agentId,
    contextItems,
    grantRows,
  );

  // A tripped invariant is a hard security event: record it and fail closed
  // (the broker already dropped the offending data before returning).
  if (assembled.violation) {
    await logEvent(
      args.tenantId,
      args.runId,
      "security.isolation_violation",
      `Isolation guard tripped for ${args.agentName}: ${assembled.violation}`,
      "error",
      { agentId: args.agentId },
    );
    await db.insert(auditRecordsTable).values({
      tenantId: args.tenantId,
      runId: args.runId,
      actorType: "agent",
      action: "security.isolation_violation",
      resourceType: "agent",
      resourceId: args.agentId,
      summary: `Context isolation guard prevented a leak to "${args.agentName}"`,
      dataJson: { policy, detail: assembled.violation },
    });
  }

  const sharedBlock = assembled.visible
    .filter((v) => v.via !== "self")
    .map((v) => `- [${v.via}:${v.exposure}] ${v.source}: ${v.content}`)
    .join("\n");

  await logEvent(
    args.tenantId,
    args.runId,
    "context.scoped",
    `${args.agentName} context scoped by "${policy}" policy: ${assembled.visible.length} visible, ${assembled.withheldCount} withheld`,
    "info",
    { agentId: args.agentId },
  );

  const messages: {
    role: "system" | "user" | "assistant";
    content: string;
  }[] = [
    {
      role: "system",
      content: args.systemPrompt ?? "You are a helpful agent.",
    },
  ];
  if (sharedBlock) {
    messages.push({
      role: "system",
      content: `Context available to you (scoped by your "${policy}" policy):\n${sharedBlock}`,
    });
  }
  messages.push({ role: "user", content: args.task });

  const llmReq = {
    messages,
    temperature: undefined as number | undefined,
    maxTokens: undefined as number | undefined,
  };

  // Resolve the agent's configured model policy and invoke the real provider,
  // falling back from primary -> fallback endpoint, and only resorting to the
  // deterministic stub when no endpoint/key is configured or every call fails.
  const { primary, fallback, temperature, maxTokens } = await resolveAgentModel(
    args.tenantId,
    args.agentId,
  );
  llmReq.temperature = temperature;
  llmReq.maxTokens = maxTokens;

  const primaryKey = resolveEndpointApiKey(primary);
  const fallbackKey = resolveEndpointApiKey(fallback);

  // Builder agents with a live (non-stub) model run an agentic tool-calling
  // loop so they can actually construct & verify MCP servers/tools during the
  // run. Everything else keeps the existing complete()/stub behavior intact.
  const builderEndpoints: { endpoint: ModelEndpoint; apiKey: string | null }[] =
    [];
  if (args.canBuildIntegrations) {
    if (endpointIsLive(primary, primaryKey)) {
      builderEndpoints.push({ endpoint: primary as ModelEndpoint, apiKey: primaryKey });
    }
    if (endpointIsLive(fallback, fallbackKey)) {
      builderEndpoints.push({ endpoint: fallback as ModelEndpoint, apiKey: fallbackKey });
    }
  }

  let result: LlmResult;
  let builderToolCalls: BuilderToolCall[] = [];
  if (builderEndpoints.length > 0) {
    await logEvent(
      args.tenantId,
      args.runId,
      "agent.builder.started",
      `${args.agentName} started an autonomous integration-builder loop`,
      "info",
      { agentId: args.agentId },
    );
    // Try each live endpoint in turn (primary -> fallback), mirroring the
    // failover semantics of complete(); only drop to the stub if all fail.
    let built: { result: LlmResult; toolCalls: BuilderToolCall[] } | null = null;
    for (let i = 0; i < builderEndpoints.length; i++) {
      const ep = builderEndpoints[i];
      try {
        built = await runBuilderCompletion({
          tenantId: args.tenantId,
          runId: args.runId,
          agentId: args.agentId,
          agentName: args.agentName,
          actorUserId: args.actorUserId ?? "",
          endpoint: ep.endpoint,
          apiKey: ep.apiKey,
          task: args.task,
          systemPrompt: args.systemPrompt,
          sharedBlock,
          temperature,
          maxTokens,
        });
        if (i > 0) {
          await logEvent(
            args.tenantId,
            args.runId,
            "model.fallback",
            `${args.agentName}: builder primary endpoint failed; used fallback "${ep.endpoint.name}"`,
            "warn",
            { agentId: args.agentId },
          );
        }
        break;
      } catch (err) {
        await logEvent(
          args.tenantId,
          args.runId,
          "agent.builder.failed",
          `${args.agentName} builder loop failed on "${ep.endpoint.name}": ${String(err)}`,
          "warn",
          { agentId: args.agentId },
        );
      }
    }
    if (built) {
      result = built.result;
      builderToolCalls = built.toolCalls;
    } else {
      result = stubComplete(llmReq, args.agentName);
    }
  } else if (primary) {
    result = await complete(primary, primaryKey, llmReq);
    if (result.usedStub && fallback) {
      const fb = await complete(fallback, fallbackKey, llmReq);
      if (!fb.usedStub) {
        await logEvent(
          args.tenantId,
          args.runId,
          "model.fallback",
          `${args.agentName}: primary endpoint "${primary.name}" failed; used fallback "${fallback.name}"`,
          "warn",
          { agentId: args.agentId },
        );
        result = fb;
      }
    }
  } else {
    result = stubComplete(llmReq, args.agentName);
  }

  const [agentRun] = await db
    .insert(agentRunsTable)
    .values({
      tenantId: args.tenantId,
      runId: args.runId,
      agentId: args.agentId,
      parentAgentRunId: args.parentAgentRunId ?? null,
      role: args.role,
      status: "completed",
      task: args.task,
      inputJson: {
        contextVisibility: {
          policy,
          visibleFrom: assembled.visibleFrom,
          visibleCount: assembled.visible.length,
          withheldCount: assembled.withheldCount,
          violation: assembled.violation,
        },
      },
      outputJson: { content: result.content },
      outputValid: true,
      usedFallback: result.usedStub,
      tokensUsed: result.totalTokens,
      latencyMs: result.latencyMs,
      costUsdMicros: result.costUsdMicros,
      traceId: args.traceId,
      startedAt: new Date(Date.now() - result.latencyMs),
      completedAt: new Date(),
    })
    .returning();

  // Persist this agent's output as a fragment tagged to it. Downstream agents
  // see it ONLY if their own policy/grants permit (enforced by the broker above).
  await db.insert(contextFragmentsTable).values({
    tenantId: args.tenantId,
    runId: args.runId,
    traceId: args.traceId,
    type: "summary",
    source: `agent:${args.agentName}`,
    content: result.content,
    tokens: result.completionTokens,
    relevanceScore: 80,
    selected: true,
    sensitivity: "internal",
    redacted: false,
    agentId: args.agentId,
    agentRunId: agentRun.id,
  });

  // Surface each builder tool call (and its outcome) as its own run-visible
  // fragment so the transcript shows the concrete build/verify steps the agent
  // took, not just the final summary. Summaries are secret-scrubbed upstream.
  if (builderToolCalls.length > 0) {
    await db.insert(contextFragmentsTable).values(
      builderToolCalls.map((tc) => ({
        tenantId: args.tenantId,
        runId: args.runId,
        traceId: args.traceId,
        type: "summary" as const,
        source: `tool:${tc.name}`,
        content: `${tc.name} ${tc.ok ? "ok" : "failed"}: ${tc.summary}`,
        tokens: 0,
        relevanceScore: 60,
        selected: true,
        sensitivity: "internal" as const,
        redacted: false,
        agentId: args.agentId,
        agentRunId: agentRun.id,
      })),
    );
  }

  const agentObs = await recordObservation({
    tenantId: args.tenantId,
    traceId: args.traceId,
    parentObservationId: args.parentObsId,
    type: "agent_run",
    name: `${args.agentName} (${args.role})`,
    layer: "agents",
    agentId: args.agentId,
    agentRunId: agentRun.id,
    input: { task: args.task },
    output: { content: result.content.slice(0, 200) },
    durationMs: result.latencyMs,
    metrics: { latencyMs: result.latencyMs, totalTokens: result.totalTokens, costUsdMicros: result.costUsdMicros, usedStub: result.usedStub },
  });

  await recordObservation({
    tenantId: args.tenantId,
    traceId: args.traceId,
    parentObservationId: agentObs,
    type: "model_call",
    name: "Model completion",
    layer: "models",
    agentId: args.agentId,
    agentRunId: agentRun.id,
    input: { task: args.task },
    output: { content: result.content.slice(0, 200) },
    durationMs: result.latencyMs,
    metrics: {
      latencyMs: result.latencyMs,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      totalTokens: result.totalTokens,
      costUsdMicros: result.costUsdMicros,
      timeToFirstTokenMs: result.timeToFirstTokenMs,
      finishReason: result.finishReason,
      usedStub: result.usedStub,
    },
  });

  await logEvent(args.tenantId, args.runId, "agent.completed", `${args.agentName} completed sub-task`, "info", { agentId: args.agentId, agentRunId: agentRun.id });

  return {
    agentRunId: agentRun.id,
    tokensUsed: result.totalTokens,
    costUsdMicros: result.costUsdMicros,
    content: result.content,
  };
}
