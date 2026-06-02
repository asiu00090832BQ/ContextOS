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
import { tenantsTable, adaptersTable } from "./core";
import {
  blueprintSourceTypeEnum,
  generatedServerStatusEnum,
  synthesisRunStatusEnum,
  integrationTestStatusEnum,
  deploymentTargetTypeEnum,
  deploymentStatusEnum,
  regenerationReasonEnum,
  riskTierEnum,
  actionKindEnum,
  capabilityTypeEnum,
} from "./enums";

export const deploymentTargetsTable = pgTable(
  "deployment_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: deploymentTargetTypeEnum("type").notNull().default("simulated"),
    region: text("region"),
    configJson: jsonb("config_json").$type<Record<string, unknown>>(),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("deployment_targets_tenant_idx").on(t.tenantId)],
);

export const integrationBlueprintsTable = pgTable(
  "integration_blueprints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    serviceName: text("service_name").notNull(),
    sourceType: blueprintSourceTypeEnum("source_type")
      .notNull()
      .default("openapi"),
    sourceUrl: text("source_url"),
    sourceSpec: text("source_spec"),
    normalizedJson: jsonb("normalized_json").$type<Record<string, unknown>>(),
    operationCount: integer("operation_count").notNull().default(0),
    generationConfidenceScore: integer("generation_confidence_score")
      .notNull()
      .default(0),
    humanReviewRequired: boolean("human_review_required")
      .notNull()
      .default(false),
    analyzed: boolean("analyzed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("integration_blueprints_tenant_idx").on(t.tenantId)],
);

export const generatedMcpServersTable = pgTable(
  "generated_mcp_servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    blueprintId: uuid("blueprint_id")
      .notNull()
      .references(() => integrationBlueprintsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    version: text("version").notNull().default("1.0.0"),
    status: generatedServerStatusEnum("status").notNull().default("draft"),
    serverCode: text("server_code"),
    capabilityCount: integer("capability_count").notNull().default(0),
    testsPassed: integer("tests_passed").notNull().default(0),
    testsFailed: integer("tests_failed").notNull().default(0),
    securityReviewJson: jsonb("security_review_json").$type<
      Record<string, unknown>
    >(),
    humanReviewRequired: boolean("human_review_required")
      .notNull()
      .default(false),
    approved: boolean("approved").notNull().default(false),
    deploymentTargetId: uuid("deployment_target_id").references(
      () => deploymentTargetsTable.id,
      { onDelete: "set null" },
    ),
    deploymentStatus: deploymentStatusEnum("deployment_status")
      .notNull()
      .default("pending"),
    registeredAdapterId: uuid("registered_adapter_id").references(
      () => adaptersTable.id,
      { onDelete: "set null" },
    ),
    parentGeneratedMcpServerId: uuid("parent_generated_mcp_server_id"),
    regenerationReason: regenerationReasonEnum("regeneration_reason"),
    supersedesServerId: uuid("supersedes_server_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("generated_mcp_servers_tenant_idx").on(t.tenantId)],
);

export const synthesizedCapabilitiesTable = pgTable(
  "synthesized_capabilities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    generatedServerId: uuid("generated_server_id")
      .notNull()
      .references(() => generatedMcpServersTable.id, { onDelete: "cascade" }),
    type: capabilityTypeEnum("type").notNull().default("tool"),
    name: text("name").notNull(),
    description: text("description"),
    sourceOperation: text("source_operation"),
    httpMethod: text("http_method"),
    actionKind: actionKindEnum("action_kind").notNull().default("read"),
    riskTier: riskTierEnum("risk_tier").notNull().default("L1"),
    inputSchemaJson: jsonb("input_schema_json").$type<Record<string, unknown>>(),
    outputSchemaJson: jsonb("output_schema_json").$type<
      Record<string, unknown>
    >(),
    humanReviewRequired: boolean("human_review_required")
      .notNull()
      .default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("synthesized_capabilities_server_idx").on(t.generatedServerId),
  ],
);

export const synthesisRunsTable = pgTable(
  "synthesis_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    blueprintId: uuid("blueprint_id").references(
      () => integrationBlueprintsTable.id,
      { onDelete: "cascade" },
    ),
    generatedServerId: uuid("generated_server_id").references(
      () => generatedMcpServersTable.id,
      { onDelete: "cascade" },
    ),
    status: synthesisRunStatusEnum("status").notNull().default("pending"),
    stagesJson: jsonb("stages_json").$type<Record<string, unknown>>(),
    currentStage: text("current_stage"),
    traceId: uuid("trace_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("synthesis_runs_tenant_idx").on(t.tenantId)],
);

export const integrationTestsTable = pgTable(
  "integration_tests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    generatedServerId: uuid("generated_server_id")
      .notNull()
      .references(() => generatedMcpServersTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: integrationTestStatusEnum("status").notNull().default("pending"),
    testCode: text("test_code"),
    assertion: text("assertion"),
    durationMs: integer("duration_ms").notNull().default(0),
    output: text("output"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("integration_tests_server_idx").on(t.generatedServerId)],
);

export const insertIntegrationBlueprintSchema = createInsertSchema(
  integrationBlueprintsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type IntegrationBlueprint =
  typeof integrationBlueprintsTable.$inferSelect;
export type InsertIntegrationBlueprint = z.infer<
  typeof insertIntegrationBlueprintSchema
>;

export type GeneratedMcpServer = typeof generatedMcpServersTable.$inferSelect;
export type SynthesizedCapability =
  typeof synthesizedCapabilitiesTable.$inferSelect;
export type SynthesisRun = typeof synthesisRunsTable.$inferSelect;
export type IntegrationTest = typeof integrationTestsTable.$inferSelect;
export type DeploymentTarget = typeof deploymentTargetsTable.$inferSelect;
