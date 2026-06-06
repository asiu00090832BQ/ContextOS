import { eq, and, or, asc, desc, isNull } from "drizzle-orm";
import {
  db,
  agentsTable,
  intentsTable,
  runsTable,
  adaptersTable,
  capabilitiesTable,
  workingMemoriesTable,
  modelEndpointsTable,
  agentModelPoliciesTable,
  type Adapter,
  type Agent,
  type Capability,
} from "@workspace/db";
import { parse as parseYaml } from "yaml";
import { executeRun } from "./runEngine";
import { discoverAdapter } from "./mcp";
import {
  executeNamedCapability,
  executeCapabilityRow,
  resolveNamedCapability,
  recordCapabilityTest,
  lastTestOf,
  listExecutableCapabilities,
  smokeTestImportedTools,
  retestServerTools,
} from "./capabilityExec";
import {
  openApiToTools,
  parseRecipe,
  safeFetch,
  type AuthType,
  type ExecutionResult,
  type HttpRecipe,
} from "./webTools";
import { putSecret, resolveEndpointApiKey } from "./secretStore";
import { BOT_AGENT_NAME } from "./context";

type RiskTier = "L1" | "L2" | "L3" | "L4";
type OrchestrationMode = "static_graph" | "dynamic_delegation";

const AGENT_ROLES = new Set<string>([
  "lead",
  "specialist",
  "verifier",
  "executor",
  "summarizer",
  "router",
  "memory_manager",
]);
const CONTEXT_POLICIES = new Set<string>([
  "isolated",
  "shared_summary",
  "shared_readonly",
  "shared_full",
  "brokered",
]);

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
 * Who is invoking a tool. The ContextOS bot (`kind: "bot"`) is restricted to
 * orchestration + its own memory on EVERY surface (Telegram, web Chat, /mcp):
 * it can never execute work itself, only command agents via intents. Agents
 * running inside a run (`kind: "agent"`, or an undefined caller) get the full
 * tool catalog, including action/constructed tools.
 */
export type ToolCaller =
  | { kind: "bot"; agentId: string; telegramChatId?: string }
  | { kind: "agent"; agentId?: string };

/**
 * The only tools the ContextOS bot may call. Everything else (build/import/
 * register/test web tools, plus any constructed capability handled by the
 * `default` dispatch case) is blocked for the bot — it must create an intent
 * and command an agent instead.
 */
const BOT_ALLOWED_TOOLS = new Set<string>([
  "list_agents",
  "create_agent",
  "delete_agent",
  "list_intents",
  "create_intent",
  "run_intent",
  "run_command",
  "get_run",
  "list_runs",
  "list_adapters",
  "list_capabilities",
  "list_model_endpoints",
  "set_agent_model",
  "remember",
  "recall_memories",
]);

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
    name: "create_agent",
    description:
      "Create a new agent in this ContextOS tenant. Use this to spin up a specialist, verifier, executor, etc. Returns the new agent's id. After creating, you can assign it a model with set_agent_model.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Display name for the agent." },
        role: {
          type: "string",
          enum: [
            "lead",
            "specialist",
            "verifier",
            "executor",
            "summarizer",
            "router",
            "memory_manager",
          ],
          description: "The agent's role. Defaults to 'specialist'.",
        },
        description: {
          type: "string",
          description: "Short description of what this agent is for.",
        },
        systemPrompt: {
          type: "string",
          description: "System prompt that defines the agent's behavior.",
        },
        contextPolicy: {
          type: "string",
          enum: [
            "isolated",
            "shared_summary",
            "shared_readonly",
            "shared_full",
            "brokered",
          ],
          description:
            "How this agent shares context with others. Defaults to 'isolated'.",
        },
        exposeAsCapabilityProvider: {
          type: "boolean",
          description:
            "Whether other agents can call this agent as a capability. Defaults to false.",
        },
        canBuildIntegrations: {
          type: "boolean",
          description:
            "Whether this agent may build new MCP integrations. Defaults to false.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "delete_agent",
    description:
      "Permanently delete an agent from this ContextOS tenant by its id. Use list_agents first to find the agent's id. This also removes the agent's model policy, run participation and memories. The system ContextOS bot agent cannot be deleted.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: {
          type: "string",
          description: "The id of the agent to delete.",
        },
      },
      required: ["agentId"],
    },
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
    name: "list_model_endpoints",
    description:
      "List the LLM model endpoints configured in this workspace (e.g. OpenRouter, Anthropic), with each endpoint's id, provider, model and whether it is live (has a usable key). Use this to discover endpoint ids before assigning one with set_agent_model.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "set_agent_model",
    description:
      "Set which model endpoint an agent uses. Assigns a primary (and optional fallback) LLM endpoint to an agent so its chat replies and runs use that model. Agent and endpoint may be given by id or by name.",
    inputSchema: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          description: "Agent id or exact name to configure.",
        },
        endpoint: {
          type: "string",
          description: "Primary model endpoint id or exact name.",
        },
        fallback: {
          type: "string",
          description: "Optional fallback model endpoint id or name.",
        },
        temperature: {
          type: "number",
          description: "Sampling temperature 0..1 (default 0.7).",
        },
        maxTokens: {
          type: "number",
          description: "Max output tokens (default 2048).",
        },
      },
      required: ["agent", "endpoint"],
    },
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
  {
    name: "create_web_mcp_server",
    description:
      "Build a brand-new MCP for an ordinary website or REST/HTTP web service (one that is NOT already an MCP server). This creates an empty 'constructed' server with a base URL; afterwards add tools with add_web_mcp_tool or import_openapi_tools. Returns the new server's adapterId.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "A label for the service." },
        baseUrl: {
          type: "string",
          description:
            "The service's base URL that all tool paths are appended to, e.g. https://api.example.com/v1.",
        },
        description: { type: "string" },
        authType: {
          type: "string",
          enum: ["none", "bearer", "api_key_header", "query"],
          description:
            "How the service authenticates. Omit or 'none' for public services.",
        },
        authName: {
          type: "string",
          description:
            "Header name (for api_key_header) or query-param name (for query) carrying the credential.",
        },
        secret: {
          type: "string",
          description:
            "The API key / token. Stored in the secret store, never in the database. Only send when authType is not 'none'.",
        },
        allowPrivateNetwork: {
          type: "boolean",
          description:
            "Allow calls to private/internal addresses. Defaults to false; leave false for public internet services.",
        },
      },
      required: ["name", "baseUrl"],
    },
  },
  {
    name: "add_web_mcp_tool",
    description:
      "Add one callable HTTP tool to a constructed web MCP server (created via create_web_mcp_server). Define the request shape with a path template; {param} tokens in pathTemplate/query/headers/body are filled from the tool's arguments at call time.",
    inputSchema: {
      type: "object",
      properties: {
        adapterId: {
          type: "string",
          description: "The constructed server's id from create_web_mcp_server.",
        },
        name: {
          type: "string",
          description: "Unique tool name, e.g. get_weather.",
        },
        description: { type: "string" },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
        },
        pathTemplate: {
          type: "string",
          description:
            "Path appended to the server base URL, may contain {param} tokens, e.g. /users/{id}.",
        },
        query: {
          type: "object",
          description:
            "Query parameters; values may contain {param} tokens, e.g. { q: \"{city}\" }.",
        },
        headers: {
          type: "object",
          description: "Extra request headers; values may contain {param} tokens.",
        },
        body: {
          description:
            "Request body for non-GET methods. Use an object whose string leaves may contain {param} tokens (sent as JSON).",
        },
        inputSchema: {
          type: "object",
          description:
            "JSON Schema (object) describing the tool's arguments. Defaults to an empty object schema.",
        },
        actionKind: {
          type: "string",
          enum: ["read", "list", "create", "update", "destructive", "custom"],
        },
        riskTier: { type: "string", enum: ["L1", "L2", "L3", "L4"] },
      },
      required: ["adapterId", "name", "method", "pathTemplate"],
    },
  },
  {
    name: "import_openapi_tools",
    description:
      "Auto-generate callable tools for a web service from its OpenAPI / Swagger spec. Provide an existing adapterId, or a name to create a new constructed server in one step. Supply the spec via specUrl (fetched) or specText (inline JSON/YAML).",
    inputSchema: {
      type: "object",
      properties: {
        adapterId: {
          type: "string",
          description:
            "Existing constructed server id. Omit to create a new server (then `name` is required).",
        },
        name: {
          type: "string",
          description: "Label for the new server when adapterId is omitted.",
        },
        specUrl: {
          type: "string",
          description: "URL of the OpenAPI/Swagger document to fetch.",
        },
        specText: {
          type: "string",
          description: "Inline OpenAPI/Swagger document (JSON or YAML).",
        },
        baseUrl: {
          type: "string",
          description:
            "Override base URL for the tools. Defaults to the spec's server URL.",
        },
        replaceExisting: {
          type: "boolean",
          description:
            "Replace the server's current tools instead of adding to them.",
        },
      },
      required: [],
    },
  },
  {
    name: "test_web_tool",
    description:
      "Dry-run a just-created web tool (a constructed capability from add_web_mcp_tool / import_openapi_tools) with sample arguments to confirm it works BEFORE relying on it in an answer. Unlike calling the tool directly, this never aborts the conversation on failure — it returns the live HTTP status, body, and error so you can fix a wrong path template, query, header, or auth and try again. Use it right after building a tool.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The constructed tool's name to test.",
        },
        args: {
          type: "object",
          description:
            "Sample arguments to invoke the tool with (matching its inputSchema). Defaults to an empty object.",
        },
        adapterId: {
          type: "string",
          description:
            "Optional constructed server id to disambiguate when several tools share the same name. Omit to test the first matching tool.",
        },
        force: {
          type: "boolean",
          description:
            "Re-run the test even when the tool was already verified working. By default a known-good tool is not re-tested and its stored result is returned.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "retest_web_server",
    description:
      "Re-test a whole constructed web server by dry-running EVERY safe read/list tool on it (not just one), reusing the same safety gate as the post-import smoke test. Use this after you change a server's base URL or credentials to re-verify its health. Returns a per-tool ok/fail + error summary and never invokes create/update/destructive tools (those are skipped, not called).",
    inputSchema: {
      type: "object",
      properties: {
        adapterId: {
          type: "string",
          description: "The constructed server's id to re-test.",
        },
      },
      required: ["adapterId"],
    },
  },
  {
    name: "remember",
    description:
      "Save a durable, long-term memory — an operational rule, a standing preference, or a larger ongoing task — that must survive beyond the rolling 48-hour Telegram chat window. Use this whenever the user states a standing instruction or a big task to keep working on. Saved memories are automatically reloaded into your context on every future message.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description:
            "Short stable label for the memory, e.g. 'tone' or 'project-x-goal'.",
        },
        value: {
          type: "string",
          description: "The full content to remember.",
        },
        kind: {
          type: "string",
          enum: ["semantic", "procedural", "episodic"],
          description:
            "semantic = facts/rules/preferences; procedural = how-to / operational rules; episodic = notable events or larger tasks. Defaults to semantic.",
        },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "recall_memories",
    description:
      "List your saved long-term memories (operational rules, preferences, larger tasks). They are also injected automatically each message, but use this to review or confirm exactly what is stored.",
    inputSchema: { type: "object", properties: {} },
  },
];

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Load a constructed adapter scoped to the tenant, or undefined. Only matches
 * transport="constructed" servers so the web-builder tools can never mutate a
 * registered real MCP server. */
async function loadConstructedAdapter(tenantId: string, id: string) {
  const [adapter] = await db
    .select()
    .from(adaptersTable)
    .where(
      and(
        eq(adaptersTable.id, id),
        eq(adaptersTable.tenantId, tenantId),
        eq(adaptersTable.transport, "constructed"),
      ),
    );
  return adapter;
}

export class McpToolError extends Error {}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve an agent by id (when the ref is a UUID) or by exact name. */
async function resolveAgentRef(
  tenantId: string,
  ref: string,
): Promise<Agent | null> {
  if (UUID_RE.test(ref)) {
    const [byId] = await db
      .select()
      .from(agentsTable)
      .where(and(eq(agentsTable.id, ref), eq(agentsTable.tenantId, tenantId)));
    if (byId) return byId;
  }
  const [byName] = await db
    .select()
    .from(agentsTable)
    .where(and(eq(agentsTable.name, ref), eq(agentsTable.tenantId, tenantId)));
  return byName ?? null;
}

/** Resolve a model endpoint by id (when the ref is a UUID) or by exact name. */
async function resolveEndpointRef(
  tenantId: string,
  ref: string,
): Promise<{ id: string; name: string } | null> {
  if (UUID_RE.test(ref)) {
    const [byId] = await db
      .select({ id: modelEndpointsTable.id, name: modelEndpointsTable.name })
      .from(modelEndpointsTable)
      .where(
        and(
          eq(modelEndpointsTable.id, ref),
          eq(modelEndpointsTable.tenantId, tenantId),
        ),
      );
    if (byId) return byId;
  }
  const [byName] = await db
    .select({ id: modelEndpointsTable.id, name: modelEndpointsTable.name })
    .from(modelEndpointsTable)
    .where(
      and(
        eq(modelEndpointsTable.name, ref),
        eq(modelEndpointsTable.tenantId, tenantId),
      ),
    );
  return byName ?? null;
}

/**
 * Execute a single tool by name. All reads/writes are scoped to `tenantId`.
 * Returns a JSON-serializable result that the caller wraps as tool output.
 */
export async function callTool(
  tenantId: string,
  userId: string,
  name: string,
  args: Record<string, unknown>,
  caller?: ToolCaller,
): Promise<unknown> {
  if (caller?.kind === "bot" && !BOT_ALLOWED_TOOLS.has(name)) {
    throw new McpToolError(
      `The ContextOS bot can't run "${name}" itself — it only commands agents. ` +
        `Create an intent and start a run (create_intent / run_command / run_intent), ` +
        `and an agent will perform this action for you.`,
    );
  }
  // The bot's memory tools key off its agent id; if it couldn't be resolved we
  // fail clearly instead of attempting an insert/select with an empty UUID.
  if (
    caller?.kind === "bot" &&
    !caller.agentId &&
    (name === "remember" || name === "recall_memories")
  ) {
    throw new McpToolError(
      "The ContextOS bot agent isn't available for this tenant, so bot memory is unavailable.",
    );
  }
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
    case "list_model_endpoints": {
      const rows = await db
        .select()
        .from(modelEndpointsTable)
        .where(eq(modelEndpointsTable.tenantId, tenantId))
        .orderBy(desc(modelEndpointsTable.createdAt));
      return {
        endpoints: rows.map((e) => {
          const managed = (e.apiKeyRef ?? "").startsWith("managed://");
          const live = managed || !!resolveEndpointApiKey(e);
          return {
            id: e.id,
            name: e.name,
            providerType: e.providerType,
            model: e.modelName,
            isDefault: e.isDefault,
            live,
          };
        }),
      };
    }
    case "set_agent_model": {
      const agentRef = asString(args.agent);
      const endpointRef = asString(args.endpoint);
      if (!agentRef) throw new McpToolError("`agent` is required.");
      if (!endpointRef) throw new McpToolError("`endpoint` is required.");
      const agent = await resolveAgentRef(tenantId, agentRef);
      if (!agent) throw new McpToolError(`Agent not found: ${agentRef}`);
      const primary = await resolveEndpointRef(tenantId, endpointRef);
      if (!primary)
        throw new McpToolError(`Model endpoint not found: ${endpointRef}`);
      let fallbackId: string | null = null;
      const fbRef = asString(args.fallback);
      if (fbRef) {
        const fb = await resolveEndpointRef(tenantId, fbRef);
        if (!fb)
          throw new McpToolError(`Fallback endpoint not found: ${fbRef}`);
        fallbackId = fb.id;
      }
      const temperature =
        typeof args.temperature === "number"
          ? Math.round(Math.max(0, Math.min(1, args.temperature)) * 100)
          : undefined;
      const maxTokens =
        typeof args.maxTokens === "number"
          ? Math.max(1, Math.round(args.maxTokens))
          : undefined;
      const [existing] = await db
        .select()
        .from(agentModelPoliciesTable)
        .where(
          and(
            eq(agentModelPoliciesTable.tenantId, tenantId),
            eq(agentModelPoliciesTable.agentId, agent.id),
          ),
        );
      const values = {
        tenantId,
        agentId: agent.id,
        primaryEndpointId: primary.id,
        fallbackEndpointId: fallbackId,
        ...(temperature !== undefined ? { temperature } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        updatedAt: new Date(),
      };
      const [row] = existing
        ? await db
            .update(agentModelPoliciesTable)
            .set(values)
            .where(eq(agentModelPoliciesTable.id, existing.id))
            .returning()
        : await db
            .insert(agentModelPoliciesTable)
            .values(values)
            .returning();
      return {
        agentId: agent.id,
        agentName: agent.name,
        primaryEndpointId: row.primaryEndpointId,
        primaryEndpointName: primary.name,
        fallbackEndpointId: row.fallbackEndpointId,
        temperature: row.temperature / 100,
        maxTokens: row.maxTokens,
      };
    }
    case "create_agent": {
      const agentName = asString(args.name);
      if (!agentName) throw new McpToolError("`name` is required.");
      const roleArg = asString(args.role) ?? "specialist";
      if (!AGENT_ROLES.has(roleArg)) {
        throw new McpToolError(
          `Invalid role "${roleArg}". Valid roles: ${[...AGENT_ROLES].join(", ")}.`,
        );
      }
      const policyArg = asString(args.contextPolicy) ?? "isolated";
      if (!CONTEXT_POLICIES.has(policyArg)) {
        throw new McpToolError(
          `Invalid contextPolicy "${policyArg}". Valid values: ${[...CONTEXT_POLICIES].join(", ")}.`,
        );
      }
      const [existing] = await db
        .select({ id: agentsTable.id })
        .from(agentsTable)
        .where(
          and(
            eq(agentsTable.tenantId, tenantId),
            eq(agentsTable.name, agentName),
          ),
        );
      if (existing) {
        throw new McpToolError(
          `An agent named "${agentName}" already exists in this tenant.`,
        );
      }
      const [row] = await db
        .insert(agentsTable)
        .values({
          tenantId,
          name: agentName,
          role: roleArg as Agent["role"],
          description: asString(args.description) ?? null,
          systemPrompt: asString(args.systemPrompt) ?? null,
          contextPolicy: policyArg as Agent["contextPolicy"],
          exposeAsCapabilityProvider:
            typeof args.exposeAsCapabilityProvider === "boolean"
              ? args.exposeAsCapabilityProvider
              : false,
          canBuildIntegrations:
            typeof args.canBuildIntegrations === "boolean"
              ? args.canBuildIntegrations
              : false,
        })
        .returning();
      return {
        agentId: row.id,
        name: row.name,
        role: row.role,
        contextPolicy: row.contextPolicy,
        isActive: row.isActive,
      };
    }
    case "delete_agent": {
      const agentId = asString(args.agentId);
      if (!agentId) throw new McpToolError("`agentId` is required.");
      const [target] = await db
        .select()
        .from(agentsTable)
        .where(
          and(eq(agentsTable.id, agentId), eq(agentsTable.tenantId, tenantId)),
        );
      if (!target) throw new McpToolError("Agent not found.");
      const isSystemBot =
        (target.metadataJson as { isSystemBot?: boolean } | null)
          ?.isSystemBot === true || target.name === BOT_AGENT_NAME;
      if (isSystemBot) {
        throw new McpToolError(
          `The system "${BOT_AGENT_NAME}" agent is the ContextOS concierge and cannot be deleted.`,
        );
      }
      // working_memories.agentId has no FK cascade, so clear the agent's
      // memories explicitly before removing the agent (keeps the delete
      // truthful and avoids orphaned rows). FK-linked rows (model policy,
      // run participation, shared-context grants) cascade automatically.
      await db
        .delete(workingMemoriesTable)
        .where(
          and(
            eq(workingMemoriesTable.tenantId, tenantId),
            eq(workingMemoriesTable.agentId, agentId),
          ),
        );
      await db
        .delete(agentsTable)
        .where(
          and(eq(agentsTable.id, agentId), eq(agentsTable.tenantId, tenantId)),
        );
      return { deleted: true, agentId, name: target.name };
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
          telegramChatId:
            caller?.kind === "bot" ? caller.telegramChatId ?? null : null,
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
          telegramChatId:
            caller?.kind === "bot" ? caller.telegramChatId ?? null : null,
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
          metadataJson: { createdVia: "agent" },
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
    case "create_web_mcp_server": {
      const label = asString(args.name);
      const baseUrl = asString(args.baseUrl);
      if (!label || !baseUrl) {
        throw new McpToolError("`name` and `baseUrl` are required.");
      }
      const authType = (asString(args.authType) ?? "none") as AuthType;
      if (!["none", "bearer", "api_key_header", "query"].includes(authType)) {
        throw new McpToolError(`Unsupported authType "${authType}".`);
      }
      const secret = asString(args.secret);
      const credentialRef =
        authType !== "none" && secret ? putSecret(secret) : null;
      const [adapter] = await db
        .insert(adaptersTable)
        .values({
          tenantId,
          name: label,
          description: asString(args.description) ?? null,
          transport: "constructed",
          endpointUrl: baseUrl,
          status: "active",
          protocolVersion: "constructed/1.0",
          credentialRef,
          metadataJson: {
            authType,
            authName: asString(args.authName) ?? null,
            allowPrivateNetwork: args.allowPrivateNetwork === true,
            createdVia: "agent",
          },
        })
        .returning();
      return {
        adapterId: adapter.id,
        name: adapter.name,
        baseUrl: adapter.endpointUrl,
        authType,
        next: "Add tools with add_web_mcp_tool or import_openapi_tools using this adapterId.",
      };
    }
    case "add_web_mcp_tool": {
      const adapterId = asString(args.adapterId);
      const toolName = asString(args.name);
      const method = asString(args.method);
      const pathTemplate = asString(args.pathTemplate);
      if (!adapterId || !toolName || !method || !pathTemplate) {
        throw new McpToolError(
          "`adapterId`, `name`, `method`, and `pathTemplate` are required.",
        );
      }
      const adapter = await loadConstructedAdapter(tenantId, adapterId);
      if (!adapter) {
        throw new McpToolError("Constructed server not found for that adapterId.");
      }
      const recipeInput: HttpRecipe = {
        kind: "http",
        method: method.toUpperCase() as HttpRecipe["method"],
        pathTemplate,
        ...(args.query && typeof args.query === "object"
          ? { query: args.query as Record<string, string> }
          : {}),
        ...(args.headers && typeof args.headers === "object"
          ? { headers: args.headers as Record<string, string> }
          : {}),
        ...(args.body !== undefined ? { body: args.body } : {}),
      };
      const recipe = parseRecipe(recipeInput);
      if (!recipe) {
        throw new McpToolError(
          "Invalid HTTP recipe. Provide a valid method and pathTemplate.",
        );
      }
      const inputSchema =
        args.inputSchema && typeof args.inputSchema === "object"
          ? (args.inputSchema as Record<string, unknown>)
          : { type: "object", properties: {} };
      const capValues = {
        type: "tool" as const,
        name: toolName,
        description: asString(args.description) ?? null,
        riskTier: (asString(args.riskTier) as RiskTier | undefined) ?? "L2",
        actionKind:
          (asString(args.actionKind) as
            | "read"
            | "list"
            | "create"
            | "update"
            | "destructive"
            | "custom"
            | undefined) ?? "custom",
        humanReviewRequired: false,
        inputSchemaJson: inputSchema,
        executionJson: recipe as unknown as Record<string, unknown>,
      };
      const [existing] = await db
        .select()
        .from(capabilitiesTable)
        .where(
          and(
            eq(capabilitiesTable.tenantId, tenantId),
            eq(capabilitiesTable.adapterId, adapter.id),
            eq(capabilitiesTable.name, toolName),
          ),
        );
      // Re-adding a tool with an existing name edits its recipe. That
      // invalidates any prior verification, so clear lastTestJson — the tool
      // shows unverified until the smoke test below (or a manual test)
      // re-verifies it. This also avoids duplicate same-named capabilities.
      const [cap] = existing
        ? await db
            .update(capabilitiesTable)
            .set({ ...capValues, lastTestJson: null })
            .where(eq(capabilitiesTable.id, existing.id))
            .returning()
        : await db
            .insert(capabilitiesTable)
            .values({ tenantId, adapterId: adapter.id, ...capValues })
            .returning();
      // Auto dry-run the new tool when it is a safe read/list operation so a
      // broken base URL/auth/recipe is caught now instead of on the first real
      // call. Reuses the shared smoke-test path + safe allowlist gate (read/list,
      // riskTier L1, GET/HEAD, !humanReviewRequired); create/update/destructive
      // tools are never auto-invoked. The outcome is recorded on the capability's
      // lastTest via recordCapabilityTest so the tool shows verified/failed right
      // away — the same check the UI single-tool route performs.
      const smokeTest = await smokeTestImportedTools(adapter, [cap]);
      const smokeTestHint = !smokeTest.ran
        ? "Not auto-tested (create/update/destructive or non-GET tool). Verify it manually with test_web_tool before relying on it."
        : smokeTest.ok
          ? `Auto dry-run of "${smokeTest.tool}" succeeded — the base URL and auth look correct.`
          : `Auto dry-run of "${smokeTest.tool}" FAILED (${smokeTest.error ?? `HTTP ${smokeTest.status}`}). Fix the base URL/auth/recipe and re-test before relying on this tool.`;
      return {
        capabilityId: cap.id,
        name: cap.name,
        adapterId: adapter.id,
        note: "This tool is now callable in this conversation.",
        smokeTest,
        smokeTestHint,
      };
    }
    case "import_openapi_tools": {
      let adapter = (await (async () => {
        const adapterId = asString(args.adapterId);
        return adapterId
          ? await loadConstructedAdapter(tenantId, adapterId)
          : undefined;
      })());
      if (asString(args.adapterId) && !adapter) {
        throw new McpToolError("Constructed server not found for that adapterId.");
      }
      const specUrl = asString(args.specUrl);
      const specTextArg = asString(args.specText);
      if (!specUrl && !specTextArg) {
        throw new McpToolError("Provide `specUrl` or `specText`.");
      }

      // Create a server up-front if none was supplied (one-step import).
      if (!adapter) {
        const label = asString(args.name);
        if (!label) {
          throw new McpToolError(
            "`name` is required when adapterId is omitted (to create the server).",
          );
        }
        const [created] = await db
          .insert(adaptersTable)
          .values({
            tenantId,
            name: label,
            transport: "constructed",
            endpointUrl: asString(args.baseUrl) ?? "",
            status: "active",
            protocolVersion: "constructed/1.0",
            metadataJson: {
              authType: "none",
              allowPrivateNetwork: false,
              createdVia: "agent",
            },
          })
          .returning();
        adapter = created;
      }

      const allowPrivate =
        (adapter.metadataJson as Record<string, unknown> | null)
          ?.allowPrivateNetwork === true;

      let specText = specTextArg ?? "";
      if (!specText && specUrl) {
        const r = await safeFetch(
          specUrl,
          {
            headers: { accept: "application/json, application/yaml, text/yaml" },
            timeoutMs: 20_000,
          },
          allowPrivate,
        );
        if (!r.ok) {
          throw new McpToolError(`Failed to fetch spec: HTTP ${r.status}`);
        }
        specText = await r.text();
      }

      let doc: Record<string, unknown>;
      try {
        doc =
          specText.trim().startsWith("{") || specText.trim().startsWith("[")
            ? JSON.parse(specText)
            : (parseYaml(specText) as Record<string, unknown>);
      } catch (err) {
        throw new McpToolError(
          `Could not parse spec: ${err instanceof Error ? err.message : "invalid format"}`,
        );
      }

      const parsedSpec = openApiToTools(doc);
      if (parsedSpec.tools.length === 0) {
        throw new McpToolError("No operations found in the provided spec.");
      }
      const baseUrl =
        asString(args.baseUrl) ?? parsedSpec.baseUrl ?? adapter.endpointUrl;

      if (args.replaceExisting === true) {
        await db
          .delete(capabilitiesTable)
          .where(eq(capabilitiesTable.adapterId, adapter.id));
      }
      const inserted = await db
        .insert(capabilitiesTable)
        .values(
          parsedSpec.tools.map((t) => ({
            tenantId,
            adapterId: adapter!.id,
            type: "tool" as const,
            name: t.name,
            description: t.description,
            riskTier: t.riskTier as RiskTier,
            actionKind: t.actionKind,
            humanReviewRequired: t.humanReviewRequired,
            inputSchemaJson: t.inputSchema,
            executionJson: t.recipe as unknown as Record<string, unknown>,
          })),
        )
        .returning();
      const [updatedAdapter] = await db
        .update(adaptersTable)
        .set({
          endpointUrl: baseUrl,
          protocolVersion: "constructed/1.0",
          lastDiscoveredAt: new Date(),
        })
        .where(eq(adaptersTable.id, adapter.id))
        .returning();

      // Auto dry-run a representative safe read/list tool so a broken import
      // (wrong base URL or auth) is caught now instead of on the first real
      // request. Reuses the same execution path as test_web_tool, never invokes
      // create/update/destructive tools, and never aborts the import on failure.
      const smokeTest = await smokeTestImportedTools(
        updatedAdapter ?? adapter,
        inserted,
      );
      const smokeTestHint = !smokeTest.ran
        ? "No safe read/list tool was available to auto-test; verify a tool manually with test_web_tool before relying on the import."
        : smokeTest.ok
          ? `Auto dry-run of "${smokeTest.tool}" succeeded — the base URL and auth look correct.`
          : `Auto dry-run of "${smokeTest.tool}" FAILED (${smokeTest.error ?? `HTTP ${smokeTest.status}`}). Fix the base URL/auth (re-run import_openapi_tools) and re-test before relying on these tools.`;

      // Persist the outcome so the ContextOS web UI can surface import health on
      // the constructed-server detail view (read-only display; no re-execution).
      const existingMeta =
        ((updatedAdapter ?? adapter).metadataJson as Record<
          string,
          unknown
        > | null) ?? {};
      await db
        .update(adaptersTable)
        .set({
          metadataJson: {
            ...existingMeta,
            lastImportSmokeTest: {
              ...smokeTest,
              hint: smokeTestHint,
              ranAt: new Date().toISOString(),
            },
          },
        })
        .where(eq(adaptersTable.id, adapter.id));

      return {
        adapterId: adapter.id,
        baseUrl,
        sourceTitle: parsedSpec.title,
        toolsCreated: inserted.length,
        tools: inserted.slice(0, 50).map((c) => ({
          name: c.name,
          actionKind: c.actionKind,
          riskTier: c.riskTier,
          description: c.description,
        })),
        smokeTest,
        smokeTestHint,
      };
    }
    case "test_web_tool": {
      const toolName = asString(args.name);
      if (!toolName) throw new McpToolError("`name` is required.");
      const sampleArgs =
        args.args && typeof args.args === "object" && !Array.isArray(args.args)
          ? (args.args as Record<string, unknown>)
          : {};
      const adapterId = asString(args.adapterId);
      const force = args.force === true;
      let capability: Capability;
      let adapter: Adapter;
      if (adapterId) {
        const found = await loadConstructedAdapter(tenantId, adapterId);
        if (!found) {
          throw new McpToolError(
            "Constructed server not found for that adapterId.",
          );
        }
        adapter = found;
        const [cap] = await db
          .select()
          .from(capabilitiesTable)
          .where(
            and(
              eq(capabilitiesTable.tenantId, tenantId),
              eq(capabilitiesTable.adapterId, adapter.id),
              eq(capabilitiesTable.name, toolName),
            ),
          )
          .orderBy(asc(capabilitiesTable.createdAt), asc(capabilitiesTable.id));
        if (!cap) {
          throw new McpToolError(
            `No tool named "${toolName}" on that constructed server.`,
          );
        }
        capability = cap;
      } else {
        const resolved = await resolveNamedCapability(tenantId, toolName);
        if (!resolved) {
          throw new McpToolError(
            `No executable web tool named "${toolName}" found. Build it first with add_web_mcp_tool or import_openapi_tools.`,
          );
        }
        capability = resolved.capability;
        adapter = resolved.adapter;
      }

      // Skip re-testing a tool already verified working (unless force=true), so
      // the bot can rely on a known-good tool without spending another request.
      const prior = lastTestOf(capability);
      if (!force && prior?.ok) {
        return {
          tested: toolName,
          ok: true,
          status: prior.status,
          skipped: true,
          lastTestedAt: prior.testedAt,
          error: null,
          hint: "Already verified working on the last test; skipped re-testing. Pass force=true to test again.",
        };
      }

      const result = await executeCapabilityRow(
        capability,
        adapter,
        sampleArgs,
      );
      // Persist the outcome so it can be reused and surfaced later.
      const record = await recordCapabilityTest(capability.id, result);
      // Intentionally do NOT throw on failure: the whole point is to surface a
      // bad result so the agent can self-correct in the same conversation.
      return {
        tested: toolName,
        ok: result.ok,
        status: result.status ?? null,
        durationMs: result.durationMs,
        extracted: result.extracted ?? null,
        body: result.body ?? null,
        error: result.error ?? null,
        lastTestedAt: record.testedAt,
        hint: result.ok
          ? "The tool works; you can rely on it in your answer now."
          : "The tool failed. Fix the path/query/headers/auth (re-run add_web_mcp_tool or import_openapi_tools) and test_web_tool again before relying on it.",
      };
    }
    case "retest_web_server": {
      const adapterId = asString(args.adapterId);
      if (!adapterId) throw new McpToolError("`adapterId` is required.");
      const adapter = await loadConstructedAdapter(tenantId, adapterId);
      if (!adapter) {
        throw new McpToolError(
          "Constructed server not found for that adapterId.",
        );
      }
      const caps = await db
        .select()
        .from(capabilitiesTable)
        .where(
          and(
            eq(capabilitiesTable.tenantId, tenantId),
            eq(capabilitiesTable.adapterId, adapter.id),
          ),
        );
      const outcome = await retestServerTools(adapter, caps);
      return {
        adapterId: adapter.id,
        ...outcome,
        hint:
          outcome.ran === 0
            ? "No safe read/list tool was available to dry-run; mutating tools are never auto-invoked."
            : outcome.failed === 0
              ? `All ${outcome.ran} safe tools responded correctly — the base URL and auth look right.`
              : `${outcome.failed} of ${outcome.ran} tools FAILED. Fix the base URL/auth and re-test before relying on this server.`,
      };
    }
    case "remember": {
      const key = asString(args.key);
      const value = asString(args.value);
      if (!key || !value) {
        throw new McpToolError("`key` and `value` are required.");
      }
      const kind = asString(args.kind);
      const type: "semantic" | "procedural" | "episodic" =
        kind === "procedural"
          ? "procedural"
          : kind === "episodic"
            ? "episodic"
            : "semantic";
      const [row] = await db
        .insert(workingMemoriesTable)
        .values({
          tenantId,
          agentId: caller?.kind === "bot" ? caller.agentId : null,
          type,
          key,
          value,
          tags: ["long_term"],
          metadataJson: {
            source: caller?.kind === "bot" ? "contextos_bot" : "agent",
            savedBy: userId || null,
          },
        })
        .returning();
      return { remembered: true, id: row.id, key, type };
    }
    case "recall_memories": {
      let rows;
      if (caller?.kind === "bot") {
        const [bot] = await db
          .select({ policy: agentsTable.contextPolicy })
          .from(agentsTable)
          .where(eq(agentsTable.id, caller.agentId));
        rows = await loadOwnedLongTermMemories(
          tenantId,
          caller.agentId,
          (bot?.policy ?? "isolated") !== "isolated",
        );
      } else {
        rows = await db
          .select()
          .from(workingMemoriesTable)
          .where(
            and(
              eq(workingMemoriesTable.tenantId, tenantId),
              isNull(workingMemoriesTable.runId),
            ),
          )
          .orderBy(desc(workingMemoriesTable.createdAt));
      }
      return {
        memories: rows.map((m) => ({
          id: m.id,
          key: m.key,
          value: m.value,
          type: m.type,
          createdAt: m.createdAt,
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
 * Resolve the reserved "ContextOS Bot" agent id for a tenant. The /mcp surface
 * is treated as the bot, so external clients get the same command-only
 * restriction and memory partition. Returns null if no bot agent exists.
 */
export async function getBotAgentId(tenantId: string): Promise<string | null> {
  const [bot] = await db
    .select({ id: agentsTable.id })
    .from(agentsTable)
    .where(
      and(
        eq(agentsTable.tenantId, tenantId),
        eq(agentsTable.name, "ContextOS Bot"),
      ),
    )
    .limit(1);
  return bot?.id ?? null;
}

/**
 * Load an agent's OWN durable long-term memories (runId IS NULL). When
 * `includeShared` is true (the agent's context policy is not "isolated") the
 * tenant-shared pool (agentId IS NULL) is merged in too. This is the single
 * source of truth for the bot's memory partition, reused by `recall_memories`
 * and the Telegram/web long-term injection block.
 */
export async function loadOwnedLongTermMemories(
  tenantId: string,
  agentId: string,
  includeShared: boolean,
  limit = 50,
): Promise<(typeof workingMemoriesTable.$inferSelect)[]> {
  const ownership = includeShared
    ? or(
        eq(workingMemoriesTable.agentId, agentId),
        isNull(workingMemoriesTable.agentId),
      )
    : eq(workingMemoriesTable.agentId, agentId);
  return db
    .select()
    .from(workingMemoriesTable)
    .where(
      and(
        eq(workingMemoriesTable.tenantId, tenantId),
        isNull(workingMemoriesTable.runId),
        ownership,
      ),
    )
    .orderBy(desc(workingMemoriesTable.createdAt))
    .limit(limit);
}

/**
 * The full tool catalog visible to an MCP client: the built-in ContextOS tools
 * plus every constructed (executable) capability registered in this tenant.
 * When the caller is the ContextOS bot, only orchestration + own-memory tools
 * are advertised — no action tools and no constructed capabilities.
 */
export async function listToolsForTenant(
  tenantId: string,
  caller?: ToolCaller,
): Promise<McpTool[]> {
  if (caller?.kind === "bot") {
    return TOOLS.filter((t) => BOT_ALLOWED_TOOLS.has(t.name));
  }
  const constructed = await listExecutableCapabilities(tenantId);
  const seen = new Set(TOOLS.map((t) => t.name));
  const dynamic: McpTool[] = [];
  // Dedupe by name (first occurrence wins, matching the deterministic dispatch
  // order in executeNamedCapability) so tools/list never advertises a tool name
  // that would dispatch ambiguously.
  for (const c of constructed) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    const base = c.description ?? `Constructed tool: ${c.name}`;
    // Surface the last verification outcome inline so the bot can prefer a
    // known-good tool and be warned about one whose last dry-run failed.
    const test = lastTestOf(c);
    let suffix = "";
    if (test?.ok) {
      suffix = " [verified working — no need to re-test]";
    } else if (test && !test.ok) {
      suffix = ` [last test FAILED${
        test.status ? ` (status ${test.status})` : ""
      } — re-test with test_web_tool before relying on it]`;
    }
    dynamic.push({
      name: c.name,
      description: `${base}${suffix}`,
      inputSchema: toJsonSchema(c.inputSchemaJson),
    });
  }
  return [...TOOLS, ...dynamic];
}
