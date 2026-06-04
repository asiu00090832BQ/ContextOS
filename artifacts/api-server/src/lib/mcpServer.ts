import { eq, and, desc } from "drizzle-orm";
import {
  db,
  agentsTable,
  intentsTable,
  runsTable,
  adaptersTable,
  capabilitiesTable,
} from "@workspace/db";
import { executeRun } from "./runEngine";
import { discoverAdapter } from "./mcp";
import {
  executeNamedCapability,
  listExecutableCapabilities,
} from "./capabilityExec";

type RiskTier = "L1" | "L2" | "L3" | "L4";
type OrchestrationMode = "static_graph" | "dynamic_delegation";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_SERVER_INFO = {
  name: "contextos",
  title: "ContextOS",
  version: "1.0.0",
};

interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

/**
 * Tools exposed to any MCP-compatible AI client that connects with an API key.
 * These let an external agent operate ContextOS remotely and — via
 * `register_mcp_server` — teach itself to use brand-new online services by
 * registering and discovering their MCP servers on the fly.
 */
export const TOOLS: McpTool[] = [
  {
    name: "list_agents",
    description: "List the agents configured in this ContextOS tenant.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_intents",
    description: "List intents (goals) and their current status.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_intent",
    description: "Create a new intent (a goal for agents to pursue).",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title for the intent." },
        goal: { type: "string", description: "What should be accomplished." },
        constraints: { type: "string" },
        successCriteria: { type: "string" },
        riskTier: { type: "string", enum: ["L1", "L2", "L3", "L4"] },
      },
      required: ["goal"],
    },
  },
  {
    name: "run_intent",
    description: "Start a run for an existing intent.",
    inputSchema: {
      type: "object",
      properties: {
        intentId: { type: "string" },
        orchestrationMode: {
          type: "string",
          enum: ["static_graph", "dynamic_delegation"],
        },
        leadAgentId: { type: "string" },
      },
      required: ["intentId"],
    },
  },
  {
    name: "run_command",
    description:
      "Create an intent and immediately start a run for it in one call. The fastest way to make ContextOS do something.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "What should be accomplished." },
        title: { type: "string" },
        constraints: { type: "string" },
        successCriteria: { type: "string" },
        riskTier: { type: "string", enum: ["L1", "L2", "L3", "L4"] },
        orchestrationMode: {
          type: "string",
          enum: ["static_graph", "dynamic_delegation"],
        },
        leadAgentId: { type: "string" },
      },
      required: ["goal"],
    },
  },
  {
    name: "get_run",
    description: "Get the status and summary of a run by id.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
    },
  },
  {
    name: "list_runs",
    description: "List recent runs and their statuses.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_adapters",
    description: "List registered MCP adapters (connected external services).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_capabilities",
    description:
      "List the tools/resources/prompts discovered across all connected adapters.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "register_mcp_server",
    description:
      "Connect a brand-new online service by registering its MCP server URL, then auto-discover the tools/resources it exposes. Use this to teach ContextOS to interact with a service it has never used before.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "A label for the service." },
        endpointUrl: {
          type: "string",
          description: "The MCP server's HTTP endpoint URL.",
        },
        description: { type: "string" },
      },
      required: ["name", "endpointUrl"],
    },
  },
];

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export class McpToolError extends Error {}

/**
 * Execute a single tool by name. All reads/writes are scoped to `tenantId`.
 * Returns a JSON-serializable result that the caller wraps as tool output.
 */
export async function callTool(
  tenantId: string,
  userId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "list_agents": {
      const rows = await db
        .select()
        .from(agentsTable)
        .where(eq(agentsTable.tenantId, tenantId))
        .orderBy(desc(agentsTable.createdAt));
      return {
        agents: rows.map((a) => ({
          id: a.id,
          name: a.name,
          role: a.role,
          isActive: a.isActive,
          contextPolicy: a.contextPolicy,
        })),
      };
    }
    case "list_intents": {
      const rows = await db
        .select()
        .from(intentsTable)
        .where(eq(intentsTable.tenantId, tenantId))
        .orderBy(desc(intentsTable.createdAt));
      return {
        intents: rows.map((i) => ({
          id: i.id,
          title: i.title,
          goal: i.goal,
          status: i.status,
          riskTier: i.riskTier,
        })),
      };
    }
    case "create_intent": {
      const goal = asString(args.goal);
      if (!goal) throw new McpToolError("`goal` is required.");
      const [row] = await db
        .insert(intentsTable)
        .values({
          tenantId,
          title: asString(args.title) ?? goal.slice(0, 80),
          goal,
          constraints: asString(args.constraints) ?? null,
          successCriteria: asString(args.successCriteria) ?? null,
          riskTier: (asString(args.riskTier) as RiskTier) ?? "L2",
          createdBy: userId,
        })
        .returning();
      return { intentId: row.id, title: row.title, status: row.status };
    }
    case "run_intent": {
      const intentId = asString(args.intentId);
      if (!intentId) throw new McpToolError("`intentId` is required.");
      const [intent] = await db
        .select()
        .from(intentsTable)
        .where(
          and(eq(intentsTable.id, intentId), eq(intentsTable.tenantId, tenantId)),
        );
      if (!intent) throw new McpToolError("Intent not found.");
      const [run] = await db
        .insert(runsTable)
        .values({
          tenantId,
          intentId: intent.id,
          status: "pending",
          orchestrationMode:
            (asString(args.orchestrationMode) as OrchestrationMode) ??
            "static_graph",
          leadAgentId: asString(args.leadAgentId) ?? null,
        })
        .returning();
      void executeRun(tenantId, run.id);
      return { runId: run.id, status: run.status, intentId: intent.id };
    }
    case "run_command": {
      const goal = asString(args.goal);
      if (!goal) throw new McpToolError("`goal` is required.");
      const [intent] = await db
        .insert(intentsTable)
        .values({
          tenantId,
          title: asString(args.title) ?? goal.slice(0, 80),
          goal,
          constraints: asString(args.constraints) ?? null,
          successCriteria: asString(args.successCriteria) ?? null,
          riskTier: (asString(args.riskTier) as RiskTier) ?? "L2",
          createdBy: userId,
        })
        .returning();
      const [run] = await db
        .insert(runsTable)
        .values({
          tenantId,
          intentId: intent.id,
          status: "pending",
          orchestrationMode:
            (asString(args.orchestrationMode) as OrchestrationMode) ??
            "static_graph",
          leadAgentId: asString(args.leadAgentId) ?? null,
        })
        .returning();
      void executeRun(tenantId, run.id);
      return { intentId: intent.id, runId: run.id, status: run.status };
    }
    case "get_run": {
      const runId = asString(args.runId);
      if (!runId) throw new McpToolError("`runId` is required.");
      const [run] = await db
        .select()
        .from(runsTable)
        .where(and(eq(runsTable.id, runId), eq(runsTable.tenantId, tenantId)));
      if (!run) throw new McpToolError("Run not found.");
      return {
        id: run.id,
        intentId: run.intentId,
        status: run.status,
        summary: run.summary,
        orchestrationMode: run.orchestrationMode,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
      };
    }
    case "list_runs": {
      const rows = await db
        .select()
        .from(runsTable)
        .where(eq(runsTable.tenantId, tenantId))
        .orderBy(desc(runsTable.createdAt));
      return {
        runs: rows.map((r) => ({
          id: r.id,
          intentId: r.intentId,
          status: r.status,
          summary: r.summary,
        })),
      };
    }
    case "list_adapters": {
      const rows = await db
        .select()
        .from(adaptersTable)
        .where(eq(adaptersTable.tenantId, tenantId))
        .orderBy(desc(adaptersTable.createdAt));
      return {
        adapters: rows.map((a) => ({
          id: a.id,
          name: a.name,
          status: a.status,
          transport: a.transport,
          endpointUrl: a.endpointUrl,
        })),
      };
    }
    case "list_capabilities": {
      const rows = await db
        .select()
        .from(capabilitiesTable)
        .where(eq(capabilitiesTable.tenantId, tenantId))
        .orderBy(desc(capabilitiesTable.createdAt));
      return {
        capabilities: rows.map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          riskTier: c.riskTier,
          adapterId: c.adapterId,
          description: c.description,
        })),
      };
    }
    case "register_mcp_server": {
      const label = asString(args.name);
      const endpointUrl = asString(args.endpointUrl);
      if (!label || !endpointUrl) {
        throw new McpToolError("`name` and `endpointUrl` are required.");
      }
      const [adapter] = await db
        .insert(adaptersTable)
        .values({
          tenantId,
          name: label,
          description: asString(args.description) ?? null,
          transport: "streamable_http",
          endpointUrl,
        })
        .returning();
      const result = await discoverAdapter(adapter.name, adapter.endpointUrl);
      await db
        .delete(capabilitiesTable)
        .where(eq(capabilitiesTable.adapterId, adapter.id));
      const inserted = result.capabilities.length
        ? await db
            .insert(capabilitiesTable)
            .values(
              result.capabilities.map((c) => ({
                tenantId,
                adapterId: adapter.id,
                ...c,
              })),
            )
            .returning()
        : [];
      await db
        .update(adaptersTable)
        .set({
          status: "active",
          protocolVersion: result.protocolVersion,
          lastDiscoveredAt: new Date(),
        })
        .where(eq(adaptersTable.id, adapter.id));
      return {
        adapterId: adapter.id,
        status: "active",
        protocolVersion: result.protocolVersion,
        discoveryMode: result.serverInfo.mode ?? "unknown",
        capabilities: inserted.map((c) => ({
          name: c.name,
          type: c.type,
          riskTier: c.riskTier,
          description: c.description,
        })),
      };
    }
    default: {
      const result = await executeNamedCapability(tenantId, name, args);
      if (result === null) {
        throw new McpToolError(`Unknown tool: ${name}`);
      }
      if (!result.ok) {
        throw new McpToolError(
          result.error ?? `Tool "${name}" failed to execute.`,
        );
      }
      return {
        ok: true,
        status: result.status ?? null,
        durationMs: result.durationMs,
        extracted: result.extracted ?? null,
        body: result.body ?? null,
      };
    }
  }
}

function toJsonSchema(raw: unknown): JsonSchema {
  const obj = (raw as Record<string, unknown> | null) ?? {};
  const properties =
    (obj.properties as Record<string, unknown> | undefined) ?? {};
  const required = Array.isArray(obj.required)
    ? (obj.required as string[])
    : undefined;
  return { type: "object", properties, ...(required ? { required } : {}) };
}

/**
 * The full tool catalog visible to an MCP client: the built-in ContextOS tools
 * plus every constructed (executable) capability registered in this tenant.
 */
export async function listToolsForTenant(
  tenantId: string,
): Promise<McpTool[]> {
  const constructed = await listExecutableCapabilities(tenantId);
  const seen = new Set(TOOLS.map((t) => t.name));
  const dynamic: McpTool[] = [];
  // Dedupe by name (first occurrence wins, matching the deterministic dispatch
  // order in executeNamedCapability) so tools/list never advertises a tool name
  // that would dispatch ambiguously.
  for (const c of constructed) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    dynamic.push({
      name: c.name,
      description: c.description ?? `Constructed tool: ${c.name}`,
      inputSchema: toJsonSchema(c.inputSchemaJson),
    });
  }
  return [...TOOLS, ...dynamic];
}
