import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db, apiKeysTable, type ApiKey } from "@workspace/db";

const TOKEN_PREFIX = "ctxos_";

export interface GeneratedKey {
  token: string;
  keyPrefix: string;
  keyHash: string;
  lastFour: string;
}

/** Hash a raw token for storage/lookup. We never persist the raw token. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Mint a fresh API key. The raw `token` is returned exactly once. */
export function generateApiKey(): GeneratedKey {
  const raw = randomBytes(24).toString("base64url");
  const token = `${TOKEN_PREFIX}${raw}`;
  return {
    token,
    keyPrefix: TOKEN_PREFIX,
    keyHash: hashToken(token),
    lastFour: token.slice(-4),
  };
}

/**
 * Resolve a raw bearer token to its API key row, or null when it is unknown,
 * revoked, or expired. Touches `lastUsedAt` on success (fire-and-forget).
 */
export async function verifyApiKey(token: string): Promise<ApiKey | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const keyHash = hashToken(token);
  const [row] = await db
    .select()
    .from(apiKeysTable)
    .where(and(eq(apiKeysTable.keyHash, keyHash), isNull(apiKeysTable.revokedAt)));
  if (!row) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;
  void db
    .update(apiKeysTable)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeysTable.id, row.id));
  return row;
}

/** Extract a bearer token from an Authorization header, if present. */
export function bearerFromHeader(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}
