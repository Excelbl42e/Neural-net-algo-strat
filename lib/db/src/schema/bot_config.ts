import { pgTable, serial, text, boolean, numeric, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const botConfigTable = pgTable("bot_config", {
  id: serial("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  autotradeMode: text("autotrade_mode").notNull().default("off"),
  riskPerTradePct: numeric("risk_per_trade_pct", { precision: 5, scale: 2 }).notNull().default("1.00"),
  maxConcurrentPositions: integer("max_concurrent_positions").notNull().default(3),
  maxDailyLossPct: numeric("max_daily_loss_pct", { precision: 5, scale: 2 }).notNull().default("5.00"),
  minConfidence: numeric("min_confidence", { precision: 4, scale: 3 }).notNull().default("0.700"),
  allowedInstruments: text("allowed_instruments").notNull().default(""),
  killzones: text("killzones").notNull().default(""),
  smallAccountMaxRiskPct: numeric("small_account_max_risk_pct", { precision: 5, scale: 2 }).notNull().default("10.00"),
  minRiskReward: numeric("min_risk_reward", { precision: 5, scale: 2 }).notNull().default("2.00"),
  atrPercentileMin: numeric("atr_percentile_min", { precision: 5, scale: 2 }).notNull().default("15.00"),
  atrPercentileMax: numeric("atr_percentile_max", { precision: 5, scale: 2 }).notNull().default("90.00"),
  efficiencyRatioMin: numeric("efficiency_ratio_min", { precision: 5, scale: 3 }).notNull().default("0.150"),
  minStopAtr: numeric("min_stop_atr", { precision: 5, scale: 2 }).notNull().default("1.00"),
  maxPerAssetClass: integer("max_per_asset_class").notNull().default(2),
  newsBlackoutBeforeMin: integer("news_blackout_before_min").notNull().default(30),
  newsBlackoutAfterMin: integer("news_blackout_after_min").notNull().default(30),
  maxSpreadCostPct: numeric("max_spread_cost_pct", { precision: 5, scale: 2 }).notNull().default("0.50"),
  // Multiplier positions only close via their own stop-loss/take-profit —
  // there is no other expiry. This is the safety-net max hold time before
  // contract-monitor force-closes one at market, in case price never
  // reaches either level. Binary contracts already expire on their own via
  // their configured duration and are unaffected by this.
  maxPositionHoldHours: integer("max_position_hold_hours").notNull().default(36),
  notes: text("notes"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertBotConfigSchema = createInsertSchema(botConfigTable).omit({ id: true, updatedAt: true });
export type InsertBotConfig = z.infer<typeof insertBotConfigSchema>;
export type BotConfig = typeof botConfigTable.$inferSelect;
