import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import {
  db,
  agentsTable,
  agentModelPoliciesTable,
  modelEndpointsTable,
} from "@workspace/db";
import {
  ListAgentsResponse,
  CreateAgentBody,
  GetAgentParams,
  GetAgentResponse,
  UpdateAgentParams,
  UpdateAgentBody,
  UpdateAgentResponse,
  DeleteAgentParams,
  SetAgentModelPolicyParams,
  SetAgentModelPolicyBody,
  SetAgentModelPolicyResponse,
  ListModelEndpointsResponse,
  CreateModelEndpointBody,
  GetModelEndpointParams,
  GetModelEndpointResponse,
  UpdateModelEndpointParams,
  UpdateModelEndpointBody,
  UpdateModelEndpointResponse,
  DeleteModelEndpointParams,
  TestModelEndpointParams,
  TestModelEndpointResponse,
} from "@workspace/api-zod";
import {
  serializeAgent,
  serializeModelPolicy,
  serializeModelEndpoint,
} from "../lib/serialize";
import { testEndpoint } from "../lib/llm";
import { putSecret, deleteSecret, resolveSecret, isSecretRef } from "../lib/secretStore";

type AgentRole =
  | "lead"
  | "specialist"
  | "verifier"
  | "executor"
  | "summarizer"
  | "router"
  | "memory_manager";
type ContextPolicy =
  | "isolated"
  | "shared_summary"
  | "shared_readonly"
  | "shared_full"
  | "brokered";
type ProviderType =
  | "openai"
  | "anthropic"
  | "google"
  | "openrouter"
  | "azure_openai"
  | "openai_compatible";
type ModelEndpointStatus = "untested" | "active" | "error" | "disabled";

const router: IRouter = Router();

async function loadPolicy(agentId: string) {
  const [p] = await db
    .select()
    .from(agentModelPoliciesTable)
    .where(eq(agentModelPoliciesTable.agentId, agentId));
  return p ?? null;
}

router.get("/agents", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(agentsTable)
    .where(eq(agentsTable.tenantId, req.tenantId))
    .orderBy(desc(agentsTable.createdAt));
  res.json(ListAgentsResponse.parse(rows.map((a) => serializeAgent(a))));
});

router.post("/agents", async (req, res): Promise<void> => {
  const parsed = CreateAgentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(agentsTable)
    .values({
      tenantId: req.tenantId,
      name: parsed.data.name,
      role: parsed.data.role as AgentRole,
      description: parsed.data.description ?? null,
      systemPrompt: parsed.data.systemPrompt ?? null,
      capabilityScope: parsed.data.capabilityScope ?? null,
      contextPolicy: (parsed.data.contextPolicy as ContextPolicy) ?? "isolated",
      exposeAsCapabilityProvider: parsed.data.exposeAsCapabilityProvider ?? false,
    })
    .returning();
  res.status(201).json(GetAgentResponse.parse(serializeAgent(row)));
});

router.get("/agents/:id", async (req, res): Promise<void> => {
  const params = GetAgentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .select()
    .from(agentsTable)
    .where(and(eq(agentsTable.id, params.data.id), eq(agentsTable.tenantId, req.tenantId)));
  if (!row) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  res.json(GetAgentResponse.parse(serializeAgent(row, await loadPolicy(row.id))));
});

router.patch("/agents/:id", async (req, res): Promise<void> => {
  const params = UpdateAgentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateAgentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .update(agentsTable)
    .set({
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      ...(parsed.data.systemPrompt !== undefined ? { systemPrompt: parsed.data.systemPrompt } : {}),
      ...(parsed.data.capabilityScope !== undefined ? { capabilityScope: parsed.data.capabilityScope } : {}),
      ...(parsed.data.contextPolicy !== undefined ? { contextPolicy: parsed.data.contextPolicy as ContextPolicy } : {}),
      ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
      ...(parsed.data.exposeAsCapabilityProvider !== undefined
        ? { exposeAsCapabilityProvider: parsed.data.exposeAsCapabilityProvider }
        : {}),
    })
    .where(and(eq(agentsTable.id, params.data.id), eq(agentsTable.tenantId, req.tenantId)))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  res.json(UpdateAgentResponse.parse(serializeAgent(row, await loadPolicy(row.id))));
});

router.delete("/agents/:id", async (req, res): Promise<void> => {
  const params = DeleteAgentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .delete(agentsTable)
    .where(and(eq(agentsTable.id, params.data.id), eq(agentsTable.tenantId, req.tenantId)))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  res.sendStatus(204);
});

router.put("/agents/:id/model-policy", async (req, res): Promise<void> => {
  const params = SetAgentModelPolicyParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = SetAgentModelPolicyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [agent] = await db
    .select()
    .from(agentsTable)
    .where(and(eq(agentsTable.id, params.data.id), eq(agentsTable.tenantId, req.tenantId)));
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  const existing = await loadPolicy(agent.id);
  const values = {
    tenantId: req.tenantId,
    agentId: agent.id,
    primaryEndpointId: parsed.data.primaryEndpointId ?? null,
    fallbackEndpointId: parsed.data.fallbackEndpointId ?? null,
    temperature: parsed.data.temperature ?? 70,
    maxTokens: parsed.data.maxTokens ?? 2048,
  };
  const [row] = existing
    ? await db
        .update(agentModelPoliciesTable)
        .set(values)
        .where(eq(agentModelPoliciesTable.id, existing.id))
        .returning()
    : await db.insert(agentModelPoliciesTable).values(values).returning();
  res.json(SetAgentModelPolicyResponse.parse(serializeModelPolicy(row)));
});

// Model endpoints
router.get("/model-endpoints", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(modelEndpointsTable)
    .where(eq(modelEndpointsTable.tenantId, req.tenantId))
    .orderBy(desc(modelEndpointsTable.createdAt));
  res.json(ListModelEndpointsResponse.parse(rows.map(serializeModelEndpoint)));
});

router.post("/model-endpoints", async (req, res): Promise<void> => {
  const parsed = CreateModelEndpointBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const apiKeyRef = parsed.data.apiKey ? putSecret(parsed.data.apiKey) : null;
  let row;
  try {
    [row] = await db
      .insert(modelEndpointsTable)
      .values({
        tenantId: req.tenantId,
        name: parsed.data.name,
        providerType: parsed.data.providerType as ProviderType,
        baseUrl: parsed.data.baseUrl ?? null,
        host: parsed.data.host ?? null,
        port: parsed.data.port ?? null,
        modelName: parsed.data.modelName,
        apiKeyRef,
        organization: parsed.data.organization ?? null,
        deployment: parsed.data.deployment ?? null,
        requestTimeoutMs: parsed.data.requestTimeoutMs ?? undefined,
        maxRetries: parsed.data.maxRetries ?? undefined,
        isDefault: parsed.data.isDefault ?? false,
      })
      .returning();
  } catch (err) {
    // Compensate so we never orphan a stored secret when the row never persists.
    deleteSecret(apiKeyRef);
    throw err;
  }
  res.status(201).json(GetModelEndpointResponse.parse(serializeModelEndpoint(row)));
});

router.get("/model-endpoints/:id", async (req, res): Promise<void> => {
  const params = GetModelEndpointParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .select()
    .from(modelEndpointsTable)
    .where(and(eq(modelEndpointsTable.id, params.data.id), eq(modelEndpointsTable.tenantId, req.tenantId)));
  if (!row) {
    res.status(404).json({ error: "Model endpoint not found" });
    return;
  }
  res.json(GetModelEndpointResponse.parse(serializeModelEndpoint(row)));
});

router.patch("/model-endpoints/:id", async (req, res): Promise<void> => {
  const params = UpdateModelEndpointParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateModelEndpointBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [existing] = await db
    .select()
    .from(modelEndpointsTable)
    .where(and(eq(modelEndpointsTable.id, params.data.id), eq(modelEndpointsTable.tenantId, req.tenantId)));
  if (!existing) {
    res.status(404).json({ error: "Model endpoint not found" });
    return;
  }
  // Resolve the secret mutation, but defer destructive operations until the DB
  // update has committed so a failed write can never leave a dangling reference
  // (cleared/rotated secret missing) or an orphaned secret.
  let apiKeyRefUpdate: { apiKeyRef: string | null } | undefined;
  let createdRefForRollback: string | null = null;
  let secretToDeleteAfterCommit: string | null = null;
  if (parsed.data.apiKey !== undefined) {
    if (parsed.data.apiKey) {
      const reusedExistingRef = isSecretRef(existing.apiKeyRef);
      const ref = putSecret(parsed.data.apiKey, existing.apiKeyRef);
      if (!reusedExistingRef) createdRefForRollback = ref;
      apiKeyRefUpdate = { apiKeyRef: ref };
    } else {
      secretToDeleteAfterCommit = existing.apiKeyRef;
      apiKeyRefUpdate = { apiKeyRef: null };
    }
  }
  let row;
  try {
    [row] = await db
      .update(modelEndpointsTable)
      .set({
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.baseUrl !== undefined ? { baseUrl: parsed.data.baseUrl } : {}),
        ...(parsed.data.host !== undefined ? { host: parsed.data.host } : {}),
        ...(parsed.data.port !== undefined ? { port: parsed.data.port } : {}),
        ...(parsed.data.modelName !== undefined ? { modelName: parsed.data.modelName } : {}),
        ...(apiKeyRefUpdate ?? {}),
        ...(parsed.data.organization !== undefined ? { organization: parsed.data.organization } : {}),
        ...(parsed.data.deployment !== undefined ? { deployment: parsed.data.deployment } : {}),
        ...(parsed.data.requestTimeoutMs !== undefined ? { requestTimeoutMs: parsed.data.requestTimeoutMs } : {}),
        ...(parsed.data.maxRetries !== undefined ? { maxRetries: parsed.data.maxRetries } : {}),
        ...(parsed.data.isDefault !== undefined ? { isDefault: parsed.data.isDefault } : {}),
        ...(parsed.data.status !== undefined ? { status: parsed.data.status as ModelEndpointStatus } : {}),
      })
      .where(and(eq(modelEndpointsTable.id, params.data.id), eq(modelEndpointsTable.tenantId, req.tenantId)))
      .returning();
  } catch (err) {
    if (createdRefForRollback) deleteSecret(createdRefForRollback);
    throw err;
  }
  if (!row) {
    if (createdRefForRollback) deleteSecret(createdRefForRollback);
    res.status(404).json({ error: "Model endpoint not found" });
    return;
  }
  if (secretToDeleteAfterCommit) deleteSecret(secretToDeleteAfterCommit);
  res.json(UpdateModelEndpointResponse.parse(serializeModelEndpoint(row)));
});

router.delete("/model-endpoints/:id", async (req, res): Promise<void> => {
  const params = DeleteModelEndpointParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .delete(modelEndpointsTable)
    .where(and(eq(modelEndpointsTable.id, params.data.id), eq(modelEndpointsTable.tenantId, req.tenantId)))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Model endpoint not found" });
    return;
  }
  deleteSecret(row.apiKeyRef);
  res.sendStatus(204);
});

router.post("/model-endpoints/:id/test", async (req, res): Promise<void> => {
  const params = TestModelEndpointParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .select()
    .from(modelEndpointsTable)
    .where(and(eq(modelEndpointsTable.id, params.data.id), eq(modelEndpointsTable.tenantId, req.tenantId)));
  if (!row) {
    res.status(404).json({ error: "Model endpoint not found" });
    return;
  }
  const result = await testEndpoint(row, resolveSecret(row.apiKeyRef));
  const usedStub = result.mode !== "live";
  await db
    .update(modelEndpointsTable)
    .set({
      status: result.ok ? "active" : "error",
      lastTestedAt: new Date(),
      lastTestResultJson: { ...result },
    })
    .where(eq(modelEndpointsTable.id, row.id));
  res.json(
    TestModelEndpointResponse.parse({
      ok: result.ok,
      latencyMs: result.latencyMs,
      message: result.detail,
      model: row.modelName,
      usedStub,
    }),
  );
});

export default router;
