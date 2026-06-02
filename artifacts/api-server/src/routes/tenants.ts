import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, tenantsTable } from "@workspace/db";
import {
  ListTenantsResponse,
  CreateTenantBody,
  GetTenantParams,
  GetTenantResponse,
  UpdateTenantParams,
  UpdateTenantBody,
  UpdateTenantResponse,
  DeleteTenantParams,
} from "@workspace/api-zod";
import { serializeTenant } from "../lib/serialize";

const router: IRouter = Router();

router.get("/tenants", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(tenantsTable)
    .orderBy(desc(tenantsTable.createdAt));
  res.json(ListTenantsResponse.parse(rows.map(serializeTenant)));
});

router.post("/tenants", async (req, res): Promise<void> => {
  const parsed = CreateTenantBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(tenantsTable)
    .values({
      name: parsed.data.name,
      slug: parsed.data.slug,
      description: parsed.data.description ?? null,
    })
    .returning();
  res.status(201).json(GetTenantResponse.parse(serializeTenant(row)));
});

router.get("/tenants/:id", async (req, res): Promise<void> => {
  const params = GetTenantParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .select()
    .from(tenantsTable)
    .where(eq(tenantsTable.id, params.data.id));
  if (!row) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  res.json(GetTenantResponse.parse(serializeTenant(row)));
});

router.patch("/tenants/:id", async (req, res): Promise<void> => {
  const params = UpdateTenantParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = UpdateTenantBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [row] = await db
    .update(tenantsTable)
    .set({
      ...(body.data.name !== undefined ? { name: body.data.name } : {}),
      ...(body.data.slug !== undefined ? { slug: body.data.slug } : {}),
      ...(body.data.description !== undefined
        ? { description: body.data.description }
        : {}),
    })
    .where(eq(tenantsTable.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  res.json(UpdateTenantResponse.parse(serializeTenant(row)));
});

router.delete("/tenants/:id", async (req, res): Promise<void> => {
  const params = DeleteTenantParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .select()
    .from(tenantsTable)
    .where(eq(tenantsTable.id, params.data.id));
  if (!row) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  if (row.isDefault) {
    res.status(400).json({ error: "Cannot delete the default tenant" });
    return;
  }
  await db.delete(tenantsTable).where(eq(tenantsTable.id, params.data.id));
  res.status(204).end();
});

export default router;
