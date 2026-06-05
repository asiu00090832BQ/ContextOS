import { and, eq } from "drizzle-orm";
import {
  db,
  usersTable,
  tenantsTable,
  membershipsTable,
  principalsTable,
  agentsTable,
  type Tenant,
  type User,
  type Agent,
} from "@workspace/db";
import { logger } from "./logger";

export interface OwnerContext {
  user: User;
  tenant: Tenant;
  botAgent: Agent;
}

let cached: OwnerContext | null = null;

const OWNER_EMAIL = "owner@contextos.local";
const DEFAULT_TENANT_SLUG = "default";
const BOT_AGENT_NAME = "ContextOS Bot";
const BOT_SYSTEM_PROMPT =
  "You are the ContextOS bot. You never execute work yourself. " +
  "Your job is to understand the user's goal, manage your own long-term memory, " +
  "and command agents to do the work by creating and running intents. " +
  "When a task requires building integrations, running tools, or any action, " +
  "create an intent and delegate it to an agent — do not attempt to act directly.";

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

  let [botAgent] = await db
    .select()
    .from(agentsTable)
    .where(
      and(
        eq(agentsTable.tenantId, tenant.id),
        eq(agentsTable.name, BOT_AGENT_NAME),
      ),
    );

  if (!botAgent) {
    [botAgent] = await db
      .insert(agentsTable)
      .values({
        tenantId: tenant.id,
        name: BOT_AGENT_NAME,
        role: "router",
        description:
          "The conversational ContextOS assistant. Orchestrates work by commanding agents; never executes tools itself.",
        systemPrompt: BOT_SYSTEM_PROMPT,
        contextPolicy: "isolated",
        canBuildIntegrations: false,
        metadataJson: { isSystemBot: true },
      })
      .returning();
    logger.info({ botAgentId: botAgent.id }, "Bootstrapped ContextOS bot agent");
  }

  cached = { user, tenant, botAgent };
  return cached;
}

/** Returns the cached owner context, bootstrapping if needed. */
export async function getContext(): Promise<OwnerContext> {
  return cached ?? bootstrapContext();
}

export function clearContextCache(): void {
  cached = null;
}
