import { eq } from "drizzle-orm";
import {
  db,
  tenantsTable,
  observationMetricsTable,
  evaluationRecordsTable,
  observationsTable,
  tracesTable,
  agentMessagesTable,
  sharedContextGrantsTable,
  approvalRequestsTable,
  actionsTable,
  agentRunsTable,
  contextFragmentsTable,
  contextPacksTable,
  artifactsTable,
  eventLogsTable,
  auditRecordsTable,
  workingMemoriesTable,
  policyBundlesTable,
  runsTable,
  intentsTable,
  agentModelPoliciesTable,
  agentsTable,
  modelEndpointsTable,
  capabilitiesTable,
  adaptersTable,
  linkedAccountsTable,
  integrationTestsTable,
  synthesizedCapabilitiesTable,
  synthesisRunsTable,
  generatedMcpServersTable,
  integrationBlueprintsTable,
  deploymentTargetsTable,
  uiViewsTable,
  telemetryExportsTable,
} from "@workspace/db";

const DEFAULT_TENANT_SLUG = "default";

async function clearAllTenantData(): Promise<void> {
  const tenants = await db.select().from(tenantsTable);
  if (tenants.length === 0) {
    console.log("No tenants found; nothing to clear.");
    return;
  }

  // Order respects foreign-key dependencies (children before parents).
  const order = [
    observationMetricsTable,
    evaluationRecordsTable,
    observationsTable,
    tracesTable,
    agentMessagesTable,
    sharedContextGrantsTable,
    approvalRequestsTable,
    actionsTable,
    agentRunsTable,
    contextFragmentsTable,
    contextPacksTable,
    artifactsTable,
    eventLogsTable,
    auditRecordsTable,
    workingMemoriesTable,
    policyBundlesTable,
    runsTable,
    intentsTable,
    agentModelPoliciesTable,
    agentsTable,
    modelEndpointsTable,
    capabilitiesTable,
    adaptersTable,
    linkedAccountsTable,
    integrationTestsTable,
    synthesizedCapabilitiesTable,
    synthesisRunsTable,
    generatedMcpServersTable,
    integrationBlueprintsTable,
    deploymentTargetsTable,
    uiViewsTable,
    telemetryExportsTable,
  ] as const;

  for (const tenant of tenants) {
    for (const table of order) {
      await db.delete(table).where(eq(table.tenantId, tenant.id));
    }
    console.log(`Cleared all data for tenant "${tenant.slug}" (${tenant.id}).`);
  }

  console.log(
    "\nDone. Owner identity, tenant, membership, and principal are preserved.",
  );
  if (!tenants.some((t) => t.slug === DEFAULT_TENANT_SLUG)) {
    console.warn("Note: no default tenant present.");
  }
}

clearAllTenantData()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Clear failed:", err);
    process.exit(1);
  });
