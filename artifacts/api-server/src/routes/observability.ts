import { Router, type IRouter } from "express";
import { eq, and, desc, inArray } from "drizzle-orm";
import {
  db,
  tracesTable,
  observationsTable,
  observationMetricsTable,
  evaluationRecordsTable,
  uiViewsTable,
  telemetryExportsTable,
} from "@workspace/db";
import {
  ListTracesQueryParams,
  ListTracesResponse,
  GetTraceParams,
  GetTraceResponse,
  GetObservabilityMetricsQueryParams,
  GetObservabilityMetricsResponse,
  ListEvaluationRecordsResponse,
  CreateEvaluationRecordBody,
  LabelEvaluationRecordParams,
  LabelEvaluationRecordBody,
  LabelEvaluationRecordResponse,
  ListUiViewsResponse,
  CreateUiViewBody,
  DeleteUiViewParams,
  ListTelemetryExportsResponse,
  CreateTelemetryExportBody,
  UpdateTelemetryExportParams,
  UpdateTelemetryExportBody,
  UpdateTelemetryExportResponse,
} from "@workspace/api-zod";
import {
  serializeTrace,
  serializeObservation,
  serializeEvaluation,
  serializeUiView,
  serializeTelemetryExport,
} from "../lib/serialize";

type RiskTier = "L1" | "L2" | "L3" | "L4";
type EvalLabel = "success" | "failure" | "partial" | "unlabeled";
type TelemetryFormat = "otlp" | "jsonl" | "csv";
type TraceStatus = "ok" | "error" | "partial" | "running";
type TraceRootType = "run" | "mcp_request" | "synthesis" | "manual";

function normalizeEvalLabel(value: string | undefined): EvalLabel {
  switch (value) {
    case "success":
    case "pass":
      return "success";
    case "failure":
    case "fail":
      return "failure";
    case "partial":
    case "neutral":
      return "partial";
    default:
      return "unlabeled";
  }
}

function normalizeTelemetryFormat(value: string): TelemetryFormat {
  switch (value) {
    case "jsonl":
    case "json":
      return "jsonl";
    case "csv":
      return "csv";
    default:
      return "otlp";
  }
}

const router: IRouter = Router();

router.get("/traces", async (req, res): Promise<void> => {
  const q = ListTracesQueryParams.safeParse(req.query);
  if (!q.success) {
    res.status(400).json({ error: q.error.message });
    return;
  }
  const conds = [eq(tracesTable.tenantId, req.tenantId)];
  if (q.data.status) conds.push(eq(tracesTable.status, q.data.status as TraceStatus));
  if (q.data.riskTier) conds.push(eq(tracesTable.riskTier, q.data.riskTier as RiskTier));
  if (q.data.rootType) conds.push(eq(tracesTable.rootType, q.data.rootType as TraceRootType));
  const rows = await db
    .select()
    .from(tracesTable)
    .where(and(...conds))
    .orderBy(desc(tracesTable.createdAt));
  res.json(ListTracesResponse.parse(rows.map(serializeTrace)));
});

router.get("/traces/:id", async (req, res): Promise<void> => {
  const params = GetTraceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [trace] = await db
    .select()
    .from(tracesTable)
    .where(and(eq(tracesTable.id, params.data.id), eq(tracesTable.tenantId, req.tenantId)));
  if (!trace) {
    res.status(404).json({ error: "Trace not found" });
    return;
  }
  const obs = await db
    .select()
    .from(observationsTable)
    .where(eq(observationsTable.traceId, trace.id))
    .orderBy(observationsTable.startedAt);
  const obsIds = obs.map((o) => o.id);
  const metrics = obsIds.length
    ? await db
        .select()
        .from(observationMetricsTable)
        .where(inArray(observationMetricsTable.observationId, obsIds))
    : [];
  const metricMap = new Map(metrics.map((m) => [m.observationId, m]));
  res.json(
    GetTraceResponse.parse({
      ...serializeTrace(trace),
      observations: obs.map((o) => serializeObservation(o, metricMap.get(o.id) ?? null)),
    }),
  );
});

router.get("/observability/metrics", async (req, res): Promise<void> => {
  const q = GetObservabilityMetricsQueryParams.safeParse(req.query);
  if (!q.success) {
    res.status(400).json({ error: q.error.message });
    return;
  }
  const level = q.data.level ?? "agents";
  const obs = await db
    .select()
    .from(observationsTable)
    .where(eq(observationsTable.tenantId, req.tenantId));
  const metrics = await db
    .select()
    .from(observationMetricsTable)
    .where(eq(observationMetricsTable.tenantId, req.tenantId));
  const metricMap = new Map(metrics.map((m) => [m.observationId, m]));

  const keyFor = (o: (typeof obs)[number]): string => {
    switch (level) {
      case "models":
        return o.modelEndpointId ?? "no-model";
      case "tools":
        return o.capabilityId ?? "no-tool";
      case "context":
        return o.layer ?? "context";
      case "policy":
        return o.layer ?? "policy";
      case "evals":
        return o.type;
      case "agents":
      default:
        return o.agentId ?? o.layer ?? "system";
    }
  };

  const groups = new Map<
    string,
    { count: number; tokens: number; cost: number; latency: number; errors: number }
  >();
  for (const o of obs) {
    const k = keyFor(o);
    const g = groups.get(k) ?? { count: 0, tokens: 0, cost: 0, latency: 0, errors: 0 };
    const m = metricMap.get(o.id);
    g.count += 1;
    g.tokens += m?.totalTokens ?? 0;
    g.cost += m?.costUsdMicros ?? 0;
    g.latency += m?.latencyMs ?? 0;
    if (o.status === "error") g.errors += 1;
    groups.set(k, g);
  }

  const rows = [...groups.entries()].map(([label, g]) => ({
    label,
    count: g.count,
    tokens: g.tokens,
    costUsdMicros: g.cost,
    avgLatencyMs: g.count ? Math.round(g.latency / g.count) : 0,
    errorRate: g.count ? g.errors / g.count : 0,
    successRate: g.count ? (g.count - g.errors) / g.count : 1,
  }));

  let liveModelCalls = 0;
  let stubModelCalls = 0;
  for (const o of obs) {
    if (o.type !== "model_call") continue;
    const m = metricMap.get(o.id);
    if (!m || m.usedStub == null) continue;
    if (m.usedStub) stubModelCalls += 1;
    else liveModelCalls += 1;
  }

  res.json(
    GetObservabilityMetricsResponse.parse({
      level,
      rows,
      totals: {
        observations: obs.length,
        tokens: rows.reduce((s, r) => s + r.tokens, 0),
        costUsdMicros: rows.reduce((s, r) => s + r.costUsdMicros, 0),
        liveModelCalls,
        stubModelCalls,
      },
    }),
  );
});

router.get("/evaluation-records", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(evaluationRecordsTable)
    .where(eq(evaluationRecordsTable.tenantId, req.tenantId))
    .orderBy(desc(evaluationRecordsTable.createdAt));
  res.json(ListEvaluationRecordsResponse.parse(rows.map(serializeEvaluation)));
});

router.post("/evaluation-records", async (req, res): Promise<void> => {
  const parsed = CreateEvaluationRecordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(evaluationRecordsTable)
    .values({
      tenantId: req.tenantId,
      name: parsed.data.name,
      traceId: parsed.data.traceId ?? null,
      observationId: parsed.data.observationId ?? null,
      label: normalizeEvalLabel(parsed.data.label),
      score: parsed.data.score ?? null,
      reviewNote: parsed.data.reviewNote ?? null,
      isReferenceExample: parsed.data.isReferenceExample ?? false,
      evaluatorType: "human",
    })
    .returning();
  res.status(201).json(LabelEvaluationRecordResponse.parse(serializeEvaluation(row)));
});

router.post("/evaluation-records/:id/label", async (req, res): Promise<void> => {
  const params = LabelEvaluationRecordParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = LabelEvaluationRecordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .update(evaluationRecordsTable)
    .set({
      ...(parsed.data.label !== undefined ? { label: normalizeEvalLabel(parsed.data.label) } : {}),
      ...(parsed.data.score !== undefined ? { score: parsed.data.score } : {}),
      ...(parsed.data.reviewNote !== undefined ? { reviewNote: parsed.data.reviewNote } : {}),
      ...(parsed.data.isReferenceExample !== undefined ? { isReferenceExample: parsed.data.isReferenceExample } : {}),
    })
    .where(and(eq(evaluationRecordsTable.id, params.data.id), eq(evaluationRecordsTable.tenantId, req.tenantId)))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Evaluation not found" });
    return;
  }
  res.json(LabelEvaluationRecordResponse.parse(serializeEvaluation(row)));
});

router.get("/ui-views", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(uiViewsTable)
    .where(eq(uiViewsTable.tenantId, req.tenantId))
    .orderBy(desc(uiViewsTable.createdAt));
  res.json(ListUiViewsResponse.parse(rows.map(serializeUiView)));
});

router.post("/ui-views", async (req, res): Promise<void> => {
  const parsed = CreateUiViewBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(uiViewsTable)
    .values({
      tenantId: req.tenantId,
      name: parsed.data.name,
      scope: parsed.data.scope ?? "traces",
      filtersJson: parsed.data.filters ?? null,
      isPinned: parsed.data.isPinned ?? false,
    })
    .returning();
  res.status(201).json(serializeUiView(row));
});

router.delete("/ui-views/:id", async (req, res): Promise<void> => {
  const params = DeleteUiViewParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .delete(uiViewsTable)
    .where(and(eq(uiViewsTable.id, params.data.id), eq(uiViewsTable.tenantId, req.tenantId)))
    .returning();
  if (!row) {
    res.status(404).json({ error: "UI view not found" });
    return;
  }
  res.sendStatus(204);
});

router.get("/telemetry-exports", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(telemetryExportsTable)
    .where(eq(telemetryExportsTable.tenantId, req.tenantId))
    .orderBy(desc(telemetryExportsTable.createdAt));
  res.json(ListTelemetryExportsResponse.parse(rows.map(serializeTelemetryExport)));
});

router.post("/telemetry-exports", async (req, res): Promise<void> => {
  const parsed = CreateTelemetryExportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(telemetryExportsTable)
    .values({
      tenantId: req.tenantId,
      name: parsed.data.name,
      format: normalizeTelemetryFormat(parsed.data.format),
      endpoint: parsed.data.endpoint ?? null,
      enabled: parsed.data.enabled ?? true,
    })
    .returning();
  res.status(201).json(serializeTelemetryExport(row));
});

router.patch("/telemetry-exports/:id", async (req, res): Promise<void> => {
  const params = UpdateTelemetryExportParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateTelemetryExportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .update(telemetryExportsTable)
    .set({
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.endpoint !== undefined ? { endpoint: parsed.data.endpoint } : {}),
      ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
    })
    .where(and(eq(telemetryExportsTable.id, params.data.id), eq(telemetryExportsTable.tenantId, req.tenantId)))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Telemetry export not found" });
    return;
  }
  res.json(UpdateTelemetryExportResponse.parse(serializeTelemetryExport(row)));
});

export default router;
