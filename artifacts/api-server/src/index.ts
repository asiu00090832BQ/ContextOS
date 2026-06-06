import app from "./app";
import { logger } from "./lib/logger";
import { pruneTelegramHistory } from "./lib/telegramEngine";
import { reconcileRunConversations } from "./lib/chatEngine";
import {
  refreshActiveWorkspaceState,
  WORKSPACE_STATE_POLL_INTERVAL_MS,
} from "./lib/mcpServer";

// Sweep expired (>48h) Telegram chat history on this cadence (and once at boot).
const TELEGRAM_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

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
  };
  runPrune();
  setInterval(runPrune, TELEGRAM_PRUNE_INTERVAL_MS);

  // Keep each active tenant's live workspace-state snapshot warm by re-checking
  // it on a short interval, so the bot reflects the latest state continuously —
  // not only when a message arrives. Idle tenants are evicted by the sweep.
  setInterval(() => {
    void refreshActiveWorkspaceState().catch((e) =>
      logger.error({ err: e }, "Workspace state poll sweep failed"),
    );
  }, WORKSPACE_STATE_POLL_INTERVAL_MS);

  // Durably recover any run-driven chat follow-ups that were lost to a restart
  // while their run was still in flight (in-process subscriptions don't survive
  // a process bounce). Idempotent — safe to run on every boot.
  void reconcileRunConversations().catch((e) =>
    logger.error({ err: e }, "Run/conversation reconciliation sweep failed"),
  );
});
