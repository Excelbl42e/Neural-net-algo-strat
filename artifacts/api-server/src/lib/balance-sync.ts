/**
 * Automatic balance sync poller.
 *
 * Runs every SYNC_INTERVAL_MS (60 seconds).
 * For every enabled broker connection (status "connected" OR "error") it
 * calls syncDerivAccount(), then writes the fresh balance/equity back to the
 * linked account row and updates lastSyncAt on the broker connection.
 *
 * Failure policy (24/7 safe):
 *   - Transient failures increment consecutiveFailures and set status "error"
 *     so the UI shows the problem immediately.
 *   - The poller keeps retrying "error" connections on a RECOVERY_INTERVAL_MS
 *     back-off (5 minutes) so the bot self-heals without any manual action.
 *   - A successful sync resets the failure counter and restores status
 *     "connected" automatically.
 */

import { eq, or } from "drizzle-orm";
import { db, brokerConnectionsTable, accountsTable } from "@workspace/db";
import { syncDerivAccount } from "./deriv.js";
import { logger } from "./logger.js";
import { decryptSecret } from "./crypto.js";

const SYNC_INTERVAL_MS     = 60_000;   // normal healthy-connection sync cadence
const RECOVERY_INTERVAL_MS = 300_000;  // retry errored connections every 5 min

interface SyncEntry {
  connId: number;
  label: string;
  lastSyncAt: Date | null;
  lastAttemptAt: Date | null;
  lastError: string | null;
  consecutiveFailures: number;
}

const state = new Map<number, SyncEntry>();
let timer: NodeJS.Timeout | null = null;
let lastCycleAt: Date | null = null;
let activeSyncs = 0;

export interface BalanceSyncStatus {
  running: boolean;
  lastCycleAt: string | null;
  activeSyncs: number;
  connections: Array<{
    connId: number;
    label: string;
    lastSyncAt: string | null;
    lastError: string | null;
    consecutiveFailures: number;
  }>;
}

export function getBalanceSyncStatus(): BalanceSyncStatus {
  return {
    running: timer !== null,
    lastCycleAt: lastCycleAt?.toISOString() ?? null,
    activeSyncs,
    connections: Array.from(state.values()).map((e) => ({
      connId: e.connId,
      label: e.label,
      lastSyncAt: e.lastSyncAt?.toISOString() ?? null,
      lastError: e.lastError,
      consecutiveFailures: e.consecutiveFailures,
    })),
  };
}

async function syncOne(
  conn: typeof brokerConnectionsTable.$inferSelect,
): Promise<void> {
  const now = Date.now();
  const entry: SyncEntry = state.get(conn.id) ?? {
    connId: conn.id,
    label: conn.label,
    lastSyncAt: null,
    lastAttemptAt: null,
    lastError: null,
    consecutiveFailures: 0,
  };

  // For errored connections apply a back-off: only retry every RECOVERY_INTERVAL_MS
  if (conn.status === "error" && entry.lastAttemptAt != null) {
    const msSinceAttempt = now - entry.lastAttemptAt.getTime();
    if (msSinceAttempt < RECOVERY_INTERVAL_MS) {
      return; // too soon — wait for the next recovery window
    }
    logger.info(
      { connId: conn.id, label: conn.label, consecutiveFailures: entry.consecutiveFailures },
      "balance-sync: attempting auto-recovery of errored connection",
    );
  }

  entry.lastAttemptAt = new Date();
  activeSyncs++;

  try {
    const result = await syncDerivAccount(await decryptSecret(conn.credential), conn.environment);

    if (!result.ok) {
      entry.consecutiveFailures++;
      entry.lastError = result.message ?? "sync failed";
      logger.warn(
        { connId: conn.id, label: conn.label, error: entry.lastError, failures: entry.consecutiveFailures },
        "balance-sync: sync failed — will auto-retry",
      );
      await db
        .update(brokerConnectionsTable)
        .set({ status: "error", lastError: entry.lastError })
        .where(eq(brokerConnectionsTable.id, conn.id));
    } else {
      // Success — reset failure state and restore "connected"
      entry.consecutiveFailures = 0;
      entry.lastError = null;
      entry.lastSyncAt = new Date();

      await db
        .update(brokerConnectionsTable)
        .set({ status: "connected", lastSyncAt: entry.lastSyncAt, lastError: null })
        .where(eq(brokerConnectionsTable.id, conn.id));

      if (!conn.accountId) {
        // First successful sync of a new connection: create + link the account
        // automatically so no manual "Sync" click is needed.
        const [acct] = await db.insert(accountsTable).values({
          name: `${conn.label} (${result.loginid ?? "Deriv"})`,
          broker: "Deriv",
          balance: String(result.balance ?? 0),
          equity: String(result.equity ?? 0),
          margin: "0",
          currency: result.currency ?? "USD",
          accountType: conn.environment === "demo" ? "demo" : "live",
          status: "active",
          notes: `Auto-linked from Deriv API. Login: ${result.loginid ?? "unknown"}`,
        }).returning();
        await db.update(brokerConnectionsTable).set({ accountId: acct.id }).where(eq(brokerConnectionsTable.id, conn.id));
      } else {
        await db
          .update(accountsTable)
          .set({
            balance: String(result.balance ?? 0),
            equity: String(result.equity ?? 0),
          })
          .where(eq(accountsTable.id, conn.accountId));
        logger.info(
          {
            connId: conn.id,
            label: conn.label,
            loginid: result.loginid,
            balance: result.balance,
            equity: result.equity,
            openPositions: result.openPositions,
          },
          "balance-sync: account updated",
        );
      }
    }
  } catch (err) {
    entry.consecutiveFailures++;
    entry.lastError = err instanceof Error ? err.message : String(err);
    logger.error({ connId: conn.id, err }, "balance-sync: unexpected error — will auto-retry");
    await db
      .update(brokerConnectionsTable)
      .set({ status: "error", lastError: entry.lastError })
      .where(eq(brokerConnectionsTable.id, conn.id))
      .catch(() => { /* ignore secondary DB error */ });
  } finally {
    activeSyncs--;
    state.set(conn.id, entry);
  }
}

async function runCycle(): Promise<void> {
  lastCycleAt = new Date();
  let connections: (typeof brokerConnectionsTable.$inferSelect)[];
  try {
    // Include BOTH "connected" and "error" connections so errored ones self-heal
    connections = await db
      .select()
      .from(brokerConnectionsTable)
      .where(
        or(
          eq(brokerConnectionsTable.enabled, true),
        ),
      );
    // Filter in-process: enabled only, status connected or error
    connections = connections.filter(
      (c) => c.enabled && (c.status === "connected" || c.status === "error" || c.status === "disconnected"),
    );
  } catch (err) {
    logger.error({ err }, "balance-sync: failed to query broker connections");
    return;
  }

  if (connections.length === 0) return;

  await Promise.allSettled(connections.map(syncOne));
}

export function startBalanceSync(): void {
  if (timer !== null) return;
  logger.info("balance-sync: starting (interval %dms, recovery %dms)", SYNC_INTERVAL_MS, RECOVERY_INTERVAL_MS);
  void runCycle();
  timer = setInterval(() => { void runCycle(); }, SYNC_INTERVAL_MS);
}

export function stopBalanceSync(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
