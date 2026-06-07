import { db, auditRecordsTable } from "@workspace/db";
import { logger } from "./logger";

type ActorType = "user" | "agent" | "service";
type RiskTier = "L1" | "L2" | "L3" | "L4";

/**
 * One workspace change worth recording in the durable audit feed. This feed is
 * the single change-log the ContextOS bot pulls (via `get_recent_changes`) to
 * learn what happened across the workspace — from the web UI, the bot itself,
 * an agent run, or an external MCP client — so EVERY mutation surface must write
 * one of these.
 */
export interface AuditEntry {
  tenantId: string;
  action: string;
  resourceType: string;
  summary: string;
  actorType?: ActorType;
  actorId?: string | null;
  resourceId?: string | null;
  riskTier?: RiskTier | null;
  dataJson?: Record<string, unknown> | null;
  agentId?: string | null;
  runId?: string | null;
}

/**
 * Insert an audit record. Deliberately best-effort: a failure here is logged but
 * never thrown, so audit logging can never break the mutation it is recording.
 * Never put secrets (API keys, tokens) in `dataJson`.
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditRecordsTable).values({
      tenantId: entry.tenantId,
      actorType: entry.actorType ?? "user",
      actorId: entry.actorId ?? null,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId ?? null,
      summary: entry.summary,
      riskTier: entry.riskTier ?? null,
      dataJson: entry.dataJson ?? null,
      agentId: entry.agentId ?? null,
      runId: entry.runId ?? null,
    });
  } catch (err) {
    logger.error(
      { err, action: entry.action, resourceType: entry.resourceType },
      "recordAudit failed",
    );
  }
}
