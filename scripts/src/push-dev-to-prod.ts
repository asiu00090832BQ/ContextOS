/**
 * push-dev-to-prod
 * --------------------------------------------------------------------------
 * On-demand helper that copies your ContextOS *configuration data* from the
 * dev workspace into a published (production) deployment.
 *
 * It is HTTP-to-HTTP: it READS from the dev API and WRITES to the prod API,
 * so it never touches either database directly and needs no DB credentials.
 *
 * What it syncs (matched by NAME, since row IDs differ across environments):
 *   - Agents            (create if missing, update if present)
 *   - Agent model policy (which model endpoint each agent uses, temp, maxTokens)
 *   - The reserved "ContextOS Bot" agent (context policy + system prompt + model)
 *   - The bot's long-term memory (curated partition; matched by key, upserted)
 *   - Model endpoints    (optional: create shells for any missing in prod)
 *
 * What it does NOT do (by design / platform limits):
 *   - It never copies secrets (API keys). Endpoints are matched by name; if an
 *     endpoint is missing in prod it can create a *shell* (no key) with
 *     --create-endpoints, but you must set the key in the prod app afterwards.
 *   - It never deletes prod-only agents/endpoints. It is additive + updating.
 *   - It is NOT continuous. Run it whenever you want to push the latest dev
 *     setup to prod.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run push-prod            # dry run (default)
 *   pnpm --filter @workspace/scripts run push-prod -- --apply # actually write
 *
 * Flags / env:
 *   --apply                 Perform writes. Without it, runs a read-only dry run.
 *   --prod <url>            Prod base URL (default env PROD_BASE or the published URL)
 *   --dev  <url>            Dev base URL  (default env DEV_BASE or http://localhost:8080)
 *   --create-endpoints      Create shell endpoints in prod for any missing by name
 *   --only <names>          Comma-separated agent names to sync (default: all)
 *   --include-inactive      Also sync agents whose isActive=false (default: skip)
 */

const BOT_AGENT_NAME = "ContextOS Bot";
const DEFAULT_PROD = "https://vibe-code-platform.replit.app";
const DEFAULT_DEV = "http://localhost:8080";

interface ModelPolicy {
  primaryEndpointId?: string | null;
  fallbackEndpointId?: string | null;
  temperature?: number;
  maxTokens?: number;
}
interface Agent {
  id: string;
  name: string;
  role: string;
  description?: string | null;
  systemPrompt?: string | null;
  capabilityScope?: string[] | null;
  contextPolicy: string;
  exposeAsCapabilityProvider?: boolean;
  canBuildIntegrations?: boolean;
  isActive: boolean;
  modelPolicy?: ModelPolicy;
}
interface ModelEndpoint {
  id: string;
  name: string;
  providerType: string;
  baseUrl?: string | null;
  host?: string | null;
  port?: number | null;
  modelName?: string | null;
  apiKeyRef?: string | null;
  organization?: string | null;
  deployment?: string | null;
  requestTimeoutMs?: number | null;
  maxRetries?: number | null;
  isDefault?: boolean;
}
interface BotMemory {
  id: string;
  type: string;
  key: string;
  value: string;
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const APPLY = args.apply === true;
const CREATE_ENDPOINTS = args["create-endpoints"] === true;
const INCLUDE_INACTIVE = args["include-inactive"] === true;
const PROD_BASE = String(args.prod || process.env.PROD_BASE || DEFAULT_PROD).replace(/\/$/, "");
const DEV_BASE = String(args.dev || process.env.DEV_BASE || DEFAULT_DEV).replace(/\/$/, "");
const ONLY = typeof args.only === "string"
  ? new Set(args.only.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))
  : null;

const warnings: string[] = [];
const tag = APPLY ? "APPLY" : "DRY-RUN";
function log(msg: string) {
  console.log(msg);
}
function warn(msg: string) {
  warnings.push(msg);
  console.log(`  ⚠️  ${msg}`);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
async function http<T = unknown>(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

function assertNoDuplicateNames(items: { name: string }[], label: string) {
  const seen = new Map<string, number>();
  for (const it of items) {
    const k = it.name.toLowerCase();
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const dups = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  if (dups.length) {
    throw new Error(
      `Duplicate ${label} names (case-insensitive) make name-matching ambiguous: ` +
        `${dups.join(", ")}. Rename so each is unique in both envs, then re-run.`,
    );
  }
}

// Memory identity is the `key` (case-sensitive). Duplicate keys would make the
// upsert ambiguous, so stop loudly rather than guess which row to update.
function assertNoDuplicateMemoryKeys(items: { key: string }[], label: string) {
  const seen = new Map<string, number>();
  for (const it of items) seen.set(it.key, (seen.get(it.key) ?? 0) + 1);
  const dups = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  if (dups.length) {
    throw new Error(
      `Duplicate ${label} keys make matching ambiguous: ${dups.join(", ")}. ` +
        `De-duplicate, then re-run.`,
    );
  }
}

async function preflight(base: string, label: string) {
  try {
    await http(base, "GET", "/api/healthz");
  } catch (err) {
    throw new Error(
      `${label} API not reachable at ${base} (${(err as Error).message}). ` +
        (label === "PROD"
          ? "Is the deployment live yet? Pass --prod <url> if the URL differs."
          : "Is the dev API Server workflow running?"),
    );
  }
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------
async function loadAgentsWithPolicies(base: string): Promise<Agent[]> {
  const list = await http<Agent[]>(base, "GET", "/api/agents");
  const full: Agent[] = [];
  for (const a of list) {
    // GET by id includes the modelPolicy block (the list endpoint omits it).
    const detail = await http<Agent>(base, "GET", `/api/agents/${a.id}`);
    full.push(detail);
  }
  return full;
}

// The bot's curated long-term memory partition (agentId = bot, runId IS NULL).
// Run-scoped short-term memories are deliberately NOT synced: they belong to a
// specific run that does not exist in the other environment.
async function loadBotMemories(base: string): Promise<BotMemory[]> {
  return http<BotMemory[]>(base, "GET", "/api/bot/memories");
}

// ---------------------------------------------------------------------------
// Endpoint resolution (dev endpoint id -> prod endpoint id, matched by name)
// ---------------------------------------------------------------------------
function buildEndpointResolver(
  devEndpoints: ModelEndpoint[],
  prodByName: Map<string, ModelEndpoint>,
) {
  const devById = new Map(devEndpoints.map((e) => [e.id, e]));
  return function resolve(devEndpointId: string | null | undefined, ctx: string): string | null {
    if (!devEndpointId) return null;
    const devEp = devById.get(devEndpointId);
    if (!devEp) {
      warn(`${ctx}: dev endpoint id ${devEndpointId} not found in dev; skipping.`);
      return null;
    }
    const prodEp = prodByName.get(devEp.name.toLowerCase());
    if (!prodEp) {
      warn(`${ctx}: prod has no model endpoint named "${devEp.name}"; model not set. ` +
        `Create it in prod (with its API key) or re-run with --create-endpoints.`);
      return null;
    }
    return prodEp.id;
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  log(`\n=== push-dev-to-prod [${tag}] ===`);
  log(`  dev:  ${DEV_BASE}`);
  log(`  prod: ${PROD_BASE}`);
  if (!APPLY) log(`  (read-only — pass --apply to write changes to prod)`);
  log("");

  await preflight(DEV_BASE, "DEV");
  await preflight(PROD_BASE, "PROD");

  const [devAgents, devEndpoints, prodAgents, prodEndpoints] = await Promise.all([
    loadAgentsWithPolicies(DEV_BASE),
    http<ModelEndpoint[]>(DEV_BASE, "GET", "/api/model-endpoints"),
    loadAgentsWithPolicies(PROD_BASE),
    http<ModelEndpoint[]>(PROD_BASE, "GET", "/api/model-endpoints"),
  ]);

  // Name-matching is the whole strategy, so ambiguous names are a hard stop.
  assertNoDuplicateNames(devAgents, "dev agent");
  assertNoDuplicateNames(prodAgents, "prod agent");
  assertNoDuplicateNames(devEndpoints, "dev endpoint");
  assertNoDuplicateNames(prodEndpoints, "prod endpoint");

  const prodAgentByName = new Map(prodAgents.map((a) => [a.name.toLowerCase(), a]));
  const prodEndpointByName = new Map(prodEndpoints.map((e) => [e.name.toLowerCase(), e]));

  // --- 1. Model endpoints (optional shell creation) ----------------------
  log(`-- Model endpoints (dev: ${devEndpoints.length}, prod: ${prodEndpoints.length}) --`);
  for (const ep of devEndpoints) {
    const existing = prodEndpointByName.get(ep.name.toLowerCase());
    if (existing) {
      log(`  = "${ep.name}" already in prod`);
      continue;
    }
    if (!CREATE_ENDPOINTS) {
      warn(`"${ep.name}" missing in prod (pass --create-endpoints to add a shell).`);
      continue;
    }
    const body = {
      name: ep.name,
      providerType: ep.providerType,
      modelName: ep.modelName || "",
      ...(ep.baseUrl ? { baseUrl: ep.baseUrl } : {}),
      ...(ep.host ? { host: ep.host } : {}),
      ...(ep.port != null ? { port: ep.port } : {}),
      ...(ep.organization ? { organization: ep.organization } : {}),
      ...(ep.deployment ? { deployment: ep.deployment } : {}),
      ...(ep.requestTimeoutMs != null ? { requestTimeoutMs: ep.requestTimeoutMs } : {}),
      ...(ep.maxRetries != null ? { maxRetries: ep.maxRetries } : {}),
    };
    log(`  + create endpoint "${ep.name}" (${ep.providerType})`);
    if (ep.apiKeyRef) {
      warn(`"${ep.name}" uses a stored API key in dev — the key is NOT copied. ` +
        `Set it in the prod app after this run, or the endpoint won't work.`);
    }
    if (APPLY) {
      const created = await http<ModelEndpoint>(PROD_BASE, "POST", "/api/model-endpoints", body);
      prodEndpointByName.set(created.name.toLowerCase(), created);
    }
  }

  const resolveEndpoint = buildEndpointResolver(devEndpoints, prodEndpointByName);

  // --- 2. Agents + model policies ----------------------------------------
  log(`\n-- Agents (dev: ${devAgents.length}, prod: ${prodAgents.length}) --`);
  let created = 0;
  let updated = 0;
  let policiesSet = 0;
  let skipped = 0;

  for (const a of devAgents) {
    if (ONLY && !ONLY.has(a.name.toLowerCase())) continue;
    if (!a.isActive && !INCLUDE_INACTIVE && a.name !== BOT_AGENT_NAME) {
      log(`  - skip inactive "${a.name}" (use --include-inactive to sync)`);
      skipped++;
      continue;
    }

    // ----- The reserved bot: never create/rename; use /bot/policy ---------
    if (a.name === BOT_AGENT_NAME) {
      const prodBot = prodAgentByName.get(BOT_AGENT_NAME.toLowerCase());
      if (!prodBot) {
        warn(`Prod has no "${BOT_AGENT_NAME}" yet — message the bot once in prod to ` +
          `auto-create it, then re-run. Skipping bot for now.`);
        skipped++;
        continue;
      }
      log(`  ~ bot "${BOT_AGENT_NAME}": contextPolicy=${a.contextPolicy}`);
      if (APPLY) {
        await http(PROD_BASE, "PUT", "/api/bot/policy", {
          contextPolicy: a.contextPolicy,
          ...(a.systemPrompt != null ? { systemPrompt: a.systemPrompt } : {}),
        });
      }
      const primary = resolveEndpoint(a.modelPolicy?.primaryEndpointId, `bot model`);
      if (a.modelPolicy && primary) {
        const fallback = resolveEndpoint(a.modelPolicy.fallbackEndpointId, `bot fallback`);
        log(`    model -> endpoint ${primary}${fallback ? ` (fallback ${fallback})` : ""}`);
        if (APPLY) {
          await http(PROD_BASE, "PUT", `/api/agents/${prodBot.id}/model-policy`, {
            primaryEndpointId: primary,
            ...(fallback ? { fallbackEndpointId: fallback } : {}),
            ...(a.modelPolicy.temperature != null ? { temperature: a.modelPolicy.temperature } : {}),
            ...(a.modelPolicy.maxTokens != null ? { maxTokens: a.modelPolicy.maxTokens } : {}),
          });
          policiesSet++;
        }
      }
      updated++;
      continue;
    }

    // ----- Normal agents: upsert by name --------------------------------
    const prodAgent = prodAgentByName.get(a.name.toLowerCase());
    // Shared between create + update. `role` is create-only; `isActive` is
    // update-only (CreateAgentBody has no isActive — new agents start active).
    const common = {
      ...(a.description != null ? { description: a.description } : {}),
      ...(a.systemPrompt != null ? { systemPrompt: a.systemPrompt } : {}),
      ...(a.capabilityScope != null ? { capabilityScope: a.capabilityScope } : {}),
      contextPolicy: a.contextPolicy,
      ...(a.exposeAsCapabilityProvider != null
        ? { exposeAsCapabilityProvider: a.exposeAsCapabilityProvider }
        : {}),
      ...(a.canBuildIntegrations != null ? { canBuildIntegrations: a.canBuildIntegrations } : {}),
    };
    const stateLabel = `${a.role}, ${a.contextPolicy}${a.isActive ? "" : ", inactive"}`;

    let targetId: string | undefined = prodAgent?.id;
    if (prodAgent) {
      log(`  ~ update "${a.name}" (${stateLabel})`);
      if (APPLY) {
        await http(PROD_BASE, "PATCH", `/api/agents/${prodAgent.id}`, {
          name: a.name,
          ...common,
          isActive: a.isActive,
        });
      }
      updated++;
    } else {
      log(`  + create "${a.name}" (${stateLabel})`);
      if (APPLY) {
        const createdAgent = await http<Agent>(PROD_BASE, "POST", "/api/agents", {
          name: a.name,
          role: a.role,
          ...common,
        });
        targetId = createdAgent.id;
        prodAgentByName.set(createdAgent.name.toLowerCase(), createdAgent);
        // New agents are created active; match dev if it was inactive.
        if (!a.isActive) {
          await http(PROD_BASE, "PATCH", `/api/agents/${createdAgent.id}`, { isActive: false });
        }
      }
      created++;
    }

    // model policy
    if (a.modelPolicy?.primaryEndpointId) {
      const primary = resolveEndpoint(a.modelPolicy.primaryEndpointId, `"${a.name}" model`);
      const fallback = resolveEndpoint(a.modelPolicy.fallbackEndpointId, `"${a.name}" fallback`);
      if (primary) {
        log(`    model -> endpoint ${primary}${fallback ? ` (fallback ${fallback})` : ""}`);
        if (APPLY && targetId) {
          await http(PROD_BASE, "PUT", `/api/agents/${targetId}/model-policy`, {
            primaryEndpointId: primary,
            ...(fallback ? { fallbackEndpointId: fallback } : {}),
            ...(a.modelPolicy.temperature != null ? { temperature: a.modelPolicy.temperature } : {}),
            ...(a.modelPolicy.maxTokens != null ? { maxTokens: a.modelPolicy.maxTokens } : {}),
          });
          policiesSet++;
        }
      }
    } else if (prodAgent?.modelPolicy?.primaryEndpointId) {
      warn(`"${a.name}": dev has no model endpoint set but prod does; left unchanged ` +
        `(this helper never clears a model policy).`);
    }
  }

  // --- 3. Bot long-term memory (upsert by key) ---------------------------
  // Keys are the stable identity here: prod row ids differ, so we match dev
  // memories to prod ones by `key` and create/update accordingly. Never delete.
  let memoriesCreated = 0;
  let memoriesUpdated = 0;
  const prodHasBot = prodAgentByName.has(BOT_AGENT_NAME.toLowerCase());
  if (!ONLY || ONLY.has(BOT_AGENT_NAME.toLowerCase())) {
    if (!prodHasBot) {
      warn(`Skipping bot memory sync — prod has no "${BOT_AGENT_NAME}" yet.`);
    } else {
      const [devMems, prodMems] = await Promise.all([
        loadBotMemories(DEV_BASE),
        loadBotMemories(PROD_BASE),
      ]);
      assertNoDuplicateMemoryKeys(devMems, "dev bot memory");
      assertNoDuplicateMemoryKeys(prodMems, "prod bot memory");
      const prodMemByKey = new Map(prodMems.map((m) => [m.key, m]));
      log(`\n-- Bot long-term memory (dev: ${devMems.length}, prod: ${prodMems.length}) --`);
      for (const m of devMems) {
        const existing = prodMemByKey.get(m.key);
        if (!existing) {
          log(`  + create memory "${m.key}" (${m.type})`);
          if (APPLY) {
            await http(PROD_BASE, "POST", "/api/bot/memories", {
              type: m.type,
              key: m.key,
              value: m.value,
            });
          }
          memoriesCreated++;
        } else if (existing.value !== m.value || existing.type !== m.type) {
          log(`  ~ update memory "${m.key}" (${m.type})`);
          if (APPLY) {
            await http(PROD_BASE, "PUT", `/api/bot/memories/${existing.id}`, {
              type: m.type,
              key: m.key,
              value: m.value,
            });
          }
          memoriesUpdated++;
        } else {
          log(`  = memory "${m.key}" already up to date`);
        }
      }
    }
  }

  // --- Summary ----------------------------------------------------------
  log(`\n=== Summary [${tag}] ===`);
  log(`  agents created: ${created}`);
  log(`  agents updated: ${updated}`);
  log(`  model policies set: ${policiesSet}`);
  log(`  bot memories created: ${memoriesCreated}`);
  log(`  bot memories updated: ${memoriesUpdated}`);
  log(`  skipped: ${skipped}`);
  log(`  warnings: ${warnings.length}`);
  const prodOnly = prodAgents
    .filter((p) => !devAgents.some((d) => d.name.toLowerCase() === p.name.toLowerCase()))
    .map((p) => p.name);
  if (prodOnly.length) {
    log(`  note: prod-only agents left untouched: ${prodOnly.join(", ")}`);
  }
  if (!APPLY) {
    log(`\n  This was a DRY RUN. Re-run with --apply to push these changes.`);
  } else {
    log(`\n  Done. Production now reflects your dev setup.`);
  }
}

main().catch((err) => {
  console.error(`\n❌ ${(err as Error).message}`);
  process.exit(1);
});
