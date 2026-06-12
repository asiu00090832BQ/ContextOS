import { spawn } from "node:child_process";
import { and, eq } from "drizzle-orm";
import {
  db,
  agentModelPoliciesTable,
  modelEndpointsTable,
} from "@workspace/db";
import { MANAGED_ANTHROPIC_REF, MANAGED_ANTHROPIC_MODEL } from "./toolChat";
import { getBotToken, getWebhookSecret, setWebhook } from "./telegram";
import { logger } from "./logger";

/** True when not running in a production deployment. */
export function isDevelopment(): boolean {
  return process.env.NODE_ENV !== "production";
}

/**
 * Provider precedence for auto-provisioning the bot's model from `.env`. The
 * first provider whose API key is present wins. Each entry carries the env var
 * that supplies the key, a sensible default model, and (where the provider is
 * not reachable at its built-in default) an explicit base URL.
 *
 * Keep the env var names in sync with PROVIDER_ENV_FALLBACK in secretStore.ts —
 * the same names are what `resolveEndpointApiKey` reads at call time, so an
 * endpoint provisioned here resolves its key without storing anything.
 */
interface ProviderSpec {
  providerType: string;
  envVar: string;
  modelName: string;
  baseUrl: string | null;
  label: string;
}

const PROVIDER_PRECEDENCE: ProviderSpec[] = [
  {
    providerType: "openai",
    envVar: "OPENAI_API_KEY",
    modelName: "gpt-4o",
    baseUrl: "https://api.openai.com/v1",
    label: "OpenAI",
  },
  {
    providerType: "anthropic",
    envVar: "ANTHROPIC_API_KEY",
    modelName: "claude-3-5-sonnet-latest",
    baseUrl: "https://api.anthropic.com",
    label: "Anthropic",
  },
  {
    providerType: "google",
    envVar: "GEMINI_API_KEY",
    modelName: "gemini-1.5-pro",
    baseUrl: null,
    label: "Google Gemini",
  },
  {
    providerType: "openrouter",
    envVar: "OPENROUTER_API_KEY",
    modelName: "anthropic/claude-3.5-sonnet",
    baseUrl: "https://openrouter.ai/api/v1",
    label: "OpenRouter",
  },
];

interface ProvisionChoice {
  name: string;
  providerType: string;
  modelName: string;
  baseUrl: string | null;
  apiKeyRef: string | null;
  label: string;
}

/**
 * Choose which model endpoint to auto-provision from the environment. Explicit
 * provider keys win in PROVIDER_PRECEDENCE order; if none is present and we are
 * on Replit in development, fall back to the keyless managed Anthropic endpoint.
 * Returns null when nothing usable is configured.
 */
function selectProvider(): ProvisionChoice | null {
  for (const spec of PROVIDER_PRECEDENCE) {
    const key = process.env[spec.envVar];
    if (key && key.trim()) {
      return {
        name: `${spec.label} (from .env)`,
        providerType: spec.providerType,
        modelName: spec.modelName,
        baseUrl: spec.baseUrl,
        // Key is resolved from the environment at call time via
        // resolveEndpointApiKey; nothing is stored in the secret file.
        apiKeyRef: null,
        label: spec.label,
      };
    }
  }
  // Keyless Replit-managed Anthropic, only in development (managed routing is
  // not available in deployments, so we never provision it for production).
  if (isDevelopment() && process.env.REPL_ID) {
    return {
      name: "Replit Claude (managed)",
      providerType: "anthropic",
      modelName: MANAGED_ANTHROPIC_MODEL,
      baseUrl: null,
      apiKeyRef: MANAGED_ANTHROPIC_REF,
      label: "Replit-managed Anthropic",
    };
  }
  return null;
}

/**
 * Ensure the ContextOS Bot agent has a usable model policy. Idempotent and
 * non-destructive: if the bot already has a policy with a primary endpoint, this
 * does nothing. Otherwise it provisions a model endpoint from the
 * highest-precedence provider key present in the environment and wires it to the
 * bot as the primary model, so a fresh clone needs no manual model setup.
 */
export async function ensureBotModel(
  tenantId: string,
  botAgentId: string,
): Promise<void> {
  const [policy] = await db
    .select()
    .from(agentModelPoliciesTable)
    .where(
      and(
        eq(agentModelPoliciesTable.tenantId, tenantId),
        eq(agentModelPoliciesTable.agentId, botAgentId),
      ),
    );
  if (policy?.primaryEndpointId) return;

  const choice = selectProvider();
  if (!choice) {
    logger.warn(
      "No model provider key found in environment; the ContextOS Bot has no " +
        "model. Set one of OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, " +
        "or OPENROUTER_API_KEY in the root .env, then restart.",
    );
    return;
  }

  // Reuse an endpoint we previously auto-provisioned (matched by its stable
  // name) so repeated boots never create duplicates.
  let [endpoint] = await db
    .select()
    .from(modelEndpointsTable)
    .where(
      and(
        eq(modelEndpointsTable.tenantId, tenantId),
        eq(modelEndpointsTable.name, choice.name),
      ),
    );
  if (!endpoint) {
    [endpoint] = await db
      .insert(modelEndpointsTable)
      .values({
        tenantId,
        name: choice.name,
        providerType: choice.providerType as never,
        baseUrl: choice.baseUrl,
        modelName: choice.modelName,
        apiKeyRef: choice.apiKeyRef,
        isDefault: true,
        status: "active",
      })
      .returning();
  }

  if (policy) {
    await db
      .update(agentModelPoliciesTable)
      .set({ primaryEndpointId: endpoint.id })
      .where(eq(agentModelPoliciesTable.id, policy.id));
  } else {
    await db.insert(agentModelPoliciesTable).values({
      tenantId,
      agentId: botAgentId,
      primaryEndpointId: endpoint.id,
      temperature: 70,
      maxTokens: 4096,
    });
  }

  logger.info(
    { provider: choice.label, model: choice.modelName, endpoint: choice.name },
    "Auto-provisioned ContextOS Bot model from environment",
  );
}

/**
 * Apply the database schema named in DATABASE_URL by running drizzle-kit's
 * idempotent `push`. Development only: production keeps its existing deploy /
 * migration flow untouched. A clone therefore needs no manual `db push`.
 *
 * Runs the existing `@workspace/db` push-force script as a child process so the
 * exact same drizzle config (which loads the root `.env`) is used. Failures are
 * logged but do not abort boot — the server still starts and surfaces clear
 * errors on the first query if the schema is genuinely missing.
 */
export async function ensureSchema(): Promise<void> {
  if (!isDevelopment()) return;
  if (process.env.CONTEXTOS_SKIP_DB_PUSH === "1") {
    logger.info("Skipping automatic schema push (CONTEXTOS_SKIP_DB_PUSH=1)");
    return;
  }

  logger.info("Applying database schema (drizzle-kit push)...");
  await new Promise<void>((resolvePromise) => {
    const child = spawn(
      "pnpm",
      ["--filter", "@workspace/db", "run", "push-force"],
      { stdio: "inherit", env: process.env },
    );
    child.on("error", (err) => {
      logger.error(
        { err },
        "Automatic schema push could not start (is pnpm on PATH?); " +
          "continuing boot",
      );
      resolvePromise();
    });
    child.on("close", (code) => {
      if (code === 0) {
        logger.info("Database schema is up to date");
      } else {
        logger.error(
          { code },
          "Automatic schema push exited non-zero; continuing boot",
        );
      }
      resolvePromise();
    });
  });
}

/**
 * Optionally register the Telegram webhook on boot. A webhook inherently needs a
 * public HTTPS URL, so this only runs when BOTH a bot token and an explicit
 * full webhook URL (TELEGRAM_WEBHOOK_URL, e.g.
 * `https://<your-host>/api/telegram/webhook`) are present. Otherwise the
 * existing manual path (POST /api/telegram/set-webhook from the UI) is used.
 */
export async function ensureTelegramWebhook(): Promise<void> {
  const token = getBotToken();
  const url = process.env.TELEGRAM_WEBHOOK_URL?.trim();
  if (!token || !url) return;
  if (!/^https:\/\//.test(url)) {
    logger.warn(
      { url },
      "TELEGRAM_WEBHOOK_URL must be a public https URL; skipping webhook setup",
    );
    return;
  }
  const secret = getWebhookSecret();
  if (!secret) return;
  const result = await setWebhook(url, secret);
  if (result.ok) {
    logger.info({ url }, "Registered Telegram webhook from environment");
  } else {
    logger.error(
      { url, description: result.description },
      "Failed to register Telegram webhook from environment",
    );
  }
}
