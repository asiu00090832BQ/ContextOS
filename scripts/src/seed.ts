import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db,
  usersTable,
  tenantsTable,
  membershipsTable,
  principalsTable,
  linkedAccountsTable,
  adaptersTable,
  capabilitiesTable,
  intentsTable,
  runsTable,
  policyBundlesTable,
  workingMemoriesTable,
  contextFragmentsTable,
  contextPacksTable,
  actionsTable,
  approvalRequestsTable,
  artifactsTable,
  eventLogsTable,
  auditRecordsTable,
  modelEndpointsTable,
  agentsTable,
  agentModelPoliciesTable,
  agentRunsTable,
  agentMessagesTable,
  sharedContextGrantsTable,
  tracesTable,
  observationsTable,
  observationMetricsTable,
  evaluationRecordsTable,
  uiViewsTable,
  telemetryExportsTable,
  deploymentTargetsTable,
  integrationBlueprintsTable,
  generatedMcpServersTable,
  synthesizedCapabilitiesTable,
  synthesisRunsTable,
  integrationTestsTable,
} from "@workspace/db";

const OWNER_EMAIL = "owner@contextos.local";
const DEFAULT_TENANT_SLUG = "default";

function minutesAgo(mins: number): Date {
  return new Date(Date.now() - mins * 60_000);
}

async function bootstrap(): Promise<{ userId: string; tenantId: string }> {
  let [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, OWNER_EMAIL));
  if (!user) {
    [user] = await db
      .insert(usersTable)
      .values({ email: OWNER_EMAIL, name: "Owner", isOwner: true })
      .returning();
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
  }

  const [membership] = await db
    .select()
    .from(membershipsTable)
    .where(
      and(
        eq(membershipsTable.userId, user.id),
        eq(membershipsTable.tenantId, tenant.id),
      ),
    );
  if (!membership) {
    await db
      .insert(membershipsTable)
      .values({ tenantId: tenant.id, userId: user.id, role: "owner" });
  }

  const [principal] = await db
    .select()
    .from(principalsTable)
    .where(
      and(
        eq(principalsTable.userId, user.id),
        eq(principalsTable.tenantId, tenant.id),
      ),
    );
  if (!principal) {
    await db.insert(principalsTable).values({
      tenantId: tenant.id,
      type: "user",
      displayName: user.name,
      userId: user.id,
    });
  }

  return { userId: user.id, tenantId: tenant.id };
}

async function clearTenant(tenantId: string): Promise<void> {
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
  for (const table of order) {
    await db.delete(table).where(eq(table.tenantId, tenantId));
  }
}

async function seed(): Promise<void> {
  const { userId, tenantId } = await bootstrap();
  await clearTenant(tenantId);

  // ---- Model endpoints ----
  const openaiEndpointId = randomUUID();
  const anthropicEndpointId = randomUUID();
  await db.insert(modelEndpointsTable).values([
    {
      id: openaiEndpointId,
      tenantId,
      name: "GPT-4o (primary)",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      modelName: "gpt-4o",
      apiKeyRef: "stored",
      isDefault: true,
      status: "active",
      lastTestedAt: minutesAgo(120),
      lastTestResultJson: { ok: true, mode: "stub", latencyMs: 412 },
    },
    {
      id: anthropicEndpointId,
      tenantId,
      name: "Claude 3.5 Sonnet (fallback)",
      providerType: "anthropic",
      baseUrl: "https://api.anthropic.com",
      modelName: "claude-3-5-sonnet-latest",
      apiKeyRef: "stored",
      status: "untested",
    },
  ]);

  // ---- Agents + policies ----
  const leadAgentId = randomUUID();
  const researcherAgentId = randomUUID();
  const verifierAgentId = randomUUID();
  await db.insert(agentsTable).values([
    {
      id: leadAgentId,
      tenantId,
      name: "Orchestrator",
      role: "lead",
      description: "Plans the task graph and delegates to specialists.",
      systemPrompt:
        "You are the lead orchestrator. Decompose the intent into a task graph and delegate.",
      capabilityScope: ["*"],
      contextPolicy: "shared_full",
      exposeAsCapabilityProvider: false,
    },
    {
      id: researcherAgentId,
      tenantId,
      name: "Researcher",
      role: "specialist",
      description: "Gathers and synthesizes information from connected systems.",
      systemPrompt: "You are a research specialist. Retrieve and summarize.",
      capabilityScope: ["search.query", "docs.read"],
      contextPolicy: "shared_summary",
      exposeAsCapabilityProvider: true,
    },
    {
      id: verifierAgentId,
      tenantId,
      name: "Verifier",
      role: "verifier",
      description: "Checks outputs against success criteria before completion.",
      systemPrompt: "You are a verifier. Validate the work against criteria.",
      capabilityScope: ["docs.read"],
      contextPolicy: "shared_readonly",
      exposeAsCapabilityProvider: false,
    },
  ]);
  await db.insert(agentModelPoliciesTable).values([
    {
      tenantId,
      agentId: leadAgentId,
      primaryEndpointId: openaiEndpointId,
      fallbackEndpointId: anthropicEndpointId,
      temperature: 30,
      maxTokens: 4096,
    },
    {
      tenantId,
      agentId: researcherAgentId,
      primaryEndpointId: openaiEndpointId,
      temperature: 70,
      maxTokens: 2048,
    },
    {
      tenantId,
      agentId: verifierAgentId,
      primaryEndpointId: anthropicEndpointId,
      temperature: 10,
      maxTokens: 1024,
    },
  ]);

  // ---- Linked accounts ----
  const githubAccountId = randomUUID();
  const slackAccountId = randomUUID();
  await db.insert(linkedAccountsTable).values([
    {
      id: githubAccountId,
      tenantId,
      systemName: "github",
      displayName: "GitHub (acme-org)",
      authMode: "oauth2",
      status: "active",
      credentialRef: "stored",
      scopes: ["repo", "read:org"],
      accountIdentifier: "acme-org",
      lastRefreshedAt: minutesAgo(60),
    },
    {
      id: slackAccountId,
      tenantId,
      systemName: "slack",
      displayName: "Slack (Acme)",
      authMode: "oauth2",
      status: "active",
      credentialRef: "stored",
      scopes: ["chat:write", "channels:read"],
      accountIdentifier: "T0ACME",
      lastRefreshedAt: minutesAgo(45),
    },
  ]);

  // ---- Adapters + capabilities ----
  const githubAdapterId = randomUUID();
  const searchAdapterId = randomUUID();
  await db.insert(adaptersTable).values([
    {
      id: githubAdapterId,
      tenantId,
      name: "GitHub MCP",
      description: "Tools for issues, PRs, and repo content.",
      transport: "demo",
      status: "active",
      linkedAccountId: githubAccountId,
      lastDiscoveredAt: minutesAgo(50),
      lastHealthAt: minutesAgo(10),
      lastHealthResultJson: { ok: true, latencyMs: 88 },
    },
    {
      id: searchAdapterId,
      tenantId,
      name: "Web Search MCP",
      description: "Read-only web search and fetch.",
      transport: "demo",
      status: "active",
      lastDiscoveredAt: minutesAgo(50),
      lastHealthAt: minutesAgo(8),
      lastHealthResultJson: { ok: true, latencyMs: 134 },
    },
  ]);
  const searchCapId = randomUUID();
  const docsReadCapId = randomUUID();
  const issueCreateCapId = randomUUID();
  await db.insert(capabilitiesTable).values([
    {
      id: searchCapId,
      tenantId,
      adapterId: searchAdapterId,
      type: "tool",
      name: "search.query",
      description: "Search the web for a query.",
      riskTier: "L1",
      actionKind: "read",
      inputSchemaJson: { type: "object", properties: { q: { type: "string" } } },
    },
    {
      id: docsReadCapId,
      tenantId,
      adapterId: githubAdapterId,
      type: "tool",
      name: "docs.read",
      description: "Read a file from a repository.",
      riskTier: "L1",
      actionKind: "read",
    },
    {
      id: issueCreateCapId,
      tenantId,
      adapterId: githubAdapterId,
      type: "tool",
      name: "issues.create",
      description: "Create a new GitHub issue.",
      riskTier: "L3",
      actionKind: "create",
      humanReviewRequired: true,
    },
  ]);

  // ---- Deployment target ----
  const deployTargetId = randomUUID();
  await db.insert(deploymentTargetsTable).values({
    id: deployTargetId,
    tenantId,
    name: "Simulated (local)",
    type: "simulated",
    region: "us-east",
    isDefault: true,
  });

  // ---- Synthesis: blueprint -> server -> capabilities/tests ----
  const blueprintId = randomUUID();
  await db.insert(integrationBlueprintsTable).values({
    id: blueprintId,
    tenantId,
    name: "Stripe API",
    serviceName: "stripe",
    sourceType: "openapi",
    sourceUrl: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
    normalizedJson: {
      service: "stripe",
      operations: [
        { operationId: "listCustomers", method: "GET", path: "/v1/customers", summary: "List customers", mutating: false },
        { operationId: "createCustomer", method: "POST", path: "/v1/customers", summary: "Create a customer", mutating: true },
        { operationId: "createRefund", method: "POST", path: "/v1/refunds", summary: "Create a refund", mutating: true },
      ],
    },
    operationCount: 3,
    generationConfidenceScore: 86,
    humanReviewRequired: true,
    analyzed: true,
  });
  const generatedServerId = randomUUID();
  await db.insert(generatedMcpServersTable).values({
    id: generatedServerId,
    tenantId,
    blueprintId,
    name: "stripe-mcp",
    version: "1.0.0",
    status: "tested",
    serverCode: "// generated MCP server for stripe\nexport const tools = [/* ... */];\n",
    capabilityCount: 3,
    testsPassed: 3,
    testsFailed: 0,
    securityReviewJson: { findings: [], riskTier: "L3" },
    humanReviewRequired: true,
    approved: false,
    deploymentTargetId: deployTargetId,
    deploymentStatus: "pending",
  });
  await db.insert(synthesizedCapabilitiesTable).values([
    {
      tenantId,
      generatedServerId,
      type: "tool",
      name: "stripe.listCustomers",
      description: "List customers.",
      sourceOperation: "listCustomers",
      httpMethod: "GET",
      actionKind: "list",
      riskTier: "L1",
    },
    {
      tenantId,
      generatedServerId,
      type: "tool",
      name: "stripe.createCustomer",
      description: "Create a customer.",
      sourceOperation: "createCustomer",
      httpMethod: "POST",
      actionKind: "create",
      riskTier: "L2",
    },
    {
      tenantId,
      generatedServerId,
      type: "tool",
      name: "stripe.createRefund",
      description: "Issue a refund.",
      sourceOperation: "createRefund",
      httpMethod: "POST",
      actionKind: "destructive",
      riskTier: "L4",
      humanReviewRequired: true,
    },
  ]);
  await db.insert(integrationTestsTable).values([
    {
      tenantId,
      generatedServerId,
      name: "listCustomers returns array",
      status: "passed",
      assertion: "response is array",
      durationMs: 42,
      output: "ok",
    },
    {
      tenantId,
      generatedServerId,
      name: "createCustomer validates email",
      status: "passed",
      assertion: "rejects invalid email",
      durationMs: 31,
      output: "ok",
    },
  ]);
  await db.insert(synthesisRunsTable).values({
    tenantId,
    blueprintId,
    generatedServerId,
    status: "completed",
    currentStage: "tested",
    stagesJson: {
      stages: ["analyze", "generate", "security_review", "test"],
      completed: 4,
    },
    startedAt: minutesAgo(200),
    completedAt: minutesAgo(195),
  });

  // ---- Intents ----
  const completedIntentId = randomUUID();
  const runningIntentId = randomUUID();
  const draftIntentId = randomUUID();
  await db.insert(intentsTable).values([
    {
      id: completedIntentId,
      tenantId,
      title: "Summarize open issues",
      goal: "Produce a prioritized summary of open GitHub issues for the dashboard.",
      successCriteria: "A markdown report grouped by severity.",
      constraints: "Read-only. Do not modify any issues.",
      allowedSystems: ["github", "web"],
      budgetTokens: 50_000,
      maxSteps: 8,
      riskTier: "L2",
      status: "completed",
      createdBy: userId,
    },
    {
      id: runningIntentId,
      tenantId,
      title: "Draft release notes",
      goal: "Draft release notes for v2.1 from merged PRs.",
      successCriteria: "A changelog with sections for features and fixes.",
      riskTier: "L2",
      status: "running",
      createdBy: userId,
    },
    {
      id: draftIntentId,
      tenantId,
      title: "Audit third-party API usage",
      goal: "Identify which connected systems are unused in the last 90 days.",
      riskTier: "L3",
      status: "draft",
      createdBy: userId,
    },
  ]);

  // ---- Trace tree for the completed run ----
  const traceId = randomUUID();
  const completedRunId = randomUUID();
  await db.insert(tracesTable).values({
    id: traceId,
    tenantId,
    name: "Run: Summarize open issues",
    rootType: "run",
    runId: completedRunId,
    status: "ok",
    riskTier: "L2",
    initiatedBy: "Owner",
    totalTokens: 8420,
    totalCostUsdMicros: 25_260,
    durationMs: 14_200,
    observationCount: 6,
    startedAt: minutesAgo(30),
    endedAt: minutesAgo(29),
  });

  await db.insert(runsTable).values({
    id: completedRunId,
    tenantId,
    intentId: completedIntentId,
    status: "completed",
    orchestrationMode: "dynamic_delegation",
    leadAgentId,
    summary: "Generated a prioritized summary of 23 open issues.",
    tokensUsed: 8420,
    costUsdMicros: 25_260,
    traceId,
    startedAt: minutesAgo(30),
    completedAt: minutesAgo(29),
    taskGraphJson: {
      nodes: [
        { id: "n1", agent: "Researcher", task: "fetch issues" },
        { id: "n2", agent: "Researcher", task: "summarize" },
        { id: "n3", agent: "Verifier", task: "verify report" },
      ],
    },
  });

  // Observation tree: root run -> context_assembly, model_call, tool_call, agent_run -> eval
  const obsRootId = randomUUID();
  const obsContextId = randomUUID();
  const obsModelId = randomUUID();
  const obsToolId = randomUUID();
  const obsAgentId = randomUUID();
  const obsEvalId = randomUUID();
  await db.insert(observationsTable).values([
    {
      id: obsRootId,
      tenantId,
      traceId,
      type: "run",
      name: "Run root",
      status: "ok",
      layer: "orchestration",
      startedAt: minutesAgo(30),
      endedAt: minutesAgo(29),
    },
    {
      id: obsContextId,
      tenantId,
      traceId,
      parentObservationId: obsRootId,
      type: "context_assembly",
      name: "Assemble context pack",
      status: "ok",
      layer: "context",
      startedAt: minutesAgo(30),
      endedAt: minutesAgo(30),
    },
    {
      id: obsAgentId,
      tenantId,
      traceId,
      parentObservationId: obsRootId,
      type: "agent_run",
      name: "Researcher run",
      status: "ok",
      layer: "agent",
      agentId: researcherAgentId,
      startedAt: minutesAgo(30),
      endedAt: minutesAgo(29),
    },
    {
      id: obsModelId,
      tenantId,
      traceId,
      parentObservationId: obsAgentId,
      type: "model_call",
      name: "gpt-4o completion",
      status: "ok",
      layer: "model",
      modelEndpointId: openaiEndpointId,
      startedAt: minutesAgo(30),
      endedAt: minutesAgo(29),
    },
    {
      id: obsToolId,
      tenantId,
      traceId,
      parentObservationId: obsAgentId,
      type: "tool_call",
      name: "search.query",
      status: "ok",
      layer: "capability",
      capabilityId: searchCapId,
      startedAt: minutesAgo(30),
      endedAt: minutesAgo(30),
    },
    {
      id: obsEvalId,
      tenantId,
      traceId,
      parentObservationId: obsRootId,
      type: "eval",
      name: "Verifier check",
      status: "ok",
      layer: "evaluation",
      agentId: verifierAgentId,
      startedAt: minutesAgo(29),
      endedAt: minutesAgo(29),
    },
  ]);
  await db.insert(observationMetricsTable).values([
    {
      tenantId,
      observationId: obsModelId,
      latencyMs: 4120,
      promptTokens: 5200,
      completionTokens: 3220,
      totalTokens: 8420,
      costUsdMicros: 25_260,
      timeToFirstTokenMs: 380,
      finishReason: "stop",
    },
    {
      tenantId,
      observationId: obsToolId,
      latencyMs: 134,
      finishReason: "ok",
    },
  ]);

  // ---- Agent runs + messages for the completed run ----
  const leadAgentRunId = randomUUID();
  const researcherAgentRunId = randomUUID();
  const verifierAgentRunId = randomUUID();
  await db.insert(agentRunsTable).values([
    {
      id: leadAgentRunId,
      tenantId,
      runId: completedRunId,
      agentId: leadAgentId,
      role: "lead",
      status: "completed",
      task: "Plan and delegate the summarization task.",
      tokensUsed: 1200,
      latencyMs: 2100,
      costUsdMicros: 3600,
      traceId,
      observationId: obsRootId,
      startedAt: minutesAgo(30),
      completedAt: minutesAgo(29),
    },
    {
      id: researcherAgentRunId,
      tenantId,
      runId: completedRunId,
      agentId: researcherAgentId,
      parentAgentRunId: leadAgentRunId,
      role: "specialist",
      status: "completed",
      task: "Fetch and summarize open issues.",
      endpointUsedId: openaiEndpointId,
      tokensUsed: 6020,
      latencyMs: 9800,
      costUsdMicros: 18_060,
      outputValid: true,
      traceId,
      observationId: obsAgentId,
      startedAt: minutesAgo(30),
      completedAt: minutesAgo(29),
    },
    {
      id: verifierAgentRunId,
      tenantId,
      runId: completedRunId,
      agentId: verifierAgentId,
      parentAgentRunId: leadAgentRunId,
      role: "verifier",
      status: "completed",
      task: "Verify the report meets success criteria.",
      tokensUsed: 1200,
      latencyMs: 2300,
      costUsdMicros: 3600,
      outputValid: true,
      traceId,
      observationId: obsEvalId,
      startedAt: minutesAgo(29),
      completedAt: minutesAgo(29),
    },
  ]);
  await db.insert(agentMessagesTable).values([
    {
      tenantId,
      runId: completedRunId,
      fromAgentRunId: leadAgentRunId,
      toAgentRunId: researcherAgentRunId,
      fromAgentId: leadAgentId,
      toAgentId: researcherAgentId,
      messageType: "delegation",
      content: "Fetch all open issues and produce a prioritized summary.",
      traceId,
    },
    {
      tenantId,
      runId: completedRunId,
      fromAgentRunId: researcherAgentRunId,
      toAgentRunId: leadAgentRunId,
      fromAgentId: researcherAgentId,
      toAgentId: leadAgentId,
      messageType: "result",
      content: "Summary complete: 23 issues across 4 severity buckets.",
      traceId,
    },
  ]);
  await db.insert(sharedContextGrantsTable).values({
    tenantId,
    runId: completedRunId,
    fromAgentId: researcherAgentId,
    toAgentId: verifierAgentId,
    mode: "shared_summary",
    maxSensitivity: "internal",
    note: "Share the issue summary for verification.",
  });

  // ---- Context fragments + pack ----
  const frag1 = randomUUID();
  const frag2 = randomUUID();
  const frag3 = randomUUID();
  await db.insert(contextFragmentsTable).values([
    {
      id: frag1,
      tenantId,
      runId: completedRunId,
      type: "retrieval",
      source: "github:issues",
      content: "Issue #482: crash on startup when config missing.",
      tokens: 320,
      relevanceScore: 95,
      selected: true,
      traceId,
      observationId: obsContextId,
    },
    {
      id: frag2,
      tenantId,
      runId: completedRunId,
      type: "retrieval",
      source: "github:issues",
      content: "Issue #501: typo in onboarding email.",
      tokens: 120,
      relevanceScore: 40,
      selected: true,
      traceId,
      observationId: obsContextId,
    },
    {
      id: frag3,
      tenantId,
      runId: completedRunId,
      type: "memory",
      source: "working_memory",
      content: "Previous summary prioritized security issues first.",
      tokens: 90,
      relevanceScore: 60,
      selected: false,
      rejectionReason: "Superseded by fresh retrieval.",
      traceId,
      observationId: obsContextId,
    },
  ]);
  await db.insert(contextPacksTable).values({
    tenantId,
    runId: completedRunId,
    name: "Issue summary pack",
    fragmentIds: [frag1, frag2],
    totalTokens: 440,
    strategy: "relevance",
    summary: "Top relevant issue fragments selected for summarization.",
    traceId,
    observationId: obsContextId,
  });

  // ---- Working memories ----
  await db.insert(workingMemoriesTable).values([
    {
      tenantId,
      runId: completedRunId,
      type: "working",
      key: "issue_count",
      value: "23",
      sensitivity: "internal",
      tags: ["github", "issues"],
    },
    {
      tenantId,
      runId: completedRunId,
      type: "semantic",
      key: "severity_buckets",
      value: "critical, high, medium, low",
      sensitivity: "internal",
      tags: ["taxonomy"],
    },
  ]);

  // ---- Policy bundle ----
  await db.insert(policyBundlesTable).values({
    tenantId,
    runId: completedRunId,
    name: "Read-only summarization policy",
    rulesJson: { denyKinds: ["destructive", "update", "create"] },
    allowedCapabilities: ["search.query", "docs.read"],
    deniedCapabilities: ["issues.create"],
    approvalThreshold: "L3",
  });

  // ---- Actions + approval ----
  const readActionId = randomUUID();
  const blockedActionId = randomUUID();
  await db.insert(actionsTable).values([
    {
      id: readActionId,
      tenantId,
      runId: completedRunId,
      capabilityId: searchCapId,
      nodeId: "n1",
      name: "search.query",
      kind: "read",
      riskTier: "L1",
      status: "completed",
      inputJson: { q: "repo:acme open issues" },
      outputJson: { count: 23 },
      agentId: researcherAgentId,
      agentRunId: researcherAgentRunId,
      traceId,
      observationId: obsToolId,
      completedAt: minutesAgo(30),
    },
    {
      id: blockedActionId,
      tenantId,
      runId: completedRunId,
      capabilityId: issueCreateCapId,
      nodeId: "n2",
      name: "issues.create",
      kind: "create",
      riskTier: "L3",
      status: "awaiting_approval",
      inputJson: { title: "Tracking: triage summary" },
      policyDecisionJson: { decision: "requires_approval", threshold: "L3" },
      agentId: researcherAgentId,
      agentRunId: researcherAgentRunId,
      traceId,
    },
  ]);
  await db.insert(approvalRequestsTable).values({
    tenantId,
    runId: completedRunId,
    actionId: blockedActionId,
    riskTier: "L3",
    status: "pending",
    reason: "Creating a GitHub issue exceeds the read-only policy threshold.",
    expiresAt: minutesAgo(-60),
    traceId,
  });

  // ---- Artifacts ----
  await db.insert(artifactsTable).values({
    tenantId,
    runId: completedRunId,
    name: "open-issues-summary.md",
    type: "report",
    contentType: "text/markdown",
    content:
      "# Open Issues Summary\n\n## Critical (2)\n- #482 crash on startup\n\n## High (5)\n- ...\n",
    sizeBytes: 1280,
    sensitivity: "internal",
    agentId: researcherAgentId,
    agentRunId: researcherAgentRunId,
    traceId,
    observationId: obsAgentId,
  });

  // ---- Event logs ----
  await db.insert(eventLogsTable).values([
    {
      tenantId,
      runId: completedRunId,
      type: "run.started",
      level: "info",
      message: "Run started for intent 'Summarize open issues'",
      traceId,
    },
    {
      tenantId,
      runId: completedRunId,
      type: "policy.blocked",
      level: "warn",
      message: "issues.create requires approval (L3)",
      traceId,
    },
    {
      tenantId,
      runId: completedRunId,
      type: "run.completed",
      level: "info",
      message: "Run completed (8420 tokens)",
      traceId,
    },
  ]);

  // ---- Audit records ----
  await db.insert(auditRecordsTable).values([
    {
      tenantId,
      runId: completedRunId,
      actorType: "user",
      actorId: userId,
      action: "run.created",
      resourceType: "run",
      resourceId: completedRunId,
      summary: "Owner started a run for 'Summarize open issues'",
      riskTier: "L2",
      traceId,
    },
    {
      tenantId,
      runId: completedRunId,
      actorType: "agent",
      actorId: researcherAgentId,
      action: "capability.invoked",
      resourceType: "capability",
      resourceId: searchCapId,
      summary: "Researcher invoked search.query",
      riskTier: "L1",
      traceId,
    },
  ]);

  // ---- Evaluations ----
  await db.insert(evaluationRecordsTable).values([
    {
      tenantId,
      traceId,
      observationId: obsEvalId,
      name: "Meets success criteria",
      label: "success",
      score: 92,
      isReferenceExample: true,
      reviewNote: "Well-structured, grouped by severity as required.",
      evaluatorType: "human",
    },
    {
      tenantId,
      traceId,
      name: "Cost within budget",
      label: "success",
      score: 100,
      evaluatorType: "auto",
    },
  ]);

  // ---- Running run (in-flight) ----
  const runningTraceId = randomUUID();
  const runningRunId = randomUUID();
  await db.insert(tracesTable).values({
    id: runningTraceId,
    tenantId,
    name: "Run: Draft release notes",
    rootType: "run",
    runId: runningRunId,
    status: "running",
    riskTier: "L2",
    initiatedBy: "Owner",
    startedAt: minutesAgo(2),
  });
  await db.insert(runsTable).values({
    id: runningRunId,
    tenantId,
    intentId: runningIntentId,
    status: "running",
    orchestrationMode: "static_graph",
    leadAgentId,
    tokensUsed: 1500,
    costUsdMicros: 4500,
    traceId: runningTraceId,
    startedAt: minutesAgo(2),
  });

  // ---- UI views + telemetry exports ----
  await db.insert(uiViewsTable).values([
    {
      tenantId,
      name: "Failed runs",
      scope: "traces",
      filtersJson: { status: "error" },
      isPinned: true,
    },
    {
      tenantId,
      name: "High-risk actions",
      scope: "audit",
      filtersJson: { riskTier: "L3" },
      isPinned: false,
    },
  ]);
  await db.insert(telemetryExportsTable).values([
    {
      tenantId,
      name: "OTLP -> collector",
      format: "otlp",
      endpoint: "https://otel.acme.local/v1/traces",
      enabled: true,
      lastExportedAt: minutesAgo(15),
      lastExportResultJson: { ok: true, spans: 42 },
    },
    {
      tenantId,
      name: "JSONL archive",
      format: "jsonl",
      endpoint: "s3://acme-telemetry/contextos/",
      enabled: false,
    },
  ]);

  console.log("Seed complete for tenant", tenantId);
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
