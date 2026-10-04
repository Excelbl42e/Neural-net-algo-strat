// Integration check against a real Postgres: encryption migration, DB-derived execution lock,
// order bookkeeping and the entry-hours migration. Run against a scratch database, e.g.:
//   npx esbuild test/db-integration.ts --bundle --platform=node --format=esm --outfile=/tmp/dbi.mjs \
//     --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);"
//   NODE_ENV=production DATABASE_URL=postgres://... node /tmp/dbi.mjs
import { eq, sql } from "drizzle-orm";
import { db, brokerConnectionsTable, signalsTable, tradesTable, botConfigTable } from "@workspace/db";
import { ensureSchema } from "../src/lib/migrate.ts";
import { seedDefaults } from "../src/lib/seed.ts";
import { decryptSecret, encryptSecret, isEncrypted } from "../src/lib/crypto.ts";
import { getExecutionLock, claimReason, claimTag, parseClaim } from "../src/lib/reconciler.ts";
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

// 2b. an ambiguous buy keeps the claim tag the reconciler matches by
const t0 = 1_790_000_000_000;
const claimed = parseClaim(claimReason(1.25, 7, t0));
assert.deepEqual(parseClaim(`Deriv buy timed out ${claimTag(1.25, 7, t0)}`), claimed);
assert.deepEqual(claimed, { stake: 1.25, connId: 7, t: t0 });
console.log("PASS claim tag: survives the ambiguous reason");

// 2c. one trade row per signal; a second insert for the same signal is a no-op
const [ex] = await db.insert(signalsTable).values({ ...base, executionStatus: "executed", contractId: 2 }).returning();
const row = { accountId: 1, signalId: ex!.id, symbol: "frxEURUSD", direction: "buy", openPrice: "1.1", lotSize: "1", strategy: "t", reasonChain: "t", status: "closed" };
await db.insert(tradesTable).values(row).onConflictDoNothing();
await db.insert(tradesTable).values(row).onConflictDoNothing();
assert.equal((await db.select().from(tradesTable).where(eq(tradesTable.signalId, ex!.id))).length, 1);
console.log("PASS trades: unique per signal");

// 2d. clearing closed trades through the API takes their executed signals too, so no orphan locks dispatch
const { default: tradesRouter } = await import("../src/routes/trades.ts");
const express = (await import("express")).default;
const app = express(); app.use(express.json()); app.use(tradesRouter);
const server = app.listen(0); const port = (server.address() as { port: number }).port;
const openLive = await db.insert(tradesTable).values({ ...row, signalId: null, status: "open", annotations: JSON.stringify({ contractId: 99 }) }).returning();
assert.equal((await fetch(`http://127.0.0.1:${port}/trades/${openLive[0]!.id}`, { method: "DELETE" })).status, 400);
const bulk = await (await fetch(`http://127.0.0.1:${port}/trades/bulk-delete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "closed" }) })).json() as { deleted: number; openKept: number };
assert.equal(bulk.deleted, 1); assert.equal(bulk.openKept, 1);
assert.equal((await db.select().from(signalsTable).where(eq(signalsTable.id, ex!.id))).length, 0);
assert.equal((await getExecutionLock()).locked, false);
server.close(); await db.delete(tradesTable).where(eq(tradesTable.id, openLive[0]!.id));
console.log("PASS trade deletes: live position refused; cleared trades leave no orphan lock");

// 2e. entry hours: a blank killzones field became London + New York (07:00-21:00 UTC)
await db.update(botConfigTable).set({ killzones: "" }).where(eq(botConfigTable.id, 1));
await db.execute(sql`DELETE FROM app_secrets WHERE key = 'migration:entry_hours_london_newyork_v1'`);
await ensureSchema();
assert.equal((await db.select().from(botConfigTable))[0]!.killzones, "london,newyork");
await db.update(botConfigTable).set({ killzones: "london" }).where(eq(botConfigTable.id, 1));
await ensureSchema();
assert.equal((await db.select().from(botConfigTable))[0]!.killzones, "london"); // runs once; a choice is kept
console.log("PASS entry hours: blank killzones set to london,newyork once");

process.exit(0);
