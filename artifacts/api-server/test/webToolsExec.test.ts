import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Execution-path hardening tests for constructed web tools (webTools.ts):
//   1. validateArgsAgainstSchema — rejects missing-required / wrong-type / bad
//      enum, accepts well-formed args.
//   2. renderPathTemplate / executeHttpTool — a path argument can no longer
//      inject query/fragment delimiters, split into extra segments, or traverse
//      the path; normal values are left byte-for-byte unchanged.
//   3. Query-string params stay percent-encoded (no param injection).
//   4. safeFetch — cross-origin redirects strip Authorization / cookie / a
//      custom API-key header, while same-origin redirects keep them.
//   5. resolveSafeTarget — the SSRF blocklist covers the private IPv4 + IPv6
//      ranges and still lets public targets through (and `allowPrivate` opts out).
//
// webTools.ts imports only secretStore (node builtins) so NO @workspace/db mock
// is required here — the module is imported directly.
// ---------------------------------------------------------------------------

const {
  validateArgsAgainstSchema,
  renderPathTemplate,
  executeHttpTool,
  safeFetch,
  resolveSafeTarget,
} = await import("../src/lib/webTools.ts");

// A constructed-server context that allows private addresses, so the SSRF guard
// lets these tests reach a loopback stub server. SSRF blocking itself is tested
// separately against resolveSafeTarget with allowPrivate=false.
const LOCAL_CTX = {
  baseUrl: "", // filled per-server in before()
  auth: { type: "none" as const },
  credentialRef: null,
  allowPrivateNetwork: true,
};

// ---------------------------------------------------------------------------
// 1. Argument validation
// ---------------------------------------------------------------------------

describe("validateArgsAgainstSchema", () => {
  const schema = {
    type: "object",
    properties: {
      id: { type: "string" },
      count: { type: "integer" },
      ratio: { type: "number" },
      flag: { type: "boolean" },
      tags: { type: "array" },
      mode: { type: "string", enum: ["fast", "slow"] },
    },
    required: ["id", "count"],
  };

  it("accepts well-formed arguments", () => {
    assert.equal(
      validateArgsAgainstSchema(schema, {
        id: "abc",
        count: 3,
        ratio: 1.5,
        flag: true,
        tags: ["x"],
        mode: "fast",
      }),
      null,
    );
  });

  it("rejects a missing required field with a clear message", () => {
    const err = validateArgsAgainstSchema(schema, { id: "abc" });
    assert.ok(err);
    assert.match(err, /missing required argument "count"/);
  });

  it("treats an explicit null/undefined required field as missing", () => {
    const err = validateArgsAgainstSchema(schema, { id: "abc", count: null });
    assert.ok(err);
    assert.match(err, /missing required argument "count"/);
  });

  it("rejects a wrong-typed field (string where integer expected)", () => {
    const err = validateArgsAgainstSchema(schema, { id: "abc", count: "3" });
    assert.ok(err);
    assert.match(err, /argument "count" must be of type integer \(got string\)/);
  });

  it("rejects a non-integer number for an integer field", () => {
    const err = validateArgsAgainstSchema(schema, { id: "abc", count: 1.5 });
    assert.ok(err);
    assert.match(err, /argument "count" must be of type integer/);
  });

  it("rejects a value outside the declared enum", () => {
    const err = validateArgsAgainstSchema(schema, {
      id: "abc",
      count: 1,
      mode: "turbo",
    });
    assert.ok(err);
    assert.match(err, /argument "mode" must be one of/);
  });

  it("allows unknown extra properties (additionalProperties default)", () => {
    assert.equal(
      validateArgsAgainstSchema(schema, { id: "a", count: 1, extra: "ok" }),
      null,
    );
  });

  it("imposes no constraints when there is no usable schema", () => {
    assert.equal(validateArgsAgainstSchema(null, { anything: 1 }), null);
    assert.equal(validateArgsAgainstSchema({}, { anything: 1 }), null);
    assert.equal(
      validateArgsAgainstSchema({ type: "string" }, { anything: 1 }),
      null,
    );
  });
});

// ---------------------------------------------------------------------------
// 2 + 3. Path-injection containment & query encoding (via executeHttpTool)
// ---------------------------------------------------------------------------

describe("renderPathTemplate (unit)", () => {
  it("encodes injection delimiters in a substituted value", () => {
    assert.equal(
      renderPathTemplate("/items/{id}", { id: "../../admin?x=1#f" }),
      "/items/..%2F..%2Fadmin%3Fx%3D1%23f",
    );
  });

  it("rejects a bare dot-segment value (WHATWG URL would collapse any encoding)", () => {
    assert.throws(() => renderPathTemplate("/items/{id}", { id: ".." }), /dot-segment/);
    assert.throws(() => renderPathTemplate("/items/{id}", { id: "." }), /dot-segment/);
  });

  it("leaves ordinary values (including dotted filenames) unchanged", () => {
    assert.equal(
      renderPathTemplate("/files/{name}", { name: "report.pdf" }),
      "/files/report.pdf",
    );
    assert.equal(renderPathTemplate("/items/{id}", { id: "123" }), "/items/123");
  });

  it("preserves the template's own static path separators", () => {
    assert.equal(
      renderPathTemplate("/a/{x}/b/{y}", { x: "1", y: "2" }),
      "/a/1/b/2",
    );
  });
});

describe("executeHttpTool request shaping", () => {
  let server: http.Server;
  let baseUrl: string;
  let lastUrl = "";

  before(async () => {
    server = http.createServer((req, res) => {
      lastUrl = req.url ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(() => server.close());

  it("contains a path-injection argument to a single encoded segment", async () => {
    const ctx = { ...LOCAL_CTX, baseUrl };
    const res = await executeHttpTool(
      { kind: "http", method: "GET", pathTemplate: "/items/{id}" },
      ctx,
      { id: "../../admin?x=1#frag" },
    );
    assert.equal(res.ok, true);
    const parsed = new URL(lastUrl, baseUrl);
    // The host/path structure is intact and no query/fragment was injected.
    assert.equal(parsed.pathname, "/items/..%2F..%2Fadmin%3Fx%3D1%23frag");
    assert.equal(parsed.search, "");
  });

  it("rejects a bare '..' argument with no outbound request", async () => {
    const ctx = { ...LOCAL_CTX, baseUrl };
    lastUrl = "";
    const res = await executeHttpTool(
      { kind: "http", method: "GET", pathTemplate: "/items/{id}/sub" },
      ctx,
      { id: ".." },
    );
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /dot-segment/);
    assert.equal(lastUrl, ""); // server never received a request
  });

  it("percent-encodes query params so a value cannot inject extra params", async () => {
    const ctx = { ...LOCAL_CTX, baseUrl };
    await executeHttpTool(
      {
        kind: "http",
        method: "GET",
        pathTemplate: "/search",
        query: { q: "{term}" },
      },
      ctx,
      { term: "a&b=c d" },
    );
    const parsed = new URL(lastUrl, baseUrl);
    assert.equal(parsed.searchParams.get("q"), "a&b=c d");
    // Exactly one param — the "&b=c" did not split into a second one.
    assert.deepEqual([...parsed.searchParams.keys()], ["q"]);
  });

  it("leaves a well-formed call's URL unchanged", async () => {
    const ctx = { ...LOCAL_CTX, baseUrl };
    await executeHttpTool(
      {
        kind: "http",
        method: "GET",
        pathTemplate: "/files/{name}",
        query: { v: "{ver}" },
      },
      ctx,
      { name: "report.pdf", ver: "2" },
    );
    const parsed = new URL(lastUrl, baseUrl);
    assert.equal(parsed.pathname, "/files/report.pdf");
    assert.equal(parsed.searchParams.get("v"), "2");
  });
});

// ---------------------------------------------------------------------------
// 4. Cross-origin redirect secret stripping (safeFetch)
// ---------------------------------------------------------------------------

describe("safeFetch redirect credential handling", () => {
  let originA: http.Server;
  let originB: http.Server;
  let urlA: string;
  let urlB: string;
  let received: Record<string, unknown> = {};

  before(async () => {
    originB = http.createServer((req, res) => {
      received = { origin: "B", headers: req.headers };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ at: "B" }));
    });
    await new Promise<void>((r) => originB.listen(0, "127.0.0.1", r));
    urlB = `http://127.0.0.1:${(originB.address() as AddressInfo).port}`;

    originA = http.createServer((req, res) => {
      if (req.url === "/cross") {
        res.writeHead(302, { location: `${urlB}/dest` });
        res.end();
        return;
      }
      if (req.url === "/same") {
        res.writeHead(302, { location: "/landing" });
        res.end();
        return;
      }
      // /landing (same-origin destination) or /dest echoes what it received.
      received = { origin: "A", headers: req.headers };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ at: "A" }));
    });
    await new Promise<void>((r) => originA.listen(0, "127.0.0.1", r));
    urlA = `http://127.0.0.1:${(originA.address() as AddressInfo).port}`;
  });

  after(() => {
    originA.close();
    originB.close();
  });

  const sensitiveInit = {
    headers: {
      authorization: "Bearer secret-token",
      cookie: "session=abc",
      "x-api-key": "k-123",
      "x-keep-me": "fine",
    },
    sensitiveHeaders: ["x-api-key"],
  };

  it("strips Authorization/cookie/custom-API-key on a cross-origin redirect", async () => {
    const res = await safeFetch(`${urlA}/cross`, sensitiveInit, true);
    assert.equal(res.ok, true);
    assert.equal((received as any).origin, "B");
    const h = (received as any).headers as Record<string, string>;
    assert.equal(h.authorization, undefined);
    assert.equal(h.cookie, undefined);
    assert.equal(h["x-api-key"], undefined);
    // Non-sensitive headers survive the hop.
    assert.equal(h["x-keep-me"], "fine");
  });

  it("preserves credentials across a same-origin redirect", async () => {
    const res = await safeFetch(`${urlA}/same`, sensitiveInit, true);
    assert.equal(res.ok, true);
    assert.equal((received as any).origin, "A");
    const h = (received as any).headers as Record<string, string>;
    assert.equal(h.authorization, "Bearer secret-token");
    assert.equal(h.cookie, "session=abc");
    assert.equal(h["x-api-key"], "k-123");
  });
});

// ---------------------------------------------------------------------------
// 5. SSRF blocklist (resolveSafeTarget)
// ---------------------------------------------------------------------------

describe("resolveSafeTarget SSRF blocklist", () => {
  const blockedV4 = [
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254", // cloud metadata
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "100.64.0.1", // CGNAT
    "0.0.0.0",
  ];
  const blockedV6 = ["::1", "fc00::1", "fd12::1", "fe80::1", "::ffff:10.0.0.1"];

  for (const ip of blockedV4) {
    it(`blocks private IPv4 ${ip}`, async () => {
      await assert.rejects(resolveSafeTarget(`http://${ip}/`, false), /private|internal/i);
    });
  }

  for (const ip of blockedV6) {
    it(`blocks private IPv6 ${ip}`, async () => {
      await assert.rejects(resolveSafeTarget(`http://[${ip}]/`, false), /private|internal/i);
    });
  }

  it("blocks local hostnames outright", async () => {
    await assert.rejects(resolveSafeTarget("http://localhost/", false), /private/i);
    await assert.rejects(resolveSafeTarget("http://foo.internal/", false), /private/i);
  });

  it("blocks non-HTTP(S) protocols", async () => {
    await assert.rejects(resolveSafeTarget("file:///etc/passwd", false), /protocol/i);
  });

  it("allows a public IP target", async () => {
    const { url } = await resolveSafeTarget("http://8.8.8.8/", false);
    assert.equal(url.hostname, "8.8.8.8");
  });

  it("opts out of blocking when allowPrivate is true", async () => {
    const { url } = await resolveSafeTarget("http://127.0.0.1/", true);
    assert.equal(url.hostname, "127.0.0.1");
  });
});
