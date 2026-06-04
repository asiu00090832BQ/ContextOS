import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./core";
import { conversationsTable } from "./chat";

/**
 * Binds a Telegram chat (by its numeric chat id, stored as text) to a ContextOS
 * conversation so that inbound Telegram messages reuse the conversation tables
 * for short-term memory. One conversation per (tenant, chat) pair.
 */
export const telegramChatsTable = pgTable(
  "telegram_chats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    chatId: text("chat_id").notNull(),
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
    index("telegram_chats_tenant_idx").on(t.tenantId),
    unique("telegram_chats_tenant_chat_uq").on(t.tenantId, t.chatId),
  ],
);

export const insertTelegramChatSchema = createInsertSchema(
  telegramChatsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type TelegramChat = typeof telegramChatsTable.$inferSelect;
export type InsertTelegramChat = z.infer<typeof insertTelegramChatSchema>;
