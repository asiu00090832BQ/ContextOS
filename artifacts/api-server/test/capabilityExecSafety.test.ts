import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Safety tests for the capability execution layer (capabilityExec.ts):
//   1. executeCapabilityRow validates args against the stored input schema and
//      makes NO outbound request when they are invalid; valid args proceed.
//   2. pickSafeSmokeCandidates (the single auto dry-run gate) only ever returns
//      read/list + riskTier L1 + GET/HEAD + !humanReviewRequired tools.
//
// capabilityExec.ts imports `db` + table objects from @workspace/db at module
// scope, so we provide a minimal mock (the functions exercised here never query
// the DB; the mock only needs to make the named imports resolve).
// ---------------------------------------------------------------------------

const table = (name: string) => ({ _name: name });
const db = {
  update: () => ({ set: () => ({ where: async () => undefined }) }),
  select: () => ({
    from: () => ({
      innerJoin: () => ({ where: () => ({ orderBy: async () => [] }) }),
      where: () => ({ orderBy: async () => [] }),
    }),
  }),
};
mock.module("@workspace/db", {
  namedExports: {
    db,
    adaptersTable: table("adapters"),
    capabilitiesTable: table("capabilities"),
  },
});

const { executeCapabilityRow, pickSafeSmokeCandidates } = await import(
  "../src/lib/capabilityExec.ts"
);

// A constructed adapter that allows private addresses so the recipe can reach a
// loopback stub (lets us assert that an INVALID call never hits it).
function adapterFor(baseUrl: string) {
  return {
    id: "a1",
    endpointUrl: baseUrl,
    credentialRef: null,
    metadataJson: { authType: "none", allowPrivateNetwork: true },
  } as any;
}

function httpCapability(
  overrides: Record<string, unknown> = {},
): any {
  return {
    id: "c1",
    name: "get_item",
    actionKind: "read",
    riskTier: "L1",
    humanReviewRequired: false,
    inputSchemaJson: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    executionJson: { kind: "http", method: "GET", pathTemplate: "/items/{id}" },
    ...overrides,
  };
}

describe("executeCapabilityRow argument validation gate", () => {
  let server: http.Server;
  let baseUrl: string;
  let hits = 0;

  before(async () => {
    server = http.createServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => server.close());

  it("rejects invalid args and makes NO outbound request", async () => {
    hits = 0;
    const res = await executeCapabilityRow(
      httpCapability(),
      adapterFor(baseUrl),
      {}, // missing required "id"
    );
    assert.equal(res.ok, false);
    assert.equal(hits, 0);
    assert.match(res.error ?? "", /Invalid arguments for "get_item"/);
    assert.match(res.error ?? "", /missing required argument "id"/);
  });

  it("rejects a wrong-typed arg without a request", async () => {
    hits = 0;
    const res = await executeCapabilityRow(
      httpCapability({
        inputSchemaJson: {
          type: "object",
          properties: { id: { type: "integer" } },
          required: ["id"],
        },
      }),
      adapterFor(baseUrl),
      { id: "not-a-number" },
    );
    assert.equal(res.ok, false);
    assert.equal(hits, 0);
    assert.match(res.error ?? "", /must be of type integer/);
  });

  it("proceeds with the request when args are valid", async () => {
    hits = 0;
    const res = await executeCapabilityRow(httpCapability(), adapterFor(baseUrl), {
      id: "42",
    });
    assert.equal(res.ok, true);
    assert.equal(hits, 1);
  });
});

describe("pickSafeSmokeCandidates auto dry-run gate", () => {
  const recipe = (method: string, kind = "http") =>
    kind === "http"
      ? { kind: "http", method, pathTemplate: "/x" }
      : { kind: "browser", startUrl: "https://x", steps: [] };

  const caps: any[] = [
    {
      id: "1",
      name: "safe_read_get",
      actionKind: "read",
      riskTier: "L1",
      humanReviewRequired: false,
      inputSchemaJson: { type: "object", properties: {} },
      executionJson: recipe("GET"),
    },
    {
      id: "2",
      name: "safe_list_head",
      actionKind: "list",
      riskTier: "L1",
      humanReviewRequired: false,
      inputSchemaJson: { type: "object", properties: {} },
      executionJson: recipe("HEAD"),
    },
    {
      id: "3",
      name: "post_excluded",
      actionKind: "read",
      riskTier: "L1",
      humanReviewRequired: false,
      inputSchemaJson: { type: "object", properties: {} },
      executionJson: recipe("POST"),
    },
    {
      id: "4",
      name: "create_excluded",
      actionKind: "create",
      riskTier: "L2",
      humanReviewRequired: false,
      inputSchemaJson: { type: "object", properties: {} },
      executionJson: recipe("GET"),
    },
    {
      id: "5",
      name: "l2_excluded",
      actionKind: "read",
      riskTier: "L2",
      humanReviewRequired: false,
      inputSchemaJson: { type: "object", properties: {} },
      executionJson: recipe("GET"),
    },
    {
      id: "6",
      name: "review_excluded",
      actionKind: "read",
      riskTier: "L1",
      humanReviewRequired: true,
      inputSchemaJson: { type: "object", properties: {} },
      executionJson: recipe("GET"),
    },
    {
      id: "7",
      name: "browser_excluded",
      actionKind: "read",
      riskTier: "L1",
      humanReviewRequired: false,
      inputSchemaJson: { type: "object", properties: {} },
      executionJson: recipe("GET", "browser"),
    },
  ];

  it("returns only read/list + L1 + GET/HEAD + !humanReviewRequired tools", () => {
    const picked = pickSafeSmokeCandidates(caps).map((c) => c.capability.name);
    assert.deepEqual(picked.sort(), ["safe_list_head", "safe_read_get"]);
  });

  it("synthesizes type-correct sample args for required params", () => {
    const cap = {
      id: "8",
      name: "needs_args",
      actionKind: "read",
      riskTier: "L1",
      humanReviewRequired: false,
      inputSchemaJson: {
        type: "object",
        properties: {
          id: { type: "string" },
          n: { type: "integer" },
          items: { type: "array" },
        },
        required: ["id", "n", "items"],
      },
      executionJson: recipe("GET"),
    } as any;
    const [picked] = pickSafeSmokeCandidates([cap]);
    assert.ok(picked);
    assert.equal(typeof picked.args.id, "string");
    assert.equal(typeof picked.args.n, "number");
    assert.ok(Array.isArray(picked.args.items));
  });
});
