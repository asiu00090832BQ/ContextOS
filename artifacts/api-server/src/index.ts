import app from "./app";
import { logger } from "./lib/logger";
import { pruneTelegramHistory } from "./lib/telegramEngine";

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
});
