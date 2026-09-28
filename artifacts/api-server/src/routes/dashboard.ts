import { getSystemStatus } from "../lib/system-status.js";
import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, accountsTable, tradesTable, signalsTable, strategiesTable, brainLayersTable, botConfigTable } from "@workspace/db";

const router: IRouter = Router();

function computeMaxDrawdown(closedTrades: { pnl: string | null; closedAt: Date | null }[], totalEquity: number): number {
  if (closedTrades.length === 0) return 0;

  // Sort by close time ascending to build an equity curve
  const sorted = [...closedTrades].sort((a, b) => {
    const ta = a.closedAt ? new Date(a.closedAt).getTime() : 0;
    const tb = b.closedAt ? new Date(b.closedAt).getTime() : 0;
    return ta - tb;
  });

  let runningPnl = 0;
  let peak = 0;
  let maxDd = 0;

  for (const t of sorted) {
    runningPnl += parseFloat(t.pnl ?? "0");
    if (runningPnl > peak) peak = runningPnl;
    const dd = peak - runningPnl;
    if (dd > maxDd) maxDd = dd;
  }

  if (maxDd === 0) return 0;

  // Express as fraction of current equity when available, else fraction of peak P&L
  const denominator = totalEquity > 0 ? totalEquity : peak > 0 ? peak : 1;
  return maxDd / denominator;
}

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
  const dailyPnl = totalEquity - totalBalance;
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
    weeklyPnl: null,
    monthlyPnl: totalPnl,
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
    stage(2, "filters", "Quant filters", "ATR percentile, efficiency ratio, geometry, premium/discount, portfolio caps (code, not AI)", ["database"]),
    stage(3, "ai", "AI analysis", "GPT reads candles plus measured facts; cited structures are verified in code", ["ai", "signal_worker"]),
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
