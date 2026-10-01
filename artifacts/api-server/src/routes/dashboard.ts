import { getSystemStatus } from "../lib/system-status.js";
import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, accountsTable, tradesTable, signalsTable, strategiesTable, botConfigTable } from "@workspace/db";
import { computeMaxDrawdown } from "../lib/trade-stats.js";

const router: IRouter = Router();

router.get("/dashboard/overview", async (_req, res): Promise<void> => {
  const [accounts, openTrades, activeSignals, allStrategies, closedTrades, [config]] = await Promise.all([
    db.select().from(accountsTable).where(eq(accountsTable.status, "active")),
    db.select().from(tradesTable).where(eq(tradesTable.status, "open")),
    db.select().from(signalsTable).where(eq(signalsTable.status, "active")),
    db.select().from(strategiesTable).where(eq(strategiesTable.active, true)),
    db.select().from(tradesTable).where(eq(tradesTable.status, "closed")).orderBy(desc(tradesTable.closedAt)).limit(200),
    db.select().from(botConfigTable).where(eq(botConfigTable.id, 1)),
  ]);

  const totalEquity = accounts.reduce((sum, a) => sum + parseFloat(a.equity ?? "0"), 0);
  const totalBalance = accounts.reduce((sum, a) => sum + parseFloat(a.balance ?? "0"), 0);
  // Realized P&L for the current UTC day — the same definition the daily-loss
  // guard sizes against, so the number on screen and the number that can halt
  // trading agree. This used to report equity-minus-balance (i.e. unrealized
  // P&L on open positions) under a "daily" label, which is a different thing.
  const utcDayStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  const dailyPnl = closedTrades
    .filter((t) => t.closedAt != null && new Date(t.closedAt) >= utcDayStart)
    .reduce((sum, t) => sum + parseFloat(t.pnl ?? "0"), 0);
  const openPnl = totalEquity - totalBalance;
  const wins = closedTrades.filter(t => parseFloat(t.pnl ?? "0") > 0);
  const winRate = closedTrades.length > 0 ? wins.length / closedTrades.length : 0;
  const totalPnl = closedTrades.reduce((sum, t) => sum + parseFloat(t.pnl ?? "0"), 0);
  const maxDrawdown = computeMaxDrawdown(closedTrades, totalEquity);

  const lastTrade = closedTrades[0];
  const lastSignal = [...activeSignals].sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  )[0];

  const botEnabled = config?.enabled ?? false;
  const botStatus = botEnabled ? "running" : "stopped";

  res.json({
    botStatus,
    totalEquity,
    dailyPnl,
    openPnl,
    // weeklyPnl has never been computed and no caller reads it; monthlyPnl is
    // really "P&L across the last 200 closed trades", so it is reported under
    // that name rather than a calendar one it does not measure.
    weeklyPnl: null,
    monthlyPnl: totalPnl,
    recentClosedPnl: totalPnl,
    winRate,
    openTrades: openTrades.length,
    activeSignals: activeSignals.length,
    maxDrawdown,
    accountCount: accounts.length,
    strategyCount: allStrategies.length,
    lastSignalAt: lastSignal?.createdAt ?? null,
    lastTradeAt: lastTrade?.closedAt ?? null,
  });
});

router.get("/dashboard/workflow", async (_req, res): Promise<void> => {
  // Real pipeline state derived from live component status, not stored fixtures.
  const status = await getSystemStatus();
  const by = (n: string) => status.components.find((c) => c.name === n);
  const stage = (id: number, layerType: string, name: string, description: string, comps: string[]) => {
    const cs = comps.map((c) => by(c)).filter((c): c is NonNullable<typeof c> => Boolean(c));
    const st = cs.some((c) => c.status === "down") ? "error" : cs.some((c) => c.status === "degraded") ? "warning" : cs.every((c) => c.status === "idle") ? "idle" : "active";
    return { id, layerType, name, description, status: st, metrics: Object.fromEntries(cs.map((c) => [c.name, c.reason])), outputSignal: null };
  };
  const stages = [
    stage(1, "data", "Market data", "Deriv candle feed into the candles table", ["candle_feed"]),
    stage(2, "rules", "Market rules", "Deriv trading hours, Friday cutoff, sessions, news blackout, one position per pair, portfolio caps", ["database"]),
    stage(3, "judge", "Strategy poll", "60 strategies (40 quantitative, 20 technical) vote on each closed M30 candle; 70% agreement trades at market", ["signal_judge", "signal_worker"]),
    stage(4, "execution", "Order execution", "Deriv order path, reconciler, contract monitor", ["broker", "reconciler", "contract_monitor"]),
    stage(5, "accounts", "Balance sync", "Deriv balance polling", ["balance_sync"]),
  ];
  res.json({
    stages: JSON.stringify(stages),
    overallStatus: status.status === "down" ? "error" : status.status === "degraded" ? "paused" : status.bot.enabled ? "running" : "idle",
    lastUpdated: status.now,
  });
});

export default router;
