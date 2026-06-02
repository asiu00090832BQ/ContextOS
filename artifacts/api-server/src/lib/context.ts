import { eq } from "drizzle-orm";
import {
  db,
  usersTable,
  tenantsTable,
  membershipsTable,
  principalsTable,
  type Tenant,
  type User,
} from "@workspace/db";
import { logger } from "./logger";

export interface OwnerContext {
  user: User;
  tenant: Tenant;
}

let cached: OwnerContext | null = null;

const OWNER_EMAIL = "owner@contextos.local";
const DEFAULT_TENANT_SLUG = "default";

/**
 * Idempotently bootstrap the single owner user and default tenant.
 * Safe to call repeatedly; returns the same context.
 */
export async function bootstrapContext(): Promise<OwnerContext> {
  if (cached) return cached;

  let [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, OWNER_EMAIL));

  if (!user) {
    [user] = await db
      .insert(usersTable)
      .values({
        email: OWNER_EMAIL,
        name: "Owner",
        isOwner: true,
      })
      .returning();
    logger.info({ userId: user.id }, "Bootstrapped owner user");
  }

  let [tenant] = await db
    .select()
    .from(tenantsTable)
    .where(eq(tenantsTable.slug, DEFAULT_TENANT_SLUG));

  if (!tenant) {
    [tenant] = await db
      .insert(tenantsTable)
      .values({
        name: "Default Workspace",
        slug: DEFAULT_TENANT_SLUG,
        description: "Primary ContextOS workspace",
        isDefault: true,
      })
      .returning();
    logger.info({ tenantId: tenant.id }, "Bootstrapped default tenant");
  }

  const [membership] = await db
    .select()
    .from(membershipsTable)
    .where(eq(membershipsTable.userId, user.id));

  if (!membership) {
    await db.insert(membershipsTable).values({
      tenantId: tenant.id,
      userId: user.id,
      role: "owner",
    });
  }

  const [principal] = await db
    .select()
    .from(principalsTable)
    .where(eq(principalsTable.userId, user.id));

  if (!principal) {
    await db.insert(principalsTable).values({
      tenantId: tenant.id,
      type: "user",
      displayName: user.name,
      userId: user.id,
    });
  }

  cached = { user, tenant };
  return cached;
}

/** Returns the cached owner context, bootstrapping if needed. */
export async function getContext(): Promise<OwnerContext> {
  return cached ?? bootstrapContext();
}

export function clearContextCache(): void {
  cached = null;
}
