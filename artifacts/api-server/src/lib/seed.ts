import { eq, inArray, sql } from "drizzle-orm";
import { botConfigTable, brokerConnectionsTable, db, educationSourcesTable, knowledgeChunksTable } from "@workspace/db";
import { logger } from "./logger.js";
import { encryptSecret, isEncrypted } from "./crypto.js";
import { getOrCreateSecret } from "./secrets.js";

/**
 * Boot provisioning: fail-closed config row, auto-generated secrets, automatic
 * encryption of legacy plaintext broker tokens, and removal of known test scraps.
 * Nothing here needs a manual step.
 */
export async function seedDefaults(): Promise<void> {
  await getOrCreateSecret("session_signing_key");
  if (!process.env.APP_ENCRYPTION_KEY?.trim()) await getOrCreateSecret("encryption_key");

  const [existing] = await db.select({ id: botConfigTable.id }).from(botConfigTable).where(eq(botConfigTable.id, 1)).limit(1);
  if (!existing) {
    await db.insert(botConfigTable).values({
      id: 1, enabled: false, autotradeMode: "off", riskPerTradePct: "1", maxConcurrentPositions: 3,
      maxDailyLossPct: "5", minConfidence: "0.78", allowedInstruments: "", killzones: "",
    }).onConflictDoNothing();
    logger.info("Created disabled bot configuration; no sample trading data was seeded");
  }

  // Encrypt any plaintext broker tokens left from older versions.
  const conns = await db.select().from(brokerConnectionsTable);
  let migrated = 0;
  for (const c of conns) {
    if (c.credential && !isEncrypted(c.credential)) {
      await db.update(brokerConnectionsTable).set({ credential: await encryptSecret(c.credential) }).where(eq(brokerConnectionsTable.id, c.id));
      migrated++;
    }
  }
  if (migrated > 0) logger.info({ migrated }, "Encrypted legacy plaintext broker tokens");

  await purgeTestScraps();
}

/** Deletes the 1-page test PDFs (1.pdf..8.pdf, identical one-sentence body) and their chunks. */
export async function purgeTestScraps(): Promise<void> {
  const rows = await db.select({ id: educationSourcesTable.id, title: educationSourcesTable.title, content: educationSourcesTable.contentText, metadata: educationSourcesTable.metadata })
    .from(educationSourcesTable);
  const scrapSentence = "Market structure is key to understanding liquidity";
  const ids = rows.filter((r) => {
    const text = (r.content ?? "").trim();
    const short = text.length > 0 && text.length < 400 && text.includes(scrapSentence);
    const numberedName = /^[1-8](\.pdf)?$/i.test(r.title.trim());
    return short || (numberedName && text.length < 400);
  }).map((r) => r.id);
  if (ids.length === 0) return;
  await db.delete(knowledgeChunksTable).where(inArray(knowledgeChunksTable.sourceId, ids));
  await db.delete(educationSourcesTable).where(inArray(educationSourcesTable.id, ids));
  logger.info({ removed: ids.length }, "Removed test-scrap education sources and their chunks");
  void sql;
}
