import { eq } from "drizzle-orm";
import {
  db,
  tracesTable,
  observationsTable,
  observationMetricsTable,
  type Trace,
} from "@workspace/db";

interface NewTraceArgs {
  tenantId: string;
  name: string;
  rootType?: string;
  runId?: string | null;
  riskTier?: "L1" | "L2" | "L3" | "L4" | null;
  initiatedBy?: string;
}

export async function startTrace(args: NewTraceArgs): Promise<Trace> {
  const [trace] = await db
    .insert(tracesTable)
    .values({
      tenantId: args.tenantId,
      name: args.name,
      rootType: args.rootType ?? "run",
      runId: args.runId ?? null,
      riskTier: args.riskTier ?? null,
      initiatedBy: args.initiatedBy ?? "owner",
      status: "running",
      startedAt: new Date(),
    })
    .returning();
  return trace;
}

interface RecordObservationArgs {
  tenantId: string;
  traceId: string;
  parentObservationId?: string | null;
  type:
    | "run"
    | "task_node"
    | "agent_run"
    | "model_call"
    | "context_assembly"
    | "retrieval"
    | "memory_write"
    | "tool_call"
    | "policy_check"
    | "approval"
    | "artifact_write"
    | "event_emit"
    | "eval"
    | "error";
  name: string;
  layer?: string;
  status?: "ok" | "error" | "running" | "blocked";
  agentId?: string | null;
  agentRunId?: string | null;
  modelEndpointId?: string | null;
  capabilityId?: string | null;
  input?: Record<string, unknown> | null;
  output?: Record<string, unknown> | null;
  error?: Record<string, unknown> | null;
  durationMs?: number;
  metrics?: {
    latencyMs?: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    costUsdMicros?: number;
    timeToFirstTokenMs?: number;
    finishReason?: string;
  };
}

export async function recordObservation(
  args: RecordObservationArgs,
): Promise<string> {
  const now = new Date();
  const started = new Date(now.getTime() - (args.durationMs ?? 0));
  const [obs] = await db
    .insert(observationsTable)
    .values({
      tenantId: args.tenantId,
      traceId: args.traceId,
      parentObservationId: args.parentObservationId ?? null,
      type: args.type,
      name: args.name,
      layer: args.layer ?? "orchestration",
      status: args.status ?? "ok",
      agentId: args.agentId ?? null,
      agentRunId: args.agentRunId ?? null,
      modelEndpointId: args.modelEndpointId ?? null,
      capabilityId: args.capabilityId ?? null,
      inputJson: args.input ?? null,
      outputJson: args.output ?? null,
      errorJson: args.error ?? null,
      startedAt: started,
      endedAt: now,
    })
    .returning({ id: observationsTable.id });

  if (args.metrics) {
    await db.insert(observationMetricsTable).values({
      tenantId: args.tenantId,
      observationId: obs.id,
      latencyMs: args.metrics.latencyMs ?? 0,
      promptTokens: args.metrics.promptTokens ?? 0,
      completionTokens: args.metrics.completionTokens ?? 0,
      totalTokens: args.metrics.totalTokens ?? 0,
      costUsdMicros: args.metrics.costUsdMicros ?? 0,
      timeToFirstTokenMs: args.metrics.timeToFirstTokenMs ?? null,
      finishReason: args.metrics.finishReason ?? null,
    });
  }

  return obs.id;
}

export async function finalizeTrace(
  traceId: string,
  status: "ok" | "error" | "partial",
  totals: { tokens: number; costUsdMicros: number; durationMs: number },
  observationCount: number,
): Promise<void> {
  await db
    .update(tracesTable)
    .set({
      status,
      totalTokens: totals.tokens,
      totalCostUsdMicros: totals.costUsdMicros,
      durationMs: totals.durationMs,
      observationCount,
      endedAt: new Date(),
    })
    .where(eq(tracesTable.id, traceId));
}
