import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Provider-error explanation tests.
//
// `describeProviderError` is a pure function: ProviderHttpError statuses and
// raw `fetch` network/TLS failures (signalled via err.cause / err.code) must
// map to a stable summary + detail. `testEndpoint` wraps it and must report
// distinct `mode`s: "not_testable" (no key), "live" (provider reachable), and
// "error" (call failed) — both non-live modes telling the user runs fall back
// to the simulated stub.
//
// No mock.module here: llm.ts imports `ModelEndpoint` as a type only (erased at
// runtime) and the managed-Anthropic client is a lazy proxy, so the SUT imports
// cleanly. testEndpoint's live/error paths are driven by stubbing global fetch.
// ---------------------------------------------------------------------------

import type { ModelEndpoint } from "@workspace/db";
const {
  describeProviderError,
  ProviderHttpError,
  testEndpoint,
} = await import("../src/lib/llm");

// Minimal endpoint factory — only the fields the provider call paths read.
function makeEndpoint(over: Partial<ModelEndpoint> = {}): ModelEndpoint {
  return {
    id: "ep1",
    tenantId: "t1",
    name: "Test EP",
    providerType: "openai",
    baseUrl: null,
    host: null,
    port: null,
    modelName: "gpt-test",
    apiKeyRef: null,
    organization: null,
    deployment: null,
    extraHeadersJson: null,
    requestTimeoutMs: 5000,
    maxRetries: 0,
    isDefault: false,
    status: "untested",
    lastTestedAt: null,
    lastTestResultJson: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as ModelEndpoint;
}

// Build an Error whose low-level network cause carries a `code` (mirrors how
// Node's fetch hides ECONNREFUSED/ENOTFOUND/ETIMEDOUT on err.cause).
function networkError(message: string, code?: string): Error {
  const err = new Error("fetch failed");
  const cause: Record<string, unknown> = { message };
  if (code) cause.code = code;
  (err as { cause?: unknown }).cause = cause;
  return err;
}

describe("describeProviderError — HTTP statuses", () => {
  it("401 → authentication failed", () => {
    const info = describeProviderError(new ProviderHttpError(401));
    assert.match(info.summary, /Authentication failed \(401\)/);
    assert.match(info.summary, /invalid or expired/);
    assert.match(info.detail, /HTTP 401 \(Unauthorized\)/);
    assert.match(info.detail, /revoked, or expired/);
  });

  it("403 → access denied", () => {
    const info = describeProviderError(new ProviderHttpError(403));
    assert.match(info.summary, /Access denied \(403\)/);
    assert.match(info.detail, /HTTP 403 \(Forbidden\)/);
    assert.match(info.detail, /billing/);
  });

  it("404 → not found", () => {
    const info = describeProviderError(new ProviderHttpError(404));
    assert.match(info.summary, /Not found \(404\)/);
    assert.match(info.detail, /HTTP 404 \(Not Found\)/);
    assert.match(info.detail, /model name/);
  });

  it("402 → payment required", () => {
    const info = describeProviderError(new ProviderHttpError(402));
    assert.match(info.summary, /Payment required \(402\)/);
    assert.match(info.detail, /HTTP 402 \(Payment Required\)/);
    assert.match(info.detail, /credits/);
  });

  it("429 → rate limited / out of credits", () => {
    const info = describeProviderError(new ProviderHttpError(429));
    assert.match(info.summary, /Rate limited or out of credits \(429\)/);
    assert.match(info.detail, /HTTP 429 \(Too Many Requests\)/);
  });

  it("500 → upstream provider error", () => {
    const info = describeProviderError(new ProviderHttpError(500));
    assert.match(info.summary, /Provider error \(500\)/);
    assert.match(info.detail, /HTTP 500/);
    assert.match(info.detail, /their side/);
  });

  it("503 (any 5xx) → upstream provider error with the status", () => {
    const info = describeProviderError(new ProviderHttpError(503));
    assert.match(info.summary, /Provider error \(503\)/);
    assert.match(info.detail, /HTTP 503/);
  });

  it("418 (unmapped 4xx) → generic rejection with the status", () => {
    const info = describeProviderError(new ProviderHttpError(418));
    assert.match(info.summary, /Provider rejected the request \(418\)/);
    assert.match(info.detail, /HTTP 418/);
  });

  it("appends the raw provider body when present", () => {
    const info = describeProviderError(
      new ProviderHttpError(401, "Incorrect API key provided"),
    );
    assert.match(info.detail, /Provider said: Incorrect API key provided/);
  });

  it("omits the raw-body sentence when the body is empty", () => {
    const info = describeProviderError(new ProviderHttpError(401, ""));
    assert.doesNotMatch(info.detail, /Provider said:/);
  });
});

describe("describeProviderError — network / TLS failures", () => {
  it("timeout (ETIMEDOUT) → connection timed out", () => {
    const info = describeProviderError(
      networkError("connect ETIMEDOUT 10.0.0.1:443", "ETIMEDOUT"),
    );
    assert.match(info.summary, /Connection timed out/);
    assert.match(info.detail, /Connection timed out/);
    assert.match(info.detail, /public tunnel/);
  });

  it("worded timeout (no code) → connection timed out", () => {
    const info = describeProviderError(new Error("The operation timed out"));
    assert.match(info.summary, /Connection timed out/);
  });

  it("ECONNREFUSED → connection refused", () => {
    const info = describeProviderError(
      networkError("connect ECONNREFUSED 127.0.0.1:11434", "ECONNREFUSED"),
    );
    assert.match(info.summary, /Connection refused/);
    assert.match(info.detail, /Nothing accepted the connection/);
  });

  it("ENOTFOUND → host not found (DNS)", () => {
    const info = describeProviderError(
      networkError("getaddrinfo ENOTFOUND nope.invalid", "ENOTFOUND"),
    );
    assert.match(info.summary, /Host not found/);
    assert.match(info.detail, /DNS/);
  });

  it("EAI_AGAIN → host not found (DNS)", () => {
    const info = describeProviderError(
      networkError("getaddrinfo EAI_AGAIN host", "EAI_AGAIN"),
    );
    assert.match(info.summary, /Host not found/);
  });

  it("TLS / self-signed cert → certificate error", () => {
    const info = describeProviderError(
      networkError("self-signed certificate in certificate chain", "DEPTH_ZERO_SELF_SIGNED_CERT"),
    );
    assert.match(info.summary, /TLS certificate error/);
    assert.match(info.detail, /self-signed or untrusted/);
  });

  it("unrecognised Error → echoes message, folds cause into detail", () => {
    const err = new Error("Something odd happened");
    (err as { cause?: unknown }).cause = new Error("low-level reason");
    const info = describeProviderError(err);
    assert.equal(info.summary, "Something odd happened");
    assert.match(info.detail, /Something odd happened \(low-level reason\)/);
  });

  it("non-Error value → stringified for both summary and detail", () => {
    const info = describeProviderError("boom");
    assert.equal(info.summary, "boom");
    assert.equal(info.detail, "boom");
  });
});

describe("testEndpoint", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  beforeEach(() => {
    globalThis.fetch = realFetch;
  });

  it("no key on a hosted provider → not_testable, never calls the provider", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      throw new Error("should not be called");
    }) as typeof fetch;

    const result = await testEndpoint(makeEndpoint(), null);

    assert.equal(result.ok, false);
    assert.equal(result.mode, "not_testable");
    assert.equal(result.latencyMs, 0);
    assert.match(result.summary, /No API key/);
    assert.match(result.summary, /simulated stub/);
    assert.match(result.detail, /No API key is configured/);
    assert.match(result.detail, /deterministic simulated stub/);
    assert.equal(called, false);
  });

  it("provider rejects with 401 → error mode carrying the fallback warning", async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 401,
      text: async () => "Incorrect API key provided",
    })) as unknown as typeof fetch;

    const result = await testEndpoint(makeEndpoint(), "sk-bad");

    assert.equal(result.ok, false);
    assert.equal(result.mode, "error");
    assert.match(result.summary, /Authentication failed \(401\)/);
    assert.match(result.summary, /fall back to the simulated stub/);
    assert.match(result.detail, /Provider said: Incorrect API key provided/);
    assert.match(result.detail, /no live request to the provider/);
  });

  it("network failure → error mode with the mapped network explanation", async () => {
    globalThis.fetch = (async () => {
      throw networkError("connect ECONNREFUSED 127.0.0.1:443", "ECONNREFUSED");
    }) as typeof fetch;

    const result = await testEndpoint(makeEndpoint(), "sk-x");

    assert.equal(result.ok, false);
    assert.equal(result.mode, "error");
    assert.match(result.summary, /Connection refused/);
    assert.match(result.detail, /simulated stub/);
  });

  it("provider responds OK → live mode", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "pong" } }] }),
    })) as unknown as typeof fetch;

    const result = await testEndpoint(makeEndpoint(), "sk-good");

    assert.equal(result.ok, true);
    assert.equal(result.mode, "live");
    assert.match(result.summary, /Live/);
    assert.match(result.summary, /Real models will be used/);
    assert.match(result.detail, /reach the real model/);
  });

  it("keyless provider with no key still tests live (not not_testable)", async () => {
    let hit = false;
    globalThis.fetch = (async () => {
      hit = true;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "pong" } }] }),
      };
    }) as unknown as typeof fetch;

    const result = await testEndpoint(
      makeEndpoint({ providerType: "openai_compatible", baseUrl: "http://localhost:11434" }),
      null,
    );

    assert.equal(result.mode, "live");
    assert.equal(hit, true);
  });
});
