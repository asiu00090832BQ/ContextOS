import type { InferInsertModel } from "drizzle-orm";
import { capabilitiesTable } from "@workspace/db";
import type { ToolMediaBlock } from "./toolChat";

type CapabilitySeed = Omit<
  InferInsertModel<typeof capabilitiesTable>,
  "tenantId" | "adapterId"
>;

/**
 * Demo MCP adapter client. Simulates discovery + health checks against a demo
 * transport without requiring a live MCP server. Returns deterministic
 * capability catalogs keyed by the adapter name.
 */

const DEMO_CATALOGS: Record<string, CapabilitySeed[]> = {
  default: [
    {
      type: "tool",
      name: "search_documents",
      description: "Full-text search across the connected knowledge base.",
      riskTier: "L1",
      actionKind: "read",
      humanReviewRequired: false,
      inputSchemaJson: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      outputSchemaJson: {
        type: "object",
        properties: { results: { type: "array" } },
      },
    },
    {
      type: "tool",
      name: "create_record",
      description: "Create a new record in the external system.",
      riskTier: "L3",
      actionKind: "create",
      humanReviewRequired: true,
      inputSchemaJson: {
        type: "object",
        properties: { payload: { type: "object" } },
        required: ["payload"],
      },
    },
    {
      type: "resource",
      name: "account_profile",
      description: "Read-only profile resource for the linked account.",
      riskTier: "L1",
      actionKind: "read",
      humanReviewRequired: false,
    },
    {
      type: "prompt",
      name: "summarize_thread",
      description: "Prompt template that summarizes a conversation thread.",
      riskTier: "L1",
      actionKind: "read",
      humanReviewRequired: false,
    },
  ],
};

export interface DiscoveryResult {
  protocolVersion: string;
  capabilities: CapabilitySeed[];
  serverInfo: Record<string, unknown>;
}

const PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcResult {
  json: { result?: Record<string, unknown>; error?: { message?: string } } | null;
  sessionId: string | null;
}

/**
 * Extract the last JSON-RPC payload from an SSE stream body. MCP servers may
 * answer a POST with `text/event-stream`; each event carries a `data:` line.
 */
function parseSse(text: string): JsonRpcResult["json"] {
  let last: JsonRpcResult["json"] = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      last = JSON.parse(payload);
    } catch {
      // Ignore non-JSON data frames (e.g. keep-alives).
    }
  }
  return last;
}

/** Perform one JSON-RPC call against an MCP HTTP (streamable_http) endpoint. */
async function mcpRpc(
  url: string,
  payload: Record<string, unknown>,
  sessionId: string | null,
): Promise<JsonRpcResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  const nextSession = res.headers.get("mcp-session-id") ?? sessionId;
  if (!res.ok) {
    throw new Error(`MCP server responded with HTTP ${res.status}.`);
  }
  // Notifications / empty acknowledgements carry no body.
  if (res.status === 202 || res.status === 204) {
    return { json: null, sessionId: nextSession };
  }
  const contentType = res.headers.get("content-type") ?? "";
  const raw = await res.text();
  if (!raw.trim()) return { json: null, sessionId: nextSession };
  const json = contentType.includes("text/event-stream")
    ? parseSse(raw)
    : (JSON.parse(raw) as JsonRpcResult["json"]);
  return { json, sessionId: nextSession };
}

function mapToolToCapability(tool: Record<string, unknown>): CapabilitySeed {
  const annotations =
    (tool.annotations as Record<string, unknown> | undefined) ?? undefined;
  const readOnly = annotations?.readOnlyHint === true;
  const destructive = annotations?.destructiveHint === true;
  return {
    type: "tool",
    name: String(tool.name ?? "unnamed_tool"),
    description:
      typeof tool.description === "string" ? tool.description : null,
    riskTier: destructive ? "L3" : readOnly ? "L1" : "L2",
    actionKind: destructive ? "destructive" : readOnly ? "read" : "custom",
    humanReviewRequired: destructive,
    inputSchemaJson:
      (tool.inputSchema as Record<string, unknown> | undefined) ?? null,
    annotationsJson: annotations ?? null,
  };
}

/**
 * Discover an adapter's capabilities. When `endpointUrl` is a reachable MCP
 * server it performs a real handshake (initialize → notifications/initialized →
 * tools/list) and maps the returned tools to capabilities. If the endpoint is
 * missing or the handshake fails, it falls back to the deterministic demo
 * catalog so the platform stays usable offline.
 */
export async function discoverAdapter(
  adapterName: string,
  endpointUrl: string | null,
): Promise<DiscoveryResult> {
  if (endpointUrl) {
    try {
      const init = await mcpRpc(
        endpointUrl,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "contextos", version: "1.0.0" },
          },
        },
        null,
      );
      if (init.json?.error) {
        throw new Error(
          init.json.error.message ?? "MCP initialize returned an error.",
        );
      }
      const sessionId = init.sessionId;
      const negotiated =
        (init.json?.result?.protocolVersion as string | undefined) ??
        PROTOCOL_VERSION;
      const remoteInfo =
        (init.json?.result?.serverInfo as Record<string, unknown> | undefined) ??
        {};

      // Best-effort initialized notification; ignore any failure.
      try {
        await mcpRpc(
          endpointUrl,
          { jsonrpc: "2.0", method: "notifications/initialized" },
          sessionId,
        );
      } catch {
        // Some servers are stateless and don't need this; continue.
      }

      const listed = await mcpRpc(
        endpointUrl,
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        sessionId,
      );
      if (listed.json?.error) {
        throw new Error(
          listed.json.error.message ?? "MCP tools/list returned an error.",
        );
      }
      const tools = Array.isArray(listed.json?.result?.tools)
        ? (listed.json!.result!.tools as Record<string, unknown>[])
        : [];

      return {
        protocolVersion: negotiated,
        capabilities: tools.map(mapToolToCapability),
        serverInfo: {
          name: adapterName,
          transport: "streamable_http",
          endpoint: endpointUrl,
          mode: "live",
          remote: remoteInfo,
          discoveredAt: new Date().toISOString(),
        },
      };
    } catch (err) {
      // Unreachable / non-MCP endpoint: degrade to the demo catalog.
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: DEMO_CATALOGS.default,
        serverInfo: {
          name: adapterName,
          transport: "streamable_http",
          endpoint: endpointUrl,
          mode: "demo_fallback",
          error: err instanceof Error ? err.message : "Handshake failed.",
          discoveredAt: new Date().toISOString(),
        },
      };
    }
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: DEMO_CATALOGS.default,
    serverInfo: {
      name: adapterName,
      transport: "demo",
      endpoint: "demo://local",
      mode: "demo",
      discoveredAt: new Date().toISOString(),
    },
  };
}

export interface HealthResult {
  healthy: boolean;
  latencyMs: number;
  protocolVersion: string;
  checkedAt: string;
  detail: string;
}

export async function healthCheckAdapter(
  adapterName: string,
): Promise<HealthResult> {
  return {
    healthy: true,
    latencyMs: 20 + (adapterName.length % 30),
    protocolVersion: "2025-06-18",
    checkedAt: new Date().toISOString(),
    detail: "Demo transport reachable; handshake succeeded.",
  };
}

/** Parsed outcome of an MCP `tools/call`, split into text and media blocks. */
export interface McpCallResult {
  isError: boolean;
  /** Concatenated text blocks plus a placeholder line per media block. */
  text: string;
  /** Image/audio content blocks, ready to forward to the model. */
  media: ToolMediaBlock[];
  /** `structuredContent` from the result, if the server returned any. */
  structured: unknown;
}

/**
 * Convert an MCP `tools/call` result object (`{ content: [...], isError?,
 * structuredContent? }`) into a `McpCallResult`. Text blocks are joined; image
 * and audio blocks become `media` entries (with a short placeholder added to the
 * text so text-only consumers still see that media was returned); embedded
 * resources surface their text. Falls back to a JSON dump when the server
 * returns an unrecognized shape.
 */
function parseMcpToolResult(result: Record<string, unknown>): McpCallResult {
  const blocks = Array.isArray(result.content)
    ? (result.content as Record<string, unknown>[])
    : [];
  const textParts: string[] = [];
  const media: ToolMediaBlock[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const type = block.type;
    if (type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    } else if (
      (type === "image" || type === "audio") &&
      typeof block.data === "string"
    ) {
      const mimeType =
        typeof block.mimeType === "string"
          ? block.mimeType
          : type === "image"
            ? "image/png"
            : "audio/mpeg";
      media.push({ kind: type, mimeType, data: block.data });
      const kb = Math.round(((block.data.length * 3) / 4 / 1024) * 10) / 10;
      textParts.push(
        `[${type} ${mimeType} (~${kb} KB) returned and provided to you as ${type} content]`,
      );
    } else if (type === "resource") {
      const resource = block.resource as Record<string, unknown> | undefined;
      if (resource && typeof resource.text === "string") {
        textParts.push(resource.text);
      } else if (resource && typeof resource.uri === "string") {
        textParts.push(`[resource ${resource.uri}]`);
      } else {
        textParts.push("[resource content omitted]");
      }
    }
  }
  const structured = result.structuredContent ?? null;
  if (textParts.length === 0 && media.length === 0 && structured == null) {
    textParts.push(JSON.stringify(result).slice(0, 2000));
  }
  return {
    isError: result.isError === true,
    text: textParts.join("\n"),
    media,
    structured,
  };
}

/**
 * Invoke a tool on a live external MCP server over streamable HTTP. Performs the
 * initialize → notifications/initialized → tools/call handshake (mirroring
 * `discoverAdapter`) and returns the result parsed into text + media blocks.
 * Throws on transport/protocol errors; tool-level failures are surfaced via
 * `McpCallResult.isError`.
 */
export async function callMcpTool(
  endpointUrl: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const init = await mcpRpc(
    endpointUrl,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "contextos", version: "1.0.0" },
      },
    },
    null,
  );
  if (init.json?.error) {
    throw new Error(init.json.error.message ?? "MCP initialize returned an error.");
  }
  const sessionId = init.sessionId;
  try {
    await mcpRpc(
      endpointUrl,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      sessionId,
    );
  } catch {
    // Stateless servers don't require the notification; continue.
  }
  const called = await mcpRpc(
    endpointUrl,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: toolName, arguments: args ?? {} },
    },
    sessionId,
  );
  if (called.json?.error) {
    throw new Error(
      called.json.error.message ?? `MCP tools/call for "${toolName}" failed.`,
    );
  }
  const result = (called.json?.result ?? {}) as Record<string, unknown>;
  return parseMcpToolResult(result);
}
