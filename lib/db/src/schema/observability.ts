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
import { tenantsTable } from "./core";
import {
  traceStatusEnum,
  observationTypeEnum,
  observationStatusEnum,
  evalLabelEnum,
  telemetryExportFormatEnum,
  riskTierEnum,
} from "./enums";

export const tracesTable = pgTable(
  "traces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    rootType: text("root_type").notNull().default("run"),
    runId: uuid("run_id"),
    status: traceStatusEnum("status").notNull().default("running"),
    riskTier: riskTierEnum("risk_tier"),
    initiatedBy: text("initiated_by"),
    totalTokens: integer("total_tokens").notNull().default(0),
    totalCostUsdMicros: integer("total_cost_usd_micros").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    observationCount: integer("observation_count").notNull().default(0),
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("traces_tenant_idx").on(t.tenantId)],
);

export const observationsTable = pgTable(
  "observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    traceId: uuid("trace_id")
      .notNull()
      .references(() => tracesTable.id, { onDelete: "cascade" }),
    parentObservationId: uuid("parent_observation_id"),
    type: observationTypeEnum("type").notNull(),
    name: text("name").notNull(),
    status: observationStatusEnum("status").notNull().default("ok"),
    layer: text("layer").notNull().default("orchestration"),
    agentId: uuid("agent_id"),
    agentRunId: uuid("agent_run_id"),
    modelEndpointId: uuid("model_endpoint_id"),
    capabilityId: uuid("capability_id"),
    inputJson: jsonb("input_json").$type<Record<string, unknown>>(),
    outputJson: jsonb("output_json").$type<Record<string, unknown>>(),
    errorJson: jsonb("error_json").$type<Record<string, unknown>>(),
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>(),
    sensitiveMasked: boolean("sensitive_masked").notNull().default(false),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("observations_trace_idx").on(t.traceId),
    index("observations_tenant_idx").on(t.tenantId),
  ],
);

export const observationMetricsTable = pgTable(
  "observation_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    observationId: uuid("observation_id")
      .notNull()
      .references(() => observationsTable.id, { onDelete: "cascade" }),
    latencyMs: integer("latency_ms").notNull().default(0),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    costUsdMicros: integer("cost_usd_micros").notNull().default(0),
    timeToFirstTokenMs: integer("time_to_first_token_ms"),
    finishReason: text("finish_reason"),
    usedStub: boolean("used_stub").notNull().default(false),
    extraJson: jsonb("extra_json").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("observation_metrics_obs_idx").on(t.observationId)],
);

export const evaluationRecordsTable = pgTable(
  "evaluation_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    traceId: uuid("trace_id").references(() => tracesTable.id, {
      onDelete: "cascade",
    }),
    observationId: uuid("observation_id").references(
      () => observationsTable.id,
      { onDelete: "cascade" },
    ),
    name: text("name").notNull(),
    label: evalLabelEnum("label").notNull().default("unlabeled"),
    score: integer("score"),
    isReferenceExample: boolean("is_reference_example")
      .notNull()
      .default(false),
    reviewNote: text("review_note"),
    comparedTraceId: uuid("compared_trace_id"),
    evaluatorType: text("evaluator_type").notNull().default("human"),
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("evaluation_records_tenant_idx").on(t.tenantId)],
);

export const uiViewsTable = pgTable(
  "ui_views",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    scope: text("scope").notNull().default("traces"),
    filtersJson: jsonb("filters_json").$type<Record<string, unknown>>(),
    isPinned: boolean("is_pinned").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("ui_views_tenant_idx").on(t.tenantId)],
);

export const telemetryExportsTable = pgTable(
  "telemetry_exports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    format: telemetryExportFormatEnum("format").notNull().default("otlp"),
    endpoint: text("endpoint"),
    headersJson: jsonb("headers_json").$type<Record<string, string>>(),
    enabled: boolean("enabled").notNull().default(false),
    lastExportedAt: timestamp("last_exported_at", { withTimezone: true }),
    lastExportResultJson: jsonb("last_export_result_json").$type<
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
  (t) => [index("telemetry_exports_tenant_idx").on(t.tenantId)],
);

export type Trace = typeof tracesTable.$inferSelect;
export type Observation = typeof observationsTable.$inferSelect;
export type ObservationMetric = typeof observationMetricsTable.$inferSelect;
export type EvaluationRecord = typeof evaluationRecordsTable.$inferSelect;
export type UiView = typeof uiViewsTable.$inferSelect;
export type TelemetryExport = typeof telemetryExportsTable.$inferSelect;

export const insertEvaluationRecordSchema = createInsertSchema(
  evaluationRecordsTable,
).omit({ id: true, createdAt: true });
export type InsertEvaluationRecord = z.infer<
  typeof insertEvaluationRecordSchema
>;
