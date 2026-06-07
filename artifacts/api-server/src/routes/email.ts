import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, emailConfigTable } from "@workspace/db";
import {
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
import {
  getEmailStatus,
  connectEmail,
  disconnectEmail,
  setEmailEnabled,
  addAllowedSender,
  removeAllowedSenderById,
  recordDroppedSender,
  listDroppedSenders,
  dismissDroppedSenderById,
  EmailAdminError,
} from "../lib/emailAdmin";
import { resolveOwnerTarget } from "../lib/telegramEngine";
import { getContext } from "../lib/context";
import { resolveAgentModel } from "../lib/runEngine";
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
        // Record the drop so the owner can see who tried to reach the bot and
        // approve a legitimate sender they forgot to add. Never confirm the
        // inbox to the stranger (no reply is sent). Best-effort: a failure here
        // must not affect the already-acked webhook.
        try {
          await recordDroppedSender({
            tenantId,
            address: msg.from,
            subject: msg.subject ?? null,
          });
        } catch (err) {
          logger.warn({ err }, "Failed to record dropped email sender");
        }
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

/** Build the audit actor for web admin actions (the workspace owner/user). */
function webActor(req: { userId: string }): {
  actorType: "user";
  actorId: string;
} {
  return { actorType: "user", actorId: req.userId };
}

/** Map a shared-service error to an HTTP status. */
function adminErrorStatus(err: unknown): number {
  if (err instanceof EmailAdminError) return err.status;
  if (err instanceof AgentMailError) return 502;
  return 500;
}

emailAdminRouter.get("/email/status", async (req, res): Promise<void> => {
  res.json(await getEmailStatus(req.tenantId));
});

emailAdminRouter.post("/email/set-webhook", async (req, res): Promise<void> => {
  const url =
    typeof req.body?.url === "string" && req.body.url.length > 0
      ? (req.body.url as string)
      : undefined;
  try {
    const result = await connectEmail({
      tenantId: req.tenantId,
      actor: webActor(req),
      url,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res
      .status(adminErrorStatus(err))
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

emailAdminRouter.post(
  "/email/delete-webhook",
  async (req, res): Promise<void> => {
    await disconnectEmail({ tenantId: req.tenantId, actor: webActor(req) });
    res.json({ ok: true });
  },
);

emailAdminRouter.post("/email/enabled", async (req, res): Promise<void> => {
  if (typeof req.body?.enabled !== "boolean") {
    res.status(400).json({ error: "`enabled` (boolean) is required." });
    return;
  }
  try {
    const result = await setEmailEnabled({
      tenantId: req.tenantId,
      actor: webActor(req),
      enabled: req.body.enabled,
    });
    res.json(result);
  } catch (err) {
    res
      .status(adminErrorStatus(err))
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

emailAdminRouter.post(
  "/email/allowed-senders",
  async (req, res): Promise<void> => {
    const raw = typeof req.body?.address === "string" ? req.body.address : "";
    try {
      const row = await addAllowedSender({
        tenantId: req.tenantId,
        actor: webActor(req),
        address: raw,
      });
      res.status(201).json(row);
    } catch (err) {
      res
        .status(adminErrorStatus(err))
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

emailAdminRouter.delete(
  "/email/allowed-senders/:id",
  async (req, res): Promise<void> => {
    await removeAllowedSenderById({
      tenantId: req.tenantId,
      actor: webActor(req),
      id: req.params.id,
    });
    res.sendStatus(204);
  },
);

/**
 * Recent senders whose mail was dropped because they are not on the allow-list.
 * Lets the owner notice a legitimate sender they forgot to approve.
 */
emailAdminRouter.get(
  "/email/dropped-senders",
  async (req, res): Promise<void> => {
    res.json(await listDroppedSenders(req.tenantId));
  },
);

/** Dismiss a dropped-sender record without allow-listing them. */
emailAdminRouter.delete(
  "/email/dropped-senders/:id",
  async (req, res): Promise<void> => {
    await dismissDroppedSenderById({
      tenantId: req.tenantId,
      id: req.params.id,
    });
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
