import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import {
  membershipRoleEnum,
  principalTypeEnum,
  authModeEnum,
  linkedAccountStatusEnum,
  adapterTransportEnum,
  adapterStatusEnum,
  capabilityTypeEnum,
  riskTierEnum,
  intentStatusEnum,
  runStatusEnum,
  orchestrationModeEnum,
  actionKindEnum,
  actionStatusEnum,
  approvalStatusEnum,
  artifactTypeEnum,
  memoryTypeEnum,
  sensitivityEnum,
  contextFragmentTypeEnum,
} from "./enums";

export const tenantsTable = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  isDefault: boolean("is_default").notNull().default(false),
  settingsJson: jsonb("settings_json").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const usersTable = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  avatarUrl: text("avatar_url"),
  isOwner: boolean("is_owner").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const membershipsTable = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    role: membershipRoleEnum("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("memberships_tenant_idx").on(t.tenantId)],
);

export const principalsTable = pgTable(
  "principals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    type: principalTypeEnum("type").notNull(),
    displayName: text("display_name").notNull(),
    userId: uuid("user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("principals_tenant_idx").on(t.tenantId)],
);

export const linkedAccountsTable = pgTable(
  "linked_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    systemName: text("system_name").notNull(),
    displayName: text("display_name").notNull(),
    authMode: authModeEnum("auth_mode").notNull(),
    status: linkedAccountStatusEnum("status").notNull().default("active"),
    credentialRef: text("credential_ref"),
    scopes: text("scopes").array(),
    accountIdentifier: text("account_identifier"),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("linked_accounts_tenant_idx").on(t.tenantId)],
);

export const adaptersTable = pgTable(
  "adapters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    transport: adapterTransportEnum("transport").notNull().default("demo"),
    protocolVersion: text("protocol_version").notNull().default("2025-06-18"),
    endpointUrl: text("endpoint_url"),
    sessionMode: text("session_mode").notNull().default("stateless"),
    status: adapterStatusEnum("status").notNull().default("registered"),
    linkedAccountId: uuid("linked_account_id").references(
      () => linkedAccountsTable.id,
      { onDelete: "set null" },
    ),
    credentialRef: text("credential_ref"),
    isGenerated: boolean("is_generated").notNull().default(false),
    generatedServerId: uuid("generated_server_id"),
    lastDiscoveredAt: timestamp("last_discovered_at", { withTimezone: true }),
    lastHealthAt: timestamp("last_health_at", { withTimezone: true }),
    lastHealthResultJson: jsonb("last_health_result_json").$type<
      Record<string, unknown>
    >(),
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("adapters_tenant_idx").on(t.tenantId)],
);

export const capabilitiesTable = pgTable(
  "capabilities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    adapterId: uuid("adapter_id")
      .notNull()
      .references(() => adaptersTable.id, { onDelete: "cascade" }),
    type: capabilityTypeEnum("type").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    riskTier: riskTierEnum("risk_tier").notNull().default("L1"),
    actionKind: actionKindEnum("action_kind").notNull().default("read"),
    inputSchemaJson: jsonb("input_schema_json").$type<Record<string, unknown>>(),
    outputSchemaJson: jsonb("output_schema_json").$type<
      Record<string, unknown>
    >(),
    annotationsJson: jsonb("annotations_json").$type<Record<string, unknown>>(),
    executionJson: jsonb("execution_json").$type<Record<string, unknown>>(),
    lastTestJson: jsonb("last_test_json").$type<{
      ok: boolean;
      status: number | null;
      testedAt: string;
      error: string | null;
    }>(),
    humanReviewRequired: boolean("human_review_required")
      .notNull()
      .default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("capabilities_tenant_idx").on(t.tenantId),
    index("capabilities_adapter_idx").on(t.adapterId),
  ],
);

export const intentsTable = pgTable(
  "intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    goal: text("goal").notNull(),
    constraints: text("constraints"),
    successCriteria: text("success_criteria"),
    allowedSystems: text("allowed_systems").array(),
    deniedSystems: text("denied_systems").array(),
    budgetTokens: integer("budget_tokens"),
    budgetUsd: integer("budget_usd"),
    maxSteps: integer("max_steps"),
    riskTier: riskTierEnum("risk_tier").notNull().default("L2"),
    status: intentStatusEnum("status").notNull().default("draft"),
    createdBy: uuid("created_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("intents_tenant_idx").on(t.tenantId)],
);

export const runsTable = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    intentId: uuid("intent_id")
      .notNull()
      .references(() => intentsTable.id, { onDelete: "cascade" }),
    status: runStatusEnum("status").notNull().default("pending"),
    orchestrationMode: orchestrationModeEnum("orchestration_mode")
      .notNull()
      .default("static_graph"),
    leadAgentId: uuid("lead_agent_id"),
    taskGraphJson: jsonb("task_graph_json").$type<Record<string, unknown>>(),
    summary: text("summary"),
    error: text("error"),
    tokensUsed: integer("tokens_used").notNull().default(0),
    costUsdMicros: integer("cost_usd_micros").notNull().default(0),
    traceId: uuid("trace_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("runs_tenant_idx").on(t.tenantId),
    index("runs_intent_idx").on(t.intentId),
  ],
);

export const policyBundlesTable = pgTable(
  "policy_bundles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runsTable.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    rulesJson: jsonb("rules_json").$type<Record<string, unknown>>(),
    allowedCapabilities: text("allowed_capabilities").array(),
    deniedCapabilities: text("denied_capabilities").array(),
    approvalThreshold: riskTierEnum("approval_threshold")
      .notNull()
      .default("L3"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("policy_bundles_tenant_idx").on(t.tenantId)],
);

export const workingMemoriesTable = pgTable(
  "working_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runsTable.id, {
      onDelete: "cascade",
    }),
    type: memoryTypeEnum("type").notNull().default("working"),
    key: text("key").notNull(),
    value: text("value").notNull(),
    sensitivity: sensitivityEnum("sensitivity").notNull().default("internal"),
    tags: text("tags").array(),
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("working_memories_tenant_idx").on(t.tenantId)],
);

export const contextFragmentsTable = pgTable(
  "context_fragments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runsTable.id, {
      onDelete: "cascade",
    }),
    type: contextFragmentTypeEnum("type").notNull(),
    source: text("source").notNull(),
    content: text("content").notNull(),
    tokens: integer("tokens").notNull().default(0),
    relevanceScore: integer("relevance_score").notNull().default(0),
    selected: boolean("selected").notNull().default(true),
    rejectionReason: text("rejection_reason"),
    sensitivity: sensitivityEnum("sensitivity").notNull().default("internal"),
    redacted: boolean("redacted").notNull().default(false),
    agentId: uuid("agent_id"),
    agentRunId: uuid("agent_run_id"),
    traceId: uuid("trace_id"),
    observationId: uuid("observation_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("context_fragments_tenant_idx").on(t.tenantId),
    index("context_fragments_run_idx").on(t.runId),
  ],
);

export const contextPacksTable = pgTable(
  "context_packs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runsTable.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    fragmentIds: text("fragment_ids").array(),
    totalTokens: integer("total_tokens").notNull().default(0),
    strategy: text("strategy").notNull().default("relevance"),
    summary: text("summary"),
    traceId: uuid("trace_id"),
    observationId: uuid("observation_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("context_packs_tenant_idx").on(t.tenantId)],
);

export const actionsTable = pgTable(
  "actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => runsTable.id, { onDelete: "cascade" }),
    capabilityId: uuid("capability_id").references(() => capabilitiesTable.id, {
      onDelete: "set null",
    }),
    nodeId: text("node_id"),
    name: text("name").notNull(),
    kind: actionKindEnum("kind").notNull().default("read"),
    riskTier: riskTierEnum("risk_tier").notNull().default("L1"),
    status: actionStatusEnum("status").notNull().default("proposed"),
    inputJson: jsonb("input_json").$type<Record<string, unknown>>(),
    outputJson: jsonb("output_json").$type<Record<string, unknown>>(),
    error: text("error"),
    policyDecisionJson: jsonb("policy_decision_json").$type<
      Record<string, unknown>
    >(),
    agentId: uuid("agent_id"),
    agentRunId: uuid("agent_run_id"),
    traceId: uuid("trace_id"),
    observationId: uuid("observation_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("actions_tenant_idx").on(t.tenantId),
    index("actions_run_idx").on(t.runId),
  ],
);

export const approvalRequestsTable = pgTable(
  "approval_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => runsTable.id, { onDelete: "cascade" }),
    actionId: uuid("action_id")
      .notNull()
      .references(() => actionsTable.id, { onDelete: "cascade" }),
    riskTier: riskTierEnum("risk_tier").notNull().default("L3"),
    status: approvalStatusEnum("status").notNull().default("pending"),
    reason: text("reason"),
    decisionNote: text("decision_note"),
    decidedBy: uuid("decided_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    traceId: uuid("trace_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("approval_requests_tenant_idx").on(t.tenantId),
    index("approval_requests_run_idx").on(t.runId),
  ],
);

export const artifactsTable = pgTable(
  "artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runsTable.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    type: artifactTypeEnum("type").notNull().default("document"),
    contentType: text("content_type").notNull().default("text/markdown"),
    content: text("content"),
    sizeBytes: integer("size_bytes").notNull().default(0),
    sensitivity: sensitivityEnum("sensitivity").notNull().default("internal"),
    agentId: uuid("agent_id"),
    agentRunId: uuid("agent_run_id"),
    traceId: uuid("trace_id"),
    observationId: uuid("observation_id"),
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("artifacts_tenant_idx").on(t.tenantId)],
);

export const eventLogsTable = pgTable(
  "event_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runsTable.id, {
      onDelete: "cascade",
    }),
    type: text("type").notNull(),
    level: text("level").notNull().default("info"),
    message: text("message").notNull(),
    dataJson: jsonb("data_json").$type<Record<string, unknown>>(),
    agentId: uuid("agent_id"),
    agentRunId: uuid("agent_run_id"),
    traceId: uuid("trace_id"),
    observationId: uuid("observation_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("event_logs_tenant_idx").on(t.tenantId),
    index("event_logs_run_idx").on(t.runId),
  ],
);

export const auditRecordsTable = pgTable(
  "audit_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runsTable.id, {
      onDelete: "set null",
    }),
    actorType: principalTypeEnum("actor_type").notNull().default("user"),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    summary: text("summary").notNull(),
    riskTier: riskTierEnum("risk_tier"),
    dataJson: jsonb("data_json").$type<Record<string, unknown>>(),
    agentId: uuid("agent_id"),
    agentRunId: uuid("agent_run_id"),
    traceId: uuid("trace_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("audit_records_tenant_idx").on(t.tenantId)],
);

export const apiKeysTable = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    lastFour: text("last_four").notNull(),
    scopes: text("scopes").array(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("api_keys_tenant_idx").on(t.tenantId)],
);

// Insert schemas + types
export const insertTenantSchema = createInsertSchema(tenantsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type Tenant = typeof tenantsTable.$inferSelect;
export type InsertTenant = z.infer<typeof insertTenantSchema>;

export const insertLinkedAccountSchema = createInsertSchema(
  linkedAccountsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type LinkedAccount = typeof linkedAccountsTable.$inferSelect;
export type InsertLinkedAccount = z.infer<typeof insertLinkedAccountSchema>;

export const insertAdapterSchema = createInsertSchema(adaptersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type Adapter = typeof adaptersTable.$inferSelect;
export type InsertAdapter = z.infer<typeof insertAdapterSchema>;

export type Capability = typeof capabilitiesTable.$inferSelect;
export type Intent = typeof intentsTable.$inferSelect;
export type Run = typeof runsTable.$inferSelect;
export type Action = typeof actionsTable.$inferSelect;
export type ApprovalRequest = typeof approvalRequestsTable.$inferSelect;
export type Artifact = typeof artifactsTable.$inferSelect;
export type ContextFragment = typeof contextFragmentsTable.$inferSelect;
export type ContextPack = typeof contextPacksTable.$inferSelect;
export type WorkingMemory = typeof workingMemoriesTable.$inferSelect;
export type EventLog = typeof eventLogsTable.$inferSelect;
export type AuditRecord = typeof auditRecordsTable.$inferSelect;
export type PolicyBundle = typeof policyBundlesTable.$inferSelect;
export type Principal = typeof principalsTable.$inferSelect;
export type User = typeof usersTable.$inferSelect;
export type Membership = typeof membershipsTable.$inferSelect;
export type ApiKey = typeof apiKeysTable.$inferSelect;
