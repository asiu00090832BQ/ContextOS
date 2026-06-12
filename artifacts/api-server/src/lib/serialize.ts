import type {
  Tenant,
  Principal,
  Adapter,
  Capability,
  Intent,
  Run,
  Action,
  ApprovalRequest,
  Artifact,
  ContextFragment,
  ContextPack,
  WorkingMemory,
  EventLog,
  AuditRecord,
  Agent,
  AgentModelPolicy,
  AgentRun,
  AgentMessage,
  Conversation,
  ConversationMessage,
  ModelEndpoint,
  DeploymentTarget,
  Trace,
  Observation,
  ObservationMetric,
  EvaluationRecord,
  UiView,
  TelemetryExport,
} from "@workspace/db";

type Json = Record<string, unknown> | null | undefined;
const j = (v: Json) => (v == null ? undefined : v);

export function serializeAdapter(
  a: Adapter,
  capabilityCount?: number,
): Record<string, unknown> {
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    transport: a.transport,
    protocolVersion: a.protocolVersion,
    endpointUrl: a.endpointUrl,
    sessionMode: a.sessionMode,
    status: a.status,
    linkedAccountId: a.linkedAccountId,
    isGenerated: a.isGenerated,
    authType:
      ((a.metadataJson as Record<string, unknown> | null)?.authType as
        | string
        | undefined) ?? null,
    allowPrivateNetwork:
      ((a.metadataJson as Record<string, unknown> | null)
        ?.allowPrivateNetwork as boolean | undefined) ?? null,
    createdVia:
      ((a.metadataJson as Record<string, unknown> | null)?.createdVia as
        | string
        | undefined) ?? null,
    lastImportSmokeTest:
      ((a.metadataJson as Record<string, unknown> | null)
        ?.lastImportSmokeTest as Record<string, unknown> | undefined) ?? null,
    lastDiscoveredAt: a.lastDiscoveredAt ?? null,
    lastHealthAt: a.lastHealthAt ?? null,
    capabilityCount: capabilityCount ?? null,
    createdAt: a.createdAt,
  };
}

export function serializeAdapterDetail(
  a: Adapter,
  capabilities: Capability[],
): Record<string, unknown> {
  return {
    ...serializeAdapter(a, capabilities.length),
    capabilities: capabilities.map(serializeCapability),
    lastHealthResult: j(a.lastHealthResultJson),
  };
}

export function serializeCapability(c: Capability): Record<string, unknown> {
  return {
    id: c.id,
    adapterId: c.adapterId,
    type: c.type,
    name: c.name,
    description: c.description,
    riskTier: c.riskTier,
    actionKind: c.actionKind,
    humanReviewRequired: c.humanReviewRequired,
    inputSchema: j(c.inputSchemaJson),
    outputSchema: j(c.outputSchemaJson),
    executionKind:
      ((c.executionJson as Record<string, unknown> | null)?.kind as
        | string
        | undefined) ?? null,
    lastTest: c.lastTestJson ?? null,
    createdAt: c.createdAt,
  };
}

export function serializeIntent(
  i: Intent,
  runCount?: number,
): Record<string, unknown> {
  return {
    id: i.id,
    title: i.title,
    goal: i.goal,
    constraints: i.constraints,
    successCriteria: i.successCriteria,
    allowedSystems: i.allowedSystems ?? null,
    deniedSystems: i.deniedSystems ?? null,
    budgetTokens: i.budgetTokens,
    budgetUsd: i.budgetUsd,
    maxSteps: i.maxSteps,
    riskTier: i.riskTier,
    status: i.status,
    runCount: runCount ?? null,
    createdAt: i.createdAt,
  };
}

export function serializeRun(
  r: Run,
  intentTitle?: string | null,
  extra?: { liveCallCount?: number; stubCallCount?: number },
): Record<string, unknown> {
  return {
    id: r.id,
    intentId: r.intentId,
    intentTitle: intentTitle ?? null,
    status: r.status,
    orchestrationMode: r.orchestrationMode,
    leadAgentId: r.leadAgentId,
    summary: r.summary,
    error: r.error,
    tokensUsed: r.tokensUsed,
    costUsdMicros: r.costUsdMicros,
    traceId: r.traceId,
    startedAt: r.startedAt ?? null,
    completedAt: r.completedAt ?? null,
    createdAt: r.createdAt,
    liveCallCount: extra?.liveCallCount ?? null,
    stubCallCount: extra?.stubCallCount ?? null,
  };
}

export function serializeAction(a: Action): Record<string, unknown> {
  return {
    id: a.id,
    runId: a.runId,
    capabilityId: a.capabilityId,
    nodeId: a.nodeId,
    name: a.name,
    kind: a.kind,
    riskTier: a.riskTier,
    status: a.status,
    input: j(a.inputJson),
    output: j(a.outputJson),
    error: a.error,
    policyDecision: j(a.policyDecisionJson),
    agentId: a.agentId,
    agentRunId: a.agentRunId,
    createdAt: a.createdAt,
    completedAt: a.completedAt ?? null,
  };
}

export function serializeApproval(
  a: ApprovalRequest,
  actionName?: string | null,
): Record<string, unknown> {
  return {
    id: a.id,
    runId: a.runId,
    actionId: a.actionId,
    actionName: actionName ?? null,
    riskTier: a.riskTier,
    status: a.status,
    reason: a.reason,
    decisionNote: a.decisionNote,
    decidedAt: a.decidedAt ?? null,
    expiresAt: a.expiresAt ?? null,
    createdAt: a.createdAt,
  };
}

export function serializeArtifact(a: Artifact): Record<string, unknown> {
  return {
    id: a.id,
    runId: a.runId,
    name: a.name,
    type: a.type,
    contentType: a.contentType,
    content: a.content,
    sizeBytes: a.sizeBytes,
    sensitivity: a.sensitivity,
    createdAt: a.createdAt,
  };
}

export function serializeTenant(t: Tenant): Record<string, unknown> {
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    description: t.description,
    isDefault: t.isDefault,
  };
}

export function serializePrincipal(p: Principal): Record<string, unknown> {
  return {
    id: p.id,
    type: p.type,
    displayName: p.displayName,
    userId: p.userId,
    metadata: p.metadataJson ?? null,
    createdAt: p.createdAt,
  };
}

export function serializeFragment(f: ContextFragment): Record<string, unknown> {
  return {
    id: f.id,
    runId: f.runId,
    type: f.type,
    source: f.source,
    content: f.content,
    tokens: f.tokens,
    relevanceScore: f.relevanceScore,
    selected: f.selected,
    rejectionReason: f.rejectionReason,
    sensitivity: f.sensitivity,
    redacted: f.redacted,
    agentId: f.agentId,
    createdAt: f.createdAt,
  };
}

export function serializePack(p: ContextPack): Record<string, unknown> {
  return {
    id: p.id,
    runId: p.runId,
    name: p.name,
    fragmentIds: p.fragmentIds ?? null,
    totalTokens: p.totalTokens,
    strategy: p.strategy,
    summary: p.summary,
    createdAt: p.createdAt,
  };
}

export function serializeMemory(m: WorkingMemory): Record<string, unknown> {
  return {
    id: m.id,
    runId: m.runId,
    agentId: m.agentId,
    type: m.type,
    key: m.key,
    value: m.value,
    sensitivity: m.sensitivity,
    tags: m.tags ?? null,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt ?? null,
  };
}

export function serializeEvent(e: EventLog): Record<string, unknown> {
  return {
    id: e.id,
    runId: e.runId,
    type: e.type,
    level: e.level,
    message: e.message,
    data: j(e.dataJson),
    agentId: e.agentId,
    agentRunId: e.agentRunId,
    createdAt: e.createdAt,
  };
}

export function serializeAudit(a: AuditRecord): Record<string, unknown> {
  return {
    id: a.id,
    runId: a.runId,
    actorType: a.actorType,
    actorId: a.actorId,
    action: a.action,
    resourceType: a.resourceType,
    resourceId: a.resourceId,
    summary: a.summary,
    riskTier: a.riskTier,
    createdAt: a.createdAt,
  };
}

export function serializeAgent(
  a: Agent,
  modelPolicy?: AgentModelPolicy | null,
): Record<string, unknown> {
  return {
    id: a.id,
    name: a.name,
    role: a.role,
    description: a.description,
    systemPrompt: a.systemPrompt,
    capabilityScope: a.capabilityScope ?? null,
    contextPolicy: a.contextPolicy,
    exposeAsCapabilityProvider: a.exposeAsCapabilityProvider,
    canBuildIntegrations: a.canBuildIntegrations,
    isActive: a.isActive,
    modelPolicy: modelPolicy ? serializeModelPolicy(modelPolicy) : undefined,
    createdAt: a.createdAt,
  };
}

export function serializeModelPolicy(
  p: AgentModelPolicy,
): Record<string, unknown> {
  return {
    id: p.id,
    agentId: p.agentId,
    primaryEndpointId: p.primaryEndpointId,
    fallbackEndpointId: p.fallbackEndpointId,
    temperature: p.temperature,
    maxTokens: p.maxTokens,
  };
}

export function serializeAgentRun(
  r: AgentRun,
  agentName?: string | null,
): Record<string, unknown> {
  return {
    id: r.id,
    runId: r.runId,
    agentId: r.agentId,
    agentName: agentName ?? null,
    parentAgentRunId: r.parentAgentRunId,
    role: r.role,
    status: r.status,
    task: r.task,
    output: j(r.outputJson),
    outputValid: r.outputValid,
    usedFallback: r.usedFallback,
    stubReason:
      (r.outputJson as { stubReason?: string } | null)?.stubReason ?? null,
    tokensUsed: r.tokensUsed,
    latencyMs: r.latencyMs,
    costUsdMicros: r.costUsdMicros,
    createdAt: r.createdAt,
  };
}

export function serializeAgentMessage(
  m: AgentMessage,
): Record<string, unknown> {
  return {
    id: m.id,
    runId: m.runId,
    fromAgentId: m.fromAgentId,
    toAgentId: m.toAgentId,
    fromAgentRunId: m.fromAgentRunId,
    toAgentRunId: m.toAgentRunId,
    messageType: m.messageType,
    content: m.content,
    createdAt: m.createdAt,
  };
}
export function serializeConversation(
  c: Conversation,
  extra?: { agentName?: string | null; messageCount?: number; lastMessageAt?: Date | null },
): Record<string, unknown> {
  return {
    id: c.id,
    title: c.title,
    agentId: c.agentId,
    agentName: extra?.agentName ?? null,
    messageCount: extra?.messageCount ?? 0,
    lastMessageAt: extra?.lastMessageAt ?? null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}
export function serializeConversationMessage(
  m: ConversationMessage,
): Record<string, unknown> {
  return {
    id: m.id,
    conversationId: m.conversationId,
    role: m.role,
    content: m.content,
    usedStub: m.usedStub,
    runId: m.runId,
    metadata: j(m.metadataJson),
    createdAt: m.createdAt,
  };
}

function maskKey(raw: string | null): string | null {
  if (!raw) return null;
  const tail = raw.slice(-4);
  return `••••••••${tail}`;
}

export function serializeModelEndpoint(
  e: ModelEndpoint,
): Record<string, unknown> {
  return {
    id: e.id,
    name: e.name,
    providerType: e.providerType,
    baseUrl: e.baseUrl,
    host: e.host,
    port: e.port,
    modelName: e.modelName,
    apiKeyRef: e.apiKeyRef ? "stored" : null,
    apiKeyMasked: maskKey(e.apiKeyRef),
    organization: e.organization,
    deployment: e.deployment,
    requestTimeoutMs: e.requestTimeoutMs,
    maxRetries: e.maxRetries,
    isDefault: e.isDefault,
    status: e.status,
    lastTestedAt: e.lastTestedAt ?? null,
    lastTestResult: j(e.lastTestResultJson),
    createdAt: e.createdAt,
  };
}

export function serializeDeploymentTarget(
  d: DeploymentTarget,
): Record<string, unknown> {
  return {
    id: d.id,
    name: d.name,
    type: d.type,
    region: d.region,
    isDefault: d.isDefault,
    createdAt: d.createdAt,
  };
}

export function serializeTrace(t: Trace): Record<string, unknown> {
  return {
    id: t.id,
    name: t.name,
    rootType: t.rootType,
    runId: t.runId,
    status: t.status,
    riskTier: t.riskTier,
    initiatedBy: t.initiatedBy,
    totalTokens: t.totalTokens,
    totalCostUsdMicros: t.totalCostUsdMicros,
    durationMs: t.durationMs,
    observationCount: t.observationCount,
    startedAt: t.startedAt ?? null,
    endedAt: t.endedAt ?? null,
    createdAt: t.createdAt,
  };
}

export function serializeObservation(
  o: Observation,
  metric?: ObservationMetric | null,
): Record<string, unknown> {
  return {
    id: o.id,
    traceId: o.traceId,
    parentObservationId: o.parentObservationId,
    type: o.type,
    name: o.name,
    status: o.status,
    layer: o.layer,
    agentId: o.agentId,
    agentRunId: o.agentRunId,
    modelEndpointId: o.modelEndpointId,
    capabilityId: o.capabilityId,
    input: j(o.inputJson),
    output: j(o.outputJson),
    error: j(o.errorJson),
    sensitiveMasked: o.sensitiveMasked,
    metrics: metric
      ? {
          latencyMs: metric.latencyMs,
          promptTokens: metric.promptTokens,
          completionTokens: metric.completionTokens,
          totalTokens: metric.totalTokens,
          costUsdMicros: metric.costUsdMicros,
          timeToFirstTokenMs: metric.timeToFirstTokenMs,
          finishReason: metric.finishReason,
          usedStub: metric.usedStub,
        }
      : undefined,
    startedAt: o.startedAt ?? null,
    endedAt: o.endedAt ?? null,
    createdAt: o.createdAt,
  };
}

export function serializeEvaluation(
  e: EvaluationRecord,
): Record<string, unknown> {
  return {
    id: e.id,
    traceId: e.traceId,
    observationId: e.observationId,
    name: e.name,
    label: e.label,
    score: e.score,
    isReferenceExample: e.isReferenceExample,
    reviewNote: e.reviewNote,
    comparedTraceId: e.comparedTraceId,
    evaluatorType: e.evaluatorType,
    createdAt: e.createdAt,
  };
}

export function serializeUiView(v: UiView): Record<string, unknown> {
  return {
    id: v.id,
    name: v.name,
    scope: v.scope,
    filters: j(v.filtersJson),
    isPinned: v.isPinned,
    createdAt: v.createdAt,
  };
}

export function serializeTelemetryExport(
  t: TelemetryExport,
): Record<string, unknown> {
  return {
    id: t.id,
    name: t.name,
    format: t.format,
    endpoint: t.endpoint,
    enabled: t.enabled,
    lastExportedAt: t.lastExportedAt ?? null,
    createdAt: t.createdAt,
  };
}
