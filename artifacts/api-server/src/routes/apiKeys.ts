import { Router, type IRouter } from "express";
import { eq, and, desc, isNull } from "drizzle-orm";
import { db, apiKeysTable, type ApiKey } from "@workspace/db";
import {
  ListApiKeysResponse,
  CreateApiKeyBody,
  RevokeApiKeyParams,
} from "@workspace/api-zod";
import { generateApiKey } from "../lib/apiKeys";

const router: IRouter = Router();

function serializeApiKey(k: ApiKey): Record<string, unknown> {
  return {
    id: k.id,
    name: k.name,
    keyPrefix: k.keyPrefix,
    lastFour: k.lastFour,
    lastUsedAt: k.lastUsedAt ?? null,
    expiresAt: k.expiresAt ?? null,
    revokedAt: k.revokedAt ?? null,
    createdAt: k.createdAt,
  };
}

router.get("/api-keys", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(apiKeysTable)
    .where(
      and(eq(apiKeysTable.tenantId, req.tenantId), isNull(apiKeysTable.revokedAt)),
    )
    .orderBy(desc(apiKeysTable.createdAt));
  res.json(ListApiKeysResponse.parse(rows.map(serializeApiKey)));
});

router.post("/api-keys", async (req, res): Promise<void> => {
  const parsed = CreateApiKeyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const gen = generateApiKey();
  const expiresAt =
    parsed.data.expiresInDays && parsed.data.expiresInDays > 0
      ? new Date(Date.now() + parsed.data.expiresInDays * 86_400_000)
      : null;
  const [row] = await db
    .insert(apiKeysTable)
    .values({
      tenantId: req.tenantId,
      name: parsed.data.name,
      keyPrefix: gen.keyPrefix,
      keyHash: gen.keyHash,
      lastFour: gen.lastFour,
      expiresAt,
      createdBy: req.userId,
    })
    .returning();
  // The raw token is returned exactly once; only its hash is persisted.
  res.status(201).json({
    id: row.id,
    name: row.name,
    token: gen.token,
    keyPrefix: row.keyPrefix,
    lastFour: row.lastFour,
    createdAt: row.createdAt,
  });
});

router.delete("/api-keys/:id", async (req, res): Promise<void> => {
  const params = RevokeApiKeyParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .update(apiKeysTable)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiKeysTable.id, params.data.id),
        eq(apiKeysTable.tenantId, req.tenantId),
        isNull(apiKeysTable.revokedAt),
      ),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "API key not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;
