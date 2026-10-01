import { and, eq, notInArray } from "drizzle-orm";
import { botConfigTable, brokerConnectionsTable, strategiesTable, db } from "@workspace/db";
import { logger } from "./logger.js";
import { encryptSecret, isEncrypted } from "./crypto.js";
import { getOrCreateSecret } from "./secrets.js";
import { STRATEGY_LIBRARY } from "./strategy-library.js";

/**
 * Boot provisioning: fail-closed config row, auto-generated secrets, automatic
 * encryption of legacy plaintext broker tokens, and the hardcoded strategy
 * library upsert. Nothing here needs a manual step.
 */
export async function seedDefaults(): Promise<void> {
  await getOrCreateSecret("session_signing_key");
  if (!process.env.APP_ENCRYPTION_KEY?.trim()) await getOrCreateSecret("encryption_key");

  const [existing] = await db.select({ id: botConfigTable.id }).from(botConfigTable).where(eq(botConfigTable.id, 1)).limit(1);
  if (!existing) {
    await db.insert(botConfigTable).values({
      id: 1, enabled: false, autotradeMode: "off", riskPerTradePct: "5", maxConcurrentPositions: 14,
      maxDailyLossPct: "5", minConfidence: "0.50", allowedInstruments: "", killzones: "",
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

  await seedStrategyLibrary();
}

/**
 * Upserts the poll's 60 strategies into strategiesTable, by name, every boot,
 * and marks every other row inactive — the retired ICT concepts stay in the
 * table for their trade history but no longer show as active strategies.
 */
export async function seedStrategyLibrary(): Promise<void> {
  for (const s of STRATEGY_LIBRARY) {
    const [existingRow] = await db.select({ id: strategiesTable.id }).from(strategiesTable).where(eq(strategiesTable.name, s.name)).limit(1);
    const values = {
      name: s.name,
      type: s.category,
      description: s.summary,
      explanation: s.rules,
      summary: s.summary,
      rules: s.rules,
      active: true,
    };
    if (existingRow) {
      await db.update(strategiesTable).set(values).where(eq(strategiesTable.id, existingRow.id));
    } else {
      await db.insert(strategiesTable).values(values);
    }
  }
  const retired = await db.update(strategiesTable).set({ active: false })
    .where(and(eq(strategiesTable.active, true), notInArray(strategiesTable.name, STRATEGY_LIBRARY.map((s) => s.name))))
    .returning({ id: strategiesTable.id });
  logger.info({ count: STRATEGY_LIBRARY.length, retired: retired.length }, "Strategy library seeded");
}
