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
import { tenantsTable, runsTable } from "./core";
import {
  agentRoleEnum,
  agentRunStatusEnum,
  sharedContextModeEnum,
  providerTypeEnum,
  modelEndpointStatusEnum,
  sensitivityEnum,
} from "./enums";

export const modelEndpointsTable = pgTable(
  "model_endpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    providerType: providerTypeEnum("provider_type").notNull(),
    baseUrl: text("base_url"),
    host: text("host"),
    port: integer("port"),
    modelName: text("model_name").notNull(),
    apiKeyRef: text("api_key_ref"),
    organization: text("organization"),
    deployment: text("deployment"),
    extraHeadersJson: jsonb("extra_headers_json").$type<
      Record<string, string>
    >(),
    requestTimeoutMs: integer("request_timeout_ms").notNull().default(30000),
    maxRetries: integer("max_retries").notNull().default(2),
    isDefault: boolean("is_default").notNull().default(false),
    status: modelEndpointStatusEnum("status").notNull().default("untested"),
    lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
    lastTestResultJson: jsonb("last_test_result_json").$type<
      Record<string, unknown>
    >(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("model_endpoints_tenant_idx").on(t.tenantId)],
);

export const agentsTable = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    role: agentRoleEnum("role").notNull(),
    description: text("description"),
    systemPrompt: text("system_prompt"),
    capabilityScope: text("capability_scope").array(),
    contextPolicy: sharedContextModeEnum("context_policy")
      .notNull()
      .default("isolated"),
    outputSchemaJson: jsonb("output_schema_json").$type<
      Record<string, unknown>
    >(),
    exposeAsCapabilityProvider: boolean("expose_as_capability_provider")
      .notNull()
      .default(false),
    canBuildIntegrations: boolean("can_build_integrations")
      .notNull()
      .default(false),
    isActive: boolean("is_active").notNull().default(true),
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("agents_tenant_idx").on(t.tenantId)],
);

export const agentModelPoliciesTable = pgTable(
  "agent_model_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    primaryEndpointId: uuid("primary_endpoint_id").references(
      () => modelEndpointsTable.id,
      { onDelete: "set null" },
    ),
    fallbackEndpointId: uuid("fallback_endpoint_id").references(
      () => modelEndpointsTable.id,
      { onDelete: "set null" },
    ),
    temperature: integer("temperature").notNull().default(70),
    maxTokens: integer("max_tokens").notNull().default(2048),
    paramsJson: jsonb("params_json").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("agent_model_policies_agent_idx").on(t.agentId)],
);

export const agentRunsTable = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => runsTable.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    parentAgentRunId: uuid("parent_agent_run_id"),
    role: agentRoleEnum("role").notNull(),
    status: agentRunStatusEnum("status").notNull().default("pending"),
    task: text("task"),
    inputJson: jsonb("input_json").$type<Record<string, unknown>>(),
    outputJson: jsonb("output_json").$type<Record<string, unknown>>(),
    outputValid: boolean("output_valid"),
    validationError: text("validation_error"),
    endpointUsedId: uuid("endpoint_used_id"),
    usedFallback: boolean("used_fallback").notNull().default(false),
    tokensUsed: integer("tokens_used").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    costUsdMicros: integer("cost_usd_micros").notNull().default(0),
    error: text("error"),
    traceId: uuid("trace_id"),
    observationId: uuid("observation_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("agent_runs_tenant_idx").on(t.tenantId),
    index("agent_runs_run_idx").on(t.runId),
  ],
);

export const agentMessagesTable = pgTable(
  "agent_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => runsTable.id, { onDelete: "cascade" }),
    fromAgentRunId: uuid("from_agent_run_id"),
    toAgentRunId: uuid("to_agent_run_id"),
    fromAgentId: uuid("from_agent_id"),
    toAgentId: uuid("to_agent_id"),
    messageType: text("message_type").notNull().default("delegation"),
    content: text("content").notNull(),
    payloadJson: jsonb("payload_json").$type<Record<string, unknown>>(),
    traceId: uuid("trace_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("agent_messages_run_idx").on(t.runId)],
);

export const sharedContextGrantsTable = pgTable(
  "shared_context_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runsTable.id, {
      onDelete: "cascade",
    }),
    fromAgentId: uuid("from_agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    toAgentId: uuid("to_agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    mode: sharedContextModeEnum("mode").notNull().default("shared_summary"),
    maxSensitivity: sensitivityEnum("max_sensitivity")
      .notNull()
      .default("internal"),
    fragmentIds: text("fragment_ids").array(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("shared_context_grants_run_idx").on(t.runId)],
);

export const insertModelEndpointSchema = createInsertSchema(
  modelEndpointsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type ModelEndpoint = typeof modelEndpointsTable.$inferSelect;
export type InsertModelEndpoint = z.infer<typeof insertModelEndpointSchema>;

export const insertAgentSchema = createInsertSchema(agentsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type Agent = typeof agentsTable.$inferSelect;
export type InsertAgent = z.infer<typeof insertAgentSchema>;

export type AgentModelPolicy = typeof agentModelPoliciesTable.$inferSelect;
export type AgentRun = typeof agentRunsTable.$inferSelect;
export type AgentMessage = typeof agentMessagesTable.$inferSelect;
export type SharedContextGrant = typeof sharedContextGrantsTable.$inferSelect;
