import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, botConfigTable, type BotConfig } from "@workspace/db";
import { UpdateBotConfigBody } from "@workspace/api-zod";
import { brokerConnectionsTable } from "@workspace/db";
import { and } from "drizzle-orm";
import { getSecret } from "../lib/secrets.js";
import { describeStakePlan, RISK_BANDS } from "../lib/execution-risk.js";

const router: IRouter = Router();

const DEFAULTS = {
  id: 1,
  enabled: false,
  autotradeMode: "off" as const,
  smallAccountMaxRiskPct: 10,
  minRiskReward: 1.5,
  atrPercentileMin: 15,
  atrPercentileMax: 90,
  efficiencyRatioMin: 0.15,
  minStopAtr: 1,
  maxPerAssetClass: 2,
  newsBlackoutBeforeMin: 30,
  newsBlackoutAfterMin: 30,
  maxSpreadCostPct: 0.5,
  maxPositionHoldHours: 96,
  riskPerTradePct: 5,
  maxConcurrentPositions: 3,
  maxDailyLossPct: 5,
  minConfidence: 0.5,
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

// The risk ladder itself, served rather than restated in the UI, so the bands
// a person reads are the bands the sizer applies.
router.get("/config/risk-bands", async (_req, res): Promise<void> => {
  const [row] = await db.select().from(botConfigTable).where(eq(botConfigTable.id, 1));
  const cfg = row ? serialize(row) : { ...DEFAULTS, updatedAt: "" };
  res.json({
    configuredRiskPct: cfg.riskPerTradePct,
    bands: RISK_BANDS.map((b, i) => ({
      band: b.band,
      from: b.from,
      to: RISK_BANDS[i + 1]?.from ?? null,
      riskPct: b.riskPct,
      why: b.why,
      appliedRiskPct: Math.min(cfg.riskPerTradePct, b.riskPct),
    })),
  });
});

// Stake preview from the SAME sizing function the worker uses (no hardcoded balances).
router.get("/config/stake-preview", async (req, res): Promise<void> => {
  const [row] = await db.select().from(botConfigTable).where(eq(botConfigTable.id, 1));
  const cfg = row ? serialize(row) : { ...DEFAULTS, updatedAt: "" };
  const equities = String(req.query.equity ?? "").split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0).slice(0, 8);
  // describeStakePlan uses pollStake, the dispatcher's own sizing, so this
  // table cannot drift from what the worker does.
  const rows = equities.map((equity) => {
    const plan = describeStakePlan({
      equity,
      riskPerTradePct: cfg.riskPerTradePct,
      maxConcurrentPositions: cfg.maxConcurrentPositions,
      maxPerAssetClass: (cfg as { maxPerAssetClass: number }).maxPerAssetClass,
    });
    return {
      equity,
      ok: plan.stake != null,
      reason: plan.blocked ?? undefined,
      stake: plan.stake,
      band: plan.band,
      riskPct: plan.riskPct,
      riskCappedByBand: plan.riskCappedByBand,
      contract: plan.contract,
      typicalLoss: plan.typicalLoss,
      worstCaseLoss: plan.worstCaseLoss,
      worstCasePctOfEquity: plan.worstCasePctOfEquity,
      fundablePositions: plan.fundable,
      configuredPositions: Math.min(cfg.maxConcurrentPositions, (cfg as { maxPerAssetClass: number }).maxPerAssetClass),
      positionsLimitedBy: plan.limitedBy,
    };
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
    maxPositionHoldHours: d.maxPositionHoldHours ?? prev?.maxPositionHoldHours ?? 96,
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
