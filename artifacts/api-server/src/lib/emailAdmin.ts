import { and, asc, eq } from "drizzle-orm";
import { db, emailConfigTable, emailAllowedSendersTable } from "@workspace/db";
import {
  isAgentMailConnected,
  getOrCreateInbox,
  createWebhook,
  deleteWebhook,
  sendMessage,
} from "./agentmail";
import { normalizeAddress } from "./emailUtils";
import { recordAudit } from "./audit";

/**
 * Shared email-channel administration service. Both the web admin routes
 * (`routes/email.ts`) and the ContextOS bot's email tools (`mcpServer.ts`) call
 * these functions, so setting up/managing the channel and sending email behaves
 * identically and is audited the same way regardless of surface.
 */

/** Audit actor fields, supplied by the calling surface (user or bot agent). */
export interface EmailActor {
  actorType?: "user" | "agent" | "service";
  actorId?: string | null;
  agentId?: string | null;
}

/** A typed admin failure with an HTTP status so the web routes can map it. */
export class EmailAdminError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "EmailAdminError";
    this.status = status;
  }
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const INBOX_DISPLAY_NAME = "ContextOS Bot";
const WEBHOOK_PATH = "/api/email/webhook";
const BASE64_RE = /^[A-Za-z0-9+/]+=*$/;

/** A single outbound attachment as accepted by `sendEmail`. */
export interface EmailAttachment {
  /** Displayed file name (e.g. "report.pdf"). */
  filename: string;
  /** The file's bytes, base64-encoded. */
  content: string;
  /** MIME type; defaults to application/octet-stream when omitted. */
  contentType?: string;
}

/**
 * Validate and shape caller-supplied attachments into AgentMail's payload form.
 * Each attachment needs a filename and base64 `content`; the MIME type defaults
 * to application/octet-stream. Throws an `EmailAdminError` on malformed input so
 * the web routes/bot get a clear 400 rather than a vague provider error.
 */
function normalizeAttachments(
  attachments?: EmailAttachment[],
): { filename: string; content: string; content_type: string }[] {
  if (!attachments || attachments.length === 0) return [];
  return attachments.map((att, i) => {
    const filename = (att?.filename ?? "").trim();
    const content = (att?.content ?? "").trim();
    if (!filename) {
      throw new EmailAdminError(
        `Attachment ${i + 1} is missing a \`filename\`.`,
      );
    }
    if (!content) {
      throw new EmailAdminError(
        `Attachment "${filename}" is missing base64 \`content\`.`,
      );
    }
    if (!BASE64_RE.test(content)) {
      throw new EmailAdminError(
        `Attachment "${filename}" \`content\` must be base64-encoded.`,
      );
    }
    const contentType = (att?.contentType ?? "").trim();
    return {
      filename,
      content,
      content_type: contentType || "application/octet-stream",
    };
  });
}

export interface EmailStatus {
  connected: boolean;
  error?: string;
  inbox: { inboxId: string; email: string } | null;
  webhook: { configured: boolean };
  enabled: boolean;
  allowedSenders: { id: string; address: string }[];
}

/**
 * Derive the public base URL of this deployment when there is no browser origin
 * to read (e.g. the bot connecting email over Telegram). Prefers an explicit
 * https override, then the deployment domain(s), then the dev domain.
 */
export function resolvePublicBaseUrl(override?: string): string | null {
  const explicit = (override ?? "").trim();
  if (explicit) {
    const cleaned = explicit.replace(/\/+$/, "");
    return /^https:\/\//.test(cleaned) ? cleaned : null;
  }
  const domains = (process.env.REPLIT_DOMAINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (domains.length > 0) return `https://${domains[0]}`;
  const dev = (process.env.REPLIT_DEV_DOMAIN ?? "").trim();
  if (dev) return `https://${dev}`;
  return null;
}

/**
 * Resolve the inbound-webhook URL. Accepts either an already-complete webhook
 * URL, a base URL override, or nothing (derive from the environment).
 */
export function resolveWebhookUrl(override?: string): string | null {
  const trimmed = (override ?? "").trim();
  if (/\/api\/email\/webhook\/?$/.test(trimmed)) {
    return /^https:\/\//.test(trimmed) ? trimmed.replace(/\/+$/, "") : null;
  }
  const base = resolvePublicBaseUrl(override);
  return base ? `${base}${WEBHOOK_PATH}` : null;
}

/** Current connection / inbox / allow-list state for this tenant. */
export async function getEmailStatus(tenantId: string): Promise<EmailStatus> {
  let connected = false;
  let connError: string | undefined;
  try {
    connected = await isAgentMailConnected();
  } catch (err) {
    connError = err instanceof Error ? err.message : String(err);
  }
  const [config] = await db
    .select()
    .from(emailConfigTable)
    .where(eq(emailConfigTable.tenantId, tenantId));
  const senders = await db
    .select()
    .from(emailAllowedSendersTable)
    .where(eq(emailAllowedSendersTable.tenantId, tenantId))
    .orderBy(asc(emailAllowedSendersTable.address));
  return {
    connected,
    error: connError,
    inbox: config ? { inboxId: config.inboxId, email: config.inboxEmail } : null,
    webhook: { configured: Boolean(config?.webhookId) },
    enabled: config?.enabled ?? true,
    allowedSenders: senders.map((s) => ({ id: s.id, address: s.address })),
  };
}

/**
 * Provision (or reuse) the bot's inbox and register the inbound webhook,
 * replacing any prior registration. `url` may be a complete webhook URL (web UI,
 * derived from the browser origin) or a base override; when omitted the public
 * base URL is derived from the environment (for the bot).
 */
export async function connectEmail(opts: {
  tenantId: string;
  actor: EmailActor;
  url?: string;
}): Promise<{ inbox: { email: string }; url: string }> {
  const { tenantId, actor } = opts;
  const url = resolveWebhookUrl(opts.url);
  if (!url) {
    throw new EmailAdminError(
      "Could not determine a public https webhook URL. Pass an explicit `baseUrl`.",
    );
  }
  if (!(await isAgentMailConnected())) {
    throw new EmailAdminError(
      "AgentMail is not connected. Connect the AgentMail integration first.",
    );
  }
  const inbox = await getOrCreateInbox(INBOX_DISPLAY_NAME);

  const [existing] = await db
    .select()
    .from(emailConfigTable)
    .where(eq(emailConfigTable.tenantId, tenantId));
  // Replace any prior webhook so we don't accumulate stale registrations.
  if (existing?.webhookId) {
    try {
      await deleteWebhook(existing.webhookId);
    } catch {
      // best-effort
    }
  }
  const webhook = await createWebhook(url, inbox.inbox_id);

  if (existing) {
    await db
      .update(emailConfigTable)
      .set({
        inboxId: inbox.inbox_id,
        inboxEmail: inbox.email,
        webhookId: webhook.webhook_id,
        webhookSecret: webhook.secret,
        enabled: true,
      })
      .where(eq(emailConfigTable.tenantId, tenantId));
  } else {
    await db.insert(emailConfigTable).values({
      tenantId,
      inboxId: inbox.inbox_id,
      inboxEmail: inbox.email,
      webhookId: webhook.webhook_id,
      webhookSecret: webhook.secret,
    });
  }

  await recordAudit({
    tenantId,
    ...actor,
    action: "email.webhook_configured",
    resourceType: "email_channel",
    resourceId: inbox.inbox_id,
    summary: `Connected email channel inbox ${inbox.email}`,
  });
  return { inbox: { email: inbox.email }, url };
}

/** Remove the inbound webhook (the bot stops receiving mail). */
export async function disconnectEmail(opts: {
  tenantId: string;
  actor: EmailActor;
}): Promise<{ ok: true }> {
  const { tenantId, actor } = opts;
  const [config] = await db
    .select()
    .from(emailConfigTable)
    .where(eq(emailConfigTable.tenantId, tenantId));
  if (config?.webhookId) {
    try {
      await deleteWebhook(config.webhookId);
    } catch {
      // best-effort
    }
  }
  if (config) {
    await db
      .update(emailConfigTable)
      .set({ webhookId: null, webhookSecret: null })
      .where(eq(emailConfigTable.tenantId, tenantId));
    await recordAudit({
      tenantId,
      ...actor,
      action: "email.webhook_removed",
      resourceType: "email_channel",
      resourceId: config.inboxId,
      summary: "Disconnected email channel webhook",
    });
  }
  return { ok: true };
}

/** Turn inbound email handling on or off without disconnecting the webhook. */
export async function setEmailEnabled(opts: {
  tenantId: string;
  actor: EmailActor;
  enabled: boolean;
}): Promise<{ enabled: boolean }> {
  const { tenantId, actor, enabled } = opts;
  const [config] = await db
    .select()
    .from(emailConfigTable)
    .where(eq(emailConfigTable.tenantId, tenantId));
  if (!config) {
    throw new EmailAdminError(
      "Email channel is not set up yet. Connect email first.",
    );
  }
  await db
    .update(emailConfigTable)
    .set({ enabled })
    .where(eq(emailConfigTable.tenantId, tenantId));
  await recordAudit({
    tenantId,
    ...actor,
    action: enabled ? "email.enabled" : "email.disabled",
    resourceType: "email_channel",
    resourceId: config.inboxId,
    summary: `${enabled ? "Enabled" : "Disabled"} incoming email handling`,
  });
  return { enabled };
}

/** The tenant's approved sender allow-list. */
export async function listAllowedSenders(
  tenantId: string,
): Promise<{ id: string; address: string }[]> {
  const senders = await db
    .select()
    .from(emailAllowedSendersTable)
    .where(eq(emailAllowedSendersTable.tenantId, tenantId))
    .orderBy(asc(emailAllowedSendersTable.address));
  return senders.map((s) => ({ id: s.id, address: s.address }));
}

/** Add an address to the allow-list (idempotent). */
export async function addAllowedSender(opts: {
  tenantId: string;
  actor: EmailActor;
  address: string;
}): Promise<{ id: string; address: string }> {
  const { tenantId, actor } = opts;
  const address = normalizeAddress(opts.address ?? "");
  if (!address || !EMAIL_RE.test(address)) {
    throw new EmailAdminError("A valid email address is required.");
  }
  const [inserted] = await db
    .insert(emailAllowedSendersTable)
    .values({ tenantId, address })
    .onConflictDoNothing()
    .returning();
  const row =
    inserted ??
    (
      await db
        .select()
        .from(emailAllowedSendersTable)
        .where(
          and(
            eq(emailAllowedSendersTable.tenantId, tenantId),
            eq(emailAllowedSendersTable.address, address),
          ),
        )
    )[0];
  if (inserted) {
    await recordAudit({
      tenantId,
      ...actor,
      action: "email.sender_allowed",
      resourceType: "email_allowed_sender",
      resourceId: inserted.id,
      summary: `Allowed email sender ${address}`,
    });
  }
  return { id: row.id, address: row.address };
}

/** Remove an allow-list entry by its id (web UI). */
export async function removeAllowedSenderById(opts: {
  tenantId: string;
  actor: EmailActor;
  id: string;
}): Promise<{ removed: boolean; address?: string }> {
  const { tenantId, actor, id } = opts;
  const [removed] = await db
    .delete(emailAllowedSendersTable)
    .where(
      and(
        eq(emailAllowedSendersTable.id, id),
        eq(emailAllowedSendersTable.tenantId, tenantId),
      ),
    )
    .returning();
  if (removed) {
    await recordAudit({
      tenantId,
      ...actor,
      action: "email.sender_removed",
      resourceType: "email_allowed_sender",
      resourceId: removed.id,
      summary: `Removed email sender ${removed.address}`,
    });
  }
  return removed ? { removed: true, address: removed.address } : { removed: false };
}

/** Remove an allow-list entry by address (bot — owner provides the address). */
export async function removeAllowedSenderByAddress(opts: {
  tenantId: string;
  actor: EmailActor;
  address: string;
}): Promise<{ removed: boolean; address: string }> {
  const { tenantId, actor } = opts;
  const address = normalizeAddress(opts.address ?? "");
  if (!address) {
    throw new EmailAdminError("A valid email address is required.");
  }
  const [removed] = await db
    .delete(emailAllowedSendersTable)
    .where(
      and(
        eq(emailAllowedSendersTable.tenantId, tenantId),
        eq(emailAllowedSendersTable.address, address),
      ),
    )
    .returning();
  if (removed) {
    await recordAudit({
      tenantId,
      ...actor,
      action: "email.sender_removed",
      resourceType: "email_allowed_sender",
      resourceId: removed.id,
      summary: `Removed email sender ${removed.address}`,
    });
  }
  return { removed: Boolean(removed), address };
}

/**
 * Send a brand-new email from the bot's configured inbox. The channel must be
 * set up (an inbox provisioned) first.
 *
 * Plain-text (`text`) is the default body. `html` adds an optional rich HTML
 * body, and `attachments` optionally attaches one or more files (each a
 * base64-encoded `content` with a `filename`). Both are opt-in.
 */
export async function sendEmail(opts: {
  tenantId: string;
  actor: EmailActor;
  to: string;
  subject?: string;
  text: string;
  html?: string;
  attachments?: EmailAttachment[];
}): Promise<{
  messageId: string;
  to: string;
  from: string;
  subject: string;
  hasHtml: boolean;
  attachmentCount: number;
}> {
  const { tenantId, actor } = opts;
  const recipient = normalizeAddress(opts.to ?? "");
  if (!recipient || !EMAIL_RE.test(recipient)) {
    throw new EmailAdminError(
      "A valid recipient `to` email address is required.",
    );
  }
  const body = (opts.text ?? "").trim();
  if (!body) {
    throw new EmailAdminError("`text` (the email body) is required.");
  }
  const html = (opts.html ?? "").trim();
  const attachments = normalizeAttachments(opts.attachments);
  const subject = (opts.subject ?? "").trim();
  const [config] = await db
    .select()
    .from(emailConfigTable)
    .where(eq(emailConfigTable.tenantId, tenantId));
  if (!config) {
    throw new EmailAdminError(
      "Email channel is not set up yet. Connect email first.",
    );
  }
  const sent = await sendMessage(config.inboxId, {
    to: recipient,
    subject: subject || undefined,
    text: body,
    html: html || undefined,
    attachments: attachments.length > 0 ? attachments : undefined,
  });
  await recordAudit({
    tenantId,
    ...actor,
    action: "email.sent",
    resourceType: "email_channel",
    resourceId: config.inboxId,
    summary: `Sent email to ${recipient}${subject ? ` — ${subject}` : ""}${
      attachments.length > 0
        ? ` (${attachments.length} attachment${
            attachments.length === 1 ? "" : "s"
          })`
        : ""
    }`,
  });
  return {
    messageId: sent.message_id,
    to: recipient,
    from: config.inboxEmail,
    subject,
    hasHtml: Boolean(html),
    attachmentCount: attachments.length,
  };
}
