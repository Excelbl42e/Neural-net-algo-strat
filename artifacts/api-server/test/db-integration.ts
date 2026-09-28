// Integration check against a real Postgres: encryption migration + DB-derived execution lock.
import { eq } from "drizzle-orm";
import { db, brokerConnectionsTable, signalsTable, educationSourcesTable, knowledgeChunksTable } from "@workspace/db";
import { ensureSchema } from "../src/lib/migrate.ts";
import { seedDefaults } from "../src/lib/seed.ts";
import { decryptSecret, encryptSecret, isEncrypted } from "../src/lib/crypto.ts";
import { getExecutionLock } from "../src/lib/reconciler.ts";
import assert from "node:assert/strict";

await ensureSchema();
await seedDefaults();

// 1. legacy plaintext token gets encrypted on boot; round-trips; tamper fails
const [c] = await db.insert(brokerConnectionsTable).values({ broker: "deriv", label: "t", environment: "demo", credential: "PLAINTEXT_TOKEN_abc123" }).returning();
await seedDefaults();
const [after] = await db.select().from(brokerConnectionsTable).where(eq(brokerConnectionsTable.id, c!.id));
assert.ok(isEncrypted(after!.credential)); assert.ok(!after!.credential.includes("PLAINTEXT_TOKEN"));
assert.equal(await decryptSecret(after!.credential), "PLAINTEXT_TOKEN_abc123");
const tampered = after!.credential.slice(0, -4) + "AAAA";
await assert.rejects(() => decryptSecret(tampered));
assert.notEqual(await encryptSecret("x"), await encryptSecret("x")); // random IV
console.log("PASS encryption: legacy plaintext migrated, AES-GCM round-trip, tamper detected");

// 2. lock is derived from DB, and clears by itself when the signal resolves
const base = { symbol: "R_100", direction: "buy", confidence: "0.8", strategy: "t", entryZone: "1" };
assert.equal((await getExecutionLock()).locked, false);
const [s] = await db.insert(signalsTable).values({ ...base, executionStatus: "ambiguous" }).returning();
assert.equal((await getExecutionLock()).locked, true);
await db.update(signalsTable).set({ executionStatus: "rejected" }).where(eq(signalsTable.id, s!.id));
assert.equal((await getExecutionLock()).locked, false);
const [o] = await db.insert(signalsTable).values({ ...base, executionStatus: "executed", contractId: 1 }).returning();
assert.equal((await getExecutionLock()).locked, true); // executed without trade
await db.delete(signalsTable).where(eq(signalsTable.id, o!.id));
assert.equal((await getExecutionLock()).locked, false);
console.log("PASS lock: derived from DB each call; clears itself when signal resolves (no in-memory flag)");

// 3. scrap purge
const [src] = await db.insert(educationSourcesTable).values({ kind: "book", title: "3.pdf", contentText: "ICT Smart Money Concept: Market structure is key to understanding liquidity.", status: "ready" }).returning();
await db.insert(knowledgeChunksTable).values({ sourceId: src!.id, content: "ICT Smart Money Concept: Market structure is key to understanding liquidity.", chunkIndex: 0 } as any).catch((e) => console.log("chunk insert note:", e.message.slice(0, 80)));
await seedDefaults();
const left = await db.select().from(educationSourcesTable).where(eq(educationSourcesTable.id, src!.id));
assert.equal(left.length, 0);
console.log("PASS scrap purge: 1-page test PDF source removed");
process.exit(0);
