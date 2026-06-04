import { resolveSecret, isSecretRef } from "./secretStore";
import { logger } from "./logger";

/**
 * Thin Telegram Bot API client. The bot token is read from the
 * TELEGRAM_BOT_TOKEN secret (either a raw value in the environment or an opaque
 * `secret://` reference resolved via the secret store). All calls target the
 * fixed public host api.telegram.org, so no SSRF guard is needed here.
 */

const TELEGRAM_API_BASE = "https://api.telegram.org";

export function getBotToken(): string | null {
  const raw = process.env.TELEGRAM_BOT_TOKEN;
  if (!raw) return null;
  if (isSecretRef(raw)) return resolveSecret(raw);
  return raw;
}

export function getWebhookSecret(): string | null {
  return process.env.TELEGRAM_WEBHOOK_SECRET ?? null;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

async function callTelegram<T>(
  method: string,
  params: Record<string, unknown>,
): Promise<TelegramApiResponse<T>> {
  const token = getBotToken();
  if (!token) {
    return { ok: false, description: "TELEGRAM_BOT_TOKEN is not configured." };
  }
  const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json()) as TelegramApiResponse<T>;
    if (!json.ok) {
      logger.warn(
        { method, error_code: json.error_code, description: json.description },
        "Telegram API call failed",
      );
    }
    return json;
  } catch (err) {
    logger.error({ err, method }, "Telegram API request threw");
    return {
      ok: false,
      description: err instanceof Error ? err.message : "Request failed.",
    };
  }
}

const MAX_TELEGRAM_MESSAGE = 4096;

/** Send a text message, splitting overly long content into multiple messages. */
export async function sendMessage(
  chatId: number | string,
  text: string,
): Promise<void> {
  const trimmed = text.trim() || "(empty reply)";
  for (let i = 0; i < trimmed.length; i += MAX_TELEGRAM_MESSAGE) {
    const chunk = trimmed.slice(i, i + MAX_TELEGRAM_MESSAGE);
    await callTelegram("sendMessage", { chat_id: chatId, text: chunk });
  }
}

/** Send the "typing" chat action so the user sees activity while we think. */
export async function sendTyping(chatId: number | string): Promise<void> {
  await callTelegram("sendChatAction", { chat_id: chatId, action: "typing" });
}

export async function getMe(): Promise<TelegramApiResponse<TelegramUser>> {
  return callTelegram<TelegramUser>("getMe", {});
}

export async function setWebhook(
  url: string,
  secretToken: string,
): Promise<TelegramApiResponse<boolean>> {
  return callTelegram<boolean>("setWebhook", {
    url,
    secret_token: secretToken,
    allowed_updates: ["message"],
    drop_pending_updates: true,
  });
}

export async function deleteWebhook(): Promise<TelegramApiResponse<boolean>> {
  return callTelegram<boolean>("deleteWebhook", { drop_pending_updates: true });
}

export interface WebhookInfo {
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  last_error_date?: number;
  last_error_message?: string;
}

export async function getWebhookInfo(): Promise<
  TelegramApiResponse<WebhookInfo>
> {
  return callTelegram<WebhookInfo>("getWebhookInfo", {});
}
