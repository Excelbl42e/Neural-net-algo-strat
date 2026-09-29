import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, botConfigTable, type BotConfig } from "@workspace/db";
import { UpdateBotConfigBody } from "@workspace/api-zod";
import { brokerConnectionsTable } from "@workspace/db";
import { and } from "drizzle-orm";
import { getSecret } from "../lib/secrets.js";
import { calculateCappedStake, maxFundablePositions } from "../lib/execution-risk.js";

const router: IRouter = Router();

const DEFAULTS = {
  id: 1,
  enabled: false,
  autotradeMode: "off" as const,
  smallAccountMaxRiskPct: 10,
  minRiskReward: 2,
  atrPercentileMin: 15,
  atrPercentileMax: 90,
  efficiencyRatioMin: 0.15,
  minStopAtr: 1,
  maxPerAssetClass: 2,
  newsBlackoutBeforeMin: 30,
  newsBlackoutAfterMin: 30,
  maxSpreadCostPct: 0.5,
  maxPositionHoldHours: 36,
  riskPerTradePct: 1,
  maxConcurrentPositions: 3,
  maxDailyLossPct: 5,
  minConfidence: 0.7,
  allowedInstruments: "",
  killzones: "",
  notes: null as string | null,
};

function serialize(row: BotConfig) {
  return {
    id: row.id,
    enabled: row.enabled,
    autotradeMode: row.autotradeMode,
    riskPerTradePct: parseFloat(row.riskPerTradePct),
    maxConcurrentPositions: row.maxConcurrentPositions,
    maxDailyLossPct: parseFloat(row.maxDailyLossPct),
    minConfidence: parseFloat(row.minConfidence),
    allowedInstruments: row.allowedInstruments,
    killzones: row.killzones,
    smallAccountMaxRiskPct: parseFloat(row.smallAccountMaxRiskPct),
    minRiskReward: parseFloat(row.minRiskReward),
    atrPercentileMin: parseFloat(row.atrPercentileMin),
    atrPercentileMax: parseFloat(row.atrPercentileMax),
    efficiencyRatioMin: parseFloat(row.efficiencyRatioMin),
    minStopAtr: parseFloat(row.minStopAtr),
    maxPerAssetClass: row.maxPerAssetClass,
    newsBlackoutBeforeMin: row.newsBlackoutBeforeMin,
    newsBlackoutAfterMin: row.newsBlackoutAfterMin,
    maxSpreadCostPct: parseFloat(row.maxSpreadCostPct),
    maxPositionHoldHours: row.maxPositionHoldHours,
    notes: row.notes,
    updatedAt: row.updatedAt.toISOString(),
  };
}

router.get("/config", async (_req, res): Promise<void> => {
  const [row] = await db.select().from(botConfigTable).where(eq(botConfigTable.id, 1));
  if (row) {
    res.json(serialize(row));
    return;
  }
  // No row in DB yet — return in-memory defaults without persisting.
  res.json({ ...DEFAULTS, updatedAt: new Date(0).toISOString() });
});

// Stake preview from the SAME sizing function the worker uses (no hardcoded balances).
router.get("/config/stake-preview", async (req, res): Promise<void> => {
  const [row] = await db.select().from(botConfigTable).where(eq(botConfigTable.id, 1));
  const cfg = row ? serialize(row) : { ...DEFAULTS, updatedAt: "" };
  const equities = String(req.query.equity ?? "").split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0).slice(0, 8);
  const rows = equities.map((equity) => {
    const r = calculateCappedStake({
      equity, riskPerTradePct: cfg.riskPerTradePct, maxConcurrentPositions: cfg.maxConcurrentPositions,
      openPositions: 0, smallAccountMaxRiskPct: (cfg as { smallAccountMaxRiskPct: number }).smallAccountMaxRiskPct,
    });
    // The configured concurrent-position cap is aspirational on a small
    // account: the daily-loss budget reserves each open stake, so the first
    // trade can consume the whole day's allowance. Report what is actually
    // fundable alongside the stake, rather than a number the dispatcher
    // cannot honour.
    const slots = maxFundablePositions({
      equity,
      riskPerTradePct: cfg.riskPerTradePct,
      maxConcurrentPositions: cfg.maxConcurrentPositions,
      maxDailyLossPct: cfg.maxDailyLossPct,
      smallAccountMaxRiskPct: (cfg as { smallAccountMaxRiskPct: number }).smallAccountMaxRiskPct,
    });
    return r.ok
      ? {
          equity, ok: true, stake: r.stake,
          riskPct: Number(((r.stake / equity) * 100).toFixed(2)),
          contract: r.stake < 1 ? "binary (multiplier needs >= $1)" : "multiplier or binary",
          fundablePositions: slots.fundable,
          configuredPositions: slots.configured,
          positionsLimitedBy: slots.limitedBy,
        }
      : { equity, ok: false, reason: r.reason, fundablePositions: 0, configuredPositions: slots.configured, positionsLimitedBy: slots.limitedBy };
  });
  res.json(rows);
});

router.put("/config", async (req, res): Promise<void> => {
  const parsed = UpdateBotConfigBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const d = parsed.data;
  const [prev] = await db.select().from(botConfigTable).where(eq(botConfigTable.id, 1));
  const keep = (v: number | undefined, old: string | number | undefined, def: number): string =>
    String(v ?? (old !== undefined ? Number(old) : def));
  if (d.autotradeMode === "auto_live") {
    let passed = false;
    try { passed = JSON.parse((await getSecret("selftest:last")) ?? "{}").passed === true; } catch { /* */ }
    const [realConn] = await db.select({ id: brokerConnectionsTable.id }).from(brokerConnectionsTable)
      .where(and(eq(brokerConnectionsTable.environment, "real"), eq(brokerConnectionsTable.status, "connected"), eq(brokerConnectionsTable.enabled, true))).limit(1);
    if (!passed || !realConn) {
      res.status(400).json({ error: `auto_live needs ${!realConn ? "a connected real (non-virtual) Deriv connection" : ""}${!realConn && !passed ? " and " : ""}${!passed ? "a passed demo self-test (Brokers page)" : ""}.` });
      return;
    }
  }
  const values = {
    id: 1,
    enabled: parsed.data.enabled,
    autotradeMode: parsed.data.autotradeMode,
    riskPerTradePct: String(parsed.data.riskPerTradePct),
    maxConcurrentPositions: parsed.data.maxConcurrentPositions,
    maxDailyLossPct: String(parsed.data.maxDailyLossPct),
    minConfidence: String(parsed.data.minConfidence),
    allowedInstruments: parsed.data.allowedInstruments,
    killzones: parsed.data.killzones,
    smallAccountMaxRiskPct: keep(d.smallAccountMaxRiskPct, prev?.smallAccountMaxRiskPct, 10),
    minRiskReward: keep(d.minRiskReward, prev?.minRiskReward, 2),
    atrPercentileMin: keep(d.atrPercentileMin, prev?.atrPercentileMin, 15),
    atrPercentileMax: keep(d.atrPercentileMax, prev?.atrPercentileMax, 90),
    efficiencyRatioMin: keep(d.efficiencyRatioMin, prev?.efficiencyRatioMin, 0.15),
    minStopAtr: keep(d.minStopAtr, prev?.minStopAtr, 1),
    maxPerAssetClass: d.maxPerAssetClass ?? prev?.maxPerAssetClass ?? 2,
    newsBlackoutBeforeMin: d.newsBlackoutBeforeMin ?? prev?.newsBlackoutBeforeMin ?? 30,
    newsBlackoutAfterMin: d.newsBlackoutAfterMin ?? prev?.newsBlackoutAfterMin ?? 30,
    maxSpreadCostPct: keep(d.maxSpreadCostPct, prev?.maxSpreadCostPct, 0.5),
    maxPositionHoldHours: d.maxPositionHoldHours ?? prev?.maxPositionHoldHours ?? 36,
    notes: parsed.data.notes ?? null,
  };
  const [row] = await db
    .insert(botConfigTable)
    .values(values)
    .onConflictDoUpdate({
      target: botConfigTable.id,
      set: { ...values, updatedAt: new Date() },
    })
    .returning();
  res.json(serialize(row));
});

export default router;
