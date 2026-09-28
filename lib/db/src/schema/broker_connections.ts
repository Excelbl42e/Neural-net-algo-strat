import { pgTable, serial, text, integer, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const brokerConnectionsTable = pgTable("broker_connections", {
  id: serial("id").primaryKey(),
  broker: text("broker").notNull(),
  label: text("label").notNull(),
  environment: text("environment").notNull().default("real"),
  accountId: integer("account_id"),
  credential: text("credential").notNull(),
  status: text("status").notNull().default("disconnected"),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  lastError: text("last_error"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertBrokerConnectionSchema = createInsertSchema(brokerConnectionsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  lastSyncAt: true,
  lastError: true,
});
export type InsertBrokerConnection = z.infer<typeof insertBrokerConnectionSchema>;
export type BrokerConnection = typeof brokerConnectionsTable.$inferSelect;
