import { pgTable, serial, integer, text, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tradesTable = pgTable("trades", {
  id: serial("id").primaryKey(),
  accountId: integer("account_id").notNull(),
  signalId: integer("signal_id"),
  symbol: text("symbol").notNull(),
  direction: text("direction").notNull(), // buy | sell
  openPrice: numeric("open_price", { precision: 18, scale: 5 }).notNull(),
  closePrice: numeric("close_price", { precision: 18, scale: 5 }),
  stopLoss: numeric("stop_loss", { precision: 18, scale: 5 }),
  takeProfit: numeric("take_profit", { precision: 18, scale: 5 }),
  lotSize: numeric("lot_size", { precision: 10, scale: 2 }).notNull(),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  status: text("status").notNull().default("open"), // open | closed | pending | cancelled
  pnl: numeric("pnl", { precision: 18, scale: 2 }),
  pips: numeric("pips", { precision: 10, scale: 1 }),
  riskReward: numeric("risk_reward", { precision: 10, scale: 2 }),
  strategy: text("strategy").notNull(),
  reasonChain: text("reason_chain").notNull(),
  annotations: text("annotations"),
  holdingTime: integer("holding_time"), // in minutes
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertTradeSchema = createInsertSchema(tradesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type Trade = typeof tradesTable.$inferSelect;
