import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Unit tests for the Firecrawl web-tool client. firecrawl.ts has no module
// dependencies of its own — it only uses the global `fetch`, `process.env`,
// and timers — so these tests exercise the REAL module and stub `globalThis`
// primitives (fetch / Date.now / setTimeout). No live network, no DB.
// ---------------------------------------------------------------------------
const {
  FirecrawlError,
  firecrawlApiKey,
  isFirecrawlConfigured,
  firecrawlScrape,
  firecrawlSearch,
  firecrawlMap,
  firecrawlCrawl,
} = await import("../src/lib/firecrawl");

const KEY = "fc-test-key";

/** Build a minimal `Response`-like object the client understands. */
function makeRes(
  body: unknown,
  opts: { ok?: boolean; status?: number; statusText?: string } = {},
): any {
  const text =
    typeof body === "string" ? body : body == null ? "" : JSON.stringify(body);
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    statusText: opts.statusText ?? "OK",
    text: async () => text,
  };
}

/** Capture of one fetch call (url + parsed JSON body) for assertions. */
interface FetchCall {
  url: string;
  method: string;
  body: any;
}

const realFetch = globalThis.fetch;
const realDateNow = Date.now;
const realSetTimeout = globalThis.setTimeout;
let calls: FetchCall[] = [];

/**
 * Install a fetch stub. `responder(call)` returns the Response-like object (or
 * throws to simulate a network/timeout failure).
 */
function stubFetch(responder: (call: FetchCall) => any): void {
  globalThis.fetch = (async (url: any, init: any) => {
    const call: FetchCall = {
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return responder(call);
  }) as any;
}

beforeEach(() => {
  calls = [];
  process.env.FIRECRAWL_API_KEY = KEY;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realDateNow;
  globalThis.setTimeout = realSetTimeout;
});

describe("firecrawl key configuration", () => {
  it("reports the key as configured when set", () => {
    process.env.FIRECRAWL_API_KEY = "  spaced-key  ";
    assert.equal(firecrawlApiKey(), "spaced-key");
    assert.equal(isFirecrawlConfigured(), true);
  });

  it("reports not-configured when the key is missing or blank", () => {
    delete process.env.FIRECRAWL_API_KEY;
    assert.equal(firecrawlApiKey(), null);
    assert.equal(isFirecrawlConfigured(), false);

    process.env.FIRECRAWL_API_KEY = "   ";
    assert.equal(firecrawlApiKey(), null);
    assert.equal(isFirecrawlConfigured(), false);
  });

  it("throws a FirecrawlError (and never calls fetch) when no key is set", async () => {
    delete process.env.FIRECRAWL_API_KEY;
    stubFetch(() => makeRes({ data: {} }));

    await assert.rejects(
      firecrawlScrape({ url: "https://example.com" }),
      (err: unknown) => {
        assert.ok(err instanceof FirecrawlError);
        assert.match((err as Error).message, /not configured/i);
        return true;
      },
    );
    assert.equal(calls.length, 0);
  });
});

describe("firecrawl error translation", () => {
  it("surfaces the API's error message on an HTTP error", async () => {
    stubFetch(() =>
      makeRes(
        { error: "Insufficient credits" },
        { ok: false, status: 402, statusText: "Payment Required" },
      ),
    );
    await assert.rejects(
      firecrawlScrape({ url: "https://example.com" }),
      (err: unknown) => {
        assert.ok(err instanceof FirecrawlError);
        assert.equal((err as Error).message, "Insufficient credits");
        return true;
      },
    );
  });

  it("falls back to HTTP status text when the error body has no message", async () => {
    stubFetch(() =>
      makeRes("not json", { ok: false, status: 500, statusText: "Server Error" }),
    );
    await assert.rejects(
      firecrawlSearch({ query: "hi" }),
      (err: unknown) => {
        assert.ok(err instanceof FirecrawlError);
        assert.match((err as Error).message, /Firecrawl HTTP 500 Server Error/);
        return true;
      },
    );
  });

  it("translates a timeout abort into a FirecrawlError", async () => {
    stubFetch(() => {
      throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    });
    await assert.rejects(
      firecrawlScrape({ url: "https://example.com" }),
      (err: unknown) => {
        assert.ok(err instanceof FirecrawlError);
        assert.match((err as Error).message, /timed out/i);
        return true;
      },
    );
  });

  it("translates a generic network failure into a FirecrawlError", async () => {
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    await assert.rejects(
      firecrawlMap({ url: "https://example.com" }),
      (err: unknown) => {
        assert.ok(err instanceof FirecrawlError);
        assert.match((err as Error).message, /ECONNREFUSED/);
        return true;
      },
    );
  });

  it("rejects when a required argument is missing", async () => {
    stubFetch(() => makeRes({ data: {} }));
    await assert.rejects(firecrawlScrape({}), FirecrawlError);
    await assert.rejects(firecrawlSearch({}), FirecrawlError);
    await assert.rejects(firecrawlMap({}), FirecrawlError);
    await assert.rejects(firecrawlCrawl({}), FirecrawlError);
    assert.equal(calls.length, 0);
  });

  it("rejects when the response body is empty/invalid", async () => {
    stubFetch(() => makeRes(""));
    await assert.rejects(
      firecrawlScrape({ url: "https://example.com" }),
      (err: unknown) => {
        assert.ok(err instanceof FirecrawlError);
        assert.match((err as Error).message, /empty\/invalid/i);
        return true;
      },
    );
  });
});

describe("firecrawl count bounds (credit-usage safety)", () => {
  it("search clamps limit to the max and defaults when omitted", async () => {
    stubFetch(() => makeRes({ data: [] }));

    await firecrawlSearch({ query: "q", limit: 100 });
    assert.equal(calls[0].body.limit, 20);

    await firecrawlSearch({ query: "q" });
    assert.equal(calls[1].body.limit, 5);

    await firecrawlSearch({ query: "q", limit: 3 });
    assert.equal(calls[2].body.limit, 3);
  });

  it("search only requests page scraping when scrapeResults is true", async () => {
    stubFetch(() => makeRes({ data: [] }));

    await firecrawlSearch({ query: "q" });
    assert.equal(calls[0].body.scrapeOptions, undefined);

    await firecrawlSearch({ query: "q", scrapeResults: true });
    assert.deepEqual(calls[1].body.scrapeOptions, { formats: ["markdown"] });
  });

  it("map clamps limit to the max and omits it when unset", async () => {
    stubFetch(() => makeRes({ links: [] }));

    await firecrawlMap({ url: "https://example.com" });
    assert.equal("limit" in calls[0].body, false);

    await firecrawlMap({ url: "https://example.com", limit: 9999 });
    assert.equal(calls[1].body.limit, 200);
  });

  it("crawl clamps limit and maxDepth and defaults the limit when omitted", async () => {
    stubFetch((call) => {
      if (call.method === "POST") return makeRes({ id: "job-1" });
      return makeRes({ status: "completed", data: [] });
    });

    await firecrawlCrawl({ url: "https://example.com", limit: 999, maxDepth: 99 });
    const start = calls.find((c) => c.method === "POST")!;
    assert.equal(start.body.limit, 50);
    assert.equal(start.body.maxDepth, 5);

    calls = [];
    await firecrawlCrawl({ url: "https://example.com" });
    const start2 = calls.find((c) => c.method === "POST")!;
    assert.equal(start2.body.limit, 20);
    assert.equal("maxDepth" in start2.body, false);
  });
});

describe("firecrawl content truncation", () => {
  it("truncates oversized scraped markdown to the cap plus a marker", async () => {
    const huge = "a".repeat(150_000);
    stubFetch(() => makeRes({ data: { markdown: huge } }));

    const out = await firecrawlScrape({ url: "https://example.com" });
    const md = out.markdown as string;
    assert.ok(md.length < huge.length);
    assert.match(md, /\n…\[truncated\]$/);
    // The retained content is exactly the cap (100k chars) before the marker.
    assert.equal(md.replace(/\n…\[truncated\]$/, "").length, 100_000);
  });

  it("leaves small content untouched", async () => {
    stubFetch(() => makeRes({ data: { markdown: "small" } }));
    const out = await firecrawlScrape({ url: "https://example.com" });
    assert.equal(out.markdown, "small");
  });
});

describe("firecrawl crawl polling", () => {
  it("returns partial results when the time budget is exhausted", async () => {
    // Drive the deadline: 1st Date.now() builds the deadline, the next while-
    // check is inside the budget (one poll happens), the following check is
    // past the deadline so the loop exits with whatever the poll returned.
    const nowSeq = [1000, 1000, 1_000_000];
    Date.now = () => (nowSeq.length > 1 ? nowSeq.shift()! : nowSeq[0]);
    // Make the inter-poll sleep instantaneous.
    globalThis.setTimeout = ((fn: any) => {
      fn();
      return 0 as any;
    }) as any;

    stubFetch((call) => {
      if (call.method === "POST") return makeRes({ id: "job-9" });
      return makeRes({
        status: "scraping",
        total: 10,
        completed: 2,
        data: [
          { markdown: "p1", metadata: { sourceURL: "https://x/1", title: "1" } },
          { markdown: "p2", metadata: { sourceURL: "https://x/2", title: "2" } },
        ],
      });
    });

    const out = await firecrawlCrawl({ url: "https://x" });
    assert.equal(out.jobId, "job-9");
    assert.equal(out.status, "scraping");
    assert.equal(out.stillRunning, true);
    assert.equal(out.returnedPages, 2);
    assert.equal(out.truncatedPages, false);
    assert.equal((out.pages as any[]).length, 2);
    assert.equal((out.pages as any[])[0].url, "https://x/1");
    // Exactly one status poll happened before the budget ran out.
    assert.equal(calls.filter((c) => c.method === "GET").length, 1);
  });

  it("stops polling immediately once the job is completed", async () => {
    Date.now = realDateNow;
    let polls = 0;
    stubFetch((call) => {
      if (call.method === "POST") return makeRes({ id: "job-2" });
      polls++;
      return makeRes({ status: "completed", total: 1, completed: 1, data: [] });
    });

    const out = await firecrawlCrawl({ url: "https://x" });
    assert.equal(out.status, "completed");
    assert.equal(out.stillRunning, false);
    assert.equal(polls, 1);
  });

  it("caps the number of returned pages and flags truncation", async () => {
    Date.now = realDateNow;
    const data = Array.from({ length: 30 }, (_, i) => ({
      markdown: `p${i}`,
      metadata: { sourceURL: `https://x/${i}`, title: `${i}` },
    }));
    stubFetch((call) => {
      if (call.method === "POST") return makeRes({ id: "job-3" });
      return makeRes({ status: "completed", total: 30, completed: 30, data });
    });

    const out = await firecrawlCrawl({ url: "https://x" });
    assert.equal(out.returnedPages, 25);
    assert.equal(out.truncatedPages, true);
    assert.equal((out.pages as any[]).length, 25);
  });

  it("fails when the crawl start returns no job id", async () => {
    stubFetch(() => makeRes({}));
    await assert.rejects(
      firecrawlCrawl({ url: "https://x" }),
      (err: unknown) => {
        assert.ok(err instanceof FirecrawlError);
        assert.match((err as Error).message, /job id/i);
        return true;
      },
    );
  });
});
