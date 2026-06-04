import { pgEnum } from "drizzle-orm/pg-core";

// Core
export const membershipRoleEnum = pgEnum("membership_role", [
  "owner",
  "admin",
  "member",
  "viewer",
]);

export const principalTypeEnum = pgEnum("principal_type", [
  "user",
  "agent",
  "service",
]);

export const authModeEnum = pgEnum("auth_mode", [
  "oauth2",
  "api_key",
  "basic",
  "none",
]);

export const linkedAccountStatusEnum = pgEnum("linked_account_status", [
  "active",
  "expired",
  "revoked",
  "error",
]);

export const adapterTransportEnum = pgEnum("adapter_transport", [
  "streamable_http",
  "stdio",
  "websocket",
  "demo",
  "constructed",
]);

export const adapterStatusEnum = pgEnum("adapter_status", [
  "registered",
  "active",
  "error",
  "disabled",
]);

export const capabilityTypeEnum = pgEnum("capability_type", [
  "tool",
  "resource",
  "prompt",
]);

export const riskTierEnum = pgEnum("risk_tier", ["L1", "L2", "L3", "L4"]);

export const intentStatusEnum = pgEnum("intent_status", [
  "draft",
  "ready",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const runStatusEnum = pgEnum("run_status", [
  "pending",
  "planning",
  "running",
  "waiting_approval",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);

export const orchestrationModeEnum = pgEnum("orchestration_mode", [
  "static_graph",
  "dynamic_delegation",
]);

export const actionKindEnum = pgEnum("action_kind", [
  "read",
  "list",
  "analysis",
  "create",
  "update",
  "destructive",
  "custom",
]);

export const actionStatusEnum = pgEnum("action_status", [
  "proposed",
  "policy_blocked",
  "awaiting_approval",
  "approved",
  "executing",
  "completed",
  "failed",
  "denied",
]);

export const approvalStatusEnum = pgEnum("approval_status", [
  "pending",
  "approved",
  "denied",
  "expired",
]);

export const artifactTypeEnum = pgEnum("artifact_type", [
  "document",
  "dataset",
  "code",
  "report",
  "summary",
  "other",
]);

export const memoryTypeEnum = pgEnum("memory_type", [
  "working",
  "episodic",
  "semantic",
  "procedural",
]);

export const sensitivityEnum = pgEnum("sensitivity", [
  "public",
  "internal",
  "confidential",
  "restricted",
]);

export const contextFragmentTypeEnum = pgEnum("context_fragment_type", [
  "retrieval",
  "memory",
  "system",
  "user",
  "tool_output",
  "summary",
]);

// Multi-agent
export const agentRoleEnum = pgEnum("agent_role", [
  "lead",
  "specialist",
  "verifier",
  "executor",
  "summarizer",
  "router",
  "memory_manager",
]);

export const agentRunStatusEnum = pgEnum("agent_run_status", [
  "pending",
  "running",
  "completed",
  "failed",
  "blocked",
]);

export const sharedContextModeEnum = pgEnum("shared_context_mode", [
  "isolated",
  "shared_summary",
  "shared_readonly",
  "shared_full",
  "brokered",
]);

export const providerTypeEnum = pgEnum("provider_type", [
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "azure_openai",
  "openai_compatible",
]);

export const modelEndpointStatusEnum = pgEnum("model_endpoint_status", [
  "untested",
  "active",
  "error",
  "disabled",
]);

// Synthesis
export const blueprintSourceTypeEnum = pgEnum("blueprint_source_type", [
  "openapi",
  "graphql",
  "sdk",
  "docs",
  "manual",
]);

export const generatedServerStatusEnum = pgEnum("generated_server_status", [
  "draft",
  "generating",
  "generated",
  "testing",
  "tested",
  "security_review",
  "approved",
  "deployed",
  "registered",
  "failed",
  "superseded",
]);

export const synthesisRunStatusEnum = pgEnum("synthesis_run_status", [
  "pending",
  "running",
  "completed",
  "failed",
]);

export const integrationTestStatusEnum = pgEnum("integration_test_status", [
  "pending",
  "passed",
  "failed",
  "skipped",
]);

export const deploymentTargetTypeEnum = pgEnum("deployment_target_type", [
  "simulated",
  "container",
  "kubernetes",
  "serverless",
]);

export const deploymentStatusEnum = pgEnum("deployment_status", [
  "pending",
  "deploying",
  "deployed",
  "failed",
]);

export const regenerationReasonEnum = pgEnum("regeneration_reason", [
  "source_changed",
  "test_failed",
  "usage_feedback",
  "security_patch",
  "schema_upgrade",
  "manual_edit",
]);

// Observability
export const traceStatusEnum = pgEnum("trace_status", [
  "ok",
  "error",
  "partial",
  "running",
]);

export const observationTypeEnum = pgEnum("observation_type", [
  "run",
  "task_node",
  "agent_run",
  "model_call",
  "context_assembly",
  "retrieval",
  "memory_write",
  "tool_call",
  "policy_check",
  "approval",
  "artifact_write",
  "event_emit",
  "eval",
  "error",
]);

export const observationStatusEnum = pgEnum("observation_status", [
  "ok",
  "error",
  "running",
  "blocked",
]);

export const evalLabelEnum = pgEnum("eval_label", [
  "success",
  "failure",
  "partial",
  "unlabeled",
]);

export const telemetryExportFormatEnum = pgEnum("telemetry_export_format", [
  "otlp",
  "jsonl",
  "csv",
]);
