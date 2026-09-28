import { pgTable, serial, text, integer, numeric, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/** Persisted exponentially-decayed performance by ICT concept or instrument. */
export const tradePerformanceTable = pgTable(
  "trade_performance",
  {
    id: serial("id").primaryKey(),
    dimension: text("dimension").notNull(), // concept | symbol
    key: text("key").notNull(),
    tradeCount: integer("trade_count").notNull().default(0),
    winCount: integer("win_count").notNull().default(0),
    lossCount: integer("loss_count").notNull().default(0),
    totalPnl: numeric("total_pnl", { precision: 18, scale: 2 }).notNull().default("0"),
    weightedTrades: numeric("weighted_trades", { precision: 18, scale: 8 }).notNull().default("0"),
    weightedWins: numeric("weighted_wins", { precision: 18, scale: 8 }).notNull().default("0"),
    lastOutcomeAt: timestamp("last_outcome_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("trade_performance_dimension_key_unique").on(t.dimension, t.key)],
);

export const insertTradePerformanceSchema = createInsertSchema(tradePerformanceTable).omit({ id: true });
export type InsertTradePerformance = z.infer<typeof insertTradePerformanceSchema>;
export type TradePerformance = typeof tradePerformanceTable.$inferSelect;
