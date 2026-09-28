import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, reportsTable, tradesTable, accountsTable } from "@workspace/db";
import {
  GenerateReportBody,
  GetReportParams,
  ListReportsQueryParams,
} from "@workspace/api-zod";
import { computeMaxDrawdown } from "../lib/trade-stats.js";

const router: IRouter = Router();

router.get("/reports", async (req, res): Promise<void> => {
  const query = ListReportsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const { type } = query.data;
  const reports = type
    ? await db.select().from(reportsTable).where(eq(reportsTable.type, type)).orderBy(desc(reportsTable.createdAt))
    : await db.select().from(reportsTable).orderBy(desc(reportsTable.createdAt));
  res.json(reports);
});

router.get("/reports/scoring", async (req, res): Promise<void> => {
  const [latest] = await db
    .select()
    .from(reportsTable)
    .orderBy(desc(reportsTable.createdAt))
    .limit(1);

  if (!latest) {
    res.json({
      period: "No data",
      scores: JSON.stringify({ winRate: 0, riskManagement: 0, strategyAdherence: 0, gamblingAvoidance: 0, profitability: 0, drawdown: 0, consistency: 0, longShortBalance: 0 }),
      totalScore: 0,
      enterpriseViable: false,
      threshold: 30,
    });
    return;
  }

  const totalScore = parseFloat(latest.totalScore ?? "0");
  res.json({
    period: latest.period,
    scores: latest.scores ?? "{}",
    totalScore,
    enterpriseViable: totalScore >= 30,
    threshold: 30,
  });
});

router.post("/reports", async (req, res): Promise<void> => {
  const parsed = GenerateReportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { type, period } = parsed.data;

  // Compute stats from trades for the period
  const allTrades = await db.select().from(tradesTable).where(eq(tradesTable.status, "closed"));
  const closed = allTrades;
  const wins = closed.filter(t => parseFloat(t.pnl ?? "0") > 0);
  const winRate = closed.length > 0 ? wins.length / closed.length : 0;
  const totalPnl = closed.reduce((sum, t) => sum + parseFloat(t.pnl ?? "0"), 0);
  const longs = closed.filter(t => t.direction === "buy").length;
  const shorts = closed.filter(t => t.direction === "sell").length;
  const holdingTimes = closed.filter(t => t.holdingTime != null).map(t => t.holdingTime!);
  const avgHoldingTime = holdingTimes.length > 0 ? holdingTimes.reduce((a, b) => a + b, 0) / holdingTimes.length : null;
  const rrValues = closed.filter(t => t.riskReward != null).map(t => parseFloat(t.riskReward!));
  const avgRR = rrValues.length > 0 ? rrValues.reduce((a, b) => a + b, 0) / rrValues.length : null;

  const activeAccounts = await db.select().from(accountsTable).where(eq(accountsTable.status, "active"));
  const totalEquity = activeAccounts.reduce((sum, a) => sum + parseFloat(a.equity ?? "0"), 0);
  const maxDrawdown = computeMaxDrawdown(closed, totalEquity);
  // scoreDrawdown derived from the real maxDrawdown above (1 = severe, 5 = negligible),
  // not a fixed constant like the fields below.
  const scoreDrawdown = maxDrawdown >= 0.4 ? 1 : maxDrawdown >= 0.25 ? 2 : maxDrawdown >= 0.15 ? 3 : maxDrawdown >= 0.05 ? 4 : 5;

  // Score categories 1-5
  const scoreWinRate = Math.max(1, Math.min(5, Math.round(winRate * 5 + 1)));
  const scoreRisk = avgRR != null ? Math.max(1, Math.min(5, Math.round(avgRR))) : 3;
  const scoreProfitability = totalPnl > 0 ? Math.min(5, Math.round(totalPnl / 500)) + 1 : 2;
  const scoreLongShort = Math.abs(longs - shorts) < 3 ? 5 : 3;
  // strategyAdherence, gamblingAvoidance and consistency have no underlying
  // measurement anywhere in this codebase — there is no tracked notion of
  // "adherence to strategy" or a gambling-behavior heuristic. Scoring them
  // would be fabricating data, so they are left out of totalScore/scores
  // rather than reported as if real. uptimePercent is likewise not tracked
  // (no deploy-uptime metric exists) and is omitted for the same reason.
  const totalScore = scoreWinRate + scoreRisk + scoreProfitability + scoreDrawdown + scoreLongShort;

  const scores = JSON.stringify({
    winRate: scoreWinRate,
    riskManagement: scoreRisk,
    profitability: scoreProfitability,
    drawdown: scoreDrawdown,
    longShortBalance: scoreLongShort,
    strategyAdherence: null,
    gamblingAvoidance: null,
    consistency: null,
    _note: "strategyAdherence, gamblingAvoidance and consistency are not computed from real data and are intentionally omitted rather than fabricated.",
  });

  const [report] = await db.insert(reportsTable).values({
    type,
    period,
    winRate: String(winRate),
    totalPnl: String(totalPnl),
    maxDrawdown: String(maxDrawdown),
    tradesCount: closed.length,
    longCount: longs,
    shortCount: shorts,
    avgHoldingTime: avgHoldingTime != null ? String(avgHoldingTime) : null,
    riskReward: avgRR != null ? String(avgRR) : null,
    // strategyAdherence/gamblingScore are NOT NULL columns with neutral
    // defaults (0 / 1) in the schema; left unset here rather than filled
    // with fabricated precise-looking values. uptimePercent has no default
    // and no underlying measurement, so it's left null (the column allows it).
    uptimePercent: null,
    scores,
    totalScore: String(totalScore),
  }).returning();

  res.status(201).json(report);
});

router.get("/reports/:id", async (req, res): Promise<void> => {
  const params = GetReportParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [report] = await db.select().from(reportsTable).where(eq(reportsTable.id, params.data.id));
  if (!report) {
    res.status(404).json({ error: "Report not found" });
    return;
  }
  res.json(report);
});

export default router;
