/**
 * Context broker — the single chokepoint that decides what context one agent is
 * allowed to see from other agents within a run.
 *
 * Design bias: OPERATIONAL safety over cryptographic strength. The rules here
 * are fail-closed and defense-in-depth:
 *   1. A single exhaustive policy switch (`filterVisibleContext`) decides
 *      visibility. Any unhandled policy is a compile error (`assertNever`), and
 *      any unknown runtime value collapses to the most restrictive mode.
 *   2. An independent invariant check (`assertNoForeignLeak`) re-validates the
 *      *output* of the filter. If a bug ever let a foreign item through to an
 *      isolated agent, this throws before the data reaches a model.
 *   3. Sensitivity + redaction ceilings are applied on every cross-agent path,
 *      so even "shared_full" never ships redacted or restricted material unless
 *      an explicit brokered grant raises the ceiling.
 *
 * The broker is PURE: it performs no I/O. Callers load rows from the database,
 * normalize them into `ContextItem`s, and pass them in. This keeps the policy
 * logic trivially testable and free of side effects.
 */

import type {
  ContextFragment,
  WorkingMemory,
  SharedContextGrant,
} from "@workspace/db";

export type SharedContextMode =
  | "isolated"
  | "shared_summary"
  | "shared_readonly"
  | "shared_full"
  | "brokered";

const VALID_MODES: ReadonlySet<string> = new Set([
  "isolated",
  "shared_summary",
  "shared_readonly",
  "shared_full",
  "brokered",
]);

/** Most restrictive mode — the fail-closed default for anything unrecognized. */
export const DEFAULT_POLICY: SharedContextMode = "isolated";

export type Sensitivity = "public" | "internal" | "confidential" | "restricted";

export const SENSITIVITY_RANK: Record<Sensitivity, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

/**
 * Cross-agent ceilings applied when NO explicit grant is involved. Even the
 * most permissive standing policy stops below `restricted`, and redacted items
 * never cross an agent boundary. Brokered grants can raise the ceiling
 * per-relationship up to `maxSensitivity`.
 */
const POLICY_CEILING: Record<SharedContextMode, Sensitivity | null> = {
  isolated: null, // no cross-agent exposure at all
  shared_summary: "internal",
  shared_readonly: "confidential",
  shared_full: "confidential",
  brokered: null, // only grants expose anything
};

export interface ContextItem {
  id: string;
  kind: "fragment" | "memory";
  /** Owning agent, or null for run-level / global context shared with everyone. */
  ownerAgentId: string | null;
  sensitivity: Sensitivity;
  redacted: boolean;
  content: string;
  summary: string;
  source: string;
}

export interface VisibleItem extends ContextItem {
  /** Whether the agent sees the full content or only a summary. */
  exposure: "full" | "summary";
  /** Why this item is visible — for auditable provenance. */
  via: "self" | "global" | "policy" | "grant";
}

export interface FilterResult {
  visible: VisibleItem[];
  /** Items that existed but were withheld from this agent. */
  withheldCount: number;
  /** Distinct foreign agent ids whose context became visible (after filtering). */
  visibleFrom: string[];
}

function assertNever(x: never): never {
  throw new Error(`Unhandled context policy: ${String(x)}`);
}

function asSensitivity(value: string): Sensitivity {
  return value in SENSITIVITY_RANK ? (value as Sensitivity) : "restricted";
}

function meetsCeiling(s: Sensitivity, ceiling: Sensitivity): boolean {
  return SENSITIVITY_RANK[s] <= SENSITIVITY_RANK[ceiling];
}

/** Coerce any stored/string policy value to a known mode, failing closed. */
export function normalizePolicy(
  value: string | null | undefined,
): SharedContextMode {
  return value && VALID_MODES.has(value)
    ? (value as SharedContextMode)
    : DEFAULT_POLICY;
}

export function normalizeFragment(f: ContextFragment): ContextItem {
  return {
    id: f.id,
    kind: "fragment",
    ownerAgentId: f.agentId ?? null,
    sensitivity: asSensitivity(f.sensitivity),
    redacted: f.redacted,
    content: f.content,
    summary: `${f.source}: ${f.content.slice(0, 80)}`,
    source: f.source,
  };
}

export function normalizeMemory(m: WorkingMemory): ContextItem {
  const ownerAgentId =
    m.metadataJson && typeof m.metadataJson === "object"
      ? ((m.metadataJson as Record<string, unknown>).agentId as string) ?? null
      : null;
  return {
    id: m.id,
    kind: "memory",
    ownerAgentId,
    sensitivity: asSensitivity(m.sensitivity),
    redacted: false,
    content: m.value,
    summary: `${m.key}: ${m.value.slice(0, 80)}`,
    source: `memory:${m.key}`,
  };
}

/** Grants are keyed by the *source* agent they authorize the recipient to read. */
type GrantIndex = Map<string, SharedContextGrant>;

function indexGrantsFor(
  selfAgentId: string,
  grants: SharedContextGrant[],
): GrantIndex {
  const idx: GrantIndex = new Map();
  for (const g of grants) {
    if (g.toAgentId !== selfAgentId) continue;
    // If multiple grants exist from the same source, keep the most permissive.
    const existing = idx.get(g.fromAgentId);
    if (
      !existing ||
      SENSITIVITY_RANK[asSensitivity(g.maxSensitivity)] >
        SENSITIVITY_RANK[asSensitivity(existing.maxSensitivity)]
    ) {
      idx.set(g.fromAgentId, g);
    }
  }
  return idx;
}

/** Map a grant mode to its exposure, failing closed for non-sharing modes. */
function grantExposure(mode: SharedContextMode): "full" | "summary" | null {
  switch (mode) {
    case "shared_summary":
      return "summary";
    case "shared_readonly":
    case "shared_full":
      return "full";
    case "isolated":
    case "brokered":
      // A grant whose own mode is isolating/brokered conveys nothing.
      return null;
    default:
      return assertNever(mode);
  }
}

function exposeForeignViaGrant(
  item: ContextItem,
  grant: SharedContextGrant,
): VisibleItem | null {
  // Redacted material never crosses an agent boundary, grant or not.
  if (item.redacted) return null;
  const ceiling = asSensitivity(grant.maxSensitivity);
  if (!meetsCeiling(item.sensitivity, ceiling)) return null;
  // Scope the grant to specific fragments when fragmentIds is provided.
  if (
    grant.fragmentIds &&
    grant.fragmentIds.length > 0 &&
    !grant.fragmentIds.includes(item.id)
  ) {
    return null;
  }
  // Fail closed: only explicit sharing modes expose anything.
  const exposure = grantExposure(normalizePolicy(grant.mode));
  if (exposure === null) return null;
  return {
    ...item,
    content: exposure === "summary" ? item.summary : item.content,
    exposure,
    via: "grant",
  };
}

function exposeForeignViaPolicy(
  item: ContextItem,
  policy: SharedContextMode,
): VisibleItem | null {
  if (item.redacted) return null;
  const ceiling = POLICY_CEILING[policy];
  if (ceiling === null) return null;
  if (!meetsCeiling(item.sensitivity, ceiling)) return null;
  const exposure: "full" | "summary" =
    policy === "shared_summary" ? "summary" : "full";
  return {
    ...item,
    content: exposure === "summary" ? item.summary : item.content,
    exposure,
    via: "policy",
  };
}

/**
 * Decide which context items the agent identified by `selfAgentId` may see.
 *
 * Self-owned and global (run-level, ownerAgentId === null) items are always
 * visible to their owner. Foreign items are gated by `policy`, then — for
 * `brokered` — by explicit grants. Returns the visible (possibly summarized)
 * items plus provenance counts.
 */
export function filterVisibleContext(
  policy: SharedContextMode,
  selfAgentId: string,
  items: ContextItem[],
  grants: SharedContextGrant[],
): FilterResult {
  const grantIndex = indexGrantsFor(selfAgentId, grants);
  const visible: VisibleItem[] = [];
  const visibleFrom = new Set<string>();
  let withheldCount = 0;

  for (const item of items) {
    // Global / run-level context is shared with every agent in the run, but
    // redacted or restricted material is never auto-exposed at the run level
    // either — a credential reference or top-secret note written without owner
    // attribution must not become a back door into otherwise-isolated agents.
    if (item.ownerAgentId === null) {
      if (item.redacted || item.sensitivity === "restricted") {
        withheldCount++;
        continue;
      }
      visible.push({ ...item, exposure: "full", via: "global" });
      continue;
    }
    // An agent always sees its own context in full.
    if (item.ownerAgentId === selfAgentId) {
      visible.push({ ...item, exposure: "full", via: "self" });
      continue;
    }

    // Foreign item — decide by policy.
    let exposed: VisibleItem | null = null;
    switch (policy) {
      case "isolated":
        exposed = null;
        break;
      case "shared_summary":
      case "shared_readonly":
      case "shared_full":
        exposed = exposeForeignViaPolicy(item, policy);
        break;
      case "brokered": {
        const grant = grantIndex.get(item.ownerAgentId);
        exposed = grant ? exposeForeignViaGrant(item, grant) : null;
        break;
      }
      default:
        // Exhaustiveness guard: adding a new mode without handling it here is a
        // compile error. At runtime an impossible value fails closed (withheld).
        assertNever(policy);
    }

    if (exposed) {
      visible.push(exposed);
      visibleFrom.add(item.ownerAgentId);
    } else {
      withheldCount++;
    }
  }

  return { visible, withheldCount, visibleFrom: [...visibleFrom] };
}

/**
 * Independent, defense-in-depth invariant. Re-validates the *output* of
 * `filterVisibleContext` against the policy and throws if anything that should
 * never be visible slipped through. Callers treat a throw as a hard security
 * failure: log it, drop the offending data, and fail closed.
 */
export function assertNoForeignLeak(
  policy: SharedContextMode,
  selfAgentId: string,
  visible: VisibleItem[],
  grants: SharedContextGrant[],
): void {
  const grantIndex = indexGrantsFor(selfAgentId, grants);

  for (const v of visible) {
    // Global items are shared, but redacted/restricted material must never be
    // present even at the run level.
    if (v.ownerAgentId === null) {
      if (v.redacted || v.sensitivity === "restricted") {
        throw new Error(
          `isolation violation: redacted/restricted global item ${v.id} exposed to agent ${selfAgentId}`,
        );
      }
      continue;
    }
    if (v.ownerAgentId === selfAgentId) continue;

    const owner = v.ownerAgentId as string;

    // Isolated (and brokered without a grant) must never surface foreign data.
    if (policy === "isolated") {
      throw new Error(
        `isolation violation: isolated agent ${selfAgentId} received foreign item ${v.id} from ${owner}`,
      );
    }

    // Redacted content must never cross an agent boundary.
    if (v.redacted) {
      throw new Error(
        `isolation violation: redacted item ${v.id} exposed to agent ${selfAgentId}`,
      );
    }

    if (policy === "brokered") {
      const grant = grantIndex.get(owner);
      if (!grant) {
        throw new Error(
          `isolation violation: brokered agent ${selfAgentId} received item ${v.id} from ${owner} with no grant`,
        );
      }
      const ceiling = asSensitivity(grant.maxSensitivity);
      if (!meetsCeiling(v.sensitivity, ceiling)) {
        throw new Error(
          `isolation violation: item ${v.id} (${v.sensitivity}) exceeds grant ceiling ${ceiling} for agent ${selfAgentId}`,
        );
      }
      // The grant may be scoped to specific fragments.
      if (
        grant.fragmentIds &&
        grant.fragmentIds.length > 0 &&
        !grant.fragmentIds.includes(v.id)
      ) {
        throw new Error(
          `isolation violation: item ${v.id} is outside grant fragment scope for agent ${selfAgentId}`,
        );
      }
      // Exposure must match what the grant mode actually permits.
      const grantMode = normalizePolicy(grant.mode);
      const expected = grantExposure(grantMode);
      if (expected === null) {
        throw new Error(
          `isolation violation: grant mode ${grantMode} conveys nothing but item ${v.id} reached agent ${selfAgentId}`,
        );
      }
      if (v.exposure !== expected) {
        throw new Error(
          `isolation violation: item ${v.id} exposure ${v.exposure} != grant mode ${grantMode} for agent ${selfAgentId}`,
        );
      }
      continue;
    }

    // Standing-policy ceiling enforcement.
    const ceiling = POLICY_CEILING[policy];
    if (ceiling === null || !meetsCeiling(v.sensitivity, ceiling)) {
      throw new Error(
        `isolation violation: item ${v.id} (${v.sensitivity}) exceeds policy ceiling for ${policy} to agent ${selfAgentId}`,
      );
    }
    // Exposure must match the standing policy (summary-only vs full).
    const expectedExposure: "full" | "summary" =
      policy === "shared_summary" ? "summary" : "full";
    if (v.exposure !== expectedExposure) {
      throw new Error(
        `isolation violation: item ${v.id} exposure ${v.exposure} != policy ${policy} for agent ${selfAgentId}`,
      );
    }
  }
}

/**
 * Convenience wrapper: filter, then assert. On an invariant failure this does
 * NOT rethrow — it fails closed by returning only self/global items and signals
 * the violation so the caller can record a security event. This guarantees a
 * model never receives leaked context even if the filter has a bug.
 */
export function assembleVisibleContext(
  policy: SharedContextMode,
  selfAgentId: string,
  items: ContextItem[],
  grants: SharedContextGrant[],
): FilterResult & { violation: string | null } {
  const result = filterVisibleContext(policy, selfAgentId, items, grants);
  try {
    assertNoForeignLeak(policy, selfAgentId, result.visible, grants);
    return { ...result, violation: null };
  } catch (err) {
    const safe = result.visible.filter(
      (v) => v.ownerAgentId === null || v.ownerAgentId === selfAgentId,
    );
    return {
      visible: safe,
      withheldCount: result.withheldCount + (result.visible.length - safe.length),
      visibleFrom: [],
      violation: err instanceof Error ? err.message : String(err),
    };
  }
}
