import { Router, type IRouter } from "express";
import { eq, and, desc, count } from "drizzle-orm";
import { db, intentsTable, runsTable } from "@workspace/db";
import {
  ListIntentsQueryParams,
  ListIntentsResponse,
  CreateIntentBody,
  GetIntentParams,
  GetIntentResponse,
  UpdateIntentParams,
  UpdateIntentBody,
  UpdateIntentResponse,
  DeleteIntentParams,
  StartRunParams,
  StartRunBody,
  GetRunResponse,
} from "@workspace/api-zod";
import { serializeIntent, serializeRun } from "../lib/serialize";
import { executeRun } from "../lib/runEngine";
import { recordAudit } from "../lib/audit";

type RiskTier = "L1" | "L2" | "L3" | "L4";
type IntentStatus =
  | "draft"
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
type OrchestrationMode = "static_graph" | "dynamic_delegation";

const router: IRouter = Router();

router.get("/intents", async (req, res): Promise<void> => {
  const q = ListIntentsQueryParams.safeParse(req.query);
  if (!q.success) {
    res.status(400).json({ error: q.error.message });
    return;
  }
  const conds = [eq(intentsTable.tenantId, req.tenantId)];
  if (q.data.status) conds.push(eq(intentsTable.status, q.data.status as IntentStatus));
  const rows = await db
    .select()
    .from(intentsTable)
    .where(and(...conds))
    .orderBy(desc(intentsTable.createdAt));
  const counts = await db
    .select({ intentId: runsTable.intentId, c: count() })
    .from(runsTable)
    .where(eq(runsTable.tenantId, req.tenantId))
    .groupBy(runsTable.intentId);
  const map = new Map(counts.map((c) => [c.intentId, c.c]));
  res.json(ListIntentsResponse.parse(rows.map((i) => serializeIntent(i, map.get(i.id) ?? 0))));
});

router.post("/intents", async (req, res): Promise<void> => {
  const parsed = CreateIntentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(intentsTable)
    .values({
      tenantId: req.tenantId,
      title: parsed.data.title,
      goal: parsed.data.goal,
      constraints: parsed.data.constraints ?? null,
      successCriteria: parsed.data.successCriteria ?? null,
      allowedSystems: parsed.data.allowedSystems ?? null,
      deniedSystems: parsed.data.deniedSystems ?? null,
      budgetTokens: parsed.data.budgetTokens ?? null,
      budgetUsd: parsed.data.budgetUsd ?? null,
      maxSteps: parsed.data.maxSteps ?? null,
      riskTier: (parsed.data.riskTier as RiskTier) ?? "L2",
      createdBy: req.userId,
    })
    .returning();
  await recordAudit({
    tenantId: req.tenantId,
    actorId: req.userId,
    action: "intent.created",
    resourceType: "intent",
    resourceId: row.id,
    summary: `Created intent "${row.title}"`,
    riskTier: row.riskTier,
  });
  res.status(201).json(GetIntentResponse.parse(serializeIntent(row, 0)));
});

router.get("/intents/:id", async (req, res): Promise<void> => {
  const params = GetIntentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .select()
    .from(intentsTable)
    .where(and(eq(intentsTable.id, params.data.id), eq(intentsTable.tenantId, req.tenantId)));
  if (!row) {
    res.status(404).json({ error: "Intent not found" });
    return;
  }
  const [c] = await db
    .select({ c: count() })
    .from(runsTable)
    .where(eq(runsTable.intentId, row.id));
  res.json(GetIntentResponse.parse(serializeIntent(row, c.c)));
});

router.patch("/intents/:id", async (req, res): Promise<void> => {
  const params = UpdateIntentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateIntentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .update(intentsTable)
    .set({
      ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
      ...(parsed.data.goal !== undefined ? { goal: parsed.data.goal } : {}),
      ...(parsed.data.constraints !== undefined ? { constraints: parsed.data.constraints } : {}),
      ...(parsed.data.successCriteria !== undefined ? { successCriteria: parsed.data.successCriteria } : {}),
      ...(parsed.data.riskTier !== undefined ? { riskTier: parsed.data.riskTier as RiskTier } : {}),
      ...(parsed.data.status !== undefined ? { status: parsed.data.status as IntentStatus } : {}),
    })
    .where(and(eq(intentsTable.id, params.data.id), eq(intentsTable.tenantId, req.tenantId)))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Intent not found" });
    return;
  }
  await recordAudit({
    tenantId: req.tenantId,
    actorId: req.userId,
    action: "intent.updated",
    resourceType: "intent",
    resourceId: row.id,
    summary: `Updated intent "${row.title}"`,
    riskTier: row.riskTier,
    dataJson: { changed: Object.keys(parsed.data) },
  });
  res.json(UpdateIntentResponse.parse(serializeIntent(row)));
});

router.delete("/intents/:id", async (req, res): Promise<void> => {
  const params = DeleteIntentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .delete(intentsTable)
    .where(and(eq(intentsTable.id, params.data.id), eq(intentsTable.tenantId, req.tenantId)))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Intent not found" });
    return;
  }
  await recordAudit({
    tenantId: req.tenantId,
    actorId: req.userId,
    action: "intent.deleted",
    resourceType: "intent",
    resourceId: row.id,
    summary: `Deleted intent "${row.title}"`,
  });
  res.sendStatus(204);
});

router.post("/intents/:id/start-run", async (req, res): Promise<void> => {
  const params = StartRunParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = StartRunBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [intent] = await db
    .select()
    .from(intentsTable)
    .where(and(eq(intentsTable.id, params.data.id), eq(intentsTable.tenantId, req.tenantId)));
  if (!intent) {
    res.status(404).json({ error: "Intent not found" });
    return;
  }
  const [run] = await db
    .insert(runsTable)
    .values({
      tenantId: req.tenantId,
      intentId: intent.id,
      status: "pending",
      orchestrationMode: (parsed.data.orchestrationMode as OrchestrationMode) ?? "static_graph",
      leadAgentId: parsed.data.leadAgentId ?? null,
    })
    .returning();

  await recordAudit({
    tenantId: req.tenantId,
    actorId: req.userId,
    action: "run.started",
    resourceType: "run",
    resourceId: run.id,
    summary: `Started run for intent "${intent.title}"`,
    riskTier: intent.riskTier,
    runId: run.id,
    dataJson: { intentId: intent.id, orchestrationMode: run.orchestrationMode },
  });

  void executeRun(req.tenantId, run.id);

  res.status(201).json(GetRunResponse.parse(serializeRun(run, intent.title)));
});

export default router;
