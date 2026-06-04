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
