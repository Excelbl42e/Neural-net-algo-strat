/**
 * Contract Monitor
 *
 * Every 30s: checks each open contract against its own connected demo account.
 * A trade is closed only when proposal_open_contract confirms it is sold.
 *
 * Each contract query uses a short-lived WebSocket, torn down when done.
 */

import { eq, and } from "drizzle-orm";
import { db, tradesTable, brokerConnectionsTable } from "@workspace/db";
import { logger } from "./logger.js";
import { rebuildMissingTradeReviews } from "./trade-review.js";
import { decryptSecret } from "./crypto.js";
import { fetchContractStatuses } from "./deriv.js";

const POLL_INTERVAL_MS = 30_000;

let timer: NodeJS.Timeout | null = null;
let cycleRunning = false;
let lastCycleAt: Date | null = null;
let lastError: string | null = null;

export function getContractMonitorStatus() {
  return { running: timer !== null, lastCycleAt: lastCycleAt?.toISOString() ?? null, lastError };
}

// ─── Parse contractId out of the annotations JSON ────────────────────────────

function getContractId(annotations: string | null): number | null {
  if (!annotations) return null;
  try {
    const obj = JSON.parse(annotations);
    return typeof obj.contractId === "number" ? obj.contractId : null;
  } catch {
    return null;
  }
}

// ─── Query a single contract through its owning broker account ────────────────

interface SettledContract {
  contractId: number;
  sellPrice: number | null;
  profit: number | null;
  sellSpot: number | null;
  sellTime: number | null;
}

// ─── Monitor cycle ────────────────────────────────────────────────────────────

async function runCycle(): Promise<void> {
  if (cycleRunning) return;
  cycleRunning = true;

  try {
    // Load all open trades that have a contractId
    const openTrades = await db
      .select()
      .from(tradesTable)
      .where(eq(tradesTable.status, "open"));

    const tradesToCheck = openTrades
      .map((t) => ({ trade: t, contractId: getContractId(t.annotations) }))
      .filter((x): x is { trade: typeof openTrades[0]; contractId: number } =>
        x.contractId !== null,
      );

    if (tradesToCheck.length === 0) {
      await rebuildMissingTradeReviews();
      return;
    }

    // Only use enabled connections, and only for the account that owns each
    // trade. A missing match is not evidence that a contract settled.
    const connections = await db
      .select()
      .from(brokerConnectionsTable)
      .where(and(eq(brokerConnectionsTable.enabled, true), eq(brokerConnectionsTable.status, "connected")));

    const settled: SettledContract[] = [];
    const byConn = new Map<number, number[]>();
    for (const entry of tradesToCheck) {
      const conn = connections.find((c) => c.accountId === entry.trade.accountId);
      if (!conn) continue;
      byConn.set(conn.id, [...(byConn.get(conn.id) ?? []), entry.contractId]);
    }
    for (const [connId, ids] of byConn) {
      const conn = connections.find((c) => c.id === connId)!;
      try {
        const token = await decryptSecret(conn.credential);
        const statuses = await fetchContractStatuses(token, conn.environment === "real" ? "real" : "demo", ids);
        for (const info of statuses.values()) {
          if (info.isSold) {
            settled.push({
              contractId: info.contractId, sellPrice: info.sellPrice, profit: info.profit,
              sellSpot: info.sellSpot, sellTime: info.sellTime,
            });
          }
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : "contract status query failed";
      }
    }

    if (settled.length === 0) {
      await rebuildMissingTradeReviews();
      return;
    }

    logger.info({ count: settled.length }, "contract-monitor: closing settled contracts");

    for (const cs of settled) {
      const entry = tradesToCheck.find((x) => x.contractId === cs.contractId);
      if (!entry) continue;

      const pnl = cs.profit ?? (cs.sellPrice != null
        ? cs.sellPrice - parseFloat(entry.trade.lotSize ?? "10")
        : null);

      const closePrice = cs.sellSpot != null ? String(cs.sellSpot) : null;
      const closedAt = cs.sellTime ? new Date(cs.sellTime * 1000) : new Date();

      const [closedTrade] = await db
        .update(tradesTable)
        .set({
          status: "closed",
          closePrice,
          pnl: pnl != null ? String(Number(pnl.toFixed(2))) : null,
          closedAt,
        })
        .where(and(eq(tradesTable.id, entry.trade.id), eq(tradesTable.status, "open")))
        .returning();

      if (closedTrade) logger.info(
        {
          tradeId: entry.trade.id,
          contractId: cs.contractId,
          pnl,
          closePrice,
        },
        "contract-monitor: trade closed",
      );
    }
    // Review creation is deliberately recoverable: a process restart between
    // settlement and review persistence is repaired by the next poll.
    await rebuildMissingTradeReviews();
  } catch (err) {
    lastError = err instanceof Error ? err.message.replace(/otp=[^&\s]+/g, "otp=[redacted]") : "cycle error";
    logger.error({ msg: lastError }, "contract-monitor: cycle error");
  } finally {
    lastCycleAt = new Date();
    cycleRunning = false;
  }
}

// ─── Start / stop ─────────────────────────────────────────────────────────────

export function startContractMonitor(): void {
  if (timer !== null) return;
  logger.info("contract-monitor: starting (interval %dms)", POLL_INTERVAL_MS);
  setTimeout(() => { void runCycle(); }, 20_000);
  timer = setInterval(() => { void runCycle(); }, POLL_INTERVAL_MS);
}

export function stopContractMonitor(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
