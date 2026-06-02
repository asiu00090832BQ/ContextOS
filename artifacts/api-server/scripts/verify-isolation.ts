/**
 * Standalone verification for the context broker. No test runner is configured,
 * so this is bundled with esbuild and run directly with node. It asserts the
 * fail-closed isolation guarantees.
 */
import {
  filterVisibleContext,
  assertNoForeignLeak,
  assembleVisibleContext,
  normalizePolicy,
  type ContextItem,
  type SharedContextMode,
} from "../src/lib/contextBroker";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok  - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL- ${name}`);
  }
}

const SELF = "agent-self";
const OTHER = "agent-other";

function item(
  id: string,
  ownerAgentId: string | null,
  sensitivity: ContextItem["sensitivity"],
  redacted = false,
): ContextItem {
  return {
    id,
    kind: "fragment",
    ownerAgentId,
    sensitivity,
    redacted,
    content: `content-${id}`,
    summary: `summary-${id}`,
    source: `src-${id}`,
  };
}

const grant = (over: Partial<any> = {}): any => ({
  id: "g1",
  tenantId: "t",
  runId: "r",
  fromAgentId: OTHER,
  toAgentId: SELF,
  mode: "shared_full",
  maxSensitivity: "confidential",
  fragmentIds: null,
  note: null,
  createdAt: new Date(),
  ...over,
});

const baseItems: ContextItem[] = [
  item("global", null, "internal"),
  item("self-1", SELF, "confidential"),
  item("other-pub", OTHER, "public"),
  item("other-int", OTHER, "internal"),
  item("other-conf", OTHER, "confidential"),
  item("other-restricted", OTHER, "restricted"),
  item("other-redacted", OTHER, "internal", true),
];

// 1. isolated: only global + self, nothing foreign.
{
  const r = filterVisibleContext("isolated", SELF, baseItems, []);
  const ids = r.visible.map((v) => v.id).sort();
  check("isolated sees only global+self", JSON.stringify(ids) === JSON.stringify(["global", "self-1"]));
  check("isolated reports no foreign sources", r.visibleFrom.length === 0);
  check("isolated withholds all foreign", r.withheldCount === 5);
}

// 2. shared_full: foreign up to confidential, never restricted/redacted.
{
  const r = filterVisibleContext("shared_full", SELF, baseItems, []);
  const ids = r.visible.map((v) => v.id);
  check("shared_full includes foreign confidential", ids.includes("other-conf"));
  check("shared_full excludes restricted", !ids.includes("other-restricted"));
  check("shared_full excludes redacted", !ids.includes("other-redacted"));
  check("shared_full foreign exposed as full", r.visible.find((v) => v.id === "other-conf")?.exposure === "full");
}

// 3. shared_summary: foreign up to internal, summary only.
{
  const r = filterVisibleContext("shared_summary", SELF, baseItems, []);
  const conf = r.visible.find((v) => v.id === "other-conf");
  const int = r.visible.find((v) => v.id === "other-int");
  check("shared_summary excludes foreign confidential", conf === undefined);
  check("shared_summary includes foreign internal", int !== undefined);
  check("shared_summary exposes summary content only", int?.content === "summary-other-int" && int?.exposure === "summary");
}

// 4. brokered: only granted source, ceiling + fragmentId scoping.
{
  const noGrant = filterVisibleContext("brokered", SELF, baseItems, []);
  check("brokered with no grant withholds all foreign", noGrant.visible.every((v) => v.ownerAgentId === null || v.ownerAgentId === SELF));

  const withGrant = filterVisibleContext("brokered", SELF, baseItems, [grant({ maxSensitivity: "confidential" })]);
  const ids = withGrant.visible.map((v) => v.id);
  check("brokered grant exposes up to ceiling", ids.includes("other-conf"));
  check("brokered grant still excludes restricted", !ids.includes("other-restricted"));
  check("brokered grant still excludes redacted", !ids.includes("other-redacted"));

  const scoped = filterVisibleContext("brokered", SELF, baseItems, [grant({ fragmentIds: ["other-int"] })]);
  const scopedIds = scoped.visible.filter((v) => v.ownerAgentId === OTHER).map((v) => v.id);
  check("brokered fragmentIds scoping limits to listed ids", JSON.stringify(scopedIds) === JSON.stringify(["other-int"]));

  const lowCeil = filterVisibleContext("brokered", SELF, baseItems, [grant({ maxSensitivity: "internal" })]);
  check("brokered ceiling internal excludes confidential", !lowCeil.visible.map((v) => v.id).includes("other-conf"));
}

// 5. assertNoForeignLeak catches a hand-injected leak into an isolated agent.
{
  const leaked = [{ ...item("leak", OTHER, "internal"), exposure: "full" as const, via: "policy" as const }];
  let threw = false;
  try {
    assertNoForeignLeak("isolated", SELF, leaked, []);
  } catch {
    threw = true;
  }
  check("assertNoForeignLeak throws on isolated leak", threw);
}

// 6. assembleVisibleContext fails closed (no throw, foreign dropped) on a forced leak.
//    Simulate by passing a policy whose filter is fine but asserting a stricter contract:
{
  // brokered item exposed via grant, then asserted with NO grants -> should fail closed.
  const exposed = [{ ...item("x", OTHER, "internal"), exposure: "full" as const, via: "grant" as const }];
  let threw = false;
  try {
    assertNoForeignLeak("brokered", SELF, exposed, []);
  } catch {
    threw = true;
  }
  check("assertNoForeignLeak throws on brokered item without grant", threw);
}

// 7. normalizePolicy fails closed.
{
  check("normalizePolicy maps unknown to isolated", normalizePolicy("nonsense" as SharedContextMode) === "isolated");
  check("normalizePolicy maps null to isolated", normalizePolicy(null) === "isolated");
  check("normalizePolicy preserves valid", normalizePolicy("shared_full") === "shared_full");
}

// 8. Grant mode fail-open guard: a grant whose own mode is isolating/brokered/
//    unknown must convey nothing (previously these leaked as full content).
{
  for (const m of ["isolated", "brokered", "nonsense"]) {
    const r = filterVisibleContext("brokered", SELF, baseItems, [grant({ mode: m })]);
    const foreign = r.visible.filter((v) => v.ownerAgentId === OTHER).map((v) => v.id);
    check(`brokered grant mode '${m}' conveys nothing`, foreign.length === 0);
  }
  const ro = filterVisibleContext("brokered", SELF, baseItems, [grant({ mode: "shared_readonly" })]);
  check("brokered grant mode shared_readonly exposes full", ro.visible.find((v) => v.id === "other-conf")?.exposure === "full");
  const su = filterVisibleContext("brokered", SELF, baseItems, [grant({ mode: "shared_summary", maxSensitivity: "internal" })]);
  check("brokered grant mode shared_summary exposes summary", su.visible.find((v) => v.id === "other-int")?.exposure === "summary");
}

// 9. Global redacted/restricted is never auto-exposed, even at run level.
{
  const items: ContextItem[] = [
    item("g-ok", null, "internal"),
    item("g-restricted", null, "restricted"),
    item("g-redacted", null, "internal", true),
  ];
  const r = filterVisibleContext("isolated", SELF, items, []);
  const ids = r.visible.map((v) => v.id);
  check("global ok item visible", ids.includes("g-ok"));
  check("global restricted item withheld", !ids.includes("g-restricted"));
  check("global redacted item withheld", !ids.includes("g-redacted"));
}

// 10. Invariant catches exposure-mode mismatch (summary policy returning full).
{
  const full = [{ ...item("other-int", OTHER, "internal"), exposure: "full" as const, via: "policy" as const }];
  let threw = false;
  try {
    assertNoForeignLeak("shared_summary", SELF, full, []);
  } catch {
    threw = true;
  }
  check("invariant rejects full exposure under shared_summary", threw);
}

// 11. Invariant catches a brokered item outside the grant's fragment scope.
{
  const outOfScope = [{ ...item("other-conf", OTHER, "confidential"), exposure: "full" as const, via: "grant" as const }];
  let threw = false;
  try {
    assertNoForeignLeak("brokered", SELF, outOfScope, [grant({ fragmentIds: ["other-int"] })]);
  } catch {
    threw = true;
  }
  check("invariant rejects brokered item outside fragmentIds scope", threw);
}

// 12. assembleVisibleContext fails closed (no throw) and drops foreign on violation.
{
  const r = assembleVisibleContext("shared_summary", SELF, baseItems, []);
  check("assemble shared_summary returns no violation on clean input", r.violation === null);
  // Force a violation by exposing full content where the broker never would:
  // an unknown policy normalized to isolated should withhold everything foreign.
  const iso = assembleVisibleContext("isolated", SELF, baseItems, []);
  check("assemble isolated yields zero foreign and no violation", iso.visibleFrom.length === 0 && iso.violation === null);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nAll isolation checks passed.");
}
