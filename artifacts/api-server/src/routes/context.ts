import { Router, type IRouter } from "express";
import { eq, and, desc, count, inArray } from "drizzle-orm";
import {
  db,
  adaptersTable,
  capabilitiesTable,
  runsTable,
  approvalRequestsTable,
  agentsTable,
  modelEndpointsTable,
  generatedMcpServersTable,
  tracesTable,
  intentsTable,
  artifactsTable,
  auditRecordsTable,
} from "@workspace/db";
import { GetMeResponse, GetDashboardResponse } from "@workspace/api-zod";
import { getContext } from "../lib/context";
import { serializeArtifact, serializeAudit, serializeRun } from "../lib/serialize";

const router: IRouter = Router();

router.get("/me", async (_req, res): Promise<void> => {
  const ctx = await getContext();
  res.json(
    GetMeResponse.parse({
      user: {
        id: ctx.user.id,
        email: ctx.user.email,
        name: ctx.user.name,
        avatarUrl: ctx.user.avatarUrl,
        isOwner: ctx.user.isOwner,
      },
      tenant: {
        id: ctx.tenant.id,
        name: ctx.tenant.name,
        slug: ctx.tenant.slug,
        description: ctx.tenant.description,
        isDefault: ctx.tenant.isDefault,
      },
      tenants: [
        {
          id: ctx.tenant.id,
          name: ctx.tenant.name,
          slug: ctx.tenant.slug,
          description: ctx.tenant.description,
          isDefault: ctx.tenant.isDefault,
        },
      ],
    }),
  );
});

router.get("/dashboard", async (req, res): Promise<void> => {
  const tenantId = req.tenantId;
  const [
    [adapters],
    [caps],
    [agents],
    [endpoints],
    [servers],
    [traces],
    [intents],
  ] = await Promise.all([
    db.select({ c: count() }).from(adaptersTable).where(eq(adaptersTable.tenantId, tenantId)),
    db.select({ c: count() }).from(capabilitiesTable).where(eq(capabilitiesTable.tenantId, tenantId)),
    db.select({ c: count() }).from(agentsTable).where(eq(agentsTable.tenantId, tenantId)),
    db.select({ c: count() }).from(modelEndpointsTable).where(eq(modelEndpointsTable.tenantId, tenantId)),
    db.select({ c: count() }).from(generatedMcpServersTable).where(eq(generatedMcpServersTable.tenantId, tenantId)),
    db.select({ c: count() }).from(tracesTable).where(eq(tracesTable.tenantId, tenantId)),
    db.select({ c: count() }).from(intentsTable).where(eq(intentsTable.tenantId, tenantId)),
  ]);

  const activeRuns = await db
    .select({ c: count() })
    .from(runsTable)
    .where(
      and(
        eq(runsTable.tenantId, tenantId),
        inArray(runsTable.status, ["pending", "running", "waiting_approval"]),
      ),
    );

  const pendingApprovals = await db
    .select({ c: count() })
    .from(approvalRequestsTable)
    .where(
      and(
        eq(approvalRequestsTable.tenantId, tenantId),
        eq(approvalRequestsTable.status, "pending"),
      ),
    );

  const recentRuns = await db
    .select()
    .from(runsTable)
    .where(eq(runsTable.tenantId, tenantId))
    .orderBy(desc(runsTable.createdAt))
    .limit(6);
  const intentTitles = new Map(
    (
      await db
        .select({ id: intentsTable.id, title: intentsTable.title })
        .from(intentsTable)
        .where(eq(intentsTable.tenantId, tenantId))
    ).map((i) => [i.id, i.title]),
  );

  const recentArtifacts = await db
    .select()
    .from(artifactsTable)
    .where(eq(artifactsTable.tenantId, tenantId))
    .orderBy(desc(artifactsTable.createdAt))
    .limit(6);

  const recentAudit = await db
    .select()
    .from(auditRecordsTable)
    .where(eq(auditRecordsTable.tenantId, tenantId))
    .orderBy(desc(auditRecordsTable.createdAt))
    .limit(8);

  res.json(
    GetDashboardResponse.parse({
      adapterCount: adapters.c,
      capabilityCount: caps.c,
      activeRunCount: activeRuns[0].c,
      pendingApprovalCount: pendingApprovals[0].c,
      agentCount: agents.c,
      modelEndpointCount: endpoints.c,
      generatedServerCount: servers.c,
      traceCount: traces.c,
      intentCount: intents.c,
      recentRuns: recentRuns.map((r) => serializeRun(r, intentTitles.get(r.intentId) ?? null)),
      recentArtifacts: recentArtifacts.map(serializeArtifact),
      recentAudit: recentAudit.map(serializeAudit),
    }),
  );
});

export default router;
