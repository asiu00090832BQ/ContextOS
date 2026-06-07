import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./core";
import { conversationsTable } from "./chat";

/**
 * Singleton (one row per tenant) configuration for the AgentMail email channel:
 * the bot's inbox and the inbound webhook used to verify deliveries. The
 * webhookSecret is the per-webhook Svix signing key returned by AgentMail; it is
 * used solely to verify inbound webhook authenticity (never a user credential).
 */
export const emailConfigTable = pgTable(
  "email_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    inboxId: text("inbox_id").notNull(),
    inboxEmail: text("inbox_email").notNull(),
    webhookId: text("webhook_id"),
    webhookSecret: text("webhook_secret"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [unique("email_config_tenant_uq").on(t.tenantId)],
);

/**
 * Binds an AgentMail thread (by its thread id) to a ContextOS conversation so
 * inbound emails reuse the conversation tables for short-term memory. One
 * conversation per (tenant, thread) pair. Parallel to telegram_chats.
 */
export const emailThreadsTable = pgTable(
  "email_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    threadKey: text("thread_key").notNull(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversationsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("email_threads_tenant_idx").on(t.tenantId),
    unique("email_threads_tenant_thread_uq").on(t.tenantId, t.threadKey),
  ],
);

/**
 * Approved sender allow-list. Because an inbox is reachable by anyone, only
 * emails from these (lowercased, bare) addresses are processed by the bot;
 * everything else is silently ignored.
 */
export const emailAllowedSendersTable = pgTable(
  "email_allowed_senders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("email_allowed_senders_tenant_idx").on(t.tenantId),
    unique("email_allowed_senders_tenant_address_uq").on(t.tenantId, t.address),
  ],
);

/**
 * Inbound senders whose mail was dropped because they are not on the allow-list.
 * The inbox is never confirmed to strangers (no reply is sent), but the owner
 * still needs visibility into who tried to reach the bot so they can approve a
 * legitimate sender they forgot to add. One row per (tenant, address): repeat
 * attempts bump `attempts` and refresh `lastSubject`/`lastSeenAt` rather than
 * piling up duplicates.
 */
export const emailDroppedSendersTable = pgTable(
  "email_dropped_senders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    lastSubject: text("last_subject"),
    attempts: integer("attempts").notNull().default(1),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("email_dropped_senders_tenant_idx").on(t.tenantId),
    unique("email_dropped_senders_tenant_address_uq").on(t.tenantId, t.address),
  ],
);

export const insertEmailConfigSchema = createInsertSchema(emailConfigTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertEmailThreadSchema = createInsertSchema(emailThreadsTable).omit(
  { id: true, createdAt: true, updatedAt: true },
);
export const insertEmailAllowedSenderSchema = createInsertSchema(
  emailAllowedSendersTable,
).omit({ id: true, createdAt: true });
export const insertEmailDroppedSenderSchema = createInsertSchema(
  emailDroppedSendersTable,
).omit({ id: true, firstSeenAt: true, lastSeenAt: true });

export type EmailConfig = typeof emailConfigTable.$inferSelect;
export type InsertEmailConfig = z.infer<typeof insertEmailConfigSchema>;
export type EmailThread = typeof emailThreadsTable.$inferSelect;
export type InsertEmailThread = z.infer<typeof insertEmailThreadSchema>;
export type EmailAllowedSender = typeof emailAllowedSendersTable.$inferSelect;
export type InsertEmailAllowedSender = z.infer<
  typeof insertEmailAllowedSenderSchema
>;
export type EmailDroppedSender = typeof emailDroppedSendersTable.$inferSelect;
export type InsertEmailDroppedSender = z.infer<
  typeof insertEmailDroppedSenderSchema
>;
