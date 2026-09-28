import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const brainLayersTable = pgTable("brain_layers", {
  id: serial("id").primaryKey(),
  layerType: text("layer_type").notNull(), // input | hidden | output
  name: text("name").notNull(),
  description: text("description").notNull(),
  status: text("status").notNull().default("idle"), // active | idle | processing | error
  metrics: text("metrics"), // JSON string
  outputSignal: text("output_signal"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertBrainLayerSchema = createInsertSchema(brainLayersTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertBrainLayer = z.infer<typeof insertBrainLayerSchema>;
export type BrainLayer = typeof brainLayersTable.$inferSelect;
