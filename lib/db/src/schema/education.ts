import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const educationSourcesTable = pgTable("education_sources", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(), // book | video | playlist | text
  title: text("title").notNull(),
  author: text("author"),
  sourceUrl: text("source_url"),
  contentText: text("content_text"),
  status: text("status").notNull().default("pending"), // pending | processing | ready | error
  chunksCount: integer("chunks_count").notNull().default(0),
  vectorCount: integer("vector_count").notNull().default(0),
  transcriptPreview: text("transcript_preview"),
  metadata: text("metadata"), // JSON string
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertEducationSourceSchema = createInsertSchema(educationSourcesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertEducationSource = z.infer<typeof insertEducationSourceSchema>;
export type EducationSource = typeof educationSourcesTable.$inferSelect;
