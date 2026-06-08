import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { resolveSecret } from "./secretStore";

/**
 * Web tool construction + execution engine.
 *
 * A "constructed" MCP server is an adapter row whose capabilities each carry an
 * `executionJson` recipe describing how to actually call a remote web service.
 * This module turns those recipes into live HTTP (and, later, browser) calls so
 * that constructed tools are genuinely executable — by internal agent runs and
 * by external AI clients over the /mcp endpoint.
 *
 * Security: every outbound request passes through an SSRF guard that resolves
 * the target host and refuses to contact loopback / private / link-local /
 * cloud-metadata addresses unless the owning server has explicitly opted in to
 * private-network access.
 */

// ---------------------------------------------------------------------------
// Recipe + auth types
// ---------------------------------------------------------------------------

export type ToolExecutionKind = "http" | "browser";

export interface HttpRecipe {
  kind: "http";
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  /** Path appended to the server base URL. May contain {param} tokens. */
  pathTemplate: string;
  /** Static + templated query parameters. Values may contain {param} tokens. */
  query?: Record<string, string>;
  /** Static + templated headers. Values may contain {param} tokens. */
  headers?: Record<string, string>;
  /**
   * Request body. For JSON bodies use an object whose string leaves may contain
   * {param} tokens; for raw bodies use a string template. Ignored for GET/HEAD.
   */
  body?: unknown;
  /** When true, send `body` as application/json (default for object bodies). */
  jsonBody?: boolean;
}

export type BrowserStep =
  | { action: "goto"; url: string }
  | { action: "click"; selector: string }
  | { action: "type"; selector: string; text: string }
  | { action: "waitFor"; selector: string }
  | { action: "extractText"; selector?: string; as?: string }
  | { action: "extractAttribute"; selector: string; attribute: string; as?: string }
  | { action: "screenshot"; as?: string };

export interface BrowserRecipe {
  kind: "browser";
  /** Starting URL (may contain {param} tokens). */
  startUrl: string;
  steps: BrowserStep[];
}

export type ToolRecipe = HttpRecipe | BrowserRecipe;

export type AuthType = "none" | "bearer" | "api_key_header" | "query";

export interface AuthConfig {
  type: AuthType;
  /** Header or query-param name for api_key_header / query auth. */
  name?: string;
}

export interface ServerContext {
  baseUrl: string | null;
  auth: AuthConfig;
  credentialRef: string | null;
  allowPrivateNetwork: boolean;
}

export interface ExecutionResult {
  ok: boolean;
  kind: ToolExecutionKind;
  status?: number;
  durationMs: number;
  body?: unknown;
  extracted?: Record<string, unknown>;
  error?: string;
}

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

function toScalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/** Replace {token} occurrences in a string with values from `args`. */
export function renderTemplate(
  template: string,
  args: Record<string, unknown>,
): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, key: string) =>
    key in args ? toScalar(args[key]) : "",
  );
}

/** Thrown when a path argument cannot be safely placed in a URL segment. */
export class UnsafePathArgumentError extends Error {}

/**
 * Percent-encode a single value so it is safe to splice into a URL path
 * SEGMENT. `encodeURIComponent` escapes `/`, `?`, and `#`, so an argument can no
 * longer change the host, add a query string / fragment, or split into extra
 * path segments — any value with other characters becomes one inert segment.
 *
 * The one case encoding cannot fix is a value that is exactly a relative
 * dot-segment (`.` or `..`): the WHATWG URL parser decodes and collapses every
 * encoding of those (`%2e`, `%2E`, `.%2e`, …) during path normalization, so the
 * segment would still traverse the path. Such a value is therefore rejected
 * outright (fail fast, no request) rather than silently altering the path.
 */
function encodePathValue(value: unknown): string {
  const raw = toScalar(value);
  if (raw === "." || raw === "..") {
    throw new UnsafePathArgumentError(
      `Unsafe path argument "${raw}": a path segment may not be a relative dot-segment.`,
    );
  }
  return encodeURIComponent(raw);
}

/**
 * Render a URL path template, percent-encoding each substituted argument so a
 * value cannot inject query/fragment delimiters or traverse the path. Static
 * structure in the template (its literal `/` separators) is preserved; only the
 * `{token}` substitutions are encoded.
 */
export function renderPathTemplate(
  template: string,
  args: Record<string, unknown>,
): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, key: string) =>
    key in args ? encodePathValue(args[key]) : "",
  );
}

// ---------------------------------------------------------------------------
// Argument validation (minimal JSON-Schema checker)
// ---------------------------------------------------------------------------

function jsonTypeOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

/** Validate one value against a JSON-Schema property node. Returns an error
 * sentence (without the field name) or null when the value is acceptable. */
function validateValue(
  value: unknown,
  propSchema: Record<string, unknown>,
): string | null {
  const expected = propSchema.type;
  if (typeof expected === "string") {
    const actual = jsonTypeOf(value);
    const typeOk =
      expected === "integer"
        ? actual === "number" && Number.isInteger(value as number)
        : expected === "number"
          ? actual === "number"
          : expected === "string"
            ? actual === "string"
            : expected === "boolean"
              ? actual === "boolean"
              : expected === "array"
                ? actual === "array"
                : expected === "object"
                  ? actual === "object"
                  : // Unknown / unsupported type keyword: don't reject.
                    true;
    if (!typeOk) return `must be of type ${expected} (got ${actual})`;
  }
  if (Array.isArray(propSchema.enum) && !propSchema.enum.includes(value)) {
    return `must be one of ${JSON.stringify(propSchema.enum)}`;
  }
  return null;
}

/**
 * Validate a tool call's arguments against the capability's stored JSON input
 * schema BEFORE any request is built. Returns a human-readable error string
 * describing every violation, or null when the arguments satisfy the schema.
 *
 * This is a deliberately minimal checker (no external dependency — the package
 * firewall blocks ad-hoc installs): it enforces `required` presence and the
 * declared `type`/`enum` of each known property. Unknown properties are allowed
 * (additionalProperties defaults to true), and a missing/non-object schema
 * imposes no constraints so legacy tools keep working unchanged.
 */
export function validateArgsAgainstSchema(
  schema: unknown,
  args: Record<string, unknown>,
): string | null {
  if (!schema || typeof schema !== "object") return null;
  const s = schema as {
    type?: unknown;
    properties?: unknown;
    required?: unknown;
  };
  // Tool input schemas are always object schemas; if a non-object type is
  // declared we can't meaningfully validate the args bag, so impose nothing.
  if (s.type !== undefined && s.type !== "object") return null;

  const errors: string[] = [];
  const required = Array.isArray(s.required)
    ? s.required.filter((r): r is string => typeof r === "string")
    : [];
  for (const key of required) {
    const v = args[key];
    if (!(key in args) || v === undefined || v === null) {
      errors.push(`missing required argument "${key}"`);
    }
  }

  const props =
    s.properties && typeof s.properties === "object"
      ? (s.properties as Record<string, unknown>)
      : {};
  for (const [key, value] of Object.entries(args)) {
    // Absent/null values are governed by the required check above; a non-null
    // value for a non-required field is still type-checked.
    if (value === undefined || value === null) continue;
    const propSchema = props[key];
    if (!propSchema || typeof propSchema !== "object") continue;
    const err = validateValue(value, propSchema as Record<string, unknown>);
    if (err) errors.push(`argument "${key}" ${err}`);
  }

  return errors.length > 0 ? errors.join("; ") : null;
}

function renderDeep(value: unknown, args: Record<string, unknown>): unknown {
  if (typeof value === "string") return renderTemplate(value, args);
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, args));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = renderDeep(v, args);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

function ipIsPrivate(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const parts = ip.split(".").map((n) => parseInt(n, 10));
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true; // loopback
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local + metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  // IPv6
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
  if (lower.startsWith("fe80")) return true; // link-local
  // IPv4-mapped IPv6 in dotted form (::ffff:a.b.c.d).
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipIsPrivate(mapped[1]);
  // IPv4-mapped IPv6 in compressed hex form (::ffff:hhhh:hhhh), which is how
  // URL/DNS normalization renders e.g. ::ffff:10.0.0.1 as ::ffff:a00:1.
  const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16);
    const lo = parseInt(hexMapped[2], 16);
    const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return ipIsPrivate(ipv4);
  }
  return false;
}

/**
 * Validate a URL and (when not allowing private access) resolve its host,
 * returning both the parsed URL and the concrete addresses it resolves to.
 * Throws on disallowed protocols or private/internal resolution.
 */
export async function resolveSafeTarget(
  rawUrl: string,
  allowPrivate: boolean,
): Promise<{ url: URL; addresses: string[] }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Blocked non-HTTP(S) protocol: ${url.protocol}`);
  }
  if (allowPrivate) return { url, addresses: [] };

  const host = url.hostname;
  // Block obvious local names outright.
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  ) {
    throw new Error(
      `Blocked private host "${host}". Enable private-network access on this server to allow it.`,
    );
  }
  // For a literal IP host, `url.hostname` keeps the IPv6 brackets (e.g.
  // "[::1]"), which would defeat isIP/ipIsPrivate and make IPv6 private-range
  // detection dead. Strip them before classifying.
  const hostIp =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  // If the host is a literal IP, check it directly; otherwise resolve.
  const literals = isIP(hostIp) ? [hostIp] : [];
  let addresses = literals;
  if (addresses.length === 0) {
    try {
      const records = await lookup(host, { all: true });
      addresses = records.map((r) => r.address);
    } catch {
      throw new Error(`Could not resolve host "${host}".`);
    }
  }
  if (addresses.length === 0) {
    throw new Error(`Could not resolve host "${host}".`);
  }
  for (const addr of addresses) {
    if (ipIsPrivate(addr)) {
      throw new Error(
        `Blocked request to private/internal address (${addr}) for host "${host}". Enable private-network access on this server to allow it.`,
      );
    }
  }
  return { url, addresses };
}

/**
 * Validate that a URL is safe to fetch. Throws on disallowed protocols or, when
 * `allowPrivate` is false, on hosts that resolve to private/internal addresses.
 * Returns the parsed URL.
 */
export async function assertSafeUrl(
  rawUrl: string,
  allowPrivate: boolean,
): Promise<URL> {
  return (await resolveSafeTarget(rawUrl, allowPrivate)).url;
}

/**
 * Build an undici dispatcher that pins outbound connections to the exact
 * addresses we already validated. This closes the DNS-rebinding (TOCTOU) window
 * where a hostname could resolve to a public IP during validation and a private
 * IP at connect time.
 */
function pinnedAgent(addresses: string[]): Agent {
  return new Agent({
    connect: {
      lookup: (
        _hostname: string,
        _options: unknown,
        callback: (
          err: NodeJS.ErrnoException | null,
          address: string | { address: string; family: number }[],
          family?: number,
        ) => void,
      ) => {
        const recs = addresses.map((a) => ({
          address: a,
          family: (isIP(a) || 4) as number,
        }));
        const all =
          typeof _options === "object" &&
          _options !== null &&
          (_options as { all?: boolean }).all === true;
        if (all) {
          callback(null, recs);
        } else {
          callback(null, recs[0].address, recs[0].family);
        }
      },
    },
  });
}

export interface SafeFetchResult {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Headers;
  text: () => Promise<string>;
}

/**
 * SSRF-safe fetch: validates every URL (including each redirect hop), pins
 * connections to the validated IPs, and follows redirects manually so a 3xx to
 * a private/internal target can never slip past the guard.
 */
export async function safeFetch(
  rawUrl: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
    maxRedirects?: number;
    /** Extra header names (besides the standard auth set) to strip when a
     * redirect crosses to a different origin — e.g. a custom API-key header. */
    sensitiveHeaders?: string[];
  },
  allowPrivate: boolean,
): Promise<SafeFetchResult> {
  const maxRedirects = init.maxRedirects ?? 5;
  let current = rawUrl;
  let method = init.method ?? "GET";
  let body = init.body;
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let originalOrigin: string | null = null;
  try {
    originalOrigin = new URL(rawUrl).origin;
  } catch {
    originalOrigin = null;
  }
  const sensitive = new Set(
    [
      "authorization",
      "proxy-authorization",
      "cookie",
      ...(init.sensitiveHeaders ?? []),
    ].map((h) => h.toLowerCase()),
  );
  let headers = init.headers;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const { url, addresses } = await resolveSafeTarget(current, allowPrivate);
    // Once a redirect leaves the original origin, drop credential-bearing
    // headers so an upstream open redirect cannot exfiltrate adapter secrets.
    if (headers && originalOrigin && url.origin !== originalOrigin) {
      const filtered: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) {
        if (!sensitive.has(k.toLowerCase())) filtered[k] = v;
      }
      headers = filtered;
    }
    const dispatcher = allowPrivate ? undefined : pinnedAgent(addresses);
    let res: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      res = await undiciFetch(url.toString(), {
        method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        ...(dispatcher ? { dispatcher } : {}),
      });
    } finally {
      if (dispatcher) void dispatcher.close().catch(() => undefined);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (location) {
        const next = new URL(location, url);
        // Per fetch semantics, 303 (and 301/302 from POST) downgrade to GET.
        if (
          res.status === 303 ||
          ((res.status === 301 || res.status === 302) && method === "POST")
        ) {
          method = "GET";
          body = undefined;
        }
        current = next.toString();
        continue;
      }
    }

    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      statusText: res.statusText,
      headers: res.headers as unknown as Headers,
      text: () => res.text(),
    };
  }
  throw new Error("Too many redirects.");
}

// ---------------------------------------------------------------------------
// HTTP execution
// ---------------------------------------------------------------------------

const MAX_BODY_CHARS = 200_000;
const DEFAULT_TIMEOUT_MS = 20_000;

function applyAuth(
  url: URL,
  headers: Record<string, string>,
  ctx: ServerContext,
): void {
  if (ctx.auth.type === "none") return;
  const secret = resolveSecret(ctx.credentialRef);
  if (!secret) return;
  switch (ctx.auth.type) {
    case "bearer":
      headers["authorization"] = `Bearer ${secret}`;
      break;
    case "api_key_header":
      headers[(ctx.auth.name || "x-api-key").toLowerCase()] = secret;
      break;
    case "query":
      url.searchParams.set(ctx.auth.name || "api_key", secret);
      break;
  }
}

export async function executeHttpTool(
  recipe: HttpRecipe,
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<ExecutionResult> {
  const started = Date.now();
  if (!ctx.baseUrl) {
    return {
      ok: false,
      kind: "http",
      durationMs: 0,
      error: "Constructed server has no base URL configured.",
    };
  }
  let path: string;
  try {
    path = renderPathTemplate(recipe.pathTemplate, args);
  } catch (err) {
    return {
      ok: false,
      kind: "http",
      durationMs: Date.now() - started,
      error:
        err instanceof Error ? err.message : "Invalid path argument.",
    };
  }
  const base = ctx.baseUrl.replace(/\/+$/, "");
  const joined = path.startsWith("/") ? `${base}${path}` : `${base}/${path}`;

  let url: URL;
  try {
    url = new URL(joined);
  } catch {
    return {
      ok: false,
      kind: "http",
      durationMs: Date.now() - started,
      error: `Invalid URL: ${joined}`,
    };
  }

  if (recipe.query) {
    for (const [k, v] of Object.entries(recipe.query)) {
      const rendered = renderTemplate(v, args);
      if (rendered !== "") url.searchParams.set(k, rendered);
    }
  }

  const headers: Record<string, string> = {};
  if (recipe.headers) {
    for (const [k, v] of Object.entries(recipe.headers)) {
      headers[k.toLowerCase()] = renderTemplate(v, args);
    }
  }

  const method = recipe.method;
  let bodyInit: string | undefined;
  if (method !== "GET" && method !== "HEAD" && recipe.body !== undefined) {
    const rendered = renderDeep(recipe.body, args);
    if (typeof rendered === "string" && recipe.jsonBody !== true) {
      bodyInit = rendered;
    } else {
      bodyInit = JSON.stringify(rendered);
      if (!headers["content-type"]) headers["content-type"] = "application/json";
    }
  }

  applyAuth(url, headers, ctx);
  if (!headers["accept"]) headers["accept"] = "application/json, text/*;q=0.9, */*;q=0.5";

  // When auth is injected as a custom API-key header, mark it sensitive so it
  // is stripped on cross-origin redirects (Bearer/cookie are stripped already).
  const sensitiveHeaders =
    ctx.auth.type === "api_key_header"
      ? [(ctx.auth.name || "x-api-key").toLowerCase()]
      : undefined;

  try {
    const res = await safeFetch(
      url.toString(),
      { method, headers, body: bodyInit, sensitiveHeaders },
      ctx.allowPrivateNetwork,
    );
    const contentType = res.headers.get("content-type") ?? "";
    const raw = await res.text();
    const truncated = raw.length > MAX_BODY_CHARS;
    const text = truncated ? raw.slice(0, MAX_BODY_CHARS) : raw;
    let body: unknown = text;
    if (contentType.includes("application/json")) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return {
      ok: res.ok,
      kind: "http",
      status: res.status,
      durationMs: Date.now() - started,
      body,
      ...(truncated ? { extracted: { truncated: true } } : {}),
      ...(res.ok ? {} : { error: `HTTP ${res.status} ${res.statusText}` }),
    };
  } catch (err) {
    return {
      ok: false,
      kind: "http",
      durationMs: Date.now() - started,
      error:
        err instanceof Error
          ? err.name === "TimeoutError"
            ? `Request timed out after ${DEFAULT_TIMEOUT_MS}ms.`
            : err.message
          : "Request failed.",
    };
  }
}

// ---------------------------------------------------------------------------
// Central dispatch
// ---------------------------------------------------------------------------

export async function executeRecipe(
  recipe: ToolRecipe,
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<ExecutionResult> {
  if (recipe.kind === "http") {
    return executeHttpTool(recipe, ctx, args);
  }
  if (recipe.kind === "browser") {
    const { executeBrowserTool } = await import("./browserTools");
    return executeBrowserTool(recipe, ctx, args);
  }
  return {
    ok: false,
    kind: "http",
    durationMs: 0,
    error: `Unknown tool execution kind.`,
  };
}

/** Narrow an arbitrary stored recipe into a typed ToolRecipe, or null. */
export function parseRecipe(value: unknown): ToolRecipe | null {
  if (!value || typeof value !== "object") return null;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "http") {
    const r = value as Partial<HttpRecipe>;
    if (typeof r.pathTemplate !== "string" || typeof r.method !== "string") {
      return null;
    }
    return value as HttpRecipe;
  }
  if (kind === "browser") {
    const r = value as Partial<BrowserRecipe>;
    if (typeof r.startUrl !== "string" || !Array.isArray(r.steps)) return null;
    return value as BrowserRecipe;
  }
  return null;
}

// ---------------------------------------------------------------------------
// OpenAPI import
// ---------------------------------------------------------------------------

export interface ParsedTool {
  name: string;
  description: string | null;
  actionKind: "read" | "list" | "create" | "update" | "destructive" | "custom";
  riskTier: "L1" | "L2" | "L3";
  humanReviewRequired: boolean;
  inputSchema: Record<string, unknown>;
  recipe: HttpRecipe;
}

export interface ParsedOpenApi {
  title: string | null;
  baseUrl: string | null;
  tools: ParsedTool[];
}

const METHOD_KEYS = ["get", "post", "put", "patch", "delete", "head"] as const;

function methodRisk(method: string): {
  actionKind: ParsedTool["actionKind"];
  riskTier: ParsedTool["riskTier"];
  review: boolean;
} {
  switch (method) {
    case "get":
    case "head":
      return { actionKind: "read", riskTier: "L1", review: false };
    case "post":
      return { actionKind: "create", riskTier: "L2", review: false };
    case "put":
    case "patch":
      return { actionKind: "update", riskTier: "L2", review: false };
    case "delete":
      return { actionKind: "destructive", riskTier: "L3", review: true };
    default:
      return { actionKind: "custom", riskTier: "L2", review: false };
  }
}

function slugify(input: string): string {
  return input
    .replace(/\{([^}]+)\}/g, "by_$1")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

/**
 * Parse an OpenAPI v3 / Swagger v2 document (already JSON-decoded) into a set of
 * executable HTTP tool recipes. Best-effort: unknown shapes are skipped rather
 * than throwing so a partial spec still yields usable tools.
 */
export function openApiToTools(doc: Record<string, unknown>): ParsedOpenApi {
  const info = (doc.info as Record<string, unknown> | undefined) ?? {};
  const title = typeof info.title === "string" ? info.title : null;

  // Base URL: OpenAPI v3 `servers[0].url`, else Swagger v2 host+basePath.
  let baseUrl: string | null = null;
  const servers = doc.servers as Array<{ url?: string }> | undefined;
  if (Array.isArray(servers) && servers[0]?.url) {
    baseUrl = servers[0].url;
  } else if (typeof doc.host === "string") {
    const scheme = Array.isArray(doc.schemes) && doc.schemes.includes("https")
      ? "https"
      : Array.isArray(doc.schemes) && doc.schemes.length > 0
        ? String((doc.schemes as string[])[0])
        : "https";
    baseUrl = `${scheme}://${doc.host}${typeof doc.basePath === "string" ? doc.basePath : ""}`;
  }

  const paths = (doc.paths as Record<string, unknown> | undefined) ?? {};
  const tools: ParsedTool[] = [];
  const usedNames = new Set<string>();

  for (const [pathKey, pathItemRaw] of Object.entries(paths)) {
    const pathItem = pathItemRaw as Record<string, unknown>;
    for (const method of METHOD_KEYS) {
      const opRaw = pathItem[method];
      if (!opRaw || typeof opRaw !== "object") continue;
      const op = opRaw as Record<string, unknown>;

      let name =
        typeof op.operationId === "string" && op.operationId.length > 0
          ? slugify(op.operationId)
          : slugify(`${method}_${pathKey}`);
      if (!name) name = `${method}_op`;
      let unique = name;
      let n = 2;
      while (usedNames.has(unique)) unique = `${name}_${n++}`;
      usedNames.add(unique);

      const { actionKind, riskTier, review } = methodRisk(method);
      const description =
        typeof op.summary === "string"
          ? op.summary
          : typeof op.description === "string"
            ? op.description
            : null;

      // Collect parameters from the operation + path-level params.
      const params: Array<Record<string, unknown>> = [];
      for (const src of [pathItem.parameters, op.parameters]) {
        if (Array.isArray(src)) params.push(...(src as Record<string, unknown>[]));
      }

      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      const query: Record<string, string> = {};

      for (const p of params) {
        const pname = typeof p.name === "string" ? p.name : null;
        const where = typeof p.in === "string" ? p.in : null;
        if (!pname || !where) continue;
        const schema =
          (p.schema as Record<string, unknown> | undefined) ?? {
            type: typeof p.type === "string" ? p.type : "string",
          };
        properties[pname] = {
          ...schema,
          description:
            typeof p.description === "string" ? p.description : undefined,
        };
        if (p.required === true || where === "path") required.push(pname);
        if (where === "query") query[pname] = `{${pname}}`;
      }

      // Request body (OpenAPI v3): expose a single `body` object argument.
      let body: unknown;
      let jsonBody = false;
      const requestBody = op.requestBody as Record<string, unknown> | undefined;
      if (requestBody) {
        const content = requestBody.content as
          | Record<string, { schema?: Record<string, unknown> }>
          | undefined;
        const jsonSchema = content?.["application/json"]?.schema;
        properties["body"] = jsonSchema ?? { type: "object" };
        if (requestBody.required === true) required.push("body");
        body = "{body}";
        jsonBody = true;
      }

      const recipe: HttpRecipe = {
        kind: "http",
        method: method.toUpperCase() as HttpRecipe["method"],
        pathTemplate: pathKey,
        ...(Object.keys(query).length > 0 ? { query } : {}),
        ...(body !== undefined ? { body, jsonBody } : {}),
      };

      tools.push({
        name: unique,
        description,
        actionKind,
        riskTier,
        humanReviewRequired: review,
        inputSchema: {
          type: "object",
          properties,
          ...(required.length > 0 ? { required } : {}),
        },
        recipe,
      });
    }
  }

  return { title, baseUrl, tools };
}
