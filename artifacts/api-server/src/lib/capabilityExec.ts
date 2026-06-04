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
 * Resolve a constructed-tool capability (plus its owning adapter) by name within
 * a tenant. Returns null when no executable capability with that name exists.
 * Uses the same deterministic ordering as dispatch/listing so a duplicated tool
 * name always resolves to the capability that tools/list advertised.
 */
export async function resolveNamedCapability(
  tenantId: string,
  name: string,
): Promise<{ capability: Capability; adapter: Adapter } | null> {
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
  return rows.find((r) => parseRecipe(r.capability.executionJson)) ?? null;
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
  const match = await resolveNamedCapability(tenantId, name);
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
 * The single safety gate shared by the post-import smoke test and the on-demand
 * server re-test. Only read-shaped, non-mutating GET/HEAD L1 tools that don't
 * require human review are ever eligible for auto dry-running, so neither path
 * can have side effects.
 */
function isSafeSmokeCapability(c: Capability): boolean {
  if (c.humanReviewRequired) return false;
  if (!SAFE_SMOKE_ACTION_KINDS.has(c.actionKind)) return false;
  if (c.riskTier !== "L1") return false;
  const recipe = parseRecipe(c.executionJson);
  if (!recipe || recipe.kind !== "http") return false;
  return recipe.method === "GET" || recipe.method === "HEAD";
}

/** Synthesize the minimal sample args a capability's required params need. */
function sampleArgsForCapability(
  capability: Capability,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const param of requiredParamNames(capability)) {
    args[param] = sampleValueForParam(capability, param);
  }
  return args;
}

/**
 * Return every safe read/list capability that may be dry-run, each paired with
 * synthesized sample args, ranked so tools needing the fewest required params
 * (a no-arg list call) come first. Shares the same safety gate as the
 * post-import smoke test — create/update/destructive tools are never returned.
 */
export function pickSafeSmokeCandidates(
  capabilities: Capability[],
): { capability: Capability; args: Record<string, unknown> }[] {
  return capabilities
    .filter(isSafeSmokeCapability)
    .map((c) => ({ capability: c, required: requiredParamNames(c) }))
    // Fewest required params first: a no-arg list call is the most
    // representative and least likely to fail for an unrelated reason.
    .sort((a, b) => a.required.length - b.required.length)
    .map(({ capability }) => ({
      capability,
      args: sampleArgsForCapability(capability),
    }));
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
  const candidates = pickSafeSmokeCandidates(capabilities);
  return candidates.length > 0 ? candidates[0] : null;
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
  // Persist the smoke-test outcome so the verified/failed status is recorded
  // the same way a manual test_web_tool run would record it.
  await recordCapabilityTest(pick.capability.id, result);
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

/** The persisted outcome of the most recent test_web_tool dry-run. */
export interface CapabilityTestRecord {
  ok: boolean;
  status: number | null;
  testedAt: string;
  error: string | null;
}

/** Read a capability's last recorded test outcome, if any. */
export function lastTestOf(capability: Capability): CapabilityTestRecord | null {
  const raw = capability.lastTestJson as CapabilityTestRecord | null;
  if (!raw || typeof raw.ok !== "boolean") return null;
  return {
    ok: raw.ok,
    status: typeof raw.status === "number" ? raw.status : null,
    testedAt: typeof raw.testedAt === "string" ? raw.testedAt : "",
    error: typeof raw.error === "string" ? raw.error : null,
  };
}

/**
 * Persist the outcome of a dry-run onto the capability so the bot can later skip
 * re-testing a known-good tool (or warn before relying on one that last failed)
 * and the app can surface which tools are verified.
 */
export async function recordCapabilityTest(
  capabilityId: string,
  result: ExecutionResult,
): Promise<CapabilityTestRecord> {
  const record: CapabilityTestRecord = {
    ok: result.ok,
    status: result.status ?? null,
    testedAt: new Date().toISOString(),
    error: result.error ? result.error.slice(0, 500) : null,
  };
  await db
    .update(capabilitiesTable)
    .set({ lastTestJson: record })
    .where(eq(capabilitiesTable.id, capabilityId));
  return record;
}

// ---------------------------------------------------------------------------
// On-demand server re-test (dry-run every safe read/list tool)
// ---------------------------------------------------------------------------

/** The per-tool outcome of a server re-test dry-run. */
export interface RetestToolResult {
  name: string;
  ok: boolean;
  status: number | null;
  durationMs: number;
  error: string | null;
  /** Sample args synthesized for required parameters, if any. */
  sampleArgs?: Record<string, unknown>;
}

/** Summary of dry-running every safe read/list tool of a constructed server. */
export interface RetestServerOutcome {
  /** Total capabilities on the server. */
  total: number;
  /** Number of safe tools that were actually dry-run. */
  ran: number;
  /** Number of dry-runs that succeeded. */
  passed: number;
  /** Number of dry-runs that failed. */
  failed: number;
  /** Capabilities skipped because they were not safe to auto-invoke. */
  skipped: number;
  results: RetestToolResult[];
}

/**
 * Dry-run every safe read/list tool of a constructed server, reusing the exact
 * same execution path (`executeCapabilityRow`) and safety gate as the
 * post-import smoke test. Mutating (create/update/destructive) or human-review
 * tools are never invoked; they are only counted as skipped. Never throws — each
 * tool's ok/fail + error is surfaced so a user can re-verify a whole server's
 * health after changing its base URL or credentials. Each dry-run also persists
 * the tool's verified status via `recordCapabilityTest`, exactly like the
 * post-import smoke test.
 */
export async function retestServerTools(
  adapter: Adapter,
  capabilities: Capability[],
): Promise<RetestServerOutcome> {
  const candidates = pickSafeSmokeCandidates(capabilities);
  const results: RetestToolResult[] = [];
  for (const { capability, args } of candidates) {
    const result = await executeCapabilityRow(capability, adapter, args);
    await recordCapabilityTest(capability.id, result);
    results.push({
      name: capability.name,
      ok: result.ok,
      status: result.status ?? null,
      durationMs: result.durationMs,
      error: result.error ?? null,
      ...(Object.keys(args).length > 0 ? { sampleArgs: args } : {}),
    });
  }
  const passed = results.filter((r) => r.ok).length;
  return {
    total: capabilities.length,
    ran: results.length,
    passed,
    failed: results.length - passed,
    skipped: capabilities.length - results.length,
    results,
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
