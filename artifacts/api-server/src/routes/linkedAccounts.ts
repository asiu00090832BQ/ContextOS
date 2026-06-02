import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, linkedAccountsTable } from "@workspace/db";
import {
  ListLinkedAccountsResponse,
  CreateLinkedAccountBody,
  GetLinkedAccountParams,
  GetLinkedAccountResponse,
  DeleteLinkedAccountParams,
  RefreshLinkedAccountParams,
  RefreshLinkedAccountResponse,
  RevokeLinkedAccountParams,
  RevokeLinkedAccountResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

function serialize(a: typeof linkedAccountsTable.$inferSelect) {
  return {
    id: a.id,
    systemName: a.systemName,
    displayName: a.displayName,
    authMode: a.authMode,
    status: a.status,
    credentialRef: a.credentialRef,
    scopes: a.scopes ?? null,
    accountIdentifier: a.accountIdentifier,
    lastRefreshedAt: a.lastRefreshedAt ?? null,
    expiresAt: a.expiresAt ?? null,
    createdAt: a.createdAt,
  };
}

router.get("/linked-accounts", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(linkedAccountsTable)
    .where(eq(linkedAccountsTable.tenantId, req.tenantId))
    .orderBy(desc(linkedAccountsTable.createdAt));
  res.json(ListLinkedAccountsResponse.parse(rows.map(serialize)));
});

router.post("/linked-accounts", async (req, res): Promise<void> => {
  const parsed = CreateLinkedAccountBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(linkedAccountsTable)
    .values({
      tenantId: req.tenantId,
      systemName: parsed.data.systemName,
      displayName: parsed.data.displayName,
      authMode: parsed.data.authMode as "oauth2" | "api_key" | "basic" | "none",
      status: "active",
      scopes: parsed.data.scopes ?? null,
      accountIdentifier: parsed.data.accountIdentifier ?? null,
      credentialRef: parsed.data.credentialRef ? "stored" : null,
    })
    .returning();
  res.status(201).json(GetLinkedAccountResponse.parse(serialize(row)));
});

router.get("/linked-accounts/:id", async (req, res): Promise<void> => {
  const params = GetLinkedAccountParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .select()
    .from(linkedAccountsTable)
    .where(
      and(
        eq(linkedAccountsTable.id, params.data.id),
        eq(linkedAccountsTable.tenantId, req.tenantId),
      ),
    );
  if (!row) {
    res.status(404).json({ error: "Linked account not found" });
    return;
  }
  res.json(GetLinkedAccountResponse.parse(serialize(row)));
});

router.delete("/linked-accounts/:id", async (req, res): Promise<void> => {
  const params = DeleteLinkedAccountParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .delete(linkedAccountsTable)
    .where(
      and(
        eq(linkedAccountsTable.id, params.data.id),
        eq(linkedAccountsTable.tenantId, req.tenantId),
      ),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Linked account not found" });
    return;
  }
  res.sendStatus(204);
});

router.post("/linked-accounts/:id/refresh", async (req, res): Promise<void> => {
  const params = RefreshLinkedAccountParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .update(linkedAccountsTable)
    .set({ status: "active", lastRefreshedAt: new Date() })
    .where(
      and(
        eq(linkedAccountsTable.id, params.data.id),
        eq(linkedAccountsTable.tenantId, req.tenantId),
      ),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Linked account not found" });
    return;
  }
  res.json(RefreshLinkedAccountResponse.parse(serialize(row)));
});

router.post("/linked-accounts/:id/revoke", async (req, res): Promise<void> => {
  const params = RevokeLinkedAccountParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .update(linkedAccountsTable)
    .set({ status: "revoked" })
    .where(
      and(
        eq(linkedAccountsTable.id, params.data.id),
        eq(linkedAccountsTable.tenantId, req.tenantId),
      ),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Linked account not found" });
    return;
  }
  res.json(RevokeLinkedAccountResponse.parse(serialize(row)));
});

export default router;
