import Anthropic from "@anthropic-ai/sdk";
import { anthropic as managedAnthropic } from "@workspace/integrations-anthropic-ai";
import type { ModelEndpoint } from "@workspace/db";
import { logger } from "./logger";

/** Default model used when talking to the Replit-managed Anthropic integration. */
export const MANAGED_ANTHROPIC_MODEL = "claude-sonnet-4-6";
export const MANAGED_ANTHROPIC_LABEL = "Managed Anthropic (Claude Sonnet 4.6)";
/**
 * Sentinel `apiKeyRef` marking a model endpoint that should route through the
 * Replit-managed Anthropic integration (no API key of its own). Lets us expose
 * the managed model as a real, selectable endpoint row without special-casing
 * the default null path or touching the provider enum.
 */
export const MANAGED_ANTHROPIC_REF = "managed://replit-anthropic";

export interface ToolSpec {
  /** Real ContextOS tool name. */
  name: string;
  description: string;
  /** Full JSON schema for the tool input ({ type, properties, required }). */
  inputSchema: Record<string, unknown>;
}

export interface ToolChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ToolExecutionResult {
  content: string;
  isError: boolean;
}

export interface ToolChatOptions {
  /** Selected endpoint, or null to use the Replit-managed Anthropic integration. */
  endpoint: ModelEndpoint | null;
  /** API key for the endpoint (null for keyless / managed). */
  apiKey: string | null;
  system: string;
  history: ToolChatMessage[];
  tools: ToolSpec[];
  executeTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<ToolExecutionResult>;
  maxTokens: number;
  maxIterations: number;
  temperature?: number;
}

export interface ToolChatResult {
  text: string;
  modelLabel: string;
}

/** Tool names must match ^[a-zA-Z0-9_-]{1,64}$ for every provider we support. */
function sanitizeToolName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "tool";
}

interface PreparedTool extends ToolSpec {
  safe: string;
}

/** Build sanitized tool names + a map back to real ContextOS names. */
function prepareTools(tools: ToolSpec[]): {
  prepared: PreparedTool[];
  nameMap: Map<string, string>;
} {
  const nameMap = new Map<string, string>();
  const prepared: PreparedTool[] = [];
  for (const t of tools) {
    let safe = sanitizeToolName(t.name);
    // Disambiguate collisions with a numeric suffix, truncating the base so the
    // result always stays within the 64-char provider limit (a plain `+ "_"`
    // would loop forever once `safe` is already 64 chars long).
    if (nameMap.has(safe)) {
      let n = 2;
      let candidate: string;
      do {
        const suffix = `_${n}`;
        candidate = `${safe.slice(0, 64 - suffix.length)}${suffix}`;
        n += 1;
      } while (nameMap.has(candidate));
      safe = candidate;
    }
    nameMap.set(safe, t.name);
    prepared.push({ ...t, safe });
  }
  return { prepared, nameMap };
}

/**
 * Which provider "family" an endpoint belongs to. Anthropic and Google have
 * their own native tool-calling shapes; everything else speaks the OpenAI
 * chat-completions tools format.
 */
function providerFamily(
  providerType: string,
): "anthropic" | "google" | "openai" {
  if (providerType === "anthropic") return "anthropic";
  if (providerType === "google") return "google";
  return "openai";
}

function resolveBaseUrl(endpoint: ModelEndpoint, defaultBase: string): string {
  if (endpoint.baseUrl) return endpoint.baseUrl.replace(/\/+$/, "");
  if (endpoint.host) {
    const scheme = endpoint.port === 443 ? "https" : "http";
    const portPart = endpoint.port ? `:${endpoint.port}` : "";
    return `${scheme}://${endpoint.host}${portPart}`;
  }
  return defaultBase;
}

// ---------------------------------------------------------------------------
// Anthropic (messages API + native tool_use blocks)
// ---------------------------------------------------------------------------

async function runAnthropicToolChat(
  client: Anthropic,
  model: string,
  opts: ToolChatOptions,
  prepared: PreparedTool[],
  nameMap: Map<string, string>,
): Promise<string> {
  const messages: Anthropic.MessageParam[] = opts.history.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const tools: Anthropic.Tool[] = prepared.map((t) => ({
    name: t.safe,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));

  let replyText = "";
  for (let iter = 0; iter < opts.maxIterations; iter++) {
    const response = await client.messages.create({
      model,
      max_tokens: opts.maxTokens,
      system: opts.system,
      messages,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(tools.length > 0 ? { tools } : {}),
    });

    const textParts: string[] = [];
    const toolUses: Anthropic.ToolUseBlock[] = [];
    for (const block of response.content) {
      if (block.type === "text") textParts.push(block.text);
      else if (block.type === "tool_use") toolUses.push(block);
    }
    if (textParts.length > 0) replyText = textParts.join("\n").trim();

    if (response.stop_reason !== "tool_use" || toolUses.length === 0) break;

    messages.push({ role: "assistant", content: response.content });
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const realName = nameMap.get(use.name) ?? use.name;
      const args = (use.input as Record<string, unknown>) ?? {};
      const out = await opts.executeTool(realName, args);
      toolResults.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: out.content.slice(0, 20_000),
        ...(out.isError ? { is_error: true } : {}),
      });
    }
    messages.push({ role: "user", content: toolResults });
  }
  return replyText;
}

// ---------------------------------------------------------------------------
// OpenAI-compatible (chat/completions + tool_calls)
// ---------------------------------------------------------------------------

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
}

async function runOpenAiToolChat(
  base: string,
  apiKey: string | null,
  organization: string | null,
  model: string,
  timeoutMs: number,
  opts: ToolChatOptions,
  prepared: PreparedTool[],
  nameMap: Map<string, string>,
): Promise<string> {
  const url = `${base.replace(/\/$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (organization) headers["openai-organization"] = organization;

  const messages: OpenAiMessage[] = [
    { role: "system", content: opts.system },
    ...opts.history.map((m) => ({ role: m.role, content: m.content })),
  ];
  const tools = prepared.map((t) => ({
    type: "function" as const,
    function: {
      name: t.safe,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));

  let replyText = "";
  for (let iter = 0; iter < opts.maxIterations; iter++) {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages,
        max_tokens: opts.maxTokens,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`provider ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: OpenAiMessage }[];
    };
    const msg = data.choices?.[0]?.message;
    if (!msg) break;
    if (typeof msg.content === "string" && msg.content.trim()) {
      replyText = msg.content.trim();
    }
    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) break;

    messages.push({
      role: "assistant",
      content: msg.content ?? null,
      tool_calls: calls,
    });
    for (const call of calls) {
      const realName = nameMap.get(call.function.name) ?? call.function.name;
      let args: Record<string, unknown> = {};
      try {
        args = call.function.arguments
          ? (JSON.parse(call.function.arguments) as Record<string, unknown>)
          : {};
      } catch {
        args = {};
      }
      const out = await opts.executeTool(realName, args);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: out.content.slice(0, 20_000),
      });
    }
  }
  return replyText;
}

// ---------------------------------------------------------------------------
// Google Gemini (generateContent + functionCall / functionResponse)
// ---------------------------------------------------------------------------

interface GooglePart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}
interface GoogleContent {
  role: "user" | "model";
  parts: GooglePart[];
}

async function runGoogleToolChat(
  base: string,
  apiKey: string | null,
  model: string,
  timeoutMs: number,
  opts: ToolChatOptions,
  prepared: PreparedTool[],
  nameMap: Map<string, string>,
): Promise<string> {
  const url = `${base.replace(/\/$/, "")}/models/${model}:generateContent?key=${apiKey ?? ""}`;
  const contents: GoogleContent[] = opts.history.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const toolsDecl =
    prepared.length > 0
      ? [
          {
            functionDeclarations: prepared.map((t) => ({
              name: t.safe,
              description: t.description,
              parameters: t.inputSchema,
            })),
          },
        ]
      : undefined;

  let replyText = "";
  for (let iter = 0; iter < opts.maxIterations; iter++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents,
        systemInstruction: { parts: [{ text: opts.system }] },
        ...(toolsDecl ? { tools: toolsDecl } : {}),
        generationConfig: {
          maxOutputTokens: opts.maxTokens,
          ...(opts.temperature !== undefined
            ? { temperature: opts.temperature }
            : {}),
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`provider ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      candidates?: { content?: GoogleContent }[];
    };
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const textParts = parts
      .map((p) => p.text ?? "")
      .filter(Boolean)
      .join("\n")
      .trim();
    if (textParts) replyText = textParts;

    const calls = parts.filter((p) => p.functionCall);
    if (calls.length === 0) break;

    contents.push({ role: "model", parts });
    const responseParts: GooglePart[] = [];
    for (const part of calls) {
      const fc = part.functionCall;
      if (!fc) continue;
      const realName = nameMap.get(fc.name) ?? fc.name;
      const out = await opts.executeTool(realName, fc.args ?? {});
      responseParts.push({
        functionResponse: {
          name: fc.name,
          response: { result: out.content.slice(0, 20_000), isError: out.isError },
        },
      });
    }
    contents.push({ role: "user", parts: responseParts });
  }
  return replyText;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run an agentic tool-calling conversation against the selected model endpoint
 * (or the Replit-managed Anthropic integration when `endpoint` is null). Each
 * provider family uses its own native tool/function-calling protocol, so the
 * model can actually invoke the supplied ContextOS tools regardless of vendor.
 */
export async function runToolChat(
  opts: ToolChatOptions,
): Promise<ToolChatResult> {
  const { prepared, nameMap } = prepareTools(opts.tools);
  const { endpoint } = opts;

  // Managed Anthropic integration (no endpoint selected).
  if (!endpoint) {
    const text = await runAnthropicToolChat(
      managedAnthropic as unknown as Anthropic,
      MANAGED_ANTHROPIC_MODEL,
      opts,
      prepared,
      nameMap,
    );
    return { text, modelLabel: MANAGED_ANTHROPIC_LABEL };
  }

  // A real endpoint row explicitly marked as managed (its apiKeyRef is the
  // managed sentinel) routes through the same Replit-managed Anthropic
  // integration — but as a selectable endpoint usable by the bot and agents.
  if (endpoint.apiKeyRef === MANAGED_ANTHROPIC_REF) {
    const text = await runAnthropicToolChat(
      managedAnthropic as unknown as Anthropic,
      endpoint.modelName || MANAGED_ANTHROPIC_MODEL,
      opts,
      prepared,
      nameMap,
    );
    return { text, modelLabel: `${endpoint.name} (${endpoint.modelName})` };
  }

  const family = providerFamily(endpoint.providerType);
  const label = `${endpoint.name} (${endpoint.modelName})`;
  const timeoutMs = endpoint.requestTimeoutMs ?? 30_000;

  if (family === "anthropic") {
    const client = new Anthropic({
      apiKey: opts.apiKey ?? "",
      baseURL: resolveBaseUrl(endpoint, "https://api.anthropic.com"),
    });
    const text = await runAnthropicToolChat(
      client,
      endpoint.modelName,
      opts,
      prepared,
      nameMap,
    );
    return { text, modelLabel: label };
  }

  if (family === "google") {
    const base = resolveBaseUrl(
      endpoint,
      "https://generativelanguage.googleapis.com/v1beta",
    );
    const text = await runGoogleToolChat(
      base,
      opts.apiKey,
      endpoint.modelName,
      timeoutMs,
      opts,
      prepared,
      nameMap,
    );
    return { text, modelLabel: label };
  }

  // OpenAI-compatible family (openai, openai_compatible, openrouter, azure).
  const base = resolveBaseUrl(endpoint, "https://api.openai.com/v1");
  const text = await runOpenAiToolChat(
    base,
    opts.apiKey,
    endpoint.organization ?? null,
    endpoint.modelName,
    timeoutMs,
    opts,
    prepared,
    nameMap,
  );
  return { text, modelLabel: label };
}

export { logger as toolChatLogger };
