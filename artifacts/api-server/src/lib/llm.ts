import type { ModelEndpoint } from "@workspace/db";
import { logger } from "./logger";

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

async function callOpenAiCompatible({
  endpoint,
  apiKey,
  req,
}: ProviderCallArgs): Promise<string> {
  const base = endpoint.baseUrl ?? "https://api.openai.com/v1";
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
  if (!res.ok) throw new Error(`provider ${res.status}`);
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
  const base = endpoint.baseUrl ?? "https://api.anthropic.com";
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
  if (!res.ok) throw new Error(`provider ${res.status}`);
  const data = (await res.json()) as { content?: { text?: string }[] };
  return data.content?.map((c) => c.text ?? "").join("") ?? "";
}

async function callGoogle({
  endpoint,
  apiKey,
  req,
}: ProviderCallArgs): Promise<string> {
  const base =
    endpoint.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
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
  if (!res.ok) throw new Error(`provider ${res.status}`);
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  return (
    data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? ""
  );
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
  if (!endpoint || !apiKey) {
    return stubComplete(req, endpoint?.name ?? "stub");
  }

  const start = Date.now();
  try {
    let content: string;
    switch (endpoint.providerType) {
      case "anthropic":
        content = await callAnthropic({ endpoint, apiKey, req });
        break;
      case "google":
        content = await callGoogle({ endpoint, apiKey, req });
        break;
      default:
        content = await callOpenAiCompatible({ endpoint, apiKey, req });
        break;
    }
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

/** Connectivity test for an endpoint. Returns a structured result. */
export async function testEndpoint(
  endpoint: ModelEndpoint,
  apiKey: string | null,
): Promise<{ ok: boolean; mode: string; latencyMs: number; detail: string }> {
  if (!apiKey) {
    return {
      ok: true,
      mode: "stub",
      latencyMs: 0,
      detail: "No API key configured; deterministic stub mode is active.",
    };
  }
  const start = Date.now();
  const result = await complete(endpoint, apiKey, {
    messages: [{ role: "user", content: "ping" }],
    maxTokens: 8,
  });
  return {
    ok: !result.usedStub,
    mode: result.usedStub ? "stub_fallback" : "live",
    latencyMs: Date.now() - start,
    detail: result.usedStub
      ? "Provider unreachable; fell back to stub."
      : "Live provider responded successfully.",
  };
}
