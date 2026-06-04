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
  tenantsTable,
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

  const [tenant] = await db
    .select({ settingsJson: tenantsTable.settingsJson })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId));
  const reviewedAtRaw = (tenant?.settingsJson as Record<string, unknown> | null)
    ?.botServersReviewedAt;
  const reviewedAt =
    typeof reviewedAtRaw === "string" ? new Date(reviewedAtRaw) : null;

  const constructedAdapters = await db
    .select()
    .from(adaptersTable)
    .where(
      and(
        eq(adaptersTable.tenantId, tenantId),
        eq(adaptersTable.transport, "constructed"),
      ),
    )
    .orderBy(desc(adaptersTable.createdAt));
  const botServers = constructedAdapters.filter(
    (a) =>
      ((a.metadataJson as Record<string, unknown> | null)?.createdVia as
        | string
        | undefined) === "agent",
  );
  const isNew = (createdAt: Date): boolean =>
    reviewedAt == null || createdAt.getTime() > reviewedAt.getTime();
  const newBotServerCount = botServers.filter((a) => isNew(a.createdAt)).length;
  const recentBotServers = botServers.slice(0, 5).map((a) => ({
    id: a.id,
    name: a.name,
    createdAt: a.createdAt,
    isNew: isNew(a.createdAt),
  }));

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
      botServerCount: botServers.length,
      newBotServerCount,
      recentBotServers,
      recentRuns: recentRuns.map((r) => serializeRun(r, intentTitles.get(r.intentId) ?? null)),
      recentArtifacts: recentArtifacts.map(serializeArtifact),
      recentAudit: recentAudit.map(serializeAudit),
    }),
  );
});

router.post(
  "/dashboard/review-bot-servers",
  async (req, res): Promise<void> => {
    const tenantId = req.tenantId;
    const [tenant] = await db
      .select({ settingsJson: tenantsTable.settingsJson })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, tenantId));
    if (!tenant) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }
    const settings = {
      ...((tenant.settingsJson as Record<string, unknown> | null) ?? {}),
      botServersReviewedAt: new Date().toISOString(),
    };
    await db
      .update(tenantsTable)
      .set({ settingsJson: settings })
      .where(eq(tenantsTable.id, tenantId));
    res.status(204).end();
  },
);

export default router;
