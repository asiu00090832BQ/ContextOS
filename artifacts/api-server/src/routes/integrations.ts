import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import {
  db,
  integrationBlueprintsTable,
  generatedMcpServersTable,
  synthesizedCapabilitiesTable,
  integrationTestsTable,
  deploymentTargetsTable,
  adaptersTable,
} from "@workspace/db";
import {
  ListBlueprintsResponse,
  CreateBlueprintBody,
  GetBlueprintParams,
  GetBlueprintResponse,
  AnalyzeBlueprintParams,
  AnalyzeBlueprintResponse,
  SynthesizeServerParams,
  ListGeneratedServersResponse,
  GetGeneratedServerParams,
  GetGeneratedServerResponse,
  TestGeneratedServerParams,
  TestGeneratedServerResponse,
  DeployGeneratedServerParams,
  DeployGeneratedServerResponse,
  RegisterGeneratedServerParams,
  RegisterGeneratedServerResponse,
  RegenerateGeneratedServerParams,
  RegenerateGeneratedServerBody,
  ListDeploymentTargetsResponse,
} from "@workspace/api-zod";
import {
  serializeBlueprint,
  serializeGeneratedServer,
  serializeGeneratedServerDetail,
  serializeDeploymentTarget,
} from "../lib/serialize";
import { analyzeBlueprint, synthesizeServer, type NormalizedSpec } from "../lib/synthesis";

const router: IRouter = Router();

async function loadServerDetail(server: typeof generatedMcpServersTable.$inferSelect) {
  const [caps, tests] = await Promise.all([
    db.select().from(synthesizedCapabilitiesTable).where(eq(synthesizedCapabilitiesTable.generatedServerId, server.id)),
    db.select().from(integrationTestsTable).where(eq(integrationTestsTable.generatedServerId, server.id)),
  ]);
  return serializeGeneratedServerDetail(server, caps, tests);
}

router.get("/blueprints", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(integrationBlueprintsTable)
    .where(eq(integrationBlueprintsTable.tenantId, req.tenantId))
    .orderBy(desc(integrationBlueprintsTable.createdAt));
  res.json(ListBlueprintsResponse.parse(rows.map(serializeBlueprint)));
});

router.post("/blueprints", async (req, res): Promise<void> => {
  const parsed = CreateBlueprintBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(integrationBlueprintsTable)
    .values({
      tenantId: req.tenantId,
      name: parsed.data.name,
      serviceName: parsed.data.serviceName,
      sourceType: (parsed.data.sourceType as "openapi" | "graphql" | "sdk" | "docs" | "manual") ?? "manual",
      sourceUrl: parsed.data.sourceUrl ?? null,
      sourceSpec: parsed.data.sourceSpec ?? null,
    })
    .returning();
  res.status(201).json(GetBlueprintResponse.parse(serializeBlueprint(row)));
});

router.get("/blueprints/:id", async (req, res): Promise<void> => {
  const params = GetBlueprintParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .select()
    .from(integrationBlueprintsTable)
    .where(and(eq(integrationBlueprintsTable.id, params.data.id), eq(integrationBlueprintsTable.tenantId, req.tenantId)));
  if (!row) {
    res.status(404).json({ error: "Blueprint not found" });
    return;
  }
  res.json(GetBlueprintResponse.parse(serializeBlueprint(row)));
});

router.post("/blueprints/:id/analyze", async (req, res): Promise<void> => {
  const params = AnalyzeBlueprintParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [bp] = await db
    .select()
    .from(integrationBlueprintsTable)
    .where(and(eq(integrationBlueprintsTable.id, params.data.id), eq(integrationBlueprintsTable.tenantId, req.tenantId)));
  if (!bp) {
    res.status(404).json({ error: "Blueprint not found" });
    return;
  }
  const analysis = analyzeBlueprint(bp.serviceName, bp.sourceSpec);
  const [row] = await db
    .update(integrationBlueprintsTable)
    .set({
      analyzed: true,
      normalizedJson: analysis.normalized as unknown as Record<string, unknown>,
      operationCount: analysis.operationCount,
      generationConfidenceScore: analysis.confidence,
      humanReviewRequired: analysis.confidence < 80,
    })
    .where(eq(integrationBlueprintsTable.id, bp.id))
    .returning();
  res.json(AnalyzeBlueprintResponse.parse(serializeBlueprint(row)));
});

router.post("/blueprints/:id/synthesize", async (req, res): Promise<void> => {
  const params = SynthesizeServerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [bp] = await db
    .select()
    .from(integrationBlueprintsTable)
    .where(and(eq(integrationBlueprintsTable.id, params.data.id), eq(integrationBlueprintsTable.tenantId, req.tenantId)));
  if (!bp) {
    res.status(404).json({ error: "Blueprint not found" });
    return;
  }
  if (!bp.analyzed || !bp.normalizedJson) {
    res.status(400).json({ error: "Blueprint must be analyzed before synthesis" });
    return;
  }
  const synth = synthesizeServer(bp.normalizedJson as unknown as NormalizedSpec);
  const reviewRequired = synth.capabilities.some((c) => c.humanReviewRequired);
  const [server] = await db
    .insert(generatedMcpServersTable)
    .values({
      tenantId: req.tenantId,
      blueprintId: bp.id,
      name: `${bp.serviceName}-mcp`,
      serverCode: synth.serverCode,
      securityReviewJson: synth.securityReview,
      capabilityCount: synth.capabilities.length,
      testsPassed: synth.tests.filter((t) => t.status === "passed").length,
      testsFailed: synth.tests.filter((t) => t.status !== "passed").length,
      humanReviewRequired: reviewRequired,
      status: "generated",
    })
    .returning();
  await db.insert(synthesizedCapabilitiesTable).values(
    synth.capabilities.map((c) => ({ tenantId: req.tenantId, generatedServerId: server.id, ...c })),
  );
  await db.insert(integrationTestsTable).values(
    synth.tests.map((t) => ({ tenantId: req.tenantId, generatedServerId: server.id, ...t })),
  );
  res.status(201).json(GetGeneratedServerResponse.parse(await loadServerDetail(server)));
});

router.get("/generated-servers", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(generatedMcpServersTable)
    .where(eq(generatedMcpServersTable.tenantId, req.tenantId))
    .orderBy(desc(generatedMcpServersTable.createdAt));
  res.json(ListGeneratedServersResponse.parse(rows.map(serializeGeneratedServer)));
});

router.get("/generated-servers/:id", async (req, res): Promise<void> => {
  const params = GetGeneratedServerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .select()
    .from(generatedMcpServersTable)
    .where(and(eq(generatedMcpServersTable.id, params.data.id), eq(generatedMcpServersTable.tenantId, req.tenantId)));
  if (!row) {
    res.status(404).json({ error: "Generated server not found" });
    return;
  }
  res.json(GetGeneratedServerResponse.parse(await loadServerDetail(row)));
});

async function loadServer(req: import("express").Request, id: string) {
  const [row] = await db
    .select()
    .from(generatedMcpServersTable)
    .where(and(eq(generatedMcpServersTable.id, id), eq(generatedMcpServersTable.tenantId, req.tenantId)));
  return row;
}

router.post("/generated-servers/:id/test", async (req, res): Promise<void> => {
  const params = TestGeneratedServerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const row = await loadServer(req, params.data.id);
  if (!row) {
    res.status(404).json({ error: "Generated server not found" });
    return;
  }
  const [updated] = await db
    .update(generatedMcpServersTable)
    .set({ status: "tested" })
    .where(eq(generatedMcpServersTable.id, row.id))
    .returning();
  res.json(TestGeneratedServerResponse.parse(await loadServerDetail(updated)));
});

router.post("/generated-servers/:id/deploy", async (req, res): Promise<void> => {
  const params = DeployGeneratedServerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const row = await loadServer(req, params.data.id);
  if (!row) {
    res.status(404).json({ error: "Generated server not found" });
    return;
  }
  const [updated] = await db
    .update(generatedMcpServersTable)
    .set({ status: "deployed", deploymentStatus: "deployed", approved: true })
    .where(eq(generatedMcpServersTable.id, row.id))
    .returning();
  res.json(DeployGeneratedServerResponse.parse(await loadServerDetail(updated)));
});

router.post("/generated-servers/:id/register", async (req, res): Promise<void> => {
  const params = RegisterGeneratedServerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const row = await loadServer(req, params.data.id);
  if (!row) {
    res.status(404).json({ error: "Generated server not found" });
    return;
  }
  let adapterId = row.registeredAdapterId;
  if (!adapterId) {
    const [adapter] = await db
      .insert(adaptersTable)
      .values({
        tenantId: req.tenantId,
        name: row.name,
        description: `Registered from generated MCP server ${row.name}`,
        transport: "demo",
        isGenerated: true,
        status: "active",
      })
      .returning();
    adapterId = adapter.id;
  }
  const [updated] = await db
    .update(generatedMcpServersTable)
    .set({ status: "registered", registeredAdapterId: adapterId })
    .where(eq(generatedMcpServersTable.id, row.id))
    .returning();
  res.json(RegisterGeneratedServerResponse.parse(await loadServerDetail(updated)));
});

router.post("/generated-servers/:id/regenerate", async (req, res): Promise<void> => {
  const params = RegenerateGeneratedServerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = RegenerateGeneratedServerBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const row = await loadServer(req, params.data.id);
  if (!row) {
    res.status(404).json({ error: "Generated server not found" });
    return;
  }
  const [bp] = await db
    .select()
    .from(integrationBlueprintsTable)
    .where(eq(integrationBlueprintsTable.id, row.blueprintId));
  if (bp?.normalizedJson) {
    const synth = synthesizeServer(bp.normalizedJson as unknown as NormalizedSpec);
    await db
      .delete(synthesizedCapabilitiesTable)
      .where(eq(synthesizedCapabilitiesTable.generatedServerId, row.id));
    await db
      .delete(integrationTestsTable)
      .where(eq(integrationTestsTable.generatedServerId, row.id));
    await db.insert(synthesizedCapabilitiesTable).values(
      synth.capabilities.map((c) => ({ tenantId: req.tenantId, generatedServerId: row.id, ...c })),
    );
    await db.insert(integrationTestsTable).values(
      synth.tests.map((t) => ({ tenantId: req.tenantId, generatedServerId: row.id, ...t })),
    );
    await db
      .update(generatedMcpServersTable)
      .set({
        serverCode: synth.serverCode,
        securityReviewJson: synth.securityReview,
        capabilityCount: synth.capabilities.length,
        status: "generated",
        regenerationReason: (parsed.data.reason as "source_changed" | "test_failed" | "usage_feedback" | "security_patch" | "schema_upgrade" | "manual_edit") ?? null,
      })
      .where(eq(generatedMcpServersTable.id, row.id));
  }
  const updated = await loadServer(req, row.id);
  res.json(GetGeneratedServerResponse.parse(await loadServerDetail(updated!)));
});

router.get("/deployment-targets", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(deploymentTargetsTable)
    .where(eq(deploymentTargetsTable.tenantId, req.tenantId))
    .orderBy(desc(deploymentTargetsTable.createdAt));
  res.json(ListDeploymentTargetsResponse.parse(rows.map(serializeDeploymentTarget)));
});

export default router;
