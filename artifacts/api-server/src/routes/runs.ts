import { Router, type IRouter } from "express";
import { eq, and, desc, inArray } from "drizzle-orm";
import {
  db,
  runsTable,
  intentsTable,
  actionsTable,
  approvalRequestsTable,
  contextFragmentsTable,
  contextPacksTable,
  artifactsTable,
  eventLogsTable,
  auditRecordsTable,
  workingMemoriesTable,
  agentRunsTable,
  agentMessagesTable,
  agentsTable,
} from "@workspace/db";
import {
  ListRunsQueryParams,
  ListRunsResponse,
  GetRunParams,
  GetRunResponse,
  PauseRunParams,
  PauseRunResponse,
  ResumeRunParams,
  ResumeRunResponse,
  CancelRunParams,
  CancelRunResponse,
  ListRunEventsParams,
  ListRunEventsResponse,
  GetActionParams,
  GetActionResponse,
  ListApprovalsQueryParams,
  ListApprovalsResponse,
  ApproveApprovalParams,
  ApproveApprovalBody,
  ApproveApprovalResponse,
  DenyApprovalParams,
  DenyApprovalBody,
  DenyApprovalResponse,
  ListArtifactsQueryParams,
  ListArtifactsResponse,
  GetArtifactParams,
  GetArtifactResponse,
  ListMemoryQueryParams,
  ListMemoryResponse,
  ListAuditQueryParams,
  ListAuditResponse,
} from "@workspace/api-zod";
import {
  serializeRun,
  serializeIntent,
  serializeAction,
  serializeApproval,
  serializeFragment,
  serializePack,
  serializeArtifact,
  serializeEvent,
  serializeAudit,
  serializeMemory,
  serializeAgentRun,
  serializeAgentMessage,
} from "../lib/serialize";
import { runEvents } from "../lib/events";
import { resumeRun, notifyTelegramOfRunOutcome } from "../lib/runEngine";

type RunStatus =
  | "pending"
  | "planning"
  | "running"
  | "waiting_approval"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

const router: IRouter = Router();

router.get("/runs", async (req, res): Promise<void> => {
  const q = ListRunsQueryParams.safeParse(req.query);
  if (!q.success) {
    res.status(400).json({ error: q.error.message });
    return;
  }
  const conds = [eq(runsTable.tenantId, req.tenantId)];
  if (q.data.status) conds.push(eq(runsTable.status, q.data.status as RunStatus));
  const rows = await db
    .select()
    .from(runsTable)
    .where(and(...conds))
    .orderBy(desc(runsTable.createdAt));
  const titles = new Map(
    (
      await db
        .select({ id: intentsTable.id, title: intentsTable.title })
        .from(intentsTable)
        .where(eq(intentsTable.tenantId, req.tenantId))
    ).map((i) => [i.id, i.title]),
  );
  const runIds = rows.map((r) => r.id);
  const fallbackRows = runIds.length
    ? await db
        .select({
          runId: agentRunsTable.runId,
          usedFallback: agentRunsTable.usedFallback,
        })
        .from(agentRunsTable)
        .where(inArray(agentRunsTable.runId, runIds))
    : [];
  const callAgg = new Map<string, { live: number; stub: number }>();
  for (const ar of fallbackRows) {
    const g = callAgg.get(ar.runId) ?? { live: 0, stub: 0 };
    if (ar.usedFallback) g.stub += 1;
    else g.live += 1;
    callAgg.set(ar.runId, g);
  }
  res.json(
    ListRunsResponse.parse(
      rows.map((r) => {
        const g = callAgg.get(r.id);
        return serializeRun(r, titles.get(r.intentId) ?? null, {
          liveCallCount: g?.live ?? 0,
          stubCallCount: g?.stub ?? 0,
        });
      }),
    ),
  );
});

router.get("/runs/:id", async (req, res): Promise<void> => {
  const params = GetRunParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [run] = await db
    .select()
    .from(runsTable)
    .where(and(eq(runsTable.id, params.data.id), eq(runsTable.tenantId, req.tenantId)));
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  const [intent] = await db
    .select()
    .from(intentsTable)
    .where(eq(intentsTable.id, run.intentId));
  const [actions, approvals, fragments, packs, arts, events, aRuns, aMsgs] =
    await Promise.all([
      db.select().from(actionsTable).where(eq(actionsTable.runId, run.id)).orderBy(actionsTable.createdAt),
      db.select().from(approvalRequestsTable).where(eq(approvalRequestsTable.runId, run.id)),
      db.select().from(contextFragmentsTable).where(eq(contextFragmentsTable.runId, run.id)),
      db.select().from(contextPacksTable).where(eq(contextPacksTable.runId, run.id)),
      db.select().from(artifactsTable).where(eq(artifactsTable.runId, run.id)),
      db.select().from(eventLogsTable).where(eq(eventLogsTable.runId, run.id)).orderBy(eventLogsTable.createdAt),
      db.select().from(agentRunsTable).where(eq(agentRunsTable.runId, run.id)),
      db.select().from(agentMessagesTable).where(eq(agentMessagesTable.runId, run.id)).orderBy(agentMessagesTable.createdAt),
    ]);
  const actionNames = new Map(actions.map((a) => [a.id, a.name]));
  const agentNames = new Map(
    (await db.select({ id: agentsTable.id, name: agentsTable.name }).from(agentsTable).where(eq(agentsTable.tenantId, req.tenantId))).map(
      (a) => [a.id, a.name],
    ),
  );

  res.json(
    GetRunResponse.parse({
      ...serializeRun(run, intent?.title ?? null, {
        liveCallCount: aRuns.filter((r) => !r.usedFallback).length,
        stubCallCount: aRuns.filter((r) => r.usedFallback).length,
      }),
      taskGraph: run.taskGraphJson ?? undefined,
      intent: intent ? serializeIntent(intent) : undefined,
      actions: actions.map(serializeAction),
      approvals: approvals.map((a) => serializeApproval(a, actionNames.get(a.actionId) ?? null)),
      contextFragments: fragments.map(serializeFragment),
      contextPacks: packs.map(serializePack),
      artifacts: arts.map(serializeArtifact),
      events: events.map(serializeEvent),
      agentRuns: aRuns.map((r) => serializeAgentRun(r, agentNames.get(r.agentId) ?? null)),
      agentMessages: aMsgs.map(serializeAgentMessage),
    }),
  );
});

async function setRunStatus(
  req: import("express").Request,
  id: string,
  status: RunStatus,
): Promise<(typeof runsTable.$inferSelect) | undefined> {
  const [row] = await db
    .update(runsTable)
    .set({ status, ...(status === "cancelled" ? { completedAt: new Date() } : {}) })
    .where(and(eq(runsTable.id, id), eq(runsTable.tenantId, req.tenantId)))
    .returning();
  return row;
}

router.post("/runs/:id/pause", async (req, res): Promise<void> => {
  const params = PauseRunParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const row = await setRunStatus(req, params.data.id, "paused");
  if (!row) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  res.json(PauseRunResponse.parse(serializeRun(row)));
});

router.post("/runs/:id/resume", async (req, res): Promise<void> => {
  const params = ResumeRunParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .select()
    .from(runsTable)
    .where(and(eq(runsTable.id, params.data.id), eq(runsTable.tenantId, req.tenantId)));
  if (!row) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  // A run paused at waiting_approval continues through the run engine, which
  // checks that no approvals remain pending before finalizing. Other paused
  // states simply transition back to running.
  if (row.status === "waiting_approval") {
    void resumeRun(req.tenantId, row.id);
    res.json(ResumeRunResponse.parse(serializeRun(row)));
    return;
  }
  const updated = await setRunStatus(req, params.data.id, "running");
  if (!updated) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  res.json(ResumeRunResponse.parse(serializeRun(updated)));
});

router.post("/runs/:id/cancel", async (req, res): Promise<void> => {
  const params = CancelRunParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const row = await setRunStatus(req, params.data.id, "cancelled");
  if (!row) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  await notifyTelegramOfRunOutcome(req.tenantId, row.id);
  res.json(CancelRunResponse.parse(serializeRun(row)));
});

router.get("/runs/:id/events", async (req, res): Promise<void> => {
  const params = ListRunEventsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  // Confirm the run exists and belongs to this tenant before opening any
  // stream — preserves the tenant boundary on the SSE path (the subscription
  // is keyed only by run id, so ownership must be checked up front).
  const [ownedRun] = await db
    .select({ id: runsTable.id })
    .from(runsTable)
    .where(and(eq(runsTable.id, params.data.id), eq(runsTable.tenantId, req.tenantId)));
  if (!ownedRun) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  // SSE stream when the client requests it; otherwise fall back to a snapshot.
  if (req.headers.accept?.includes("text/event-stream")) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`event: ping\ndata: {}\n\n`);
    const unsubscribe = runEvents.subscribe(params.data.id, (payload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    });
    req.on("close", () => {
      unsubscribe();
      res.end();
    });
    return;
  }
  const rows = await db
    .select()
    .from(eventLogsTable)
    .where(and(eq(eventLogsTable.runId, params.data.id), eq(eventLogsTable.tenantId, req.tenantId)))
    .orderBy(eventLogsTable.createdAt);
  res.json(ListRunEventsResponse.parse(rows.map(serializeEvent)));
});

router.get("/actions/:id", async (req, res): Promise<void> => {
  const params = GetActionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .select()
    .from(actionsTable)
    .where(and(eq(actionsTable.id, params.data.id), eq(actionsTable.tenantId, req.tenantId)));
  if (!row) {
    res.status(404).json({ error: "Action not found" });
    return;
  }
  res.json(GetActionResponse.parse(serializeAction(row)));
});

router.get("/approvals", async (req, res): Promise<void> => {
  const q = ListApprovalsQueryParams.safeParse(req.query);
  if (!q.success) {
    res.status(400).json({ error: q.error.message });
    return;
  }
  const conds = [eq(approvalRequestsTable.tenantId, req.tenantId)];
  if (q.data.status) {
    conds.push(eq(approvalRequestsTable.status, q.data.status as "pending" | "approved" | "denied" | "expired"));
  }
  const rows = await db
    .select()
    .from(approvalRequestsTable)
    .where(and(...conds))
    .orderBy(desc(approvalRequestsTable.createdAt));
  const actionIds = rows.map((r) => r.actionId);
  const actions = actionIds.length
    ? await db.select({ id: actionsTable.id, name: actionsTable.name }).from(actionsTable).where(inArray(actionsTable.id, actionIds))
    : [];
  const names = new Map(actions.map((a) => [a.id, a.name]));
  res.json(ListApprovalsResponse.parse(rows.map((r) => serializeApproval(r, names.get(r.actionId) ?? null))));
});

router.post("/approvals/:id/approve", async (req, res): Promise<void> => {
  const params = ApproveApprovalParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = ApproveApprovalBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .update(approvalRequestsTable)
    .set({
      status: "approved",
      decisionNote: parsed.data.note ?? null,
      decidedBy: req.userId,
      decidedAt: new Date(),
    })
    .where(and(eq(approvalRequestsTable.id, params.data.id), eq(approvalRequestsTable.tenantId, req.tenantId)))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Approval not found" });
    return;
  }
  await db
    .update(actionsTable)
    .set({ status: "completed", outputJson: { ok: true, approved: true }, completedAt: new Date() })
    .where(eq(actionsTable.id, row.actionId));
  // Resume the paused run from where it stopped (finalize already-processed
  // actions) only once every required approval has been granted. This never
  // re-runs the lifecycle or recreates actions/approvals.
  const remaining = await db
    .select({ c: approvalRequestsTable.id })
    .from(approvalRequestsTable)
    .where(and(eq(approvalRequestsTable.runId, row.runId), eq(approvalRequestsTable.status, "pending")));
  if (remaining.length === 0) {
    void resumeRun(req.tenantId, row.runId);
  }
  res.json(ApproveApprovalResponse.parse(serializeApproval(row)));
});

router.post("/approvals/:id/deny", async (req, res): Promise<void> => {
  const params = DenyApprovalParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = DenyApprovalBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .update(approvalRequestsTable)
    .set({
      status: "denied",
      decisionNote: parsed.data.note ?? null,
      decidedBy: req.userId,
      decidedAt: new Date(),
    })
    .where(and(eq(approvalRequestsTable.id, params.data.id), eq(approvalRequestsTable.tenantId, req.tenantId)))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Approval not found" });
    return;
  }
  await db
    .update(actionsTable)
    .set({ status: "denied", completedAt: new Date() })
    .where(eq(actionsTable.id, row.actionId));
  await db
    .update(runsTable)
    .set({ status: "failed", error: "Action denied by reviewer", completedAt: new Date() })
    .where(eq(runsTable.id, row.runId));
  await notifyTelegramOfRunOutcome(req.tenantId, row.runId);
  res.json(DenyApprovalResponse.parse(serializeApproval(row)));
});

router.get("/artifacts", async (req, res): Promise<void> => {
  const q = ListArtifactsQueryParams.safeParse(req.query);
  if (!q.success) {
    res.status(400).json({ error: q.error.message });
    return;
  }
  const conds = [eq(artifactsTable.tenantId, req.tenantId)];
  if (q.data.runId) conds.push(eq(artifactsTable.runId, q.data.runId));
  const rows = await db
    .select()
    .from(artifactsTable)
    .where(and(...conds))
    .orderBy(desc(artifactsTable.createdAt));
  res.json(ListArtifactsResponse.parse(rows.map(serializeArtifact)));
});

router.get("/artifacts/:id", async (req, res): Promise<void> => {
  const params = GetArtifactParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .select()
    .from(artifactsTable)
    .where(and(eq(artifactsTable.id, params.data.id), eq(artifactsTable.tenantId, req.tenantId)));
  if (!row) {
    res.status(404).json({ error: "Artifact not found" });
    return;
  }
  res.json(GetArtifactResponse.parse(serializeArtifact(row)));
});

router.get("/memory", async (req, res): Promise<void> => {
  const q = ListMemoryQueryParams.safeParse(req.query);
  if (!q.success) {
    res.status(400).json({ error: q.error.message });
    return;
  }
  const conds = [eq(workingMemoriesTable.tenantId, req.tenantId)];
  if (q.data.type) conds.push(eq(workingMemoriesTable.type, q.data.type as "working" | "episodic" | "semantic"));
  if (q.data.sensitivity) {
    conds.push(eq(workingMemoriesTable.sensitivity, q.data.sensitivity as "public" | "internal" | "confidential" | "restricted"));
  }
  let rows = await db
    .select()
    .from(workingMemoriesTable)
    .where(and(...conds))
    .orderBy(desc(workingMemoriesTable.createdAt));
  if (q.data.q) {
    const needle = q.data.q.toLowerCase();
    rows = rows.filter(
      (r) => r.key.toLowerCase().includes(needle) || r.value.toLowerCase().includes(needle),
    );
  }
  res.json(ListMemoryResponse.parse(rows.map(serializeMemory)));
});

router.get("/audit", async (req, res): Promise<void> => {
  const q = ListAuditQueryParams.safeParse(req.query);
  if (!q.success) {
    res.status(400).json({ error: q.error.message });
    return;
  }
  const conds = [eq(auditRecordsTable.tenantId, req.tenantId)];
  if (q.data.resourceType) conds.push(eq(auditRecordsTable.resourceType, q.data.resourceType));
  if (q.data.riskTier) conds.push(eq(auditRecordsTable.riskTier, q.data.riskTier as "L1" | "L2" | "L3" | "L4"));
  const rows = await db
    .select()
    .from(auditRecordsTable)
    .where(and(...conds))
    .orderBy(desc(auditRecordsTable.createdAt));
  res.json(ListAuditResponse.parse(rows.map(serializeAudit)));
});

export default router;
