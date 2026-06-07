/**
 * Firecrawl web tools.
 *
 * A small, first-class client for Firecrawl's web API so any ContextOS agent
 * (and the bot) can scrape, search, map, and crawl the web instantly — without
 * having to construct a per-site web MCP first. These are the "quick web MCP":
 * one ready-made, general-purpose web capability.
 *
 * Auth: the deployed server calls Firecrawl directly with its own key (the
 * Replit-managed `externalApi__firecrawl` proxy is only available to the Agent
 * tooling sandbox, never to this runtime). The key is read from the
 * `FIRECRAWL_API_KEY` environment secret. There is no Replit OAuth connector.
 *
 * SSRF: requests go to a single fixed, trusted host (Firecrawl's API). The URL
 * the caller wants scraped/crawled is passed to Firecrawl as a parameter — this
 * server never fetches arbitrary caller-supplied URLs itself — so the
 * constructed-tool SSRF guard (which protects against fetching internal hosts)
 * does not apply here.
 */

const FIRECRAWL_BASE = (
  process.env.FIRECRAWL_API_BASE?.trim().replace(/\/+$/, "") ||
  "https://api.firecrawl.dev"
).replace(/\/+$/, "");

const SCRAPE_TIMEOUT_MS = 60_000;
const CRAWL_POLL_TIMEOUT_MS = 90_000;
const CRAWL_POLL_INTERVAL_MS = 2_000;

/** Cap any single piece of page content so a huge page can't blow up a reply. */
const MAX_CONTENT_CHARS = 100_000;
/** Cap how many crawled pages we return in one tool result. */
const MAX_CRAWL_PAGES = 25;

/** A Firecrawl-specific failure (missing key, API error, network/timeout). */
export class FirecrawlError extends Error {}

/** The Firecrawl API key from the environment, or null when not configured. */
export function firecrawlApiKey(): string | null {
  const k = process.env.FIRECRAWL_API_KEY;
  return k && k.trim() ? k.trim() : null;
}

/** Whether Firecrawl web tools are usable (an API key is configured). */
export function isFirecrawlConfigured(): boolean {
  return firecrawlApiKey() !== null;
}

/** The built-in web tool names backed by Firecrawl. */
export const FIRECRAWL_TOOL_NAMES = [
  "firecrawl_scrape",
  "firecrawl_search",
  "firecrawl_map",
  "firecrawl_crawl",
] as const;

/**
 * Notice appended to a web tool's catalog description (and surfaced to agents /
 * the bot) when Firecrawl is not configured, so they are warned up front rather
 * than discovering it only when a call fails mid-task.
 */
export const FIRECRAWL_UNCONFIGURED_NOTICE =
  "UNAVAILABLE — web access is not configured (the FIRECRAWL_API_KEY secret is " +
  "not set). Do NOT call this tool; it will fail. Tell the user to add a " +
  "Firecrawl API key to enable web scraping, search, mapping, and crawling.";

function requireKey(): string {
  const k = firecrawlApiKey();
  if (!k) {
    throw new FirecrawlError(
      "Firecrawl web tools are not configured. Set the FIRECRAWL_API_KEY " +
        "secret to enable web scraping, search, mapping, and crawling.",
    );
  }
  return k;
}

function truncate(value: unknown): unknown {
  if (typeof value === "string" && value.length > MAX_CONTENT_CHARS) {
    return `${value.slice(0, MAX_CONTENT_CHARS)}\n…[truncated]`;
  }
  return value;
}

async function firecrawlFetch<T>(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown; timeoutMs: number },
): Promise<T> {
  const key = requireKey();
  const headers: Record<string, string> = {
    authorization: `Bearer ${key}`,
  };
  let bodyInit: string | undefined;
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    bodyInit = JSON.stringify(init.body);
  }
  let res: Response;
  try {
    res = await fetch(`${FIRECRAWL_BASE}${path}`, {
      method: init.method,
      headers,
      body: bodyInit,
      signal: AbortSignal.timeout(init.timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new FirecrawlError(
        `Firecrawl request timed out after ${init.timeoutMs}ms.`,
      );
    }
    throw new FirecrawlError(
      err instanceof Error ? err.message : "Firecrawl request failed.",
    );
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const apiMsg =
      json && typeof json === "object" && "error" in json
        ? String((json as { error: unknown }).error)
        : null;
    throw new FirecrawlError(
      apiMsg ?? `Firecrawl HTTP ${res.status} ${res.statusText}`.trim(),
    );
  }
  if (json === null) {
    throw new FirecrawlError("Firecrawl returned an empty/invalid response.");
  }
  return json as T;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function posInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return undefined;
}

/**
 * Resolve a caller-supplied count to a sane, bounded value. Always returns a
 * value within [1, max]; falls back to `fallback` when omitted/invalid. This
 * caps Firecrawl credit usage so an agent (or the bot) can't request a runaway
 * search/map/crawl.
 */
function boundedInt(value: unknown, max: number, fallback: number): number {
  const n = posInt(value) ?? fallback;
  return Math.min(n, max);
}

// Hard upper bounds for caller-supplied counts (credit-usage safety).
const MAX_SEARCH_LIMIT = 20;
const MAX_MAP_LIMIT = 200;
const MAX_CRAWL_LIMIT = 50;
const MAX_CRAWL_DEPTH = 5;

// ---------------------------------------------------------------------------
// scrape
// ---------------------------------------------------------------------------

export async function firecrawlScrape(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const url = str(args.url);
  if (!url) throw new FirecrawlError("`url` is required.");
  const formats =
    Array.isArray(args.formats) && args.formats.length > 0
      ? args.formats.filter((f): f is string => typeof f === "string")
      : ["markdown"];
  const body: Record<string, unknown> = { url, formats };
  if (typeof args.onlyMainContent === "boolean") {
    body.onlyMainContent = args.onlyMainContent;
  }
  const json = await firecrawlFetch<{ data?: Record<string, unknown> }>(
    "/v1/scrape",
    { method: "POST", body, timeoutMs: SCRAPE_TIMEOUT_MS },
  );
  const data = json.data ?? {};
  return {
    url,
    markdown: truncate(data.markdown ?? null),
    html: truncate(data.html ?? null),
    links: data.links ?? null,
    metadata: data.metadata ?? null,
  };
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

export async function firecrawlSearch(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const query = str(args.query);
  if (!query) throw new FirecrawlError("`query` is required.");
  const limit = boundedInt(args.limit, MAX_SEARCH_LIMIT, 5);
  const body: Record<string, unknown> = { query, limit };
  // Optionally scrape each result's page content (markdown), not just the
  // search snippet. Costs extra Firecrawl credits per scraped result.
  if (args.scrapeResults === true) {
    body.scrapeOptions = { formats: ["markdown"] };
  }
  const json = await firecrawlFetch<{ data?: unknown }>("/v1/search", {
    method: "POST",
    body,
    timeoutMs: SCRAPE_TIMEOUT_MS,
  });
  const rows = Array.isArray(json.data) ? json.data : [];
  const results = rows.map((r) => {
    const row = (r ?? {}) as Record<string, unknown>;
    return {
      title: row.title ?? null,
      url: row.url ?? null,
      description: row.description ?? null,
      ...(row.markdown !== undefined
        ? { markdown: truncate(row.markdown) }
        : {}),
    };
  });
  return { query, count: results.length, results };
}

// ---------------------------------------------------------------------------
// map
// ---------------------------------------------------------------------------

export async function firecrawlMap(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const url = str(args.url);
  if (!url) throw new FirecrawlError("`url` is required.");
  const body: Record<string, unknown> = { url };
  const search = str(args.search);
  if (search) body.search = search;
  if (args.limit !== undefined) {
    body.limit = boundedInt(args.limit, MAX_MAP_LIMIT, MAX_MAP_LIMIT);
  }
  const json = await firecrawlFetch<{ links?: unknown }>("/v1/map", {
    method: "POST",
    body,
    timeoutMs: SCRAPE_TIMEOUT_MS,
  });
  const links = Array.isArray(json.links) ? json.links : [];
  return { url, count: links.length, links };
}

// ---------------------------------------------------------------------------
// crawl (async on Firecrawl's side — start a job, then poll to completion)
// ---------------------------------------------------------------------------

interface CrawlStatus {
  status?: string;
  total?: number;
  completed?: number;
  data?: unknown;
}

export async function firecrawlCrawl(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const url = str(args.url);
  if (!url) throw new FirecrawlError("`url` is required.");
  const body: Record<string, unknown> = {
    url,
    limit: boundedInt(args.limit, MAX_CRAWL_LIMIT, 20),
  };
  if (args.maxDepth !== undefined) {
    body.maxDepth = boundedInt(args.maxDepth, MAX_CRAWL_DEPTH, MAX_CRAWL_DEPTH);
  }

  const start = await firecrawlFetch<{ id?: string }>("/v1/crawl", {
    method: "POST",
    body,
    timeoutMs: SCRAPE_TIMEOUT_MS,
  });
  const jobId = str(start.id);
  if (!jobId) {
    throw new FirecrawlError("Firecrawl did not return a crawl job id.");
  }

  // Poll the job until it completes/fails or we hit the bounded wait. A crawl
  // can take a long time; rather than block indefinitely we return whatever has
  // completed so far plus the live status when the budget is exhausted.
  const deadline = Date.now() + CRAWL_POLL_TIMEOUT_MS;
  let last: CrawlStatus = {};
  while (Date.now() < deadline) {
    last = await firecrawlFetch<CrawlStatus>(`/v1/crawl/${jobId}`, {
      method: "GET",
      timeoutMs: SCRAPE_TIMEOUT_MS,
    });
    const status = str(last.status);
    if (status === "completed" || status === "failed") break;
    await new Promise((r) => setTimeout(r, CRAWL_POLL_INTERVAL_MS));
  }

  const pagesRaw = Array.isArray(last.data) ? last.data : [];
  const pages = pagesRaw.slice(0, MAX_CRAWL_PAGES).map((p) => {
    const page = (p ?? {}) as Record<string, unknown>;
    const meta = (page.metadata ?? {}) as Record<string, unknown>;
    return {
      url: meta.sourceURL ?? meta.url ?? null,
      title: meta.title ?? null,
      markdown: truncate(page.markdown ?? null),
    };
  });
  const status = str(last.status) || "running";
  return {
    jobId,
    status,
    total: last.total ?? null,
    completed: last.completed ?? null,
    returnedPages: pages.length,
    truncatedPages: pagesRaw.length > pages.length,
    stillRunning: status !== "completed" && status !== "failed",
    pages,
  };
}
