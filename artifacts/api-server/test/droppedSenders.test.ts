import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Owner-facing guarantees of the "pending senders" feature, tested against the
// REAL emailAdmin service. The inbound-webhook test only asserts that a dropped
// sender gets recorded; here we cover the admin surface around it:
//   - recordDroppedSender upsert/dedup per (tenant, address): a repeat attempt
//     bumps `attempts` and refreshes lastSubject/lastSeenAt instead of inserting
//     a duplicate (and keeps firstSeenAt).
//   - listDroppedSenders ordering (most-recent first) and limit.
//   - dismissDroppedSenderById removes only the targeted row.
//   - addAllowedSender clears any matching pending record (approving resolves it).
//
// Unlike emailFlow.test.ts (single-tenant, where-clauses ignored), these cases
// need a where/conflict-aware store, so drizzle-orm's operators are mocked into
// plain descriptors the in-memory db interprets. The table column references
// come through a Proxy so eq(table.col, val) carries the column name.
// ---------------------------------------------------------------------------
type Row = Record<string, any>;
const store: Record<string, Row[]> = {};

// --- drizzle-orm operators -> inspectable descriptors ----------------------
const eq = (col: any, val: any) => ({ __pred: "eq", col, val });
const and = (...ps: any[]) => ({ __pred: "and", ps });
const or = (...ps: any[]) => ({ __pred: "or", ps });
const isNull = (col: any) => ({ __pred: "isNull", col });
const asc = (col: any) => ({ __order: "asc", col });
const desc = (col: any) => ({ __order: "desc", col });
// recordDroppedSender uses sql`${col} + 1`; we only need to recognise it as an
// increment of the targeted column during a conflict update.
const sql = (_strings: TemplateStringsArray, ..._exprs: any[]) => ({
  __sqlIncrement: true,
});
mock.module("drizzle-orm", {
  namedExports: { eq, and, or, isNull, asc, desc, sql },
});

// --- @workspace/db: tables expose column descriptors via Proxy -------------
const table = (name: string) =>
  new Proxy(
    { _name: name },
    {
      get(target: any, prop) {
        if (prop === "_name") return name;
        if (typeof prop !== "string") return target[prop];
        return { __col: true, table: name, name: prop };
      },
    },
  );

const TABLE_EXPORTS = [
  "emailConfigTable",
  "emailAllowedSendersTable",
  "emailDroppedSendersTable",
  "auditRecordsTable",
];

function matches(row: Row, pred: any): boolean {
  if (!pred) return true;
  switch (pred.__pred) {
    case "eq":
      return row[pred.col.name] === pred.val;
    case "and":
      return pred.ps.every((p: any) => matches(row, p));
    case "or":
      return pred.ps.some((p: any) => matches(row, p));
    case "isNull":
      return row[pred.col.name] == null;
    default:
      return true;
  }
}

function cmp(a: any, b: any): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function withDefaults(name: string, values: Row): Row {
  const now = new Date();
  const base: Row = { id: randomUUID(), createdAt: now };
  if (name === "emailDroppedSendersTable") {
    base.firstSeenAt = now;
    base.lastSeenAt = now;
  }
  return { ...base, ...values };
}

function applySet(row: Row, set: Row) {
  for (const [k, v] of Object.entries(set)) {
    if (v && (v as any).__sqlIncrement) row[k] = (row[k] ?? 0) + 1;
    else row[k] = v;
  }
}

function makeChain(kind: "select" | "insert" | "update" | "delete", tbl?: any) {
  let target = tbl;
  let wherePred: any;
  let order: any;
  let limitN: number | undefined;
  let values: any;
  let setVals: any;
  let conflict: { kind: "nothing" | "update"; cfg?: any } | undefined;

  function exec(): Row[] {
    const name = target?._name as string;
    const rows = (store[name] ??= []);
    if (kind === "select") {
      let out = rows.filter((r) => matches(r, wherePred));
      if (order) {
        const col = order.col.name;
        const dir = order.__order;
        out = [...out].sort(
          (a, b) => cmp(a[col], b[col]) * (dir === "desc" ? -1 : 1),
        );
      }
      if (typeof limitN === "number") out = out.slice(0, limitN);
      return out;
    }
    if (kind === "insert") {
      if (conflict?.kind === "update") {
        const cols = (conflict.cfg.target ?? []).map((c: any) => c.name);
        const existing = rows.find((r) =>
          cols.every((c: string) => r[c] === values[c]),
        );
        if (existing) {
          applySet(existing, conflict.cfg.set ?? {});
          return [existing];
        }
      } else if (conflict?.kind === "nothing") {
        const existing = rows.find(
          (r) => r.tenantId === values.tenantId && r.address === values.address,
        );
        if (existing) return [];
      }
      const row = withDefaults(name, values);
      rows.push(row);
      return [row];
    }
    if (kind === "update") {
      const matched = rows.filter((r) => matches(r, wherePred));
      for (const r of matched) applySet(r, setVals);
      return matched;
    }
    // delete
    const matched = rows.filter((r) => matches(r, wherePred));
    for (const r of matched) rows.splice(rows.indexOf(r), 1);
    return matched;
  }

  const chain: any = {
    from(t: any) {
      target = t;
      return chain;
    },
    where(p: any) {
      wherePred = p;
      return chain;
    },
    orderBy(o: any) {
      order = o;
      return chain;
    },
    limit(n: number) {
      limitN = n;
      return chain;
    },
    values(v: any) {
      values = v;
      return chain;
    },
    set(v: any) {
      setVals = v;
      return chain;
    },
    onConflictDoNothing() {
      conflict = { kind: "nothing" };
      return chain;
    },
    onConflictDoUpdate(cfg: any) {
      conflict = { kind: "update", cfg };
      return chain;
    },
    returning() {
      return chain;
    },
    then(resolve: any, reject: any) {
      try {
        return Promise.resolve(exec()).then(resolve, reject);
      } catch (err) {
        return Promise.reject(err).then(resolve, reject);
      }
    },
  };
  return chain;
}

const db = {
  select: () => makeChain("select"),
  selectDistinct: () => makeChain("select"),
  insert: (t: any) => makeChain("insert", t),
  update: (t: any) => makeChain("update", t),
  delete: (t: any) => makeChain("delete", t),
};

const dbNamedExports: Record<string, unknown> = { db };
for (const name of TABLE_EXPORTS) dbNamedExports[name] = table(name);
mock.module("@workspace/db", { namedExports: dbNamedExports });

// agentmail's network boundary is never reached by these functions; stub the
// SDK only so importing the real emailAdmin (-> agentmail) resolves.
mock.module("@replit/connectors-sdk", {
  namedExports: { ReplitConnectors: class {} },
});

const {
  recordDroppedSender,
  listDroppedSenders,
  dismissDroppedSenderById,
  addAllowedSender,
} = await import("../src/lib/emailAdmin");

const TENANT = "tenant-1";
const ACTOR = { actorType: "user" as const, actorId: "user-1" };

function dropped(): Row[] {
  return store["emailDroppedSendersTable"] ?? [];
}
function allowed(): Row[] {
  return store["emailAllowedSendersTable"] ?? [];
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

describe("recordDroppedSender", () => {
  it("inserts a new row, normalizing the address", async () => {
    await recordDroppedSender({
      tenantId: TENANT,
      address: "Alice <Alice@Example.com>",
      subject: "Hello there",
    });
    assert.equal(dropped().length, 1);
    const [row] = dropped();
    assert.equal(row.address, "alice@example.com");
    assert.equal(row.lastSubject, "Hello there");
    assert.equal(row.attempts, 1);
  });

  it("dedups per (tenant, address): a repeat bumps attempts and refreshes subject/lastSeen, keeping firstSeenAt", async () => {
    await recordDroppedSender({
      tenantId: TENANT,
      address: "bob@acme.com",
      subject: "First",
    });
    const firstSeenAt = dropped()[0].firstSeenAt as Date;
    // Force a measurably-later lastSeenAt on the repeat.
    dropped()[0].lastSeenAt = new Date(Date.now() - 60_000);
    const prevLastSeen = dropped()[0].lastSeenAt as Date;

    await recordDroppedSender({
      tenantId: TENANT,
      address: "BOB@acme.com",
      subject: "Second",
    });

    assert.equal(dropped().length, 1, "no duplicate row inserted");
    const [row] = dropped();
    assert.equal(row.attempts, 2, "attempts incremented");
    assert.equal(row.lastSubject, "Second", "lastSubject refreshed");
    assert.equal(
      (row.firstSeenAt as Date).getTime(),
      firstSeenAt.getTime(),
      "firstSeenAt preserved",
    );
    assert.ok(
      (row.lastSeenAt as Date).getTime() > prevLastSeen.getTime(),
      "lastSeenAt refreshed forward",
    );
  });
});

describe("listDroppedSenders", () => {
  it("returns most-recently-seen first and honours the limit", async () => {
    for (const a of ["a@x.com", "b@x.com", "c@x.com"]) {
      await recordDroppedSender({ tenantId: TENANT, address: a });
    }
    // Assign deterministic, distinct lastSeenAt so ordering is unambiguous.
    const rows = dropped();
    rows.find((r) => r.address === "a@x.com")!.lastSeenAt = new Date(1_000);
    rows.find((r) => r.address === "b@x.com")!.lastSeenAt = new Date(3_000);
    rows.find((r) => r.address === "c@x.com")!.lastSeenAt = new Date(2_000);

    const all = await listDroppedSenders(TENANT);
    assert.deepEqual(
      all.map((r) => r.address),
      ["b@x.com", "c@x.com", "a@x.com"],
    );
    // Serialized timestamps for the owner UI.
    assert.equal(typeof all[0].lastSeenAt, "string");
    assert.equal(typeof all[0].firstSeenAt, "string");

    const top2 = await listDroppedSenders(TENANT, 2);
    assert.deepEqual(
      top2.map((r) => r.address),
      ["b@x.com", "c@x.com"],
    );
  });
});

describe("dismissDroppedSenderById", () => {
  it("removes only the targeted row", async () => {
    await recordDroppedSender({ tenantId: TENANT, address: "keep@x.com" });
    await recordDroppedSender({ tenantId: TENANT, address: "drop@x.com" });
    const victim = dropped().find((r) => r.address === "drop@x.com")!;

    const res = await dismissDroppedSenderById({
      tenantId: TENANT,
      id: victim.id,
    });
    assert.deepEqual(res, { removed: true });
    assert.deepEqual(
      dropped().map((r) => r.address),
      ["keep@x.com"],
    );
  });

  it("reports removed:false for an unknown id", async () => {
    await recordDroppedSender({ tenantId: TENANT, address: "keep@x.com" });
    const res = await dismissDroppedSenderById({
      tenantId: TENANT,
      id: "does-not-exist",
    });
    assert.deepEqual(res, { removed: false });
    assert.equal(dropped().length, 1);
  });
});

describe("addAllowedSender", () => {
  it("clears the matching pending record while leaving others, and allow-lists the address", async () => {
    await recordDroppedSender({ tenantId: TENANT, address: "alice@example.com" });
    await recordDroppedSender({ tenantId: TENANT, address: "other@example.com" });

    const result = await addAllowedSender({
      tenantId: TENANT,
      actor: ACTOR,
      address: "Alice <Alice@Example.com>",
    });

    assert.equal(result.address, "alice@example.com");
    assert.deepEqual(
      allowed().map((r) => r.address),
      ["alice@example.com"],
    );
    // The approved sender's pending record is gone; the unrelated one remains.
    assert.deepEqual(
      dropped().map((r) => r.address),
      ["other@example.com"],
    );
  });

  it("is idempotent: re-adding the same sender does not create a duplicate allow row", async () => {
    await addAllowedSender({
      tenantId: TENANT,
      actor: ACTOR,
      address: "dup@example.com",
    });
    const again = await addAllowedSender({
      tenantId: TENANT,
      actor: ACTOR,
      address: "Dup@Example.com",
    });
    assert.equal(again.address, "dup@example.com");
    assert.equal(
      allowed().filter((r) => r.address === "dup@example.com").length,
      1,
    );
  });
});

// The functions are all scoped by tenantId; with a single tenant a missing
// tenant predicate would pass unnoticed, so these assert true isolation.
describe("tenant isolation", () => {
  const T2 = "tenant-2";

  it("recordDroppedSender does not dedup the same address across tenants", async () => {
    await recordDroppedSender({ tenantId: TENANT, address: "shared@x.com" });
    await recordDroppedSender({ tenantId: T2, address: "shared@x.com" });
    assert.equal(dropped().length, 2);
    for (const r of dropped()) assert.equal(r.attempts, 1);
  });

  it("listDroppedSenders returns only the caller tenant's rows", async () => {
    await recordDroppedSender({ tenantId: TENANT, address: "mine@x.com" });
    await recordDroppedSender({ tenantId: T2, address: "theirs@x.com" });
    const mine = await listDroppedSenders(TENANT);
    assert.deepEqual(
      mine.map((r) => r.address),
      ["mine@x.com"],
    );
  });

  it("dismissDroppedSenderById will not remove another tenant's record", async () => {
    await recordDroppedSender({ tenantId: T2, address: "theirs@x.com" });
    const theirs = dropped().find((r) => r.tenantId === T2)!;
    const res = await dismissDroppedSenderById({
      tenantId: TENANT,
      id: theirs.id,
    });
    assert.deepEqual(res, { removed: false });
    assert.equal(dropped().length, 1);
  });

  it("addAllowedSender clears only the caller tenant's pending record", async () => {
    await recordDroppedSender({ tenantId: TENANT, address: "shared@x.com" });
    await recordDroppedSender({ tenantId: T2, address: "shared@x.com" });

    await addAllowedSender({
      tenantId: TENANT,
      actor: ACTOR,
      address: "shared@x.com",
    });

    // Only the caller tenant's pending record is cleared.
    assert.deepEqual(
      dropped().map((r) => r.tenantId),
      [T2],
    );
    assert.deepEqual(
      allowed().map((r) => ({ tenantId: r.tenantId, address: r.address })),
      [{ tenantId: TENANT, address: "shared@x.com" }],
    );
  });
});
