import type { ModelEndpoint } from "@workspace/db";
import { anthropic as managedAnthropic } from "@workspace/integrations-anthropic-ai";
import { logger } from "./logger";
import { MANAGED_ANTHROPIC_REF, MANAGED_ANTHROPIC_MODEL } from "./toolChat";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  messages: LlmMessage[];
  temperature?: number; // 0..1
  maxTokens?: number;
}

export interface LlmResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsdMicros: number;
  finishReason: string;
  usedStub: boolean;
  latencyMs: number;
  timeToFirstTokenMs: number;
}

// Rough per-provider micro-USD pricing per 1K tokens (prompt/completion blended).
const PRICE_PER_1K_MICROS: Record<string, number> = {
  openai: 5000,
  anthropic: 8000,
  google: 3500,
  openai_compatible: 2000,
  azure_openai: 5000,
  ollama: 0,
  custom: 1000,
};

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function deterministicHash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/**
 * Deterministic stub completion — used when no real endpoint/key is available
 * or when a real provider call fails. Produces stable, plausible output.
 */
export function stubComplete(req: LlmRequest, endpointLabel: string): LlmResult {
  const prompt = req.messages.map((m) => `${m.role}: ${m.content}`).join("\n");
  const seed = deterministicHash(prompt + endpointLabel);
  const promptTokens = req.messages.reduce(
    (sum, m) => sum + estimateTokens(m.content),
    0,
  );
  const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
  const summary = lastUser?.content.slice(0, 200) ?? "the requested task";
  const content = JSON.stringify({
    status: "completed",
    reasoning: `Analyzed the objective and produced a deterministic plan for: ${summary}`,
    result: `Simulated completion (seed ${seed % 100000}).`,
  });
  const completionTokens = estimateTokens(content);
  const totalTokens = promptTokens + completionTokens;
  const costUsdMicros = Math.round(
    (totalTokens / 1000) * (PRICE_PER_1K_MICROS.custom ?? 1000),
  );
  return {
    content,
    promptTokens,
    completionTokens,
    totalTokens,
    costUsdMicros,
    finishReason: "stop",
    usedStub: true,
    latencyMs: 120 + (seed % 380),
    timeToFirstTokenMs: 40 + (seed % 90),
  };
}

interface ProviderCallArgs {
  endpoint: ModelEndpoint;
  apiKey: string | null;
  req: LlmRequest;
}

// Provider types that can be reached without an API key (e.g. self-hosted /
// local OpenAI-compatible servers such as Ollama or vLLM behind host/port).
const KEYLESS_PROVIDER_TYPES = new Set(["openai_compatible"]);

/**
 * Whether an endpoint/descriptor has an explicitly configured destination
 * (Base URL or host). Such a target is assumed to be a local / self-hosted
 * server the user controls and is therefore reachable without an API key.
 */
function hasExplicitTarget(e: {
  baseUrl?: string | null;
  host?: string | null;
}): boolean {
  return Boolean(e.baseUrl?.trim() || e.host?.trim());
}

/**
 * An API key is required only for hosted providers that fall back to their
 * built-in default endpoint. Keyless provider types and any endpoint with an
 * explicit Base URL / host are reachable without a key.
 */
function requiresApiKey(
  providerType: string,
  target: { baseUrl?: string | null; host?: string | null },
): boolean {
  if (KEYLESS_PROVIDER_TYPES.has(providerType)) return false;
  if (hasExplicitTarget(target)) return false;
  return true;
}

/**
 * Resolve the base URL for an endpoint. Prefer an explicit baseUrl; otherwise
 * derive it from host/port (port 443 implies https); finally fall back to the
 * provider default. `suffix` is appended only when deriving from host/port.
 */
function resolveBaseUrl(
  endpoint: ModelEndpoint,
  defaultBase: string,
  suffix = "",
): string {
  if (endpoint.baseUrl) return endpoint.baseUrl;
  if (endpoint.host) {
    const scheme = endpoint.port === 443 ? "https" : "http";
    const portPart = endpoint.port ? `:${endpoint.port}` : "";
    return `${scheme}://${endpoint.host}${portPart}${suffix}`;
  }
  return defaultBase;
}

async function callOpenAiCompatible({
  endpoint,
  apiKey,
  req,
}: ProviderCallArgs): Promise<string> {
  const base = resolveBaseUrl(endpoint, "https://api.openai.com/v1", "/v1");
  const url = `${base.replace(/\/$/, "")}/chat/completions`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (endpoint.organization) headers["openai-organization"] = endpoint.organization;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: endpoint.modelName,
      messages: req.messages,
      temperature: req.temperature ?? 0.7,
      max_tokens: req.maxTokens ?? 1024,
    }),
    signal: AbortSignal.timeout(endpoint.requestTimeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`provider ${res.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return data.choices?.[0]?.message?.content ?? "";
}

async function callAnthropic({
  endpoint,
  apiKey,
  req,
}: ProviderCallArgs): Promise<string> {
  const base = resolveBaseUrl(endpoint, "https://api.anthropic.com");
  const url = `${base.replace(/\/$/, "")}/v1/messages`;
  const system = req.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
  const messages = req.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (apiKey) headers["x-api-key"] = apiKey;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: endpoint.modelName,
      system,
      messages,
      max_tokens: req.maxTokens ?? 1024,
      temperature: req.temperature ?? 0.7,
    }),
    signal: AbortSignal.timeout(endpoint.requestTimeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`provider ${res.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
  }
  const data = (await res.json()) as { content?: { text?: string }[] };
  return data.content?.map((c) => c.text ?? "").join("") ?? "";
}

async function callGoogle({
  endpoint,
  apiKey,
  req,
}: ProviderCallArgs): Promise<string> {
  const base = resolveBaseUrl(
    endpoint,
    "https://generativelanguage.googleapis.com/v1beta",
  );
  const url = `${base.replace(/\/$/, "")}/models/${endpoint.modelName}:generateContent?key=${apiKey ?? ""}`;
  const contents = req.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents,
      generationConfig: {
        temperature: req.temperature ?? 0.7,
        maxOutputTokens: req.maxTokens ?? 1024,
      },
    }),
    signal: AbortSignal.timeout(endpoint.requestTimeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`provider ${res.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
  }
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  return (
    data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? ""
  );
}

/**
 * Completion via the Replit-managed Anthropic integration (no API key of its
 * own). Mirrors the managed path in toolChat so an endpoint marked with the
 * managed sentinel is usable by agents (run/chat engines), not just the bot.
 */
async function callManagedAnthropic({
  endpoint,
  req,
}: ProviderCallArgs): Promise<string> {
  const system = req.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
  const messages = req.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));
  const res = await managedAnthropic.messages.create({
    model: endpoint.modelName || MANAGED_ANTHROPIC_MODEL,
    ...(system ? { system } : {}),
    messages,
    max_tokens: req.maxTokens ?? 1024,
    temperature: req.temperature ?? 0.7,
  });
  return res.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

/** Dispatch a single completion request to the correct provider. Throws on failure. */
async function callProvider(args: ProviderCallArgs): Promise<string> {
  if (args.endpoint.apiKeyRef === MANAGED_ANTHROPIC_REF) {
    return callManagedAnthropic(args);
  }
  switch (args.endpoint.providerType) {
    case "anthropic":
      return callAnthropic(args);
    case "google":
      return callGoogle(args);
    default:
      return callOpenAiCompatible(args);
  }
}

/**
 * Produce a human-readable reason for a failed provider call. Node's `fetch`
 * wraps low-level network/TLS errors in a generic "fetch failed" whose real
 * cause lives on `err.cause` — surface that so users can tell a timeout from a
 * refused connection, a bad TLS cert, or an unreachable (e.g. private LAN) host.
 */
export function describeProviderError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);

  const cause = (err as { cause?: unknown }).cause;
  const causeMsg =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : "";
  const code =
    cause && typeof cause === "object" && "code" in cause
      ? String((cause as { code: unknown }).code)
      : "";
  // Single haystack of everything we know about the failure so detection works
  // regardless of whether the signal came from the error, its cause, or a code.
  const hay = `${err.name} ${err.message} ${code} ${causeMsg}`;

  if (/timeout|timed ?out|ETIMEDOUT/i.test(hay)) {
    return "Connection timed out. The server did not respond in time — this is what happens when the Base URL points to a private / LAN address (e.g. 192.168.x.x, 10.x.x.x, localhost) that this cloud-hosted server cannot reach. Expose your model with a public tunnel (ngrok, Cloudflare Tunnel, or Tailscale Funnel) and use that public HTTPS URL instead.";
  }
  if (/ECONNREFUSED/i.test(hay)) {
    return "Connection refused. Nothing accepted the connection at that host/port from the cloud — if it's a private / LAN address it isn't reachable from here. Expose your model with a public tunnel and use that URL.";
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(hay)) {
    return "Host not found (DNS). The domain in the Base URL could not be resolved from the cloud. Check the URL, or use a public tunnel URL.";
  }
  if (/certificate|self.?signed|SSL|TLS|DEPTH_ZERO|ERR_TLS/i.test(hay)) {
    return "TLS certificate error. The server's HTTPS certificate is self-signed or untrusted by the cloud. Use a tunnel that provides a valid certificate (ngrok / Cloudflare Tunnel) instead of a raw self-signed HTTPS endpoint.";
  }
  // Upstream HTTP status (the provider answered but rejected the call). The
  // thrown message is shaped like "provider 403" / "provider 403: <body>" or
  // "Provider responded 403.", so pull the status out of those known prefixes
  // (anchored to avoid matching unrelated 3-digit numbers like a port).
  const statusMatch = hay.match(/(?:provider|responded)[^\d]{0,4}(\d{3})/i);
  if (statusMatch) {
    const mapped = describeHttpStatus(Number(statusMatch[1]));
    if (mapped) return mapped;
  }
  return causeMsg ? `${err.message} (${causeMsg})` : err.message;
}

/**
 * Map a common upstream HTTP status to a short, actionable explanation. Returns
 * null for statuses we don't have specific guidance for, so the caller can fall
 * back to the raw message.
 */
function describeHttpStatus(status: number): string | null {
  switch (status) {
    case 400:
      return "The provider rejected the request (400). The model name is likely invalid for this provider, or a parameter isn't supported by this model. Verify the exact model id (use \"Fetch models\").";
    case 401:
      return "Authentication failed (401). The API key is missing, invalid, or expired for this provider. Re-enter a valid key on this endpoint.";
    case 402:
      return "Payment required (402). This provider account is out of credits or has no active billing. Add credits/billing for this key, or switch to a model your plan covers.";
    case 403:
      return "Access denied (403). The key is valid but not allowed to use this model or endpoint. Enable access to this model for your key, or pick a model the key can use.";
    case 404:
      return "Not found (404). The model name doesn't exist at this provider, or the Base URL path is wrong. Check the exact model id (use \"Fetch models\") and the Base URL.";
    case 429:
      return "Rate limited (429). Too many requests, or you've hit a quota/credit limit for this provider. Wait and retry, or check your plan's limits and credits.";
    default:
      if (status >= 500)
        return `The provider had a server error (${status}). This is on the provider's side — wait a moment and try again.`;
      return null;
  }
}

/**
 * Run a completion against a real provider, falling back to the deterministic
 * stub when there is no endpoint, no API key, or the provider call fails.
 */
export async function complete(
  endpoint: ModelEndpoint | null,
  apiKey: string | null,
  req: LlmRequest,
): Promise<LlmResult> {
  const managed = endpoint?.apiKeyRef === MANAGED_ANTHROPIC_REF;
  if (
    !endpoint ||
    (!managed && requiresApiKey(endpoint.providerType, endpoint) && !apiKey)
  ) {
    return stubComplete(req, endpoint?.name ?? "stub");
  }

  const start = Date.now();
  try {
    const content = await callProvider({ endpoint, apiKey, req });
    const latencyMs = Date.now() - start;
    const promptTokens = req.messages.reduce(
      (s, m) => s + estimateTokens(m.content),
      0,
    );
    const completionTokens = estimateTokens(content);
    const totalTokens = promptTokens + completionTokens;
    const rate = PRICE_PER_1K_MICROS[endpoint.providerType] ?? 2000;
    return {
      content,
      promptTokens,
      completionTokens,
      totalTokens,
      costUsdMicros: Math.round((totalTokens / 1000) * rate),
      finishReason: "stop",
      usedStub: false,
      latencyMs,
      timeToFirstTokenMs: Math.min(latencyMs, 80),
    };
  } catch (err) {
    logger.warn(
      { err, endpoint: endpoint.name },
      "LLM provider call failed; using deterministic stub fallback",
    );
    return stubComplete(req, endpoint.name);
  }
}

export interface ListModelsInput {
  providerType: string;
  baseUrl?: string | null;
  host?: string | null;
  port?: number | null;
  apiKey?: string | null;
}

/** Resolve a base URL from a plain descriptor (used before an endpoint exists). */
function resolveBaseFromInput(
  input: ListModelsInput,
  defaultBase: string,
  suffix = "",
): string {
  if (input.baseUrl) return input.baseUrl;
  if (input.host) {
    const scheme = input.port === 443 ? "https" : "http";
    const portPart = input.port ? `:${input.port}` : "";
    return `${scheme}://${input.host}${portPart}${suffix}`;
  }
  return defaultBase;
}

/**
 * Query a provider for the real list of model names it exposes. Lets the UI
 * auto-detect models instead of forcing the user to type one by hand. Throws a
 * descriptive Error when the provider rejects the request or is unreachable.
 */
export async function listModels(input: ListModelsInput): Promise<string[]> {
  const timeout = AbortSignal.timeout(15000);
  if (requiresApiKey(input.providerType, input) && !input.apiKey) {
    throw new Error("An API key is required to list this provider's models.");
  }

  if (input.providerType === "anthropic") {
    const base = resolveBaseFromInput(input, "https://api.anthropic.com");
    const res = await fetch(`${base.replace(/\/$/, "")}/v1/models`, {
      headers: {
        "x-api-key": input.apiKey ?? "",
        "anthropic-version": "2023-06-01",
      },
      signal: timeout,
    });
    if (!res.ok) throw new Error(`Provider responded ${res.status}.`);
    const data = (await res.json()) as { data?: { id?: string }[] };
    return dedupeSort((data.data ?? []).map((m) => m.id ?? ""));
  }

  if (input.providerType === "google") {
    const base = resolveBaseFromInput(
      input,
      "https://generativelanguage.googleapis.com/v1beta",
    );
    const res = await fetch(
      `${base.replace(/\/$/, "")}/models?key=${input.apiKey ?? ""}`,
      { signal: timeout },
    );
    if (!res.ok) throw new Error(`Provider responded ${res.status}.`);
    const data = (await res.json()) as { models?: { name?: string }[] };
    return dedupeSort(
      (data.models ?? []).map((m) => (m.name ?? "").replace(/^models\//, "")),
    );
  }

  // openai / openai_compatible / openrouter / azure_openai
  const base = resolveBaseFromInput(input, "https://api.openai.com/v1", "/v1");
  const headers: Record<string, string> = {};
  if (input.apiKey) headers.authorization = `Bearer ${input.apiKey}`;
  const res = await fetch(`${base.replace(/\/$/, "")}/models`, {
    headers,
    signal: timeout,
  });
  if (!res.ok) throw new Error(`Provider responded ${res.status}.`);
  const data = (await res.json()) as { data?: { id?: string }[] };
  return dedupeSort((data.data ?? []).map((m) => m.id ?? ""));
}

function dedupeSort(ids: string[]): string[] {
  return [...new Set(ids.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

/** Connectivity test for an endpoint. Returns a structured result. */
export async function testEndpoint(
  endpoint: ModelEndpoint,
  apiKey: string | null,
): Promise<{ ok: boolean; mode: string; latencyMs: number; detail: string }> {
  if (requiresApiKey(endpoint.providerType, endpoint) && !apiKey) {
    return {
      ok: false,
      mode: "not_testable",
      latencyMs: 0,
      detail:
        "No API key configured; a live connection cannot be tested. Runs will use the deterministic stub until a key is added.",
    };
  }
  const start = Date.now();
  try {
    await callProvider({
      endpoint,
      apiKey,
      req: { messages: [{ role: "user", content: "ping" }], maxTokens: 8 },
    });
    return {
      ok: true,
      mode: "live",
      latencyMs: Date.now() - start,
      detail: "Live provider responded successfully.",
    };
  } catch (err) {
    return {
      ok: false,
      mode: "error",
      latencyMs: Date.now() - start,
      detail: describeProviderError(err),
    };
  }
}
