import { Router, type IRouter } from "express";
import { db, intentsTable, runsTable } from "@workspace/db";
import { RunCommandBody } from "@workspace/api-zod";
import { executeRun } from "../lib/runEngine";
import { requireApiKey } from "../middlewares/tenant";
import { recordAudit } from "../lib/audit";

type RiskTier = "L1" | "L2" | "L3" | "L4";
type OrchestrationMode = "static_graph" | "dynamic_delegation";

const router: IRouter = Router();

// Remote surface: only reachable with a valid API key, never the owner session.
router.use("/commands", requireApiKey);

/**
 * One-call convenience for remote callers (an external AI/script with an API
 * key): create an intent and immediately start a run for it. Returns the ids so
 * the caller can poll run status.
 */
router.post("/commands/run", async (req, res): Promise<void> => {
  const parsed = RunCommandBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [intent] = await db
    .insert(intentsTable)
    .values({
      tenantId: req.tenantId,
      title: parsed.data.title ?? parsed.data.goal.slice(0, 80),
      goal: parsed.data.goal,
      constraints: parsed.data.constraints ?? null,
      successCriteria: parsed.data.successCriteria ?? null,
      riskTier: (parsed.data.riskTier as RiskTier) ?? "L2",
      createdBy: req.userId,
    })
    .returning();
  const [run] = await db
    .insert(runsTable)
    .values({
      tenantId: req.tenantId,
      intentId: intent.id,
      status: "pending",
      orchestrationMode:
        (parsed.data.orchestrationMode as OrchestrationMode) ?? "static_graph",
      leadAgentId: parsed.data.leadAgentId ?? null,
    })
    .returning();

  await recordAudit({
    tenantId: req.tenantId,
    actorType: "service",
    actorId: req.userId,
    action: "run.started",
    resourceType: "run",
    resourceId: run.id,
    summary: `Remote command started run for intent "${intent.title}"`,
    riskTier: intent.riskTier,
    runId: run.id,
    dataJson: { intentId: intent.id, via: "commands_api" },
  });

  void executeRun(req.tenantId, run.id);

  res.status(201).json({
    intentId: intent.id,
    runId: run.id,
    status: run.status,
  });
});

export default router;
