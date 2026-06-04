import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable, usersTable, runsTable } from "./core";
import { agentsTable } from "./agents";
import { conversationMessageRoleEnum } from "./enums";

export const conversationsTable = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("New conversation"),
    agentId: uuid("agent_id").references(() => agentsTable.id, {
      onDelete: "set null",
    }),
    createdBy: uuid("created_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("conversations_tenant_idx").on(t.tenantId)],
);

export const conversationMessagesTable = pgTable(
  "conversation_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversationsTable.id, { onDelete: "cascade" }),
    role: conversationMessageRoleEnum("role").notNull(),
    content: text("content").notNull(),
    // For agent replies: whether the deterministic stub was used (no live model
    // endpoint was reached). Null for user/system messages.
    usedStub: boolean("used_stub"),
    // When an agent reply kicked off a run, link it so the UI can render an
    // inline "started a run" card and surface approvals/status.
    runId: uuid("run_id").references(() => runsTable.id, {
      onDelete: "set null",
    }),
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("conversation_messages_conversation_idx").on(t.conversationId),
    index("conversation_messages_tenant_idx").on(t.tenantId),
  ],
);

export const insertConversationSchema = createInsertSchema(
  conversationsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type Conversation = typeof conversationsTable.$inferSelect;
export type InsertConversation = z.infer<typeof insertConversationSchema>;

export const insertConversationMessageSchema = createInsertSchema(
  conversationMessagesTable,
).omit({ id: true, createdAt: true });
export type ConversationMessage = typeof conversationMessagesTable.$inferSelect;
export type InsertConversationMessage = z.infer<
  typeof insertConversationMessageSchema
>;
