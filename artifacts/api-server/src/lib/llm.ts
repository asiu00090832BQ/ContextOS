import type { ModelEndpoint } from "@workspace/db";
import { anthropic as managedAnthropic } from "@workspace/integrations-anthropic-ai";
import { logger } from "./logger";
import { defaultOpenAiCompatibleBase } from "./providerDefaults";
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
  /**
   * When `usedStub` is true, a short plain-language reason the real model was
   * not reached (no endpoint / no API key / a provider error from
   * describeProviderError). Undefined on a real (non-stub) completion.
   */
  stubReason?: string;
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

/**
 * Error carrying an upstream HTTP status (and a short body snippet) from a
 * provider call, so describeProviderError can map status codes (401/403/404/
 * 429/...) to plain-language explanations instead of surfacing a bare number.
 */
export class ProviderHttpError extends Error {
  status: number;
  body: string;
  constructor(status: number, body = "") {
    super(`provider ${status}`);
    this.name = "ProviderHttpError";
    this.status = status;
    this.body = body;
  }
}

/** Read a small slice of an error response body for diagnostic context. */
async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 500).trim();
  } catch {
    return "";
  }
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
export function stubComplete(
  req: LlmRequest,
  endpointLabel: string,
  reason?: string,
): LlmResult {
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
    stubReason:
      reason ??
      "The real model wasn't reached, so deterministic simulated output was used instead.",
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
  const base = resolveBaseUrl(
    endpoint,
    defaultOpenAiCompatibleBase(endpoint.providerType),
    "/v1",
  );
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
  if (!res.ok) throw new ProviderHttpError(res.status, await readErrorBody(res));
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
  if (!res.ok) throw new ProviderHttpError(res.status, await readErrorBody(res));
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
  if (!res.ok) throw new ProviderHttpError(res.status, await readErrorBody(res));
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
 * Two-level description of a failed provider call: a one-line `summary` for the
 * default view and an expanded `detail` with the likely cause, what to do, and
 * any raw signal from the provider. Maps common HTTP statuses (401/403/404/
 * 429/402/5xx) to plain-language explanations, and unwraps the low-level
 * network/TLS cause that Node's `fetch` hides on `err.cause`.
 */
export interface ProviderErrorInfo {
  summary: string;
  detail: string;
}

export function describeProviderError(err: unknown): ProviderErrorInfo {
  // Upstream HTTP failures carry the status and a body snippet — map the status
  // to an actionable explanation rather than surfacing a bare number.
  if (err instanceof ProviderHttpError) {
    return describeHttpStatus(err.status, err.body);
  }

  if (!(err instanceof Error)) {
    const text = String(err);
    return { summary: text, detail: text };
  }

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
    return {
      summary: "Connection timed out — the model server didn't respond in time.",
      detail:
        "Connection timed out. The server did not respond in time — this is what happens when the Base URL points to a private / LAN address (e.g. 192.168.x.x, 10.x.x.x, localhost) that this cloud-hosted server cannot reach. Expose your model with a public tunnel (ngrok, Cloudflare Tunnel, or Tailscale Funnel) and use that public HTTPS URL instead.",
    };
  }
  if (/ECONNREFUSED/i.test(hay)) {
    return {
      summary: "Connection refused — nothing answered at that host/port.",
      detail:
        "Connection refused. Nothing accepted the connection at that host/port from the cloud — if it's a private / LAN address it isn't reachable from here. Expose your model with a public tunnel and use that URL.",
    };
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(hay)) {
    return {
      summary: "Host not found — the Base URL's domain couldn't be resolved.",
      detail:
        "Host not found (DNS). The domain in the Base URL could not be resolved from the cloud. Check the URL, or use a public tunnel URL.",
    };
  }
  if (/certificate|self.?signed|SSL|TLS|DEPTH_ZERO|ERR_TLS/i.test(hay)) {
    return {
      summary: "TLS certificate error — the server's HTTPS cert isn't trusted.",
      detail:
        "TLS certificate error. The server's HTTPS certificate is self-signed or untrusted by the cloud. Use a tunnel that provides a valid certificate (ngrok / Cloudflare Tunnel) instead of a raw self-signed HTTPS endpoint.",
    };
  }
  const full = causeMsg ? `${err.message} (${causeMsg})` : err.message;
  return { summary: err.message, detail: full };
}

/** Map an upstream HTTP status to a brief summary and an expanded explanation. */
function describeHttpStatus(status: number, body: string): ProviderErrorInfo {
  const raw = body ? ` Provider said: ${body}` : "";
  if (status === 401) {
    return {
      summary: "Authentication failed (401) — the API key looks invalid or expired.",
      detail:
        `The provider rejected the credentials with HTTP 401 (Unauthorized). The API key is likely missing, mistyped, revoked, or expired — or it belongs to a different provider. Re-check the key and save it again.${raw}`,
    };
  }
  if (status === 403) {
    return {
      summary: "Access denied (403) — your key isn't allowed to use this model.",
      detail:
        `The provider accepted the request but refused it with HTTP 403 (Forbidden). Common causes: the key doesn't have access to this model, your account or region isn't enabled for it, billing isn't set up, or the model name is gated. Check the model is enabled for your account and that billing/credits are active.${raw}`,
    };
  }
  if (status === 404) {
    return {
      summary: "Not found (404) — the model name or Base URL may be wrong.",
      detail:
        `The provider returned HTTP 404 (Not Found). Usually the model name doesn't exist for this provider, or the Base URL points at the wrong path. Verify the exact model id and the Base URL.${raw}`,
    };
  }
  if (status === 402) {
    return {
      summary: "Payment required (402) — the account has no credits.",
      detail:
        `The provider returned HTTP 402 (Payment Required). Your account is out of credits or has no active billing. Add credits or set up billing with the provider, then retry.${raw}`,
    };
  }
  if (status === 429) {
    return {
      summary: "Rate limited or out of credits (429).",
      detail:
        `The provider returned HTTP 429 (Too Many Requests). Either you're sending requests too fast, or the account has hit its quota / run out of credits. Wait and retry, raise your rate limit, or add credits.${raw}`,
    };
  }
  if (status >= 500) {
    return {
      summary: `Provider error (${status}) — the upstream service failed.`,
      detail:
        `The provider returned HTTP ${status}, an error on their side. This is usually temporary — retry in a bit. If it persists, check the provider's status page.${raw}`,
    };
  }
  return {
    summary: `Provider rejected the request (${status}).`,
    detail: `The provider responded with HTTP ${status}.${raw}`,
  };
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
  if (!endpoint) {
    return stubComplete(
      req,
      "stub",
      "No model endpoint is configured for this agent, so simulated output was used.",
    );
  }
  if (!managed && requiresApiKey(endpoint.providerType, endpoint) && !apiKey) {
    return stubComplete(
      req,
      endpoint.name,
      "No API key is configured for this endpoint, so the real model could not be reached and simulated output was used.",
    );
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
    const info = describeProviderError(err);
    logger.warn(
      { err, endpoint: endpoint.name },
      "LLM provider call failed; using deterministic stub fallback",
    );
    return stubComplete(req, endpoint.name, info.summary);
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
  const base = resolveBaseFromInput(
    input,
    defaultOpenAiCompatibleBase(input.providerType),
    "/v1",
  );
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

export interface EndpointTestResult {
  ok: boolean;
  /** "live" (real provider reachable) | "not_testable" | "error" — the latter two run simulated. */
  mode: "live" | "not_testable" | "error";
  latencyMs: number;
  /** One-line message for the default view. */
  summary: string;
  /** Expanded explanation: likely cause, what to do, and any raw provider signal. */
  detail: string;
}

/** Connectivity test for an endpoint. Returns a structured result. */
export async function testEndpoint(
  endpoint: ModelEndpoint,
  apiKey: string | null,
): Promise<EndpointTestResult> {
  if (requiresApiKey(endpoint.providerType, endpoint) && !apiKey) {
    return {
      ok: false,
      mode: "not_testable",
      latencyMs: 0,
      summary: "No API key — this endpoint can't run live and will use the simulated stub.",
      detail:
        "No API key is configured, so a live connection cannot be tested. Until a key is added, ContextOS runs will NOT reach the real provider — they fall back to the deterministic simulated stub, which returns placeholder output instead of real model responses. Add an API key to make this endpoint live.",
    };
  }
  const start = Date.now();
  try {
    await callProvider({
      endpoint,
      apiKey,
      req: { messages: [{ role: "user", content: "ping" }], maxTokens: 8 },
    });
    const latencyMs = Date.now() - start;
    return {
      ok: true,
      mode: "live",
      latencyMs,
      summary: `Live — the provider responded in ${latencyMs}ms. Real models will be used.`,
      detail: `Live provider responded successfully in ${latencyMs}ms. ContextOS runs against this endpoint will reach the real model.`,
    };
  } catch (err) {
    const info = describeProviderError(err);
    return {
      ok: false,
      mode: "error",
      latencyMs: Date.now() - start,
      summary: `${info.summary} Runs will fall back to the simulated stub until this is fixed.`,
      detail: `${info.detail}\n\nWhile this test fails, ContextOS makes no live request to the provider for this endpoint — runs fall back to the deterministic simulated stub (placeholder output), so real models won't be reached until the test passes.`,
    };
  }
}
