import { createHmac, timingSafeEqual } from "node:crypto";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { logger } from "./logger";

/**
 * Thin AgentMail client. Authentication is handled entirely by the Replit
 * Connectors proxy (there is no API key in our environment): every request is
 * routed through connectors.proxy("agentmail", ...), which injects the user's
 * authorized credentials. The proxy returns a raw Response, so each call parses
 * the body itself.
 *
 * AgentMail gives the ContextOS bot its own email inbox that can both send and
 * receive. Inbound mail is delivered to us as Svix-signed webhook events.
 */

const CONNECTOR = "agentmail";

export class AgentMailError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AgentMailError";
    this.status = status;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function call<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  // Never cache the client — the proxy refreshes credentials per request.
  const connectors = new ReplitConnectors();
  const hasBody = init?.body !== undefined;
  const res = await connectors.proxy(CONNECTOR, path, {
    method: init?.method ?? "GET",
    headers: hasBody ? { "content-type": "application/json" } : undefined,
    body: hasBody ? JSON.stringify(init?.body) : undefined,
  });
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const message =
      (data as { error?: { message?: string }; message?: string } | null)?.error
        ?.message ??
      (data as { message?: string } | null)?.message ??
      `AgentMail request ${path} failed (${res.status}).`;
    throw new AgentMailError(message, res.status);
  }
  return data as T;
}

export interface AgentMailInbox {
  inbox_id: string;
  email: string;
  display_name?: string | null;
}

export interface AgentMailWebhook {
  webhook_id: string;
  url: string;
  secret: string;
  event_types: string[];
  enabled: boolean;
}

/** A single received message as carried by a message.received webhook event. */
export interface AgentMailMessage {
  inbox_id: string;
  thread_id: string;
  message_id: string;
  from: string;
  to?: string[];
  subject?: string | null;
  text?: string | null;
  preview?: string | null;
}

export interface MessageReceivedEvent {
  type: string;
  event_type: string;
  event_id: string;
  message: AgentMailMessage;
}

/** Whether the AgentMail connection is reachable/authorized. */
export async function isAgentMailConnected(): Promise<boolean> {
  try {
    await call("/v0/inboxes");
    return true;
  } catch (err) {
    if (
      err instanceof AgentMailError &&
      (err.status === 401 || err.status === 403)
    ) {
      return false;
    }
    throw err;
  }
}

export async function listInboxes(): Promise<AgentMailInbox[]> {
  const data = await call<{ inboxes?: AgentMailInbox[] } | AgentMailInbox[]>(
    "/v0/inboxes",
  );
  if (Array.isArray(data)) return data;
  return data.inboxes ?? [];
}

export async function createInbox(
  displayName: string,
): Promise<AgentMailInbox> {
  return call<AgentMailInbox>("/v0/inboxes", {
    method: "POST",
    body: { display_name: displayName },
  });
}

/** Return the bot's inbox, provisioning one the first time. */
export async function getOrCreateInbox(
  displayName: string,
): Promise<AgentMailInbox> {
  const existing = await listInboxes();
  if (existing.length > 0) return existing[0];
  return createInbox(displayName);
}

/** Reply in-thread to a received message (keeps the email conversation intact). */
export async function sendReply(
  inboxId: string,
  messageId: string,
  text: string,
): Promise<{ message_id: string; thread_id: string }> {
  return call(
    `/v0/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(
      messageId,
    )}/reply`,
    { method: "POST", body: { text } },
  );
}

/**
 * Send a brand-new email (a fresh thread) from the bot's inbox. Unlike
 * `sendReply`, this starts a new conversation with the given recipient(s),
 * subject, and plain-text body. Used by the bot's `send_email` tool.
 */
export async function sendMessage(
  inboxId: string,
  opts: { to: string | string[]; subject?: string; text: string },
): Promise<{ message_id: string; thread_id: string }> {
  return call(`/v0/inboxes/${encodeURIComponent(inboxId)}/messages`, {
    method: "POST",
    body: {
      to: Array.isArray(opts.to) ? opts.to : [opts.to],
      ...(opts.subject ? { subject: opts.subject } : {}),
      text: opts.text,
    },
  });
}

export async function createWebhook(
  url: string,
  inboxId: string,
): Promise<AgentMailWebhook> {
  return call<AgentMailWebhook>("/v0/webhooks", {
    method: "POST",
    body: { url, event_types: ["message.received"], inbox_ids: [inboxId] },
  });
}

export async function deleteWebhook(webhookId: string): Promise<void> {
  await call(`/v0/webhooks/${encodeURIComponent(webhookId)}`, {
    method: "DELETE",
  });
}

// Reject signed payloads whose timestamp is outside this window (in seconds) to
// blunt replay of an old, captured-but-still-validly-signed delivery.
const WEBHOOK_TOLERANCE_SEC = 5 * 60;

/**
 * Verify an AgentMail (Svix) webhook signature. AgentMail signs each delivery
 * with the per-webhook `secret`: the signed content is `${id}.${timestamp}.${body}`
 * HMAC-SHA256'd with the base64 secret (after the `whsec_` prefix). The
 * svix-signature header is a space-separated list of `v1,<base64sig>` entries;
 * the delivery is genuine if any entry matches. Uses a constant-time compare and
 * also enforces timestamp freshness (±5 min) to resist replay.
 */
export function verifyWebhookSignature(
  secret: string,
  headers: { id?: string; timestamp?: string; signature?: string },
  rawBody: string,
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  // Timestamp freshness: must be a recent unix-seconds value.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > WEBHOOK_TOLERANCE_SEC) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const expected = createHmac("sha256", key)
    .update(signedContent)
    .digest("base64");
  const expectedBuf = Buffer.from(expected);
  for (const part of signature.split(" ")) {
    const sig = part.includes(",") ? part.split(",")[1] : part;
    const sigBuf = Buffer.from(sig);
    if (
      sigBuf.length === expectedBuf.length &&
      timingSafeEqual(sigBuf, expectedBuf)
    ) {
      return true;
    }
  }
  return false;
}

export { logger as agentMailLogger };
