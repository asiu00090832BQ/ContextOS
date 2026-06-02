import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import {
  db,
  tenantsTable,
  contextFragmentsTable,
  contextPacksTable,
} from "@workspace/db";
import {
  ListContextFragmentsQueryParams,
  ListContextFragmentsResponse,
  CreateContextFragmentBody,
  GetContextFragmentParams,
  GetContextFragmentResponse,
  UpdateContextFragmentParams,
  UpdateContextFragmentBody,
  UpdateContextFragmentResponse,
  DeleteContextFragmentParams,
  ListContextPacksQueryParams,
  ListContextPacksResponse,
  CreateContextPackBody,
  GetContextPackParams,
  GetContextPackResponse,
  UpdateContextPackParams,
  UpdateContextPackBody,
  UpdateContextPackResponse,
  DeleteContextPackParams,
  GetSettingsResponse,
  UpdateSettingsBody,
  UpdateSettingsResponse,
} from "@workspace/api-zod";
import { serializeFragment, serializePack } from "../lib/serialize";

type FragmentType =
  | "retrieval"
  | "memory"
  | "system"
  | "user"
  | "tool_output"
  | "summary";
type Sensitivity = "public" | "internal" | "confidential" | "restricted";

const router: IRouter = Router();

router.get("/context-fragments", async (req, res): Promise<void> => {
  const query = ListContextFragmentsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const filters = [eq(contextFragmentsTable.tenantId, req.tenantId)];
  if (query.data.runId) {
    filters.push(eq(contextFragmentsTable.runId, query.data.runId));
  }
  const rows = await db
    .select()
    .from(contextFragmentsTable)
    .where(and(...filters))
    .orderBy(desc(contextFragmentsTable.createdAt));
  res.json(ListContextFragmentsResponse.parse(rows.map(serializeFragment)));
});

router.post("/context-fragments", async (req, res): Promise<void> => {
  const parsed = CreateContextFragmentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(contextFragmentsTable)
    .values({
      tenantId: req.tenantId,
      runId: parsed.data.runId ?? null,
      type: parsed.data.type as FragmentType,
      source: parsed.data.source,
      content: parsed.data.content,
      tokens: parsed.data.tokens ?? 0,
      relevanceScore: parsed.data.relevanceScore ?? 0,
      selected: parsed.data.selected ?? true,
      sensitivity: (parsed.data.sensitivity as Sensitivity) ?? "internal",
    })
    .returning();
  res.status(201).json(GetContextFragmentResponse.parse(serializeFragment(row)));
});

router.get("/context-fragments/:id", async (req, res): Promise<void> => {
  const params = GetContextFragmentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .select()
    .from(contextFragmentsTable)
    .where(
      and(
        eq(contextFragmentsTable.id, params.data.id),
        eq(contextFragmentsTable.tenantId, req.tenantId),
      ),
    );
  if (!row) {
    res.status(404).json({ error: "Context fragment not found" });
    return;
  }
  res.json(GetContextFragmentResponse.parse(serializeFragment(row)));
});

router.patch("/context-fragments/:id", async (req, res): Promise<void> => {
  const params = UpdateContextFragmentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = UpdateContextFragmentBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [row] = await db
    .update(contextFragmentsTable)
    .set({
      ...(body.data.type !== undefined
        ? { type: body.data.type as FragmentType }
        : {}),
      ...(body.data.source !== undefined ? { source: body.data.source } : {}),
      ...(body.data.content !== undefined ? { content: body.data.content } : {}),
      ...(body.data.tokens !== undefined ? { tokens: body.data.tokens } : {}),
      ...(body.data.relevanceScore !== undefined
        ? { relevanceScore: body.data.relevanceScore }
        : {}),
      ...(body.data.selected !== undefined
        ? { selected: body.data.selected }
        : {}),
      ...(body.data.sensitivity !== undefined
        ? { sensitivity: body.data.sensitivity as Sensitivity }
        : {}),
      ...(body.data.rejectionReason !== undefined
        ? { rejectionReason: body.data.rejectionReason }
        : {}),
    })
    .where(
      and(
        eq(contextFragmentsTable.id, params.data.id),
        eq(contextFragmentsTable.tenantId, req.tenantId),
      ),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Context fragment not found" });
    return;
  }
  res.json(UpdateContextFragmentResponse.parse(serializeFragment(row)));
});

router.delete("/context-fragments/:id", async (req, res): Promise<void> => {
  const params = DeleteContextFragmentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const result = await db
    .delete(contextFragmentsTable)
    .where(
      and(
        eq(contextFragmentsTable.id, params.data.id),
        eq(contextFragmentsTable.tenantId, req.tenantId),
      ),
    )
    .returning();
  if (result.length === 0) {
    res.status(404).json({ error: "Context fragment not found" });
    return;
  }
  res.status(204).end();
});

router.get("/context-packs", async (req, res): Promise<void> => {
  const query = ListContextPacksQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const filters = [eq(contextPacksTable.tenantId, req.tenantId)];
  if (query.data.runId) {
    filters.push(eq(contextPacksTable.runId, query.data.runId));
  }
  const rows = await db
    .select()
    .from(contextPacksTable)
    .where(and(...filters))
    .orderBy(desc(contextPacksTable.createdAt));
  res.json(ListContextPacksResponse.parse(rows.map(serializePack)));
});

router.post("/context-packs", async (req, res): Promise<void> => {
  const parsed = CreateContextPackBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(contextPacksTable)
    .values({
      tenantId: req.tenantId,
      runId: parsed.data.runId ?? null,
      name: parsed.data.name,
      fragmentIds: parsed.data.fragmentIds ?? null,
      totalTokens: parsed.data.totalTokens ?? 0,
      strategy: parsed.data.strategy ?? "relevance",
      summary: parsed.data.summary ?? null,
    })
    .returning();
  res.status(201).json(GetContextPackResponse.parse(serializePack(row)));
});

router.get("/context-packs/:id", async (req, res): Promise<void> => {
  const params = GetContextPackParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .select()
    .from(contextPacksTable)
    .where(
      and(
        eq(contextPacksTable.id, params.data.id),
        eq(contextPacksTable.tenantId, req.tenantId),
      ),
    );
  if (!row) {
    res.status(404).json({ error: "Context pack not found" });
    return;
  }
  res.json(GetContextPackResponse.parse(serializePack(row)));
});

router.patch("/context-packs/:id", async (req, res): Promise<void> => {
  const params = UpdateContextPackParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = UpdateContextPackBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [row] = await db
    .update(contextPacksTable)
    .set({
      ...(body.data.name !== undefined ? { name: body.data.name } : {}),
      ...(body.data.fragmentIds !== undefined
        ? { fragmentIds: body.data.fragmentIds }
        : {}),
      ...(body.data.totalTokens !== undefined
        ? { totalTokens: body.data.totalTokens }
        : {}),
      ...(body.data.strategy !== undefined
        ? { strategy: body.data.strategy }
        : {}),
      ...(body.data.summary !== undefined ? { summary: body.data.summary } : {}),
    })
    .where(
      and(
        eq(contextPacksTable.id, params.data.id),
        eq(contextPacksTable.tenantId, req.tenantId),
      ),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Context pack not found" });
    return;
  }
  res.json(UpdateContextPackResponse.parse(serializePack(row)));
});

router.delete("/context-packs/:id", async (req, res): Promise<void> => {
  const params = DeleteContextPackParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const result = await db
    .delete(contextPacksTable)
    .where(
      and(
        eq(contextPacksTable.id, params.data.id),
        eq(contextPacksTable.tenantId, req.tenantId),
      ),
    )
    .returning();
  if (result.length === 0) {
    res.status(404).json({ error: "Context pack not found" });
    return;
  }
  res.status(204).end();
});

router.get("/settings", async (req, res): Promise<void> => {
  const [tenant] = await db
    .select()
    .from(tenantsTable)
    .where(eq(tenantsTable.id, req.tenantId));
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  res.json(
    GetSettingsResponse.parse({
      tenantId: tenant.id,
      settings: tenant.settingsJson ?? {},
    }),
  );
});

router.put("/settings", async (req, res): Promise<void> => {
  const body = UpdateSettingsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [tenant] = await db
    .update(tenantsTable)
    .set({ settingsJson: body.data.settings })
    .where(eq(tenantsTable.id, req.tenantId))
    .returning();
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  res.json(
    UpdateSettingsResponse.parse({
      tenantId: tenant.id,
      settings: tenant.settingsJson ?? {},
    }),
  );
});

export default router;
