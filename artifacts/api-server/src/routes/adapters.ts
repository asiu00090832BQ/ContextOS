import { Router, type IRouter } from "express";
import { eq, and, desc, count } from "drizzle-orm";
import { db, adaptersTable, capabilitiesTable } from "@workspace/db";
import {
  ListAdaptersResponse,
  CreateAdapterBody,
  GetAdapterParams,
  GetAdapterResponse,
  UpdateAdapterParams,
  UpdateAdapterBody,
  UpdateAdapterResponse,
  DeleteAdapterParams,
  DiscoverAdapterParams,
  DiscoverAdapterResponse,
  TestAdapterParams,
  TestAdapterResponse,
  ListCapabilitiesQueryParams,
  ListCapabilitiesResponse,
} from "@workspace/api-zod";
import {
  serializeAdapter,
  serializeAdapterDetail,
  serializeCapability,
} from "../lib/serialize";
import { discoverAdapter, healthCheckAdapter } from "../lib/mcp";

type AdapterTransport = "streamable_http" | "stdio" | "websocket" | "demo";
type AdapterStatus = "registered" | "active" | "error" | "disabled";
type CapabilityType = "tool" | "resource" | "prompt";
type RiskTier = "L1" | "L2" | "L3" | "L4";

const router: IRouter = Router();

router.get("/adapters", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(adaptersTable)
    .where(eq(adaptersTable.tenantId, req.tenantId))
    .orderBy(desc(adaptersTable.createdAt));
  const counts = await db
    .select({ adapterId: capabilitiesTable.adapterId, c: count() })
    .from(capabilitiesTable)
    .where(eq(capabilitiesTable.tenantId, req.tenantId))
    .groupBy(capabilitiesTable.adapterId);
  const map = new Map(counts.map((c) => [c.adapterId, c.c]));
  res.json(
    ListAdaptersResponse.parse(
      rows.map((a) => serializeAdapter(a, map.get(a.id) ?? 0)),
    ),
  );
});

router.post("/adapters", async (req, res): Promise<void> => {
  const parsed = CreateAdapterBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(adaptersTable)
    .values({
      tenantId: req.tenantId,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      transport: (parsed.data.transport as AdapterTransport | undefined) ?? "demo",
      endpointUrl: parsed.data.endpointUrl ?? null,
      linkedAccountId: parsed.data.linkedAccountId ?? null,
    })
    .returning();
  res.status(201).json(GetAdapterResponse.parse(serializeAdapterDetail(row, [])));
});

router.get("/adapters/:id", async (req, res): Promise<void> => {
  const params = GetAdapterParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .select()
    .from(adaptersTable)
    .where(
      and(eq(adaptersTable.id, params.data.id), eq(adaptersTable.tenantId, req.tenantId)),
    );
  if (!row) {
    res.status(404).json({ error: "Adapter not found" });
    return;
  }
  const caps = await db
    .select()
    .from(capabilitiesTable)
    .where(eq(capabilitiesTable.adapterId, row.id));
  res.json(GetAdapterResponse.parse(serializeAdapterDetail(row, caps)));
});

router.patch("/adapters/:id", async (req, res): Promise<void> => {
  const params = UpdateAdapterParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateAdapterBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .update(adaptersTable)
    .set({
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      ...(parsed.data.endpointUrl !== undefined ? { endpointUrl: parsed.data.endpointUrl } : {}),
      ...(parsed.data.status !== undefined ? { status: parsed.data.status as AdapterStatus } : {}),
    })
    .where(
      and(eq(adaptersTable.id, params.data.id), eq(adaptersTable.tenantId, req.tenantId)),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Adapter not found" });
    return;
  }
  const caps = await db
    .select()
    .from(capabilitiesTable)
    .where(eq(capabilitiesTable.adapterId, row.id));
  res.json(UpdateAdapterResponse.parse(serializeAdapterDetail(row, caps)));
});

router.delete("/adapters/:id", async (req, res): Promise<void> => {
  const params = DeleteAdapterParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .delete(adaptersTable)
    .where(
      and(eq(adaptersTable.id, params.data.id), eq(adaptersTable.tenantId, req.tenantId)),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Adapter not found" });
    return;
  }
  res.sendStatus(204);
});

router.post("/adapters/:id/discover", async (req, res): Promise<void> => {
  const params = DiscoverAdapterParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [adapter] = await db
    .select()
    .from(adaptersTable)
    .where(
      and(eq(adaptersTable.id, params.data.id), eq(adaptersTable.tenantId, req.tenantId)),
    );
  if (!adapter) {
    res.status(404).json({ error: "Adapter not found" });
    return;
  }
  const result = await discoverAdapter(adapter.name, adapter.endpointUrl);
  await db
    .delete(capabilitiesTable)
    .where(eq(capabilitiesTable.adapterId, adapter.id));
  const inserted = await db
    .insert(capabilitiesTable)
    .values(
      result.capabilities.map((c) => ({
        tenantId: req.tenantId,
        adapterId: adapter.id,
        ...c,
      })),
    )
    .returning();
  const [updated] = await db
    .update(adaptersTable)
    .set({
      status: "active",
      protocolVersion: result.protocolVersion,
      lastDiscoveredAt: new Date(),
    })
    .where(eq(adaptersTable.id, adapter.id))
    .returning();
  res.json(DiscoverAdapterResponse.parse(serializeAdapterDetail(updated, inserted)));
});

router.post("/adapters/:id/test", async (req, res): Promise<void> => {
  const params = TestAdapterParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [adapter] = await db
    .select()
    .from(adaptersTable)
    .where(
      and(eq(adaptersTable.id, params.data.id), eq(adaptersTable.tenantId, req.tenantId)),
    );
  if (!adapter) {
    res.status(404).json({ error: "Adapter not found" });
    return;
  }
  const health = await healthCheckAdapter(adapter.name);
  await db
    .update(adaptersTable)
    .set({
      status: health.healthy ? "active" : "error",
      lastHealthAt: new Date(),
      lastHealthResultJson: { ...health },
    })
    .where(eq(adaptersTable.id, adapter.id));
  res.json(
    TestAdapterResponse.parse({
      ok: health.healthy,
      latencyMs: health.latencyMs,
      message: health.detail,
      details: { protocolVersion: health.protocolVersion, checkedAt: health.checkedAt },
    }),
  );
});

router.get("/capabilities", async (req, res): Promise<void> => {
  const q = ListCapabilitiesQueryParams.safeParse(req.query);
  if (!q.success) {
    res.status(400).json({ error: q.error.message });
    return;
  }
  const conds = [eq(capabilitiesTable.tenantId, req.tenantId)];
  if (q.data.type) conds.push(eq(capabilitiesTable.type, q.data.type as CapabilityType));
  if (q.data.riskTier) conds.push(eq(capabilitiesTable.riskTier, q.data.riskTier as RiskTier));
  if (q.data.adapterId) conds.push(eq(capabilitiesTable.adapterId, q.data.adapterId));
  const rows = await db
    .select()
    .from(capabilitiesTable)
    .where(and(...conds))
    .orderBy(desc(capabilitiesTable.createdAt));
  res.json(ListCapabilitiesResponse.parse(rows.map(serializeCapability)));
});

export default router;
