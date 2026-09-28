import { Router, type IRouter } from "express";
import { and, desc, eq, ilike } from "drizzle-orm";
import { db, tradePerformanceTable, tradeReviewsTable } from "@workspace/db";

const router: IRouter = Router();

router.get("/journal/reviews", async (req, res): Promise<void> => {
  const limitRaw = Number.parseInt(String(req.query.limit ?? "50"), 10);
  const offsetRaw = Number.parseInt(String(req.query.offset ?? "0"), 10);
  const limit = Math.min(200, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 50));
  const offset = Math.max(0, Number.isFinite(offsetRaw) ? offsetRaw : 0);
  const conditions = [];
  if (typeof req.query.symbol === "string" && req.query.symbol.trim()) {
    conditions.push(eq(tradeReviewsTable.symbol, req.query.symbol.trim()));
  }
  if (typeof req.query.classification === "string" && req.query.classification.trim()) {
    conditions.push(eq(tradeReviewsTable.classification, req.query.classification.trim()));
  }
  const rows = await db.select().from(tradeReviewsTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(tradeReviewsTable.closedAt), desc(tradeReviewsTable.id))
    .limit(limit).offset(offset);
  res.json(rows.map((row) => ({
    ...row,
    claimedConcepts: JSON.parse(row.claimedConcepts) as string[],
  })));
});

router.get("/journal/performance", async (req, res): Promise<void> => {
  const conditions = [];
  if (req.query.dimension === "concept" || req.query.dimension === "symbol") {
    conditions.push(eq(tradePerformanceTable.dimension, req.query.dimension));
  } else if (req.query.dimension != null) {
    res.status(400).json({ error: "dimension must be concept or symbol" });
    return;
  }
  if (typeof req.query.search === "string" && req.query.search.trim()) {
    conditions.push(ilike(tradePerformanceTable.key, `%${req.query.search.trim()}%`));
  }
  const rows = await db.select().from(tradePerformanceTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(tradePerformanceTable.tradeCount), tradePerformanceTable.key);
  res.json(rows.map((row) => {
    const weightedTrades = Number(row.weightedTrades);
    const weightedWins = Number(row.weightedWins);
    const lifetimeRate = row.tradeCount > 0 ? row.winCount / row.tradeCount : null;
    const sampleAdjustedRate = (weightedWins + 2) / (weightedTrades + 4);
    return {
      dimension: row.dimension,
      key: row.key,
      tradeCount: row.tradeCount,
      winCount: row.winCount,
      lossCount: row.lossCount,
      totalPnl: Number(row.totalPnl),
      winRate: lifetimeRate,
      sampleAdjustedWinRate: sampleAdjustedRate,
      weightedSampleCount: weightedTrades,
      lastOutcomeAt: row.lastOutcomeAt,
      updatedAt: row.updatedAt,
    };
  }));
});

export default router;