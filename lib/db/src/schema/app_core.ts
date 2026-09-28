import { pgTable, serial, text, timestamp, integer, boolean } from "drizzle-orm/pg-core";

/** Single-owner login. Password is a scrypt hash, never plaintext. */
export const appOwnerTable = pgTable("app_owner", {
  id: serial("id").primaryKey(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Auto-generated secrets (session signing key, token-encryption key, self-test record). */
export const appSecretsTable = pgTable("app_secrets", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Raw Deriv frames with UTC receipt time. Tokens/OTPs are redacted before insert. */
export const derivFramesTable = pgTable("deriv_frames", {
  id: serial("id").primaryKey(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  direction: text("direction").notNull(), // in | out
  kind: text("kind").notNull(),
  signalId: integer("signal_id"),
  contractId: text("contract_id"),
  payload: text("payload").notNull(),
  ok: boolean("ok"),
});
