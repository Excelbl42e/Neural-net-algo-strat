import { pgTable, serial, text, numeric, timestamp, bigint } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export type SignalExecutionStatus =
  | "generated"
  | "awaiting_broker"
  | "executed"
  | "rejected"
  | "ambiguous";

export const signalsTable = pgTable("signals", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  direction: text("direction").notNull(), // buy | sell
  confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull(),
  strategy: text("strategy").notNull(),
  concepts: text("concepts"),
  entryZone: text("entry_zone").notNull(),
  targetZone: text("target_zone"),
  stopZone: text("stop_zone"),
  // Structured numeric levels for chart rendering
  entryLow: numeric("entry_low", { precision: 18, scale: 8 }),
  entryHigh: numeric("entry_high", { precision: 18, scale: 8 }),
  stopLevel: numeric("stop_level", { precision: 18, scale: 8 }),
  target1Level: numeric("target1_level", { precision: 18, scale: 8 }),
  target2Level: numeric("target2_level", { precision: 18, scale: 8 }),
  // JSON-encoded array of {kind, low, high, label} drawings the AI saw
  // (FVGs, OBs, sweep lines, key levels, etc.) for chart annotations.
  levels: text("levels"),
  reasoning: text("reasoning"),
  status: text("status").notNull().default("active"), // active | executed | expired | cancelled
  executionStatus: text("execution_status").$type<SignalExecutionStatus>().notNull().default("generated"),
  executionReason: text("execution_reason"),
  contractId: bigint("contract_id", { mode: "number" }),
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertSignalSchema = createInsertSchema(signalsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSignal = z.infer<typeof insertSignalSchema>;
export type Signal = typeof signalsTable.$inferSelect;
