import { Router, type IRouter } from "express";
import {
  getMe,
  setWebhook,
  deleteWebhook,
  getWebhookInfo,
  sendMessage,
  sendTyping,
  getBotToken,
  getWebhookSecret,
  type TelegramUpdate,
} from "../lib/telegram";
import { handleTelegramMessage, resolveOwnerTarget } from "../lib/telegramEngine";
import { getContext } from "../lib/context";
import { resolveAgentModel } from "../lib/runEngine";
import { logger } from "../lib/logger";

/**
 * Unauthenticated Telegram webhook. This router is mounted OUTSIDE the tenant
 * context / API-key surface: Telegram cannot send a bearer token, so requests
 * are authenticated solely by the secret token Telegram echoes back in the
 * X-Telegram-Bot-Api-Secret-Token header (configured at setWebhook time).
 */
export const telegramWebhookRouter: IRouter = Router();

telegramWebhookRouter.post("/telegram/webhook", (req, res): void => {
  const expected = getWebhookSecret();
  const provided = req.header("x-telegram-bot-api-secret-token");
  // Always require a configured secret AND a matching header. Reject otherwise.
  if (!expected || provided !== expected) {
    res.status(401).json({ error: "Unauthorized." });
    return;
  }

  const update = req.body as TelegramUpdate;
  // Acknowledge immediately so Telegram does not retry while we call the model.
  res.status(200).json({ ok: true });

  const message = update?.message ?? update?.edited_message;
  const text = message?.text?.trim();
  if (!message || !text) return;

  const chatId = String(message.chat.id);
  const chatTitle =
    message.chat.title ||
    message.chat.username ||
    message.chat.first_name ||
    `Telegram ${chatId}`;

  void (async () => {
    try {
      await sendTyping(chatId);
      const { tenantId, userId } = await resolveOwnerTarget();
      const reply = await handleTelegramMessage(
        tenantId,
        userId,
        chatId,
        chatTitle,
        text,
      );
      await sendMessage(chatId, reply);
    } catch (err) {
      logger.error({ err, chatId }, "Failed to process Telegram update");
      try {
        await sendMessage(
          chatId,
          "Sorry, something went wrong handling your message. Please try again.",
        );
      } catch {
        // best-effort; nothing more we can do
      }
    }
  })();
});

/**
 * Owner-only admin endpoints (mounted under the tenant-context surface) for
 * configuring and inspecting the Telegram webhook from the web UI.
 */
export const telegramAdminRouter: IRouter = Router();

telegramAdminRouter.get("/telegram/status", async (_req, res): Promise<void> => {
  const tokenConfigured = Boolean(getBotToken());
  const secretConfigured = Boolean(getWebhookSecret());
  if (!tokenConfigured) {
    res.json({
      tokenConfigured,
      secretConfigured,
      bot: null,
      webhook: null,
    });
    return;
  }
  const [me, info] = await Promise.all([getMe(), getWebhookInfo()]);
  res.json({
    tokenConfigured,
    secretConfigured,
    bot: me.ok ? me.result : null,
    webhook: info.ok ? info.result : null,
    error: me.ok ? info.ok ? undefined : info.description : me.description,
  });
});

telegramAdminRouter.post(
  "/telegram/set-webhook",
  async (req, res): Promise<void> => {
    const token = getBotToken();
    const secret = getWebhookSecret();
    if (!token || !secret) {
      res
        .status(400)
        .json({ error: "TELEGRAM_BOT_TOKEN is not configured." });
      return;
    }
    const url =
      typeof req.body?.url === "string" && req.body.url.length > 0
        ? (req.body.url as string)
        : null;
    if (!url || !/^https:\/\//.test(url)) {
      res
        .status(400)
        .json({ error: "A public https `url` is required." });
      return;
    }
    const result = await setWebhook(url, secret);
    if (!result.ok) {
      res.status(502).json({ error: result.description ?? "setWebhook failed." });
      return;
    }
    res.json({ ok: true, url });
  },
);

telegramAdminRouter.post(
  "/telegram/delete-webhook",
  async (_req, res): Promise<void> => {
    if (!getBotToken()) {
      res.status(400).json({ error: "TELEGRAM_BOT_TOKEN is not configured." });
      return;
    }
    const result = await deleteWebhook();
    if (!result.ok) {
      res
        .status(502)
        .json({ error: result.description ?? "deleteWebhook failed." });
      return;
    }
    res.json({ ok: true });
  },
);

/**
 * The model the Telegram bot uses. It is the ContextOS Bot agent's own model
 * (the single source of truth shared with the in-app bot), so it is read-only
 * here — change it on the agent itself. Returns the resolved endpoint name.
 */
telegramAdminRouter.get("/telegram/model", async (req, res): Promise<void> => {
  const { botAgent } = await getContext();
  const { primary } = await resolveAgentModel(req.tenantId, botAgent.id);
  res.json({
    modelEndpointName: primary?.name ?? "Managed Anthropic (Claude Sonnet 4.6)",
  });
});
