import { eq, and, asc } from "drizzle-orm";
import {
  db,
  adaptersTable,
  capabilitiesTable,
  type Adapter,
  type Capability,
} from "@workspace/db";
import {
  executeRecipe,
  parseRecipe,
  type AuthConfig,
  type AuthType,
  type ExecutionResult,
  type ServerContext,
} from "./webTools";

/** Build the execution context (base URL, auth, SSRF policy) for an adapter. */
export function serverContextFromAdapter(adapter: Adapter): ServerContext {
  const meta = (adapter.metadataJson as Record<string, unknown> | null) ?? {};
  const authType = (meta.authType as AuthType | undefined) ?? "none";
  const auth: AuthConfig = {
    type: authType,
    name: typeof meta.authName === "string" ? meta.authName : undefined,
  };
  return {
    baseUrl: adapter.endpointUrl,
    auth,
    credentialRef: adapter.credentialRef,
    allowPrivateNetwork: meta.allowPrivateNetwork === true,
  };
}

/** Execute a capability row against its owning adapter with the given args. */
export async function executeCapabilityRow(
  capability: Capability,
  adapter: Adapter,
  args: Record<string, unknown>,
): Promise<ExecutionResult> {
  const recipe = parseRecipe(capability.executionJson);
  if (!recipe) {
    return {
      ok: false,
      kind: "http",
      durationMs: 0,
      error: `Capability "${capability.name}" has no executable recipe.`,
    };
  }
  return executeRecipe(recipe, serverContextFromAdapter(adapter), args);
}

/**
 * Resolve a constructed-tool capability by name within a tenant and execute it.
 * Returns null when no executable capability with that name exists (so callers
 * can fall back to built-in tool handling).
 */
export async function executeNamedCapability(
  tenantId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ExecutionResult | null> {
  const rows = await db
    .select({ capability: capabilitiesTable, adapter: adaptersTable })
    .from(capabilitiesTable)
    .innerJoin(adaptersTable, eq(capabilitiesTable.adapterId, adaptersTable.id))
    .where(
      and(
        eq(capabilitiesTable.tenantId, tenantId),
        eq(capabilitiesTable.name, name),
      ),
    )
    // Deterministic ordering so a duplicated tool name always dispatches to the
    // same capability (matching what listToolsForTenant advertises).
    .orderBy(asc(capabilitiesTable.createdAt), asc(capabilitiesTable.id));
  const match = rows.find((r) => parseRecipe(r.capability.executionJson));
  if (!match) return null;
  return executeCapabilityRow(match.capability, match.adapter, args);
}

// ---------------------------------------------------------------------------
// Post-import smoke test
// ---------------------------------------------------------------------------

/** Outcome of auto dry-running a representative tool right after an import. */
export interface SmokeTestOutcome {
  /** True when a safe tool was actually invoked. */
  ran: boolean;
  /** Why no tool was invoked (only set when `ran` is false). */
  reason?: string;
  /** The capability that was dry-run. */
  tool?: string;
  /** Whether the dry-run HTTP call succeeded. */
  ok?: boolean;
  status?: number | null;
  durationMs?: number;
  error?: string | null;
  /** Sample args synthesized for required parameters, if any. */
  sampleArgs?: Record<string, unknown>;
}

// Only read-shaped, non-mutating actions are ever auto-invoked. Anything that
// could create/update/delete state (or needs human review) is excluded so a
// post-import smoke test can never have side effects.
const SAFE_SMOKE_ACTION_KINDS = new Set(["read", "list"]);

function requiredParamNames(capability: Capability): string[] {
  const schema = capability.inputSchemaJson as
    | { required?: unknown }
    | null
    | undefined;
  const required = schema?.required;
  return Array.isArray(required)
    ? required.filter((r): r is string => typeof r === "string")
    : [];
}

function sampleValueForParam(
  capability: Capability,
  param: string,
): unknown {
  const schema = capability.inputSchemaJson as
    | { properties?: Record<string, unknown> }
    | null
    | undefined;
  const propRaw = schema?.properties?.[param];
  const type =
    propRaw && typeof propRaw === "object"
      ? (propRaw as { type?: unknown }).type
      : undefined;
  switch (type) {
    case "integer":
    case "number":
      return 1;
    case "boolean":
      return true;
    default:
      return "1";
  }
}

/**
 * Choose a representative safe read/list capability to dry-run after an import
 * and synthesize the minimal sample args it needs. Prefers a tool that requires
 * no arguments (a plain list endpoint) so the smoke test exercises the base URL
 * + auth without depending on a guessed resource id. Returns null when the batch
 * contains no safe read/list tool to invoke.
 */
export function pickSmokeTestCapability(
  capabilities: Capability[],
): { capability: Capability; args: Record<string, unknown> } | null {
  const candidates = capabilities.filter((c) => {
    if (c.humanReviewRequired) return false;
    if (!SAFE_SMOKE_ACTION_KINDS.has(c.actionKind)) return false;
    if (c.riskTier !== "L1") return false;
    const recipe = parseRecipe(c.executionJson);
    if (!recipe || recipe.kind !== "http") return false;
    return recipe.method === "GET" || recipe.method === "HEAD";
  });
  if (candidates.length === 0) return null;

  // Fewest required params first: a no-arg list call is the most representative
  // and least likely to fail for an unrelated reason (e.g. a wrong sample id).
  const ranked = candidates
    .map((c) => ({ capability: c, required: requiredParamNames(c) }))
    .sort((a, b) => a.required.length - b.required.length);
  const best = ranked[0];

  const args: Record<string, unknown> = {};
  for (const param of best.required) {
    args[param] = sampleValueForParam(best.capability, param);
  }
  return { capability: best.capability, args };
}

/**
 * Auto dry-run a representative safe read/list tool from a freshly imported
 * batch, reusing the same execution path as `test_web_tool`. Never invokes
 * create/update/destructive tools and never throws — a failure is surfaced in
 * the returned outcome so a broken import (wrong base URL/auth) is caught
 * immediately instead of on the user's first real request.
 */
export async function smokeTestImportedTools(
  adapter: Adapter,
  capabilities: Capability[],
): Promise<SmokeTestOutcome> {
  const pick = pickSmokeTestCapability(capabilities);
  if (!pick) {
    return {
      ran: false,
      reason:
        "No safe read/list tool to dry-run (only create/update/destructive operations were imported).",
    };
  }
  const result = await executeCapabilityRow(
    pick.capability,
    adapter,
    pick.args,
  );
  return {
    ran: true,
    tool: pick.capability.name,
    ok: result.ok,
    status: result.status ?? null,
    durationMs: result.durationMs,
    error: result.error ?? null,
    ...(Object.keys(pick.args).length > 0 ? { sampleArgs: pick.args } : {}),
  };
}

/** List all executable (recipe-bearing) capabilities for a tenant. */
export async function listExecutableCapabilities(
  tenantId: string,
): Promise<Capability[]> {
  const rows = await db
    .select()
    .from(capabilitiesTable)
    .where(eq(capabilitiesTable.tenantId, tenantId))
    .orderBy(asc(capabilitiesTable.createdAt), asc(capabilitiesTable.id));
  return rows.filter((c) => parseRecipe(c.executionJson));
}
