import { Router, type IRouter } from "express";
import { eq, desc, and, inArray } from "drizzle-orm";
import { db, tradesTable, brokerConnectionsTable, signalsTable } from "@workspace/db";
import {
  CreateTradeBody,
  UpdateTradeBody,
  GetTradeParams,
  UpdateTradeParams,
  ListTradesQueryParams,
  GetRecentTradesQueryParams,
} from "@workspace/api-zod";
import { decryptSecret } from "../lib/crypto.js";
import { settlementPnl } from "../lib/execution-risk.js";
import { sellDerivTrade } from "../lib/deriv.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

function getContractId(annotations: string | null): number | null {
  if (!annotations) return null;
  try {
    const obj = JSON.parse(annotations);
    return typeof obj.contractId === "number" ? obj.contractId : null;
  } catch {
    return null;
  }
}

router.get("/trades", async (req, res): Promise<void> => {
  const query = ListTradesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const { accountId, status, symbol, limit } = query.data;
  const conditions = [];
  if (accountId != null) conditions.push(eq(tradesTable.accountId, accountId));
  if (status) conditions.push(eq(tradesTable.status, status));
  if (symbol) conditions.push(eq(tradesTable.symbol, symbol));

  const trades = await db
    .select()
    .from(tradesTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(tradesTable.createdAt))
    .limit(limit ?? 50);

  res.json(trades);
});

router.get("/trades/recent", async (req, res): Promise<void> => {
  const query = GetRecentTradesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const limit = query.data.limit ?? 10;
  const trades = await db
    .select()
    .from(tradesTable)
    .orderBy(desc(tradesTable.createdAt))
    .limit(limit);
  res.json(trades);
});

router.post("/trades", async (req, res): Promise<void> => {
  const parsed = CreateTradeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // Drizzle numeric columns require string values; coerce from parsed numbers
  const insertData = {
    ...parsed.data,
    openPrice: String(parsed.data.openPrice),
    lotSize: String(parsed.data.lotSize),
    ...(parsed.data.stopLoss != null ? { stopLoss: String(parsed.data.stopLoss) } : {}),
    ...(parsed.data.takeProfit != null ? { takeProfit: String(parsed.data.takeProfit) } : {}),
  };
  const [trade] = await db.insert(tradesTable).values(insertData as any).returning();
  res.status(201).json(trade);
});

router.get("/trades/:id", async (req, res): Promise<void> => {
  const params = GetTradeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [trade] = await db.select().from(tradesTable).where(eq(tradesTable.id, params.data.id));
  if (!trade) {
    res.status(404).json({ error: "Trade not found" });
    return;
  }
  res.json(trade);
});

router.patch("/trades/:id", async (req, res): Promise<void> => {
  const params = UpdateTradeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateTradeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const updateData: Record<string, unknown> = { ...parsed.data };
  for (const key of ["openPrice", "closePrice", "stopLoss", "takeProfit", "lotSize", "pnl"]) {
    if (updateData[key] != null) updateData[key] = String(updateData[key]);
  }
  const [trade] = await db
    .update(tradesTable)
    .set(updateData as any)
    .where(eq(tradesTable.id, params.data.id))
    .returning();
  if (!trade) {
    res.status(404).json({ error: "Trade not found" });
    return;
  }
  res.json(trade);
});

router.delete("/trades/:id", async (req, res): Promise<void> => {
  const params = GetTradeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [trade] = await db.select().from(tradesTable).where(eq(tradesTable.id, params.data.id));
  if (!trade) {
    res.status(404).json({ error: "Trade not found" });
    return;
  }
  // An open position the bot is tracking is never deleted (see bulk-delete below): close it first.
  if (trade.status === "open" && getContractId(trade.annotations) !== null && (await trackedAccountIds()).has(trade.accountId)) {
    res.status(400).json({ error: "This position is open at Deriv and the bot is tracking it. Close it first; deleting the row would leave it open with nothing tracking it." });
    return;
  }
  await deleteTradesWithSignals([trade.id]);
  res.status(204).end();
});

/**
 * Accounts with an enabled broker connection: the contract monitor checks the
 * open trades of these, and only these. An open row on any other account (its
 * connection removed or switched off) is never settled or closed by the bot,
 * so it reads "open" forever whatever happened at Deriv; it can be deleted.
 */
async function trackedAccountIds(): Promise<Set<number>> {
  const conns = await db.select({ accountId: brokerConnectionsTable.accountId })
    .from(brokerConnectionsTable).where(eq(brokerConnectionsTable.enabled, true));
  return new Set(conns.map((c) => c.accountId).filter((id): id is number => id != null));
}

/**
 * Deletes trades and the executed signals they came from. A signal marked
 * executed with no trade row reads as a placed order whose trade was never
 * written, and that locks all new orders until the reconciler links it, which
 * it never can for a trade the owner deleted. So the signal goes too.
 */
async function deleteTradesWithSignals(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await db.transaction(async (tx) => {
    const deleted = await tx.delete(tradesTable).where(inArray(tradesTable.id, ids)).returning({ signalId: tradesTable.signalId });
    const signalIds = deleted.map((d) => d.signalId).filter((id): id is number => id != null);
    if (signalIds.length > 0) {
      await tx.delete(signalsTable).where(and(inArray(signalsTable.id, signalIds), eq(signalsTable.executionStatus, "executed")));
    }
  });
}

// Manual safety valve: sell an open multiplier position at market now.
// Evidence label: code review only — sellDerivTrade has not been exercised
// against a live Deriv connection yet. Treat the first real use as a test.
router.post("/trades/:id/close", async (req, res): Promise<void> => {
  const params = GetTradeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [trade] = await db.select().from(tradesTable).where(eq(tradesTable.id, params.data.id));
  if (!trade) {
    res.status(404).json({ error: "Trade not found" });
    return;
  }
  if (trade.status !== "open") {
    res.status(400).json({ ok: false, message: `Trade is ${trade.status}, not open` });
    return;
  }
  const contractId = getContractId(trade.annotations);
  if (contractId === null) {
    res.status(400).json({ ok: false, message: "Trade has no linked broker contract" });
    return;
  }
  const [conn] = await db
    .select()
    .from(brokerConnectionsTable)
    .where(and(
      eq(brokerConnectionsTable.accountId, trade.accountId),
      eq(brokerConnectionsTable.enabled, true),
      eq(brokerConnectionsTable.status, "connected"),
    ));
  if (!conn) {
    res.status(400).json({ ok: false, message: "No connected, enabled broker connection found for this trade's account" });
    return;
  }

  const token = await decryptSecret(conn.credential);
  const result = await sellDerivTrade(token, conn.environment === "real" ? "real" : "demo", contractId);

  if (!result.ok) {
    logger.warn({ tradeId: trade.id, contractId, message: result.message, ambiguous: result.ambiguous }, "manual close: sell failed");
    res.status(400).json({ ok: false, message: result.message ?? "Sell request failed" });
    return;
  }

  const [closedTrade] = await db
    .update(tradesTable)
    .set({
      status: "closed",
      closePrice: null,
      pnl: (() => { const p = settlementPnl(result.soldFor, trade.lotSize); return p != null ? String(p) : null; })(),
      closedAt: new Date(),
    })
    .where(and(eq(tradesTable.id, trade.id), eq(tradesTable.status, "open")))
    .returning();

  logger.info({ tradeId: trade.id, contractId, soldFor: result.soldFor }, "manual close: trade closed");
  res.json({ ok: true, message: closedTrade ? result.message : "Sold at Deriv, but trade was already updated elsewhere" });
});

/**
 * Bulk housekeeping for the trade ledger.
 *
 * An open row is never deleted, whatever is asked. Deleting one does not close
 * anything at Deriv — the position stays open with real money on it, while the
 * only record of it disappears: the contract monitor stops tracking it so it
 * is never force-closed or settled, and the daily-loss guard stops counting
 * its stake as open exposure, so the very next trade is sized as though that
 * risk were not there. "Clear all" in the UI was two clicks from doing exactly
 * that on a funded account.
 */
router.post("/trades/bulk-delete", async (req, res): Promise<void> => {
  const { status } = req.body as { status?: string };
  if (status != null && status !== "closed") {
    res.status(400).json({ error: `Only closed trades can be deleted (got status "${status}")`, deleted: 0 });
    return;
  }
  // Closed rows, plus open rows nothing tracks (see trackedAccountIds).
  const tracked = await trackedAccountIds();
  const rows = await db
    .select({ id: tradesTable.id, status: tradesTable.status, accountId: tradesTable.accountId })
    .from(tradesTable)
    .where(inArray(tradesTable.status, ["open", "closed"]));
  const isUntrackedOpen = (r: { status: string; accountId: number }) => r.status === "open" && !tracked.has(r.accountId);
  const ids = rows.filter((r) => r.status === "closed" || isUntrackedOpen(r)).map((r) => r.id);
  const untracked = rows.filter(isUntrackedOpen).length;
  const openKept = rows.filter((r) => r.status === "open").length - untracked;
  await deleteTradesWithSignals(ids);
  const what = `Deleted ${ids.length - untracked} closed trade(s)${untracked > 0 ? ` and ${untracked} untracked open row(s) (their account has no enabled broker connection)` : ""}.`;
  res.json({
    deleted: ids.length,
    openKept,
    message: openKept > 0
      ? `${what} ${openKept} open position(s) the bot is tracking were kept. Close them first.`
      : what,
  });
});

export default router;
