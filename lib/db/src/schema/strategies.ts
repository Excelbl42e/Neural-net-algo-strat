import { pgTable, serial, text, boolean, integer, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const strategiesTable = pgTable("strategies", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  description: text("description").notNull(),
  explanation: text("explanation"),
  weight: numeric("weight", { precision: 4, scale: 3 }),
  active: boolean("active").notNull().default(true),
  parameters: text("parameters"),
  tradeCount: integer("trade_count").notNull().default(0),
  winRate: numeric("win_rate", { precision: 5, scale: 4 }),
  concepts: text("concepts"),
  rules: text("rules"),
  sourcesUsed: integer("sources_used").notNull().default(0),
  wordsAnalyzed: integer("words_analyzed").notNull().default(0),
  summary: text("summary"),
  synthesizedAt: timestamp("synthesized_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertStrategySchema = createInsertSchema(strategiesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertStrategy = z.infer<typeof insertStrategySchema>;
export type Strategy = typeof strategiesTable.$inferSelect;
