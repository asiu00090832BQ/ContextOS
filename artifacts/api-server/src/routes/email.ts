import { Router, type IRouter } from "express";
import { and, asc, eq } from "drizzle-orm";
import { db, emailConfigTable, emailAllowedSendersTable } from "@workspace/db";
import {
  isAgentMailConnected,
  getOrCreateInbox,
  createWebhook,
  deleteWebhook,
  sendReply,
  verifyWebhookSignature,
  AgentMailError,
  type MessageReceivedEvent,
} from "../lib/agentmail";
import {
  handleEmailMessage,
  isSenderAllowed,
  normalizeAddress,
} from "../lib/emailEngine";
import { resolveOwnerTarget } from "../lib/telegramEngine";
import { getContext } from "../lib/context";
import { resolveAgentModel } from "../lib/runEngine";
import { recordAudit } from "../lib/audit";
import { logger } from "../lib/logger";

/**
 * Unauthenticated inbound AgentMail webhook. Mounted OUTSIDE the tenant context /
 * API-key surface: AgentMail cannot send a bearer token, so deliveries are
 * authenticated solely by their Svix signature, verified against the per-webhook
 * secret persisted at connect time.
 */
export const emailWebhookRouter: IRouter = Router();

emailWebhookRouter.post("/email/webhook", (req, res): void => {
  let acked = false;
  void (async () => {
    try {
      const { tenantId, userId } = await resolveOwnerTarget();
      const [config] = await db
        .select()
        .from(emailConfigTable)
        .where(eq(emailConfigTable.tenantId, tenantId));
      if (!config || !config.webhookSecret) {
        res.status(503).json({ error: "Email channel not configured." });
        acked = true;
        return;
      }

      const rawBody =
        (req as { rawBody?: Buffer }).rawBody?.toString("utf8") ??
        JSON.stringify(req.body);
      const ok = verifyWebhookSignature(
        config.webhookSecret,
        {
          id: req.header("svix-id") ?? undefined,
          timestamp: req.header("svix-timestamp") ?? undefined,
          signature: req.header("svix-signature") ?? undefined,
        },
        rawBody,
      );
      if (!ok) {
        res.status(401).json({ error: "Invalid signature." });
        acked = true;
        return;
      }

      // Signature is valid — acknowledge immediately, then process out of band
      // so AgentMail does not retry while we call the model.
      res.status(200).json({ ok: true });
      acked = true;

      const event = req.body as MessageReceivedEvent;
      // Process ONLY genuine, non-spam, authenticated mail. The other
      // message.received.* variants (spam/blocked/unauthenticated) are ignored.
      if (event?.event_type !== "message.received") return;
      if (!config.enabled) return;

      const msg = event.message;
      if (!msg?.from || !msg.thread_id || !msg.message_id) return;
      // Defense-in-depth: only handle mail for our own configured inbox.
      if (msg.inbox_id && msg.inbox_id !== config.inboxId) return;
      // Loop guard: never react to our own outbound address.
      if (
        normalizeAddress(msg.from) === config.inboxEmail.toLowerCase()
      ) {
        return;
      }

      if (!(await isSenderAllowed(tenantId, msg.from))) {
        logger.info(
          { from: normalizeAddress(msg.from) },
          "Ignoring email from non-allowlisted sender",
        );
        return;
      }

      const text = (msg.text ?? msg.preview ?? "").trim();
      if (!text) return;

      const reply = await handleEmailMessage({
        tenantId,
        userId,
        threadKey: msg.thread_id,
        fromAddress: msg.from,
        subject: msg.subject ?? "",
        text,
      });
      await sendReply(config.inboxId, msg.message_id, reply);
    } catch (err) {
      logger.error({ err }, "Failed to process AgentMail webhook");
      if (!acked && !res.headersSent) {
        res.status(500).json({ error: "Webhook processing failed." });
      }
    }
  })();
});

/**
 * Owner-only admin endpoints (mounted under the tenant-context surface) for
 * provisioning the inbox, wiring the inbound webhook, and managing the sender
 * allow-list from the web UI.
 */
export const emailAdminRouter: IRouter = Router();

emailAdminRouter.get("/email/status", async (req, res): Promise<void> => {
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
    .where(eq(emailConfigTable.tenantId, req.tenantId));
  const senders = await db
    .select()
    .from(emailAllowedSendersTable)
    .where(eq(emailAllowedSendersTable.tenantId, req.tenantId))
    .orderBy(asc(emailAllowedSendersTable.address));
  res.json({
    connected,
    error: connError,
    inbox: config ? { inboxId: config.inboxId, email: config.inboxEmail } : null,
    webhook: { configured: Boolean(config?.webhookId) },
    enabled: config?.enabled ?? true,
    allowedSenders: senders.map((s) => ({ id: s.id, address: s.address })),
  });
});

emailAdminRouter.post("/email/set-webhook", async (req, res): Promise<void> => {
  const url =
    typeof req.body?.url === "string" && req.body.url.length > 0
      ? (req.body.url as string)
      : null;
  if (!url || !/^https:\/\//.test(url)) {
    res.status(400).json({ error: "A public https `url` is required." });
    return;
  }
  try {
    if (!(await isAgentMailConnected())) {
      res.status(400).json({
        error:
          "AgentMail is not connected. Connect the AgentMail integration first.",
      });
      return;
    }
    const inbox = await getOrCreateInbox("ContextOS Bot");

    const [existing] = await db
      .select()
      .from(emailConfigTable)
      .where(eq(emailConfigTable.tenantId, req.tenantId));
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
        .where(eq(emailConfigTable.tenantId, req.tenantId));
    } else {
      await db.insert(emailConfigTable).values({
        tenantId: req.tenantId,
        inboxId: inbox.inbox_id,
        inboxEmail: inbox.email,
        webhookId: webhook.webhook_id,
        webhookSecret: webhook.secret,
      });
    }

    await recordAudit({
      tenantId: req.tenantId,
      actorId: req.userId,
      action: "email.webhook_configured",
      resourceType: "email_channel",
      resourceId: inbox.inbox_id,
      summary: `Connected email channel inbox ${inbox.email}`,
    });
    res.json({ ok: true, inbox: { email: inbox.email }, url });
  } catch (err) {
    const status = err instanceof AgentMailError ? 502 : 500;
    res
      .status(status)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

emailAdminRouter.post(
  "/email/delete-webhook",
  async (req, res): Promise<void> => {
    const [config] = await db
      .select()
      .from(emailConfigTable)
      .where(eq(emailConfigTable.tenantId, req.tenantId));
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
        .where(eq(emailConfigTable.tenantId, req.tenantId));
      await recordAudit({
        tenantId: req.tenantId,
        actorId: req.userId,
        action: "email.webhook_removed",
        resourceType: "email_channel",
        resourceId: config.inboxId,
        summary: "Disconnected email channel webhook",
      });
    }
    res.json({ ok: true });
  },
);

emailAdminRouter.post(
  "/email/allowed-senders",
  async (req, res): Promise<void> => {
    const raw = typeof req.body?.address === "string" ? req.body.address : "";
    const address = normalizeAddress(raw);
    if (!address || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
      res.status(400).json({ error: "A valid email address is required." });
      return;
    }
    const [inserted] = await db
      .insert(emailAllowedSendersTable)
      .values({ tenantId: req.tenantId, address })
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
              eq(emailAllowedSendersTable.tenantId, req.tenantId),
              eq(emailAllowedSendersTable.address, address),
            ),
          )
      )[0];
    if (inserted) {
      await recordAudit({
        tenantId: req.tenantId,
        actorId: req.userId,
        action: "email.sender_allowed",
        resourceType: "email_allowed_sender",
        resourceId: inserted.id,
        summary: `Allowed email sender ${address}`,
      });
    }
    res.status(201).json({ id: row.id, address: row.address });
  },
);

emailAdminRouter.delete(
  "/email/allowed-senders/:id",
  async (req, res): Promise<void> => {
    const [removed] = await db
      .delete(emailAllowedSendersTable)
      .where(
        and(
          eq(emailAllowedSendersTable.id, req.params.id),
          eq(emailAllowedSendersTable.tenantId, req.tenantId),
        ),
      )
      .returning();
    if (removed) {
      await recordAudit({
        tenantId: req.tenantId,
        actorId: req.userId,
        action: "email.sender_removed",
        resourceType: "email_allowed_sender",
        resourceId: removed.id,
        summary: `Removed email sender ${removed.address}`,
      });
    }
    res.sendStatus(204);
  },
);

/**
 * The model the email bot uses — the ContextOS Bot agent's own model (shared
 * with the in-app and Telegram bots), so it is read-only here.
 */
emailAdminRouter.get("/email/model", async (req, res): Promise<void> => {
  const { botAgent } = await getContext();
  const { primary } = await resolveAgentModel(req.tenantId, botAgent.id);
  res.json({
    modelEndpointName: primary?.name ?? "Managed Anthropic (Claude Sonnet 4.6)",
  });
});
