import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, principalsTable } from "@workspace/db";
import {
  ListPrincipalsResponse,
  CreatePrincipalBody,
  GetPrincipalParams,
  GetPrincipalResponse,
  UpdatePrincipalParams,
  UpdatePrincipalBody,
  UpdatePrincipalResponse,
  DeletePrincipalParams,
} from "@workspace/api-zod";
import { serializePrincipal } from "../lib/serialize";

type PrincipalType = "user" | "agent" | "service";

const router: IRouter = Router();

router.get("/principals", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(principalsTable)
    .where(eq(principalsTable.tenantId, req.tenantId))
    .orderBy(desc(principalsTable.createdAt));
  res.json(ListPrincipalsResponse.parse(rows.map(serializePrincipal)));
});

router.post("/principals", async (req, res): Promise<void> => {
  const parsed = CreatePrincipalBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(principalsTable)
    .values({
      tenantId: req.tenantId,
      type: parsed.data.type as PrincipalType,
      displayName: parsed.data.displayName,
      userId: parsed.data.userId ?? null,
      metadataJson: parsed.data.metadata ?? null,
    })
    .returning();
  res.status(201).json(GetPrincipalResponse.parse(serializePrincipal(row)));
});

router.get("/principals/:id", async (req, res): Promise<void> => {
  const params = GetPrincipalParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .select()
    .from(principalsTable)
    .where(
      and(
        eq(principalsTable.id, params.data.id),
        eq(principalsTable.tenantId, req.tenantId),
      ),
    );
  if (!row) {
    res.status(404).json({ error: "Principal not found" });
    return;
  }
  res.json(GetPrincipalResponse.parse(serializePrincipal(row)));
});

router.patch("/principals/:id", async (req, res): Promise<void> => {
  const params = UpdatePrincipalParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = UpdatePrincipalBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [row] = await db
    .update(principalsTable)
    .set({
      ...(body.data.type !== undefined
        ? { type: body.data.type as PrincipalType }
        : {}),
      ...(body.data.displayName !== undefined
        ? { displayName: body.data.displayName }
        : {}),
      ...(body.data.userId !== undefined ? { userId: body.data.userId } : {}),
      ...(body.data.metadata !== undefined
        ? { metadataJson: body.data.metadata }
        : {}),
    })
    .where(
      and(
        eq(principalsTable.id, params.data.id),
        eq(principalsTable.tenantId, req.tenantId),
      ),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Principal not found" });
    return;
  }
  res.json(UpdatePrincipalResponse.parse(serializePrincipal(row)));
});

router.delete("/principals/:id", async (req, res): Promise<void> => {
  const params = DeletePrincipalParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const result = await db
    .delete(principalsTable)
    .where(
      and(
        eq(principalsTable.id, params.data.id),
        eq(principalsTable.tenantId, req.tenantId),
      ),
    )
    .returning();
  if (result.length === 0) {
    res.status(404).json({ error: "Principal not found" });
    return;
  }
  res.status(204).end();
});

export default router;
