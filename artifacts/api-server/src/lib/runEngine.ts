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
import { resolveSecret } from "./secretStore";
import {
  assembleVisibleContext,
  normalizePolicy,
  normalizeFragment,
  normalizeMemory,
} from "./contextBroker";
import { logger } from "./logger";

/**
 * Resolve the configured model for an agent: its model policy plus the primary
 * and fallback endpoints. Used so runs invoke the real configured providers.
 */
async function resolveAgentModel(
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
 * Execute a run deterministically: assemble context, plan a task graph,
 * dispatch agent sub-runs, propose actions (gating risky ones behind
 * approvals), and record a full trace tree. Runs in the background.
 */
export async function executeRun(tenantId: string, runId: string): Promise<void> {
  const started = Date.now();
  try {
    const [run] = await db
      .select()
      .from(runsTable)
      .where(and(eq(runsTable.id, runId), eq(runsTable.tenantId, tenantId)));
    if (!run) return;

    const [intent] = await db
      .select()
      .from(intentsTable)
      .where(eq(intentsTable.id, run.intentId));
    if (!intent) return;

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

    let totalTokens = 0;
    let totalCost = 0;
    let obsCount = 1;

    // 1. Context assembly
    const fragments = buildFragments(intent);
    const fragmentRows = await db
      .insert(contextFragmentsTable)
      .values(
        fragments.map((f) => ({ tenantId, runId, traceId: trace.id, ...f })),
      )
      .returning();
    const selected = fragmentRows.filter((f) => f.selected);
    const packTokens = selected.reduce((s, f) => s + f.tokens, 0);
    await db.insert(contextPacksTable).values({
      tenantId,
      runId,
      traceId: trace.id,
      name: "Primary context pack",
      fragmentIds: selected.map((f) => f.id),
      totalTokens: packTokens,
      strategy: "relevance",
      summary: `Assembled ${selected.length} of ${fragmentRows.length} fragments (${packTokens} tokens) by relevance.`,
    });
    await recordObservation({
      tenantId,
      traceId: trace.id,
      parentObservationId: rootObs,
      type: "context_assembly",
      name: "Assemble context pack",
      layer: "context",
      output: { selected: selected.length, total: fragmentRows.length, tokens: packTokens },
      durationMs: 60,
      metrics: { latencyMs: 60, totalTokens: packTokens },
    });
    obsCount++;
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

    // 2. Lead agent + workers (multi-agent orchestration)
    const agents = await db
      .select()
      .from(agentsTable)
      .where(and(eq(agentsTable.tenantId, tenantId), eq(agentsTable.isActive, true)))
      .orderBy(agentsTable.createdAt, agentsTable.id);
    const lead = agents.find((a) => a.role === "lead") ?? agents[0];

    if (lead) {
      await db.update(runsTable).set({ leadAgentId: lead.id }).where(eq(runsTable.id, runId));
      const leadResult = await runAgent({
        tenantId,
        runId,
        traceId: trace.id,
        parentObsId: rootObs,
        agentId: lead.id,
        agentName: lead.name,
        role: lead.role,
        task: `Plan and coordinate: ${intent.goal}`,
        systemPrompt: lead.systemPrompt,
        contextPolicy: lead.contextPolicy,
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

      const workers = agents.filter((a) => a.id !== lead.id).slice(0, 2);
      for (const w of workers) {
        const wr = await runAgent({
          tenantId,
          runId,
          traceId: trace.id,
          parentObsId: rootObs,
          agentId: w.id,
          agentName: w.name,
          role: w.role,
          task: `Execute sub-task for: ${intent.goal}`,
          systemPrompt: w.systemPrompt,
          contextPolicy: w.contextPolicy,
          parentAgentRunId: leadResult.agentRunId,
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
      }
    }

    // 3. Actions (some gated behind approval)
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

    let pendingApproval = false;
    for (const cap of caps) {
      const needsApproval =
        cap.humanReviewRequired ||
        RISK_RANK[cap.riskTier] >= RISK_RANK[policyBundle.approvalThreshold];
      const [action] = await db
        .insert(actionsTable)
        .values({
          tenantId,
          runId,
          capabilityId: cap.id,
          traceId: trace.id,
          name: cap.name,
          kind: cap.actionKind,
          riskTier: cap.riskTier,
          status: needsApproval ? "awaiting_approval" : "completed",
          inputJson: { query: intent.goal.slice(0, 80) },
          outputJson: needsApproval ? null : { ok: true, simulated: true },
          policyDecisionJson: {
            decision: needsApproval ? "require_approval" : "allow",
            riskTier: cap.riskTier,
          },
          completedAt: needsApproval ? null : new Date(),
        })
        .returning();
      const toolObs = await recordObservation({
        tenantId,
        traceId: trace.id,
        parentObservationId: rootObs,
        type: "tool_call",
        name: cap.name,
        layer: "tools",
        capabilityId: cap.id,
        status: needsApproval ? "blocked" : "ok",
        input: { query: intent.goal.slice(0, 80) },
        output: needsApproval ? { gated: true } : { ok: true },
        durationMs: 45,
        metrics: { latencyMs: 45 },
      });
      obsCount++;
      await recordObservation({
        tenantId,
        traceId: trace.id,
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
          traceId: trace.id,
          riskTier: cap.riskTier,
          status: "pending",
          reason: `Action "${cap.name}" is ${cap.riskTier} and requires human approval.`,
        });
        await logEvent(tenantId, runId, "approval.requested", `Approval required for "${cap.name}" (${cap.riskTier})`, "warn");
      } else {
        await logEvent(tenantId, runId, "action.succeeded", `Executed "${cap.name}"`);
      }
    }

    // 4. Finalize (or pause for approval)
    if (pendingApproval) {
      await db
        .update(runsTable)
        .set({
          status: "waiting_approval",
          tokensUsed: totalTokens,
          costUsdMicros: totalCost,
        })
        .where(eq(runsTable.id, runId));
      await finalizeTrace(trace.id, "ok", { tokens: totalTokens, costUsdMicros: totalCost, durationMs: Date.now() - started }, obsCount);
      await logEvent(tenantId, runId, "run.waiting", "Run paused awaiting human approval");
      return;
    }

    await db.insert(artifactsTable).values({
      tenantId,
      runId,
      traceId: trace.id,
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
    await finalizeTrace(trace.id, "ok", { tokens: totalTokens, costUsdMicros: totalCost, durationMs: Date.now() - started }, obsCount);
    await logEvent(tenantId, runId, "run.completed", `Run completed (${totalTokens} tokens)`);
  } catch (err) {
    logger.error({ err, runId }, "Run execution failed");
    await db
      .update(runsTable)
      .set({ status: "failed", error: String(err), completedAt: new Date() })
      .where(eq(runsTable.id, runId));
    await logEvent(tenantId, runId, "run.failed", `Run failed: ${String(err)}`, "error");
  }
}

/**
 * Resume a run that was paused at `waiting_approval` once all of its approvals
 * have been granted. This continues from the paused point — it finalizes the
 * already-processed actions into a completed run and does NOT re-run the
 * lifecycle or recreate any actions/approvals.
 */
export async function resumeRun(tenantId: string, runId: string): Promise<void> {
  const startedResume = Date.now();
  try {
    const [run] = await db
      .select()
      .from(runsTable)
      .where(and(eq(runsTable.id, runId), eq(runsTable.tenantId, tenantId)));
    if (!run || run.status !== "waiting_approval") return;

    // Guard: only finalize when there are no remaining pending approvals.
    const stillPending = await db
      .select({ id: approvalRequestsTable.id })
      .from(approvalRequestsTable)
      .where(and(eq(approvalRequestsTable.runId, runId), eq(approvalRequestsTable.status, "pending")));
    if (stillPending.length > 0) return;

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
    if (!claimed) return;

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
  } catch (err) {
    logger.error({ err, runId }, "Run resume failed");
    await db
      .update(runsTable)
      .set({ status: "failed", error: String(err), completedAt: new Date() })
      .where(eq(runsTable.id, runId));
    await logEvent(tenantId, runId, "run.failed", `Run resume failed: ${String(err)}`, "error");
  }
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
}

async function runAgent(args: RunAgentArgs): Promise<{
  agentRunId: string;
  tokensUsed: number;
  costUsdMicros: number;
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

  let result: LlmResult;
  if (primary) {
    result = await complete(primary, resolveSecret(primary.apiKeyRef), llmReq);
    if (result.usedStub && fallback) {
      const fb = await complete(fallback, resolveSecret(fallback.apiKeyRef), llmReq);
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
  };
}
