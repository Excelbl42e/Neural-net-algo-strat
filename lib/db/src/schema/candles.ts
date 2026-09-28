import { pgTable, serial, text, numeric, timestamp, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * OHLCV candles streamed from Deriv (or any future broker). Each row is
 * uniquely identified by (symbol, timeframe, openTime).
 */
export const candlesTable = pgTable(
  "candles",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    timeframe: text("timeframe").notNull(), // M1 | M5 | M15 | H1 | H4 | D1
    openTime: timestamp("open_time", { withTimezone: true }).notNull(),
    open: numeric("open", { precision: 18, scale: 8 }).notNull(),
    high: numeric("high", { precision: 18, scale: 8 }).notNull(),
    low: numeric("low", { precision: 18, scale: 8 }).notNull(),
    close: numeric("close", { precision: 18, scale: 8 }).notNull(),
    volume: numeric("volume", { precision: 18, scale: 4 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("candles_symbol_tf_time").on(t.symbol, t.timeframe, t.openTime)]
);

export const insertCandleSchema = createInsertSchema(candlesTable).omit({ id: true, createdAt: true });
export type InsertCandle = z.infer<typeof insertCandleSchema>;
export type Candle = typeof candlesTable.$inferSelect;

void integer;
