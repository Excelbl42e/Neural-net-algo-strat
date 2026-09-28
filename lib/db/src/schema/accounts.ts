import { pgTable, serial, text, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const accountsTable = pgTable("accounts", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  broker: text("broker").notNull(),
  balance: numeric("balance", { precision: 18, scale: 2 }).notNull().default("0"),
  equity: numeric("equity", { precision: 18, scale: 2 }).notNull().default("0"),
  margin: numeric("margin", { precision: 18, scale: 2 }).notNull().default("0"),
  marginLevel: numeric("margin_level", { precision: 10, scale: 2 }),
  currency: text("currency").notNull().default("USD"),
  accountType: text("account_type").notNull().default("demo"), // live | demo | prop
  status: text("status").notNull().default("active"), // active | inactive | suspended
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertAccountSchema = createInsertSchema(accountsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertAccount = z.infer<typeof insertAccountSchema>;
export type Account = typeof accountsTable.$inferSelect;
