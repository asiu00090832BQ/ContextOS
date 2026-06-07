import { Router, type IRouter } from "express";
import {
  listToolsForTenant,
  callTool,
  getBotAgentId,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_INFO,
  type ToolCaller,
} from "../lib/mcpServer";
import { requireApiKey } from "../middlewares/tenant";

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcReply {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

const router: IRouter = Router();

// MCP is a remote-control surface: require an API key, not the owner session.
router.use("/mcp", requireApiKey);

function ok(id: string | number | null, result: unknown): JsonRpcReply {
  return { jsonrpc: "2.0", id, result };
}

function fail(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcReply {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// The /mcp surface is the ContextOS bot to external clients: it may only
// orchestrate (command agents) + manage its own memory, never execute work.
// Fail closed — if the bot agent can't be resolved we still mark the caller as
// a bot (with an empty id) so the command-only restriction always applies.
async function resolveBotCaller(tenantId: string): Promise<ToolCaller> {
  const agentId = (await getBotAgentId(tenantId)) ?? "";
  return { kind: "bot", agentId };
}

async function dispatch(
  tenantId: string,
  userId: string,
  msg: JsonRpcMessage,
): Promise<JsonRpcReply | null> {
  const id = msg.id ?? null;
  const method = msg.method;
  // Notifications have no id and expect no response (HTTP 202).
  if (!method || method.startsWith("notifications/")) return null;

  try {
    switch (method) {
      case "initialize":
        return ok(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: MCP_SERVER_INFO,
        });
      case "ping":
        return ok(id, {});
      case "tools/list": {
        const caller = await resolveBotCaller(tenantId);
        return ok(id, { tools: await listToolsForTenant(tenantId, caller) });
      }
      case "tools/call": {
        const params = msg.params ?? {};
        const name = typeof params.name === "string" ? params.name : "";
        const args =
          (params.arguments as Record<string, unknown> | undefined) ?? {};
        try {
          const caller = await resolveBotCaller(tenantId);
          const result = await callTool(tenantId, userId, name, args, caller);
          // External MCP tool results are tagged `source: "external_mcp"` and may
          // carry image/audio content blocks (e.g. a screenshot). Re-emit those as
          // proper MCP content blocks so a downstream client receives viewable
          // media; every other result is serialized as text exactly as before.
          const r = result as {
            source?: unknown;
            content?: unknown;
            media?: unknown;
          };
          if (r && r.source === "external_mcp") {
            const blocks: Record<string, unknown>[] = [];
            if (typeof r.content === "string" && r.content.length > 0) {
              blocks.push({ type: "text", text: r.content });
            }
            if (Array.isArray(r.media)) {
              for (const m of r.media as {
                kind?: unknown;
                mimeType?: unknown;
                data?: unknown;
              }[]) {
                if (
                  m &&
                  (m.kind === "image" || m.kind === "audio") &&
                  typeof m.data === "string"
                ) {
                  blocks.push({
                    type: m.kind,
                    data: m.data,
                    mimeType:
                      typeof m.mimeType === "string"
                        ? m.mimeType
                        : m.kind === "image"
                          ? "image/png"
                          : "audio/mpeg",
                  });
                }
              }
            }
            if (blocks.length === 0) {
              blocks.push({ type: "text", text: JSON.stringify(result, null, 2) });
            }
            return ok(id, { content: blocks });
          }
          return ok(id, {
            content: [
              { type: "text", text: JSON.stringify(result, null, 2) },
            ],
          });
        } catch (err) {
          // Per MCP, tool execution failures are returned as a result with
          // isError rather than a protocol-level error.
          return ok(id, {
            content: [
              {
                type: "text",
                text:
                  err instanceof Error
                    ? err.message
                    : "Tool execution failed.",
              },
            ],
            isError: true,
          });
        }
      }
      default:
        return fail(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    return fail(
      id,
      -32603,
      err instanceof Error ? err.message : "Internal error",
    );
  }
}

/**
 * Stateless MCP server endpoint. External AI clients authenticate with an API
 * key (Authorization: Bearer ctxos_...) which `tenantContext` resolves before
 * this handler runs.
 */
router.post("/mcp", async (req, res): Promise<void> => {
  const body = req.body as JsonRpcMessage | JsonRpcMessage[];

  if (Array.isArray(body)) {
    const replies: JsonRpcReply[] = [];
    for (const msg of body) {
      const reply = await dispatch(req.tenantId, req.userId, msg);
      if (reply) replies.push(reply);
    }
    if (replies.length === 0) {
      res.sendStatus(202);
      return;
    }
    res.json(replies);
    return;
  }

  const reply = await dispatch(req.tenantId, req.userId, body);
  if (!reply) {
    res.sendStatus(202);
    return;
  }
  res.json(reply);
});

router.get("/mcp", (_req, res): void => {
  res
    .status(405)
    .json({ error: "Use POST to send MCP JSON-RPC 2.0 requests." });
});

export default router;
