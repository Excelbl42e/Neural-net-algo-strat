import { pgTable, serial, integer, text, numeric, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/** A deterministic, candle-evidence-backed review for one settled trade. */
export const tradeReviewsTable = pgTable(
  "trade_reviews",
  {
    id: serial("id").primaryKey(),
    tradeId: integer("trade_id").notNull(),
    accountId: integer("account_id").notNull(),
    symbol: text("symbol").notNull(),
    direction: text("direction").notNull(),
    strategy: text("strategy").notNull(),
    reasoning: text("reasoning").notNull(),
    claimedConcepts: text("claimed_concepts").notNull().default("[]"),
    entryPrice: numeric("entry_price", { precision: 18, scale: 8 }).notNull(),
    stopPrice: numeric("stop_price", { precision: 18, scale: 8 }),
    targetPrice: numeric("target_price", { precision: 18, scale: 8 }),
    closePrice: numeric("close_price", { precision: 18, scale: 8 }),
    outcome: text("outcome").notNull(), // win | loss | breakeven | unknown
    pnl: numeric("pnl", { precision: 18, scale: 2 }),
    classification: text("classification").notNull(),
    evidenceStatus: text("evidence_status").notNull(), // sufficient | insufficient
    evidenceSummary: text("evidence_summary").notNull(),
    candlesExamined: integer("candles_examined").notNull().default(0),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("trade_reviews_trade_id_unique").on(t.tradeId),
    index("trade_reviews_closed_at_idx").on(t.closedAt),
  ],
);

export const insertTradeReviewSchema = createInsertSchema(tradeReviewsTable).omit({ id: true, createdAt: true });
export type InsertTradeReview = z.infer<typeof insertTradeReviewSchema>;
export type TradeReview = typeof tradeReviewsTable.$inferSelect;
