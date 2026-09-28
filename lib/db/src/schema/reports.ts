import { pgTable, serial, text, integer, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const reportsTable = pgTable("reports", {
  id: serial("id").primaryKey(),
  type: text("type").notNull(), // daily | monthly
  period: text("period").notNull(), // e.g. "2026-05-11" or "2026-05"
  winRate: numeric("win_rate", { precision: 5, scale: 4 }).notNull().default("0"),
  totalPnl: numeric("total_pnl", { precision: 18, scale: 2 }).notNull().default("0"),
  maxDrawdown: numeric("max_drawdown", { precision: 10, scale: 4 }).notNull().default("0"),
  tradesCount: integer("trades_count").notNull().default(0),
  longCount: integer("long_count").notNull().default(0),
  shortCount: integer("short_count").notNull().default(0),
  avgHoldingTime: numeric("avg_holding_time", { precision: 10, scale: 2 }),
  riskReward: numeric("risk_reward", { precision: 10, scale: 2 }),
  strategyAdherence: numeric("strategy_adherence", { precision: 5, scale: 4 }).notNull().default("0"),
  gamblingScore: numeric("gambling_score", { precision: 5, scale: 4 }).notNull().default("1"),
  uptimePercent: numeric("uptime_percent", { precision: 5, scale: 2 }),
  scores: text("scores"), // JSON string of per-category scores
  totalScore: numeric("total_score", { precision: 5, scale: 2 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertReportSchema = createInsertSchema(reportsTable).omit({ id: true, createdAt: true });
export type InsertReport = z.infer<typeof insertReportSchema>;
export type Report = typeof reportsTable.$inferSelect;
