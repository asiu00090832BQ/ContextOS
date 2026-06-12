import app from "./app";
import { logger } from "./lib/logger";
import { pruneTelegramHistory } from "./lib/telegramEngine";
import { pruneEmailHistory } from "./lib/emailEngine";
import { reconcileRunConversations } from "./lib/chatEngine";
import { bootstrapContext } from "./lib/context";
import {
  ensureSchema,
  ensureBotModel,
  ensureTelegramWebhook,
} from "./lib/provisioning";

// Sweep expired (>48h) Telegram/email chat history on this cadence (and at boot).
const TELEGRAM_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Default port for a plain clone so running the server needs no extra config;
// platforms that inject PORT (e.g. Replit) still take precedence.
const DEFAULT_PORT = 8080;

const rawPort = process.env["PORT"];
const port = rawPort ? Number(rawPort) : DEFAULT_PORT;

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

/**
 * One-time startup preparation so a fresh clone needs only two steps (fill the
 * root `.env`, then run the server): apply the schema (dev), ensure the owner /
 * tenant / bot exist, and auto-provision the bot's model from `.env`.
 */
async function prepare(): Promise<void> {
  await ensureSchema();
  const { tenant, botAgent } = await bootstrapContext();
  await ensureBotModel(tenant.id, botAgent.id);
}

void prepare()
  .catch((err) => {
    logger.error({ err }, "Startup preparation failed; continuing to listen");
  })
  .finally(() => {
    app.listen(port, (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }

      logger.info({ port }, "Server listening");

      const runPrune = () => {
        void pruneTelegramHistory().catch((e) =>
          logger.error({ err: e }, "Telegram history prune failed"),
        );
        void pruneEmailHistory().catch((e) =>
          logger.error({ err: e }, "Email history prune failed"),
        );
      };
      runPrune();
      setInterval(runPrune, TELEGRAM_PRUNE_INTERVAL_MS);

      // Optionally register the Telegram webhook when a token and explicit
      // public URL are configured; otherwise the manual path is used.
      void ensureTelegramWebhook().catch((e) =>
        logger.error({ err: e }, "Telegram webhook registration failed"),
      );

      // Durably recover any run-driven chat follow-ups that were lost to a
      // restart while their run was still in flight (in-process subscriptions
      // don't survive a process bounce). Idempotent — safe to run on every boot.
      void reconcileRunConversations().catch((e) =>
        logger.error({ err: e }, "Run/conversation reconciliation sweep failed"),
      );
    });
  });
