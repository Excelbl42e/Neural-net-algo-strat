/**
 * Signal worker.
 * Just after every M30 close, for each forex pair, the 60-strategy poll (see
 * poll-engine.ts) votes, each strategy on the latest closed candle of its own
 * timeframe. When the majority side reaches the configured share (simple
 * majority by default) a signal is written and, in an auto mode, traded at
 * market on Deriv through the dispatcher below.
 */
import { eq, ne, sql, and, or, gte, lt, lte, isNull, desc, inArray } from "drizzle-orm";
import {
  db,
  signalsTable,
  strategiesTable,
  botConfigTable,
  brokerConnectionsTable,
  tradesTable,
  candlesTable,
  accountsTable,
} from "@workspace/db";

import { getOpenAI } from "./ai-client.js";
import { logger } from "./logger.js";
import { placeDerivTrade, getContractQuote } from "./deriv.js";
import { getLastTick, getOpenBucketRange } from "./candle-feeder.js";
import { ALL_FOREX_INSTRUMENTS, getSyntheticSymbol, isForexCode } from "./synthetic-catalog.js";
import {
  pollStake, worstCaseLoss,
  planEntry, entryZoneState, MULTIPLIER_MIN_STAKE, MULTIPLIER_STOP_CAP_PCT, DEFAULT_MIN_LIMIT_ORDER_USD,
  parseDerivLimitRejection, setupInvalidation,
} from "./execution-risk.js";
import { forexPreScanGate, tradingCostGate } from "./forex-readiness.js";
import { getCotSeries, cotFadeSignal, cotVetoes } from "./cot-positioning.js";
import { getNewsEvents } from "./news-calendar.js";
import { claimReason, getExecutionLock } from "./reconciler.js";
import { decryptSecret } from "./crypto.js";
import { getSecret } from "./secrets.js";
import { recordRejection } from "./rejections.js";
import { portfolioGate, isClosedCandle, nextAlignedScanAt } from "./scan-rules.js";
import { STRATEGIES, type Bars } from "./poll-strategies.js";
import {
  runPoll, pollBars, pollLevels, alignCloses, POLL_HISTORY_BARS, POLL_STOP_FRACTION, POLL_TIMEFRAMES, POLL_TIMEFRAME_MS,
  type PollInput, type PollTimeframe,
} from "./poll-engine.js";

const EMPTY_BARS: Bars = { t: [], o: [], h: [], l: [], c: [] };

// The poll votes on closed M30 candles, so it runs once per M30 close. Feed
// and open-contract monitors run on their own schedules.
const SIGNAL_INTERVAL_MS = 30 * 60 * 1000;
const POLL_STRATEGY_NAME = "Strategy poll (40 quant + 20 technical, majority)";
/** A poll signal is a market order: if it cannot be placed before the next scan, the next poll decides afresh. */
const POLL_SIGNAL_TTL_MS = SIGNAL_INTERVAL_MS;
// Only forex is traded and analyzed. The bot scans every forex major in the
// catalog unless the account has a custom allowedInstruments allow-list
// (which is itself filtered back down to forex — see below).
const DEFAULT_INSTRUMENTS = ALL_FOREX_INSTRUMENTS;

let workerRunning = false;
let lastRunAt: Date | null = null;
let lastError: string | null = null;
let signalsGeneratedTotal = 0;
let cachedEnabled: boolean | null = null;
let cachedAutotradeMode: string | null = null;
let activeMode: "auto_demo" | "auto_live" | null = null;

let activeConfig: { smallAccountMaxRiskPct: number; minConfidence: number; minRiskReward: number; maxPerAssetClass: number } = {
  smallAccountMaxRiskPct: 10, minConfidence: 0.5, minRiskReward: 1.5, maxPerAssetClass: 14,
};

/** An order is never placed against a quote older than this. Ticks arrive every second or two on the majors. */
const EXECUTION_TICK_MAX_AGE_MS = 60_000;
let lastLock: { locked: boolean; reason: string | null } = { locked: false, reason: null };
const LOCK_MSG = "Autonomous dispatch waiting: the reconciler is resolving an unresolved Deriv order";

let intervalHandle: ReturnType<typeof setTimeout> | null = null;
/** Seconds after each M30 close before scanning, so the closed candle has been written. */
const SCAN_OFFSET_MS = 20_000;
let nextScanAt: Date | null = null;

export function getWorkerStatus() {
  const staleMs = lastRunAt ? Date.now() - lastRunAt.getTime() : null;
  return {
    /** True only while a tick is executing — a few seconds every SIGNAL_INTERVAL_MS. */
    running: workerRunning,
    /**
     * True while the scan loop is scheduled. This, not `running`, is what
     * "is the worker working?" means: `running` is false for 29 of every 30
     * minutes on a perfectly healthy worker, and the dashboard read that as
     * "Not running".
     */
    scheduled: intervalHandle !== null,
    /** Ticks are late enough to be a problem, using the same rule as the health panel. */
    stalled: intervalHandle !== null && staleMs != null && staleMs > 2 * SIGNAL_INTERVAL_MS + 60_000,
    /** When the next scan is due, so "when will it trade?" is answerable from the UI. */
    nextRunAt: nextScanAt?.toISOString() ?? null,
    lastRunAt: lastRunAt?.toISOString() ?? null,
    lastError,
    signalsGeneratedTotal,
    intervalMs: SIGNAL_INTERVAL_MS,
    enabled: cachedEnabled,
    autotradeMode: cachedAutotradeMode,
    executionLocked: lastLock.locked,
    executionLockReason: lastLock.reason,
  };
}

// ── Trade dispatcher ─────────────────────────────────────────────────────────

async function setSignalExecutionState(
  signalId: number,
  executionStatus: "generated" | "awaiting_broker" | "executed" | "rejected" | "ambiguous",
  executionReason: string | null,
  options: { dispatchedAt?: Date | null; contractId?: number | null; signalStatus?: string } = {},
): Promise<void> {
  await db
    .update(signalsTable)
    .set({
      executionStatus,
      executionReason,
      ...(options.dispatchedAt !== undefined ? { dispatchedAt: options.dispatchedAt } : {}),
      ...(options.contractId !== undefined ? { contractId: options.contractId } : {}),
      ...(options.signalStatus !== undefined ? { status: options.signalStatus } : {}),
    })
    .where(eq(signalsTable.id, signalId));
}

async function transitionSignalExecution(
  signalId: number,
  expected: "generated" | "awaiting_broker",
  executionStatus: "generated" | "awaiting_broker" | "executed" | "rejected" | "ambiguous",
  executionReason: string | null,
  options: { dispatchedAt?: Date | null; contractId?: number | null; signalStatus?: string } = {},
): Promise<boolean> {
  const [updated] = await db
    .update(signalsTable)
    .set({
      executionStatus,
      executionReason,
      ...(options.dispatchedAt !== undefined ? { dispatchedAt: options.dispatchedAt } : {}),
      ...(options.contractId !== undefined ? { contractId: options.contractId } : {}),
      ...(options.signalStatus !== undefined ? { status: options.signalStatus } : {}),
    })
    .where(and(eq(signalsTable.id, signalId), eq(signalsTable.executionStatus, expected)))
    .returning({ id: signalsTable.id });
  return Boolean(updated);
}

/**
 * Record why a pending signal is still waiting — once. The entry watcher looks
 * at pending signals every few seconds, so writing the reason (and a refusal
 * panel entry) on every look would bury the panel and churn the database with
 * the same sentence. Only a change of reason is news.
 */
async function noteWaiting(signal: SignalRow, reason: string): Promise<void> {
  if (signal.id == null || signal.executionReason === reason) return;
  signal.executionReason = reason;
  await recordGeneratedReason(signal.id, reason);
  recordRejection({ symbol: signal.symbol, stage: "entry", reason });
}

async function recordGeneratedReason(signalId: number, reason: string): Promise<void> {
  await db
    .update(signalsTable)
    .set({ executionStatus: "generated", executionReason: reason })
    .where(and(
      eq(signalsTable.id, signalId),
      eq(signalsTable.executionStatus, "generated"),
      // An unchanged reason is not worth a write; the watcher re-checks often.
      sql`${signalsTable.executionReason} IS DISTINCT FROM ${reason}`,
    ));
}

async function findUntrackedExecutedSignal(): Promise<number | null> {
  const [orphan] = await db.select({ id: signalsTable.id })
    .from(signalsTable)
    .leftJoin(tradesTable, eq(tradesTable.signalId, signalsTable.id))
    .where(and(eq(signalsTable.executionStatus, "executed"), isNull(tradesTable.id)))
    .limit(1);
  return orphan?.id ?? null;
}

function preBuyRetryCount(reason: string | null): number {
  const match = reason?.match(/^Pre-buy retry (\d+)\/2:/);
  return match ? Number(match[1]) : 0;
}

interface SignalRow {
  id?: number;
  symbol: string;
  direction: string;
  confidence: string;
  strategy: string;
  reasoning: string | null;
  stopLevel: string | null;
  target1Level: string | null;
  entryLow: string | null;
  entryHigh: string | null;
  expiresAt: Date | null;
  executionStatus: "generated" | "awaiting_broker" | "executed" | "rejected" | "ambiguous";
  executionReason: string | null;
  /** When the signal was stored; price history since then decides whether the setup is still valid. */
  createdAt?: Date | null;
}

/**
 * Whole M5 candles that start after the signal was created, plus the candle
 * still forming and the live tick. The partial candle the signal was created
 * in is left out, so price from before the signal can never cancel it.
 */
const INVALIDATION_TF = "M5";
const INVALIDATION_TF_MS = 5 * 60_000;

async function invalidationSince(signal: SignalRow): Promise<string | null> {
  if (!signal.createdAt) return null;
  const stop = signal.stopLevel != null ? parseFloat(signal.stopLevel) : Number.NaN;
  const target = signal.target1Level != null ? parseFloat(signal.target1Level) : Number.NaN;
  if (!Number.isFinite(stop) || !Number.isFinite(target)) return null;
  const createdMs = signal.createdAt.getTime();
  const sinceMs = Math.ceil(createdMs / INVALIDATION_TF_MS) * INVALIDATION_TF_MS;
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  const [row] = await db
    .select({ low: sql<string | null>`min(${candlesTable.low})`, high: sql<string | null>`max(${candlesTable.high})` })
    .from(candlesTable)
    .where(and(
      eq(candlesTable.symbol, signal.symbol),
      eq(candlesTable.timeframe, INVALIDATION_TF),
      gte(candlesTable.openTime, new Date(sinceMs)),
    ));
  if (row?.low != null) low = Math.min(low, Number(row.low));
  if (row?.high != null) high = Math.max(high, Number(row.high));
  const open = getOpenBucketRange(signal.symbol, INVALIDATION_TF);
  if (open && open.startMs >= sinceMs) { low = Math.min(low, open.low); high = Math.max(high, open.high); }
  const tick = getLastTick(signal.symbol);
  if (tick && tick.at >= createdMs) { low = Math.min(low, tick.price); high = Math.max(high, tick.price); }
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  return setupInvalidation(signal.direction === "sell" ? "sell" : "buy", stop, target, low, high);
}

async function cancelInvalidated(signal: SignalRow, reason: string): Promise<void> {
  if (signal.id == null) return;
  const cancelled = await transitionSignalExecution(signal.id, "generated", "rejected", reason, { signalStatus: "cancelled" });
  if (!cancelled) return;
  recordRejection({ symbol: signal.symbol, stage: "entry", reason });
  logger.info({ symbol: signal.symbol, signalId: signal.id, reason }, "Pending signal cancelled: setup over before entry");
}

let dispatchQueue: Promise<void> = Promise.resolve();

interface ForexDispatchParams {
  killzones: string;
  newsBlackoutBeforeMin: number;
  newsBlackoutAfterMin: number;
  maxSpreadCostPct: number;
  /** Weekly cycle: last UTC weekday new trades may open (5 = every weekday). */
  lastEntryWeekday: number;
  /** Skip a trade that goes with speculators at a 3-year COT positioning extreme. */
  cotVeto: boolean;
}

async function dispatchTrade(
  signal: SignalRow,
  riskPerTradePct: number,
  maxConcurrentPositions: number,
  forex: ForexDispatchParams,
): Promise<void> {
  const previous = dispatchQueue;
  let release!: () => void;
  dispatchQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const lock = await getExecutionLock();
    lastLock = lock;
    if (lock.locked) {
      if (signal.id != null) await recordGeneratedReason(signal.id, lock.reason ?? LOCK_MSG);
      return;
    }
    await dispatchTradeUnlocked(signal, riskPerTradePct, maxConcurrentPositions, forex);
  } catch (err) {
    // A claim already written as awaiting_broker is intentionally left
    // untouched; if its state cannot be verified, fail closed globally.
    if (signal.id != null) {
      try {
        const [current] = await db.select({ executionStatus: signalsTable.executionStatus })
          .from(signalsTable).where(eq(signalsTable.id, signal.id)).limit(1);
        if (current?.executionStatus === "awaiting_broker" || current?.executionStatus === "ambiguous") {
          logger.warn("Execution state unresolved; the reconciler will resolve it against Deriv");
        } else {
          const reason = `Dispatch preflight failed: ${err instanceof Error ? err.message : String(err)}`;
          await recordGeneratedReason(signal.id, reason);
        }
      } catch (persistErr) {
        logger.warn("Execution state unresolved; the reconciler will resolve it against Deriv");
        logger.error({ signalId: signal.id, persistErr }, "Could not verify/persist dispatch state; blocking autonomous execution");
      }
    }
    throw err;
  } finally {
    release();
  }
}

/** Past this, the synced equity is treated as unusable: balance-sync polls every 60s and retries a failing connection every 5 min. */
const EQUITY_MAX_STALE_MS = 10 * 60_000;

async function dispatchTradeUnlocked(
  signal: SignalRow,
  riskPerTradePct: number,
  maxConcurrentPositions: number,
  forex: ForexDispatchParams,
): Promise<void> {
  if (signal.id == null) {
    logger.error({ symbol: signal.symbol }, "Signal has no persisted ID; refusing untrackable execution");
    return;
  }
  if (signal.executionStatus !== "generated") {
    logger.info(
      { symbol: signal.symbol, signalId: signal.id, executionStatus: signal.executionStatus },
      "Signal is not in generated execution state; refusing dispatch",
    );
    return;
  }

  if (!signal.expiresAt || signal.expiresAt.getTime() <= Date.now()) {
    await setSignalExecutionState(signal.id, "generated", "Signal expired before broker dispatch", { signalStatus: "expired" });
    logger.info({ symbol: signal.symbol, signalId: signal.id }, "Expired or undated signal refused by dispatcher");
    return;
  }
  if (!isForexCode(signal.symbol)) {
    await recordGeneratedReason(signal.id, "Non-forex instrument refused: only forex is traded and analyzed");
    logger.warn({ symbol: signal.symbol }, "Non-forex instrument refused: only forex is traded and analyzed");
    return;
  }

  logger.info({ symbol: signal.symbol, direction: signal.direction }, "dispatchTrade: looking for broker");

  if (!activeMode) {
    await recordGeneratedReason(signal.id, "Autotrade mode is off");
    return;
  }
  const wantEnv = activeMode === "auto_live" ? "real" : "demo";
  if (activeMode === "auto_live") {
    // auto_live requires one recorded, passed demo self-test.
    let passed = false;
    try { passed = JSON.parse((await getSecret("selftest:last")) ?? "{}").passed === true; } catch { /* */ }
    if (!passed) {
      await recordGeneratedReason(signal.id, "auto_live refused: no passed demo self-test on record");
      return;
    }
  }
  const conns = await db
    .select()
    .from(brokerConnectionsTable)
    .where(
      and(
        eq(brokerConnectionsTable.enabled, true),
        eq(brokerConnectionsTable.status, "connected"),
        eq(brokerConnectionsTable.environment, wantEnv),
      ),
    );

  if (!conns.length) {
    await recordGeneratedReason(signal.id, `No active connected ${wantEnv} broker`);
    logger.info({ symbol: signal.symbol }, "No active connected broker — signal kept pending");
    return;
  }

  const conn = conns[0]!;
  let token = "";
  try {
    token = (await decryptSecret(conn.credential ?? "")).trim();
  } catch (err) {
    await recordGeneratedReason(signal.id, err instanceof Error ? err.message : "Broker credential could not be decrypted");
    return;
  }
  if (!token) {
    await recordGeneratedReason(signal.id, "Connected broker has no credential token");
    logger.warn({ broker: conn.label }, "Broker has no credential token — skipping trade");
    return;
  }

  {
    // Market-hours, killzone and news checks first. These are free and local,
    // and they reject most of what gets here — running them before any network
    // call keeps a closed market from costing a round-trip per signal. The
    // trading-cost check that used to live here has moved below, to where the
    // stake and contract type are actually known.
    const newsEvents = await getNewsEvents();
    const preDispatch = forexPreScanGate({
      symbol: signal.symbol,
      now: new Date(),
      killzones: forex.killzones,
      newsEvents,
      newsBlackoutBeforeMin: forex.newsBlackoutBeforeMin,
      newsBlackoutAfterMin: forex.newsBlackoutAfterMin,
      lastEntryWeekday: forex.lastEntryWeekday,
    });
    if (!preDispatch.ok) {
      await recordGeneratedReason(signal.id, preDispatch.reason ?? "Forex readiness gate failed");
      recordRejection({ symbol: signal.symbol, stage: "forex_readiness", reason: preDispatch.reason ?? "Forex readiness gate failed" });
      logger.warn({ symbol: signal.symbol, reason: preDispatch.reason }, "Forex readiness gate refused dispatch");
      return;
    }
  }

  // COT veto: a trade that would go with speculators at a 3-year positioning
  // extreme is skipped (cot-positioning.ts). Without fresh COT data it stands
  // down and the vote trades as before.
  if (forex.cotVeto && (signal.direction === "buy" || signal.direction === "sell")) {
    const series = await getCotSeries();
    if (series) {
      const cot = cotFadeSignal(signal.symbol, series, new Date());
      if (cotVetoes(signal.direction, cot)) {
        const reason = `COT veto: speculators' positioning on this pair is at the ${Math.round((cot.percentile ?? 0) * 100)}th percentile of 3 years (week of ${cot.week}); a ${signal.direction} would follow the crowd at an extreme`;
        const cancelled = await transitionSignalExecution(signal.id, "generated", "rejected", reason, { signalStatus: "cancelled" });
        if (cancelled) {
          recordRejection({ symbol: signal.symbol, stage: "cot_veto", reason, metrics: { percentile: cot.percentile ?? -1 } });
          logger.info({ symbol: signal.symbol, signalId: signal.id, reason }, "Signal cancelled by the COT veto");
        }
        return;
      }
    }
  }

  if (conn.accountId == null) {
    await recordGeneratedReason(signal.id, `Connected ${wantEnv} broker has no linked account`);
    logger.warn({ symbol: signal.symbol, broker: conn.label }, "No linked account; refusing unvalidated execution");
    return;
  }
  const [linkedAccount] = await db
    .select({ equity: accountsTable.equity, currency: accountsTable.currency })
    .from(accountsTable)
    .where(eq(accountsTable.id, conn.accountId))
    .limit(1);
  if (!linkedAccount) {
    await recordGeneratedReason(signal.id, "Linked broker account was not found");
    logger.warn({ symbol: signal.symbol, accountId: conn.accountId }, "Linked account not found; refusing execution");
    return;
  }
  if (linkedAccount.currency.toUpperCase() !== "USD") {
    await recordGeneratedReason(signal.id, `Account currency ${linkedAccount.currency} is unsupported; risk sizing requires USD`);
    logger.warn(
      { symbol: signal.symbol, accountId: conn.accountId, currency: linkedAccount.currency },
      "Non-USD account refused because stake minimum and sizing are defined in USD",
    );
    return;
  }
  const equity = Number(linkedAccount.equity);
  // Every stake is a percentage of this number, so a stale one sizes the trade
  // against money that may no longer be in the account. balance-sync refreshes
  // it every 60s, and backs off to a 5-minute retry while a connection is
  // erroring — so anything older than EQUITY_MAX_STALE_MS means the sync is
  // broken rather than merely slow, and guessing is worse than not trading.
  const syncAgeMs = conn.lastSyncAt ? Date.now() - conn.lastSyncAt.getTime() : Number.POSITIVE_INFINITY;
  if (syncAgeMs > EQUITY_MAX_STALE_MS) {
    const age = Number.isFinite(syncAgeMs) ? `${Math.round(syncAgeMs / 60_000)} min ago` : "never";
    const reason = `Account equity was last synced ${age}; refusing to size a trade against a stale balance`;
    await recordGeneratedReason(signal.id, reason);
    recordRejection({ symbol: signal.symbol, stage: "sizing", reason, metrics: { equity, syncAgeMin: Number.isFinite(syncAgeMs) ? Math.round(syncAgeMs / 60_000) : -1 } });
    logger.warn({ symbol: signal.symbol, equity, syncAgeMs, broker: conn.label }, reason);
    return;
  }
  const [openRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tradesTable)
    .where(and(eq(tradesTable.accountId, conn.accountId), eq(tradesTable.status, "open")));
  // Per-account position ceiling, enforced here where the account is known.
  // The portfolio gate at signal time can only see "open trades somewhere",
  // and signals now wait hours for their entry, so by the time one fills the
  // count it was approved against is stale. This bot is forex-only and every
  // pair is one asset class, so the ceiling is the lower of the two caps —
  // the same figure the Configuration page shows as "at once".
  {
    const ceiling = Math.min(maxConcurrentPositions, activeConfig.maxPerAssetClass);
    const openCount = openRow?.count ?? Number.NaN;
    if (!Number.isFinite(openCount) || openCount >= ceiling) {
      const reason = Number.isFinite(openCount)
        ? `${openCount} position(s) already open on this account; the ceiling is ${ceiling}`
        : "Could not count open positions on this account; refusing execution";
      await recordGeneratedReason(signal.id, reason);
      recordRejection({ symbol: signal.symbol, stage: "portfolio", reason, metrics: { openCount, ceiling } });
      return;
    }
  }
  // One position per pair, checked again here: the scan checks it when the
  // signal is created, but a held-back signal is retried for up to 30 minutes
  // and the replay pass can dispatch an older one, so the order itself must
  // not stack a second position on a pair that already has one.
  {
    const [samePair] = await db.select({ id: tradesTable.id }).from(tradesTable).where(and(
      eq(tradesTable.accountId, conn.accountId),
      eq(tradesTable.symbol, signal.symbol),
      eq(tradesTable.status, "open"),
    )).limit(1);
    if (samePair) {
      const reason = "A position on this pair is already open on this account; not stacking a second one";
      await transitionSignalExecution(signal.id, "generated", "rejected", reason, { signalStatus: "cancelled" });
      recordRejection({ symbol: signal.symbol, stage: "portfolio", reason });
      return;
    }
  }
  // Stake: the balance band's share of the balance, at least Deriv's $1.00
  // multiplier minimum, while that much is free. The synced equity is Deriv's
  // cash balance (stakes leave it when a contract opens), but it is synced
  // once a minute, so stakes opened since the last sync are taken off here.
  // No daily-loss stop: every majority vote trades until the free balance
  // runs out — the rule the $5 backtest was run with (CHANGES.md).
  let openedSinceSync = 0;
  try {
    const recent = await db.select({ lotSize: tradesTable.lotSize }).from(tradesTable).where(and(
      eq(tradesTable.accountId, conn.accountId),
      eq(tradesTable.status, "open"),
      conn.lastSyncAt ? gte(tradesTable.openedAt, conn.lastSyncAt) : sql`true`,
    ));
    for (const r of recent) { const v = Number(r.lotSize); if (Number.isFinite(v) && v > 0) openedSinceSync += v; }
  } catch (err) {
    const reason = "Could not read open trades to work out the free balance; refusing execution";
    await recordGeneratedReason(signal.id, reason);
    logger.error({ symbol: signal.symbol, accountId: conn.accountId, err }, reason);
    return;
  }
  const freeBalance = equity - openedSinceSync;
  const sized = pollStake({ equity, freeBalance, riskPerTradePct });
  if (!sized.ok) {
    await recordGeneratedReason(signal.id, `No trade: ${sized.reason}`);
    recordRejection({ symbol: signal.symbol, stage: "sizing", reason: sized.reason, metrics: { equity, freeBalance } });
    logger.info({ symbol: signal.symbol, equity, freeBalance, reason: sized.reason }, "Stake refused");
    return;
  }
  const stakeAmount = sized.stake;
  const forceBinary = false;
  logger.info(
    { symbol: signal.symbol, equity, freeBalance, stakeAmount, band: sized.band, riskPct: sized.riskPct, worstCaseLoss: worstCaseLoss(stakeAmount) },
    "Stake computed",
  );

  // ── Entry: only at a price close to the one the poll voted on ──
  //
  // A multiplier fills at market. The signal's entry band is a quarter of an
  // M30 ATR either side of the price at the scan; planEntry measures stop,
  // target and reward:risk from the live price and only enters inside that
  // band, so a price that has run away since the vote is not chased.
  const entryLowNum  = signal.entryLow  != null ? parseFloat(signal.entryLow)  : Number.NaN;
  const entryHighNum = signal.entryHigh != null ? parseFloat(signal.entryHigh) : Number.NaN;
  const stopNum      = signal.stopLevel    != null ? parseFloat(signal.stopLevel)    : Number.NaN;
  const targetNum    = signal.target1Level != null ? parseFloat(signal.target1Level) : Number.NaN;
  const direction = signal.direction === "sell" ? "sell" as const : "buy" as const;
  const minRiskReward = activeConfig.minRiskReward;

  const tick = getLastTick(signal.symbol);
  const tickAgeMs = tick ? Date.now() - tick.at : Number.POSITIVE_INFINITY;
  if (!tick || tickAgeMs > EXECUTION_TICK_MAX_AGE_MS) {
    await noteWaiting(signal, `No live price in the last ${EXECUTION_TICK_MAX_AGE_MS / 1000}s for ${signal.symbol}; an order is never placed against a stale quote`);
    return;
  }
  const livePrice = tick.price;
  const levels = { direction, price: livePrice, entryLow: entryLowNum, entryHigh: entryHighNum, stop: stopNum, target: targetNum, minRiskReward };

  // Phase 1, no network: is the setup still valid, and is the live price in
  // the zone with enough reward:risk?
  {
    const over = await invalidationSince(signal);
    if (over) {
      await cancelInvalidated(signal, over);
      return;
    }
    const first = planEntry(levels);
    if (first.action === "cancel") {
      await transitionSignalExecution(signal.id, "generated", "rejected", first.reason, { signalStatus: "cancelled" });
      recordRejection({ symbol: signal.symbol, stage: "entry", reason: first.reason });
      logger.info({ symbol: signal.symbol, signalId: signal.id, livePrice, reason: first.reason }, "Signal cancelled at entry");
      return;
    }
    if (first.action === "refuse") {
      // Unusable stored levels do not get better with time.
      await transitionSignalExecution(signal.id, "generated", "rejected", first.reason, { signalStatus: "cancelled" });
      recordRejection({ symbol: signal.symbol, stage: "entry", reason: first.reason });
      return;
    }
    if (first.action !== "enter") {
      await noteWaiting(signal, first.reason);
      return;
    }
  }

  // Phase 2: quote exactly this contract. Deriv's quote carries the real cost
  // and, for multipliers, its own stop-loss / take-profit limits.
  const quoted = await getContractQuote(token, wantEnv, signal.symbol, {
    stakeAmount, binary: forceBinary, direction, currency: linkedAccount.currency ?? undefined,
  });
  const quote = "error" in quoted ? null : quoted;
  const costGate = tradingCostGate(quote?.costPct ?? null, forex.maxSpreadCostPct);
  if (!costGate.ok) {
    // Deriv's own reason when it refused the quote (a multiplier it does not
    // offer on this pair, say) rather than a generic "could not read a price".
    const reason = "error" in quoted
      ? `${quoted.error}; no order is sent without a live quote`
      : costGate.reason ?? "Trading-cost gate refused dispatch";
    quoteBackoff.set(signal.id, Date.now() + QUOTE_BACKOFF_MS);
    await recordGeneratedReason(signal.id, reason);
    recordRejection({ symbol: signal.symbol, stage: "forex_readiness", reason, metrics: { costPct: quote?.costPct ?? null, costSource: quote?.costSource ?? null, stakeAmount, binary: forceBinary } });
    logger.warn({ symbol: signal.symbol, quote, stakeAmount, forceBinary }, reason);
    return;
  }

  const multiplier = getSyntheticSymbol(signal.symbol)?.multiplier ?? 100;
  // Deriv's own minimums when its quote states them; a minimum learned from an
  // earlier refusal can only raise them.
  const minStopUsd = Math.max(quote?.limits.stopLossMin ?? DEFAULT_MIN_LIMIT_ORDER_USD, learnedLimitMins.stopLossMin);
  const minTakeProfitUsd = Math.max(quote?.limits.takeProfitMin ?? DEFAULT_MIN_LIMIT_ORDER_USD, learnedLimitMins.takeProfitMin);
  // The stop is capped two ways: 80% of stake (exit before Deriv's stop-out)
  // and Deriv's own maximum.
  const capFraction = Math.min(
    MULTIPLIER_STOP_CAP_PCT,
    quote?.limits.stopLossMax != null ? quote.limits.stopLossMax / stakeAmount : Number.POSITIVE_INFINITY,
  );
  const plan = planEntry(forceBinary ? levels : {
    ...levels,
    bracket: {
      stake: stakeAmount, multiplier, minStopUsd, minTakeProfitUsd, maxStopFraction: capFraction,
      commissionUsd: quote?.commissionUsd != null && quote.commissionUsd > 0 ? quote.commissionUsd : 0,
    },
  });
  if (plan.action !== "enter") {
    if (plan.action === "cancel") {
      await transitionSignalExecution(signal.id, "generated", "rejected", plan.reason, { signalStatus: "cancelled" });
      recordRejection({ symbol: signal.symbol, stage: "entry", reason: plan.reason });
    } else {
      quoteBackoff.set(signal.id, Date.now() + QUOTE_BACKOFF_MS);
      await noteWaiting(signal, plan.reason);
    }
    return;
  }

  logger.info(
    {
      symbol: signal.symbol, direction, stakeAmount, broker: conn.label, livePrice,
      zone: [entryLowNum, entryHighNum], structuralStop: stopNum, structuralTarget: targetNum,
      executedStop: plan.stopPrice, executedTarget: plan.targetPrice, rrAtFill: plan.rr,
      stopLossUsd: plan.stopLossUsd, takeProfitUsd: plan.takeProfitUsd, stopWidened: plan.stopWidened,
      limitsFromDeriv: quote?.limits.stopLossMin != null, costPct: quote?.costPct, costSource: quote?.costSource,
    },
    "Dispatching trade to Deriv",
  );

  const [claim] = await db.update(signalsTable)
    .set({
      executionStatus: "awaiting_broker",
      executionReason: claimReason(stakeAmount, conn.id),
      contractId: null,
    })
    .where(and(
      eq(signalsTable.id, signal.id),
      eq(signalsTable.executionStatus, "generated"),
      eq(signalsTable.status, "active"),
      isNull(signalsTable.dispatchedAt),
      gte(signalsTable.expiresAt, new Date()),
    ))
    .returning({ id: signalsTable.id });
  if (!claim) {
    const [current] = await db.select({ executionStatus: signalsTable.executionStatus })
      .from(signalsTable).where(eq(signalsTable.id, signal.id)).limit(1);
    if (current?.executionStatus === "awaiting_broker" || current?.executionStatus === "ambiguous") {
      logger.warn("Execution state unresolved; the reconciler will resolve it against Deriv");
    }
    logger.info({ signalId: signal.id, symbol: signal.symbol }, "Signal could not be claimed for broker dispatch");
    return;
  }

  const result = await placeDerivTrade({
    token,
    environment: wantEnv,
    signalId: signal.id,
    symbol: signal.symbol,
    direction: signal.direction as "buy" | "sell",
    stakeAmount,
    currency: linkedAccount.currency,
    entryPrice: livePrice,
    stopPrice: plan.stopPrice,
    targetPrice: plan.targetPrice,
    stopLossUsd: plan.stopLossUsd,
    takeProfitUsd: plan.takeProfitUsd,
    forceBinary,
  });

  if (!result.ok) {
    if (result.ambiguous) {
      logger.warn("Execution state unresolved; the reconciler will resolve it against Deriv");
      const reason = result.message ?? "Deriv buy outcome is ambiguous";
      const transitioned = await transitionSignalExecution(
        signal.id,
        "awaiting_broker",
        "ambiguous",
        reason,
        { dispatchedAt: new Date() },
      );
      logger.error(
        { symbol: signal.symbol, signalId: signal.id, error: result.message, statePersisted: transitioned },
        "Deriv buy outcome is ambiguous; automatic replay blocked pending manual reconciliation",
      );
      return;
    }
    if (result.retryable) {
      const previousRetries = preBuyRetryCount(signal.executionReason);
      if (previousRetries < 2) {
        const reason = `Pre-buy retry ${previousRetries + 1}/2: ${result.message ?? "Transient broker failure before order submission"}`;
        const transitioned = await transitionSignalExecution(signal.id, "awaiting_broker", "generated", reason);
        if (!transitioned) logger.warn("Execution state unresolved; the reconciler will resolve it against Deriv");
        logger.warn(
          { symbol: signal.symbol, signalId: signal.id, retry: previousRetries + 1, error: result.message, statePersisted: transitioned },
          "Known pre-buy failure; signal returned to generated for bounded retry",
        );
      } else {
        const reason = `Pre-buy retry limit exhausted after 2 retries: ${result.message ?? "Transient broker failure"}`;
        const transitioned = await transitionSignalExecution(signal.id, "awaiting_broker", "rejected", reason, {
          dispatchedAt: new Date(),
          signalStatus: "cancelled",
        });
        if (!transitioned) logger.warn("Execution state unresolved; the reconciler will resolve it against Deriv");
        logger.warn({ symbol: signal.symbol, signalId: signal.id, error: result.message, statePersisted: transitioned }, "Pre-buy retry limit exhausted");
      }
      return;
    }
    const reason = result.message ?? "Deriv explicitly rejected the buy request";
    // A refusal of the stop-loss / take-profit amount opened nothing, and says
    // Deriv's minimum is higher than the one planned against. Raise it and put
    // the signal back so the next attempt plans a bracket Deriv will take —
    // or waits, if that bracket no longer clears reward:risk. Bounded: the
    // minimum only ever rises, so this cannot repeat on the same refusal.
    const learned = forceBinary ? null : learnLimitMins(result.message, minStopUsd, minTakeProfitUsd);
    if (learned) {
      const retryReason = `Deriv refused the bracket (${reason}); minimum raised to ${learned}, re-planning`;
      const transitioned = await transitionSignalExecution(signal.id, "awaiting_broker", "generated", retryReason);
      if (!transitioned) logger.warn("Execution state unresolved; the reconciler will resolve it against Deriv");
      recordRejection({ symbol: signal.symbol, stage: "entry", reason: retryReason, metrics: { stopLossUsd: plan.stopLossUsd, takeProfitUsd: plan.takeProfitUsd } });
      logger.warn({ symbol: signal.symbol, signalId: signal.id, error: result.message, learnedLimitMins, statePersisted: transitioned }, "Deriv refused the bracket; minimum learned");
      return;
    }
    const transitioned = await transitionSignalExecution(signal.id, "awaiting_broker", "rejected", reason, {
      dispatchedAt: new Date(),
      signalStatus: "cancelled",
    });
    if (!transitioned) logger.warn("Execution state unresolved; the reconciler will resolve it against Deriv");
    logger.warn({ symbol: signal.symbol, signalId: signal.id, error: result.message, statePersisted: transitioned }, "Deriv rejected execution; replay disabled");
    return;
  }

  logger.info(
    { symbol: signal.symbol, contractId: result.contractId, buyPrice: result.buyPrice },
    "Trade placed on Deriv successfully",
  );

  const executionPersisted = await transitionSignalExecution(
    signal.id,
    "awaiting_broker",
    "executed",
    null,
    { contractId: result.contractId!, dispatchedAt: new Date(), signalStatus: "executed" },
  );
  if (!executionPersisted) {
    logger.warn("Execution state unresolved; the reconciler will resolve it against Deriv");
    logger.error(
      { signalId: signal.id, contractId: result.contractId },
      "Deriv accepted contract but executed state was not persisted; manual reconciliation required",
    );
  }

  // Write to trades table — retry up to 3 times so a transient DB hiccup
  // doesn't silently lose the record of a confirmed Deriv trade
  const accountId = conn.accountId;
  const tradePayload = {
    signalId: signal.id,
    accountId,
    symbol: signal.symbol,
    direction: signal.direction,
    // The underlying price the order was placed against. This used to be the
    // contract's buy price — the stake — which read as an open price of 1.00
    // on every pair and left the trade review unable to classify anything.
    openPrice: String(livePrice),
    lotSize: String(stakeAmount),
    // The levels the broker will actually act on, which differ from the
    // structural ones only when Deriv's minimum stop widened the stop.
    stopLoss: String(plan.stopPrice),
    takeProfit: String(plan.targetPrice),
    status: "open" as const,
    strategy: signal.strategy,
    reasonChain: signal.reasoning ?? "Strategy poll signal",
    annotations: JSON.stringify({
      contractId: result.contractId,
      contractType: result.contractType,
      confidence: signal.confidence,
      entryLow: signal.entryLow,
      entryHigh: signal.entryHigh,
      openPriceSource: "reference_spot",
      structuralStop: signal.stopLevel,
      structuralTarget: signal.target1Level,
      rrAtFill: Number(plan.rr.toFixed(3)),
      stopLossUsd: plan.stopLossUsd,
      takeProfitUsd: plan.takeProfitUsd,
      stopWidened: plan.stopWidened,
      costPct: quote?.costPct ?? null,
      costSource: quote?.costSource ?? null,
      commissionUsd: quote?.commissionUsd ?? null,
      derivLimits: quote?.limits ?? null,
    }),
  };

  let tradeWritten = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const [existingTrade] = await db.select({ id: tradesTable.id })
        .from(tradesTable)
        .where(eq(tradesTable.signalId, signal.id))
        .limit(1);
      if (existingTrade) {
        tradeWritten = true;
        break;
      }
      await db.insert(tradesTable).values(tradePayload);
      tradeWritten = true;
      break;
    } catch (dbErr) {
      logger.warn(
        { symbol: signal.symbol, contractId: result.contractId, attempt, err: dbErr },
        "Trade DB write failed — retrying",
      );
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  if (!tradeWritten) {
    logger.warn("Execution state unresolved; the reconciler will resolve it against Deriv");
    logger.error(
      { symbol: signal.symbol, contractId: result.contractId, stakeAmount },
      "Trade placed on Deriv but could NOT be written to DB after 3 attempts — manual reconciliation needed",
    );
  }

}

// ── Worker tick ──────────────────────────────────────────────────────────────

type BotConfigRow = typeof botConfigTable.$inferSelect;

/**
 * Load the saved configuration into the module state the dispatcher reads.
 * Both the 30-minute scan and the entry watcher call this, so a change of
 * mode takes effect within one watcher interval — including switching
 * trading off, which must never wait for the next scan.
 */
function applyConfig(config: BotConfigRow): void {
  // Cache for getWorkerStatus() so the status endpoint always reflects current config
  cachedEnabled = config.enabled;
  cachedAutotradeMode = config.autotradeMode;
  activeMode = config.enabled && (config.autotradeMode === "auto_demo" || config.autotradeMode === "auto_live")
    ? config.autotradeMode
    : null;
  // An unreadable agreement threshold falls back to simple majority (0.5);
  // tallyPoll clamps it as well, so NaN can never mean "trade anything".
  const parsedMinConfidence = parseFloat(config.minConfidence);
  const parsedMinRr = parseFloat(config.minRiskReward);
  activeConfig = {
    smallAccountMaxRiskPct: parseFloat(config.smallAccountMaxRiskPct),
    minConfidence: Number.isFinite(parsedMinConfidence) ? parsedMinConfidence : 0.5,
    // Same reasoning: an unreadable floor must not quietly become "no floor".
    minRiskReward: Number.isFinite(parsedMinRr) && parsedMinRr > 0 ? parsedMinRr : 1.5,
    maxPerAssetClass: Number.isFinite(config.maxPerAssetClass) && config.maxPerAssetClass > 0 ? config.maxPerAssetClass : 14,
  };
}

function forexParamsFrom(config: BotConfigRow): ForexDispatchParams {
  return {
    killzones: config.killzones,
    newsBlackoutBeforeMin: config.newsBlackoutBeforeMin,
    newsBlackoutAfterMin: config.newsBlackoutAfterMin,
    maxSpreadCostPct: parseFloat(config.maxSpreadCostPct),
    lastEntryWeekday: config.lastEntryWeekday,
    cotVeto: config.cotVeto,
  };
}

function signalRowFrom(p: typeof signalsTable.$inferSelect): SignalRow {
  return {
    id: p.id,
    symbol: p.symbol,
    direction: p.direction,
    confidence: p.confidence,
    strategy: p.strategy,
    reasoning: p.reasoning,
    stopLevel: p.stopLevel,
    target1Level: p.target1Level,
    entryLow: p.entryLow,
    entryHigh: p.entryHigh,
    expiresAt: p.expiresAt,
    executionStatus: p.executionStatus,
    executionReason: p.executionReason,
    createdAt: p.createdAt,
  };
}

// ── Entry watcher ────────────────────────────────────────────────────────────
//
// A poll signal is normally traded right after the scan. When its order is
// held back (no fresh tick yet, a quote refused, the dispatch queue busy) it
// stays valid until the next scan, and this watcher retries it against the
// live tick every few seconds. Only a signal whose price is in its entry band,
// or whose levels are already broken, is handed to the dispatcher, which
// re-runs every check before anything is sent.

const ENTRY_WATCH_MS = 15_000;
let entryWatchHandle: ReturnType<typeof setInterval> | null = null;
let entryWatchRunning = false;

async function runEntryWatch(): Promise<void> {
  // The scan runs its own replay pass over the same signals.
  if (entryWatchRunning || workerRunning) return;
  entryWatchRunning = true;
  try {
    const [config] = await db.select().from(botConfigTable).where(eq(botConfigTable.id, 1));
    if (!config) return;
    applyConfig(config);
    if (!activeMode) return;

    const now = new Date();
    const pending = await db.select().from(signalsTable).where(and(
      eq(signalsTable.status, "active"),
      eq(signalsTable.executionStatus, "generated"),
      isNull(signalsTable.dispatchedAt),
      gte(signalsTable.expiresAt, now),
    ));
    if (pending.length === 0) return;

    const forexParams = forexParamsFrom(config);
    // Expired signals are never looked at again; drop their stale entries.
    for (const [id, until] of quoteBackoff) if (Date.now() >= until) quoteBackoff.delete(id);
    for (const p of pending) {
      // Cancel a setup that is over here, ahead of every account-level gate.
      // Left to the dispatcher, a buy whose stop was taken at 03:00 — outside
      // the killzone, so the dispatch stopped at that gate — stayed pending,
      // and was entered when price came back into the zone at the London open.
      const row = signalRowFrom(p);
      const over = await invalidationSince(row).catch((err) => {
        logger.warn({ symbol: p.symbol, signalId: p.id, err: err instanceof Error ? err.message : String(err) }, "Entry watcher could not read price history");
        return null;
      });
      if (over) {
        await cancelInvalidated(row, over);
        continue;
      }
      const tick = getLastTick(p.symbol);
      if (!tick || Date.now() - tick.at > EXECUTION_TICK_MAX_AGE_MS) continue;
      const num = (v: string | null) => (v == null ? Number.NaN : parseFloat(v));
      const state = entryZoneState(
        p.direction === "sell" ? "sell" : "buy", tick.price,
        num(p.entryLow), num(p.entryHigh), num(p.stopLevel), num(p.target1Level),
      );
      if (state === "wait") continue;
      if (quoteBackoffActive(p.id)) continue;
      // One attempt per signal per minute at most. A signal in its zone can
      // still be refused for account-level reasons that hold for hours (today's
      // loss budget spent, outside the killzone), and each attempt is a handful
      // of queries. A qualifying entry goes out on the first attempt anyway.
      if (!quoteBackoff.has(p.id)) quoteBackoff.set(p.id, Date.now() + WATCH_ATTEMPT_SPACING_MS);
      await dispatchTrade(
        row,
        parseFloat(config.riskPerTradePct),
        config.maxConcurrentPositions,
        forexParams,
      ).catch((err) => {
        logger.error({ symbol: p.symbol, signalId: p.id, err: err instanceof Error ? err.message : String(err) }, "Entry watcher dispatch failed");
      });
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Entry watcher cycle failed");
  } finally {
    entryWatchRunning = false;
  }
}

/**
 * A signal that is in its zone but still cannot be entered after Deriv's quote
 * (its minimum stop, say) would otherwise be re-quoted every watcher cycle for
 * as long as price sits there — a Deriv session every fifteen seconds. Hold it
 * off for a couple of minutes instead; price has usually moved by then.
 */
const QUOTE_BACKOFF_MS = 2 * 60_000;
const WATCH_ATTEMPT_SPACING_MS = 60_000;

/**
 * Stop-loss / take-profit minimums learned from Deriv refusing an order, for
 * when its quote does not state them. Process-lifetime only: after a restart
 * the first refusal teaches it again, at the cost of one order that was never
 * opened.
 */
const learnedLimitMins = { stopLossMin: 0, takeProfitMin: 0 };

/** Raise the learned minimums from a refusal; returns what changed, or null if nothing did. */
function learnLimitMins(message: string | undefined, usedStopMin: number, usedTakeProfitMin: number): string | null {
  const parsed = parseDerivLimitRejection(message);
  if (!parsed) return null;
  const changes: string[] = [];
  if (parsed.stopLossMin != null && parsed.stopLossMin > usedStopMin + 1e-9) {
    learnedLimitMins.stopLossMin = Math.max(learnedLimitMins.stopLossMin, parsed.stopLossMin);
    changes.push(`stop-loss $${learnedLimitMins.stopLossMin.toFixed(2)}`);
  }
  if (parsed.takeProfitMin != null && parsed.takeProfitMin > usedTakeProfitMin + 1e-9) {
    learnedLimitMins.takeProfitMin = Math.max(learnedLimitMins.takeProfitMin, parsed.takeProfitMin);
    changes.push(`take-profit $${learnedLimitMins.takeProfitMin.toFixed(2)}`);
  }
  return changes.length > 0 ? changes.join(", ") : null;
}
const quoteBackoff = new Map<number, number>();
function quoteBackoffActive(signalId: number): boolean {
  const until = quoteBackoff.get(signalId);
  if (until == null) return false;
  if (Date.now() >= until) { quoteBackoff.delete(signalId); return false; }
  return true;
}

async function runWorkerTick(): Promise<void> {
  if (workerRunning) return; // prevent overlap
  workerRunning = true;
  lastError = null;

  try {
    // Load bot config
    const [config] = await db.select().from(botConfigTable).where(eq(botConfigTable.id, 1));
    if (config) applyConfig(config);
    if (!config?.enabled) {
      logger.info("Signal worker: bot disabled, skipping tick");
      return;
    }
    const forexParams = forexParamsFrom(config);
    const lock = await getExecutionLock();
    lastLock = lock;
    if (lock.locked) logger.warn({ reason: lock.reason }, "Execution locked: new autonomous orders wait for the reconciler");

    // Sanitised by applyConfig (falls back to 0.70 when the stored value is unreadable).
    const minConfidence = activeConfig.minConfidence;
    const requestedInstruments = config.allowedInstruments
      ? config.allowedInstruments
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => getSyntheticSymbol(s)?.code ?? s)
      : DEFAULT_INSTRUMENTS;
    let instruments = requestedInstruments.filter((symbol) => {
      if (isForexCode(symbol)) return true;
      logger.warn({ symbol }, "Configured non-forex instrument skipped: only forex is traded and analyzed");
      return false;
    });
    if (instruments.length === 0) {
      logger.warn({ requestedInstruments }, "Configured allow-list had no forex symbols; falling back to all forex majors");
      instruments = DEFAULT_INSTRUMENTS;
    }
    const newsEvents = await getNewsEvents();
    const scanTime = new Date();

    logger.info(
      { instruments, strategies: STRATEGIES.length, agreement: minConfidence, autotradeMode: config.autotradeMode, enabled: config.enabled },
      "Signal worker tick"
    );

    // Closed candles of every timeframe the poll uses, for every pair, read
    // once: the cross-pair strategies (currency strength, cross-sectional
    // momentum) need all pairs.
    const scanNow = Date.now();
    const history: Record<PollTimeframe, Map<string, Bars>> = { M30: new Map(), H1: new Map(), H4: new Map() };
    for (const tf of POLL_TIMEFRAMES) {
      for (const sym of ALL_FOREX_INSTRUMENTS) {
        const rows = await db
          .select({ t: candlesTable.openTime, o: candlesTable.open, h: candlesTable.high, l: candlesTable.low, c: candlesTable.close })
          .from(candlesTable)
          .where(and(eq(candlesTable.symbol, sym), eq(candlesTable.timeframe, tf)))
          .orderBy(desc(candlesTable.openTime))
          .limit(POLL_HISTORY_BARS[tf]);
        history[tf].set(sym, pollBars(rows.filter((r) => isClosedCandle(r.t.getTime(), tf, scanNow)).reverse(), tf));
      }
    }

    // ── Replay pass: dispatch any active signals that were never traded ──
    // (Catches signals created before the dispatcher was wired up, or ticks
    //  where dispatch was skipped because the broker wasn't connected yet.)
    if (activeMode && !lock.locked) {
      const replayAt = new Date();
      await db
        .update(signalsTable)
        .set({ status: "expired" })
        .where(and(
          eq(signalsTable.status, "active"),
          eq(signalsTable.executionStatus, "generated"),
          isNull(signalsTable.dispatchedAt),
          lte(signalsTable.expiresAt, replayAt),
        ));
      const pending = await db
        .select()
        .from(signalsTable)
        .where(and(
          eq(signalsTable.status, "active"),
          eq(signalsTable.executionStatus, "generated"),
          isNull(signalsTable.dispatchedAt),
          gte(signalsTable.expiresAt, replayAt),
        ));
      logger.info({ pendingCount: pending.length }, "Replay pass: pending signals to dispatch");
      for (const p of pending) {
        await dispatchTrade(
          signalRowFrom(p),
          parseFloat(config.riskPerTradePct),
          config.maxConcurrentPositions,
          forexParams,
        ).catch((err) => {
          logger.error({ symbol: p.symbol, err }, "Replay dispatch error");
        });
      }
    }

    // Cooldown: at most one poll signal per pair per hour, so a pair whose
    // order Deriv just refused is not re-polled and re-refused every scan.
    const COOLDOWN_MIN = 60;
    const cooldownCutoff = new Date(Date.now() - COOLDOWN_MIN * 60 * 1000);

    // Accounts this mode actually trades on (all accounts when signals-only).
    const tradedAccountIds: number[] = activeMode
      ? (await db.select({ accountId: brokerConnectionsTable.accountId }).from(brokerConnectionsTable).where(and(
          eq(brokerConnectionsTable.enabled, true),
          eq(brokerConnectionsTable.environment, activeMode === "auto_live" ? "real" : "demo"),
        ))).map((r) => r.accountId).filter((id): id is number => id != null)
      : [];

    let generated = 0;
    for (const symbol of instruments) {
      // Skip if a recent active signal exists (cooldown), OR if a signal was
      // permanently cancelled within the cooldown window — this prevents
      // hammering Deriv every 5 minutes with symbols it has already rejected.
      const existing = await db
        .select()
        .from(signalsTable)
        .where(
          and(
            eq(signalsTable.symbol, symbol),
            gte(signalsTable.createdAt, cooldownCutoff),
          ),
        )
        .limit(1);

      if (existing.length > 0) continue;

      const preScan = forexPreScanGate({
        symbol,
        now: scanTime,
        killzones: config.killzones,
        newsEvents,
        newsBlackoutBeforeMin: config.newsBlackoutBeforeMin,
        newsBlackoutAfterMin: config.newsBlackoutAfterMin,
        lastEntryWeekday: config.lastEntryWeekday,
      });
      if (!preScan.ok) {
        recordRejection({ symbol, stage: "forex_readiness", reason: preScan.reason ?? "Forex readiness gate failed" });
        logger.info({ symbol, reason: preScan.reason }, "Signal worker: forex readiness gate skipped this symbol");
        continue;
      }

      // Ensure the symbol is subscribed so there is a live price to anchor the
      // entry, stop and target to.
      const { getLastTick, ensureSymbolSubscribed, symbolRejectionReason, getCandleFeederStatus } = await import("./candle-feeder.js");
      // A pair Deriv itself refuses will never produce a tick, so say that
      // instead of blaming the feed and re-checking it every thirty minutes.
      const refused = symbolRejectionReason(symbol);
      if (refused) {
        recordRejection({ symbol, stage: "no_tick", reason: `Deriv does not offer this symbol on this account (${refused}); it is not scanned` });
        continue;
      }
      ensureSymbolSubscribed(symbol);
      const lastTick = getLastTick(symbol);

      // Skip analysis if the tick is stale (>5 min old) or missing — without a
      // current price there is nothing to anchor entry/stop/target against.
      const tickAgeMs = lastTick ? Date.now() - lastTick.at : Infinity;
      if (!lastTick || tickAgeMs > 5 * 60 * 1000) {
        // Blaming the feed when the feed is plainly connected sent every
        // investigation down the wrong path. Report what is actually true.
        const feedConnected = getCandleFeederStatus().connected;
        const reason = lastTick
          ? `No fresh price tick: last one is ${Math.round(tickAgeMs / 1000)}s old${feedConnected ? " while the feed is connected — the market for this pair is quiet or closed" : " and the candle feed is disconnected"}`
          : feedConnected
            ? "Subscribed to this pair but no tick has arrived yet — it is thinly traded, or the market is closed. It will be analysed as soon as one does."
            : "No price tick received yet and the candle feed is disconnected";
        logger.info({ symbol, tickAgeMs, feedConnected }, "Signal worker: no fresh tick yet — skipping this symbol this cycle");
        recordRejection({ symbol, stage: "no_tick", reason });
        continue;
      }

      // One position per pair: a new poll on a pair already in a trade would
      // only stack the same bet, and the open one runs to its own exit.
      const [alreadyOpen] = await db.select({ id: tradesTable.id }).from(tradesTable).where(and(
        eq(tradesTable.symbol, symbol),
        eq(tradesTable.status, "open"),
        tradedAccountIds.length > 0 ? inArray(tradesTable.accountId, tradedAccountIds) : sql`true`,
      )).limit(1);
      if (alreadyOpen) {
        recordRejection({ symbol, stage: "portfolio", reason: "A position on this pair is already open; it runs to its stop, target or the hold limit first" });
        continue;
      }

      // Each timeframe's newest stored candle must be the one that most
      // recently closed, or part of the vote would be about an older market.
      const pollInput: PollInput = { symbol, bars: { M30: EMPTY_BARS, H1: EMPTY_BARS, H4: EMPTY_BARS }, closes: { M30: {}, H1: {}, H4: {} } };
      let stale: string | null = null;
      for (const tf of POLL_TIMEFRAMES) {
        const bars = history[tf].get(symbol) ?? EMPTY_BARS;
        const len = POLL_TIMEFRAME_MS[tf];
        const lastClosedOpen = Math.floor(scanNow / len) * len - len;
        if (bars.t.length === 0 || bars.t[bars.t.length - 1]! < lastClosedOpen) { stale = tf; break; }
        pollInput.bars[tf] = bars;
        pollInput.closes[tf] = alignCloses(bars, history[tf]);
      }
      if (stale) {
        recordRejection({ symbol, stage: "poll", reason: `The ${stale} candle that just closed has not been stored yet; polling at the next close` });
        continue;
      }
      const poll = runPoll(pollInput, minConfidence);
      if (!poll.direction) {
        logger.info({ symbol, buy: poll.buy, sell: poll.sell, abstain: poll.abstain }, "Poll: no decision");
        recordRejection({ symbol, stage: "poll", reason: poll.reason });
        continue;
      }
      const agreeing = poll.ballots.filter((b) => b.vote === (poll.direction === "buy" ? 1 : -1)).map((b) => b.name);
      const opposing = poll.ballots.filter((b) => b.vote === (poll.direction === "buy" ? -1 : 1)).map((b) => b.name);
      const lv = pollLevels(poll.direction, lastTick.price, poll.atr, activeConfig.minRiskReward);
      const digits = lastTick.price >= 20 ? 3 : 5;
      const result = {
        direction: poll.direction,
        confidence: Number(poll.share.toFixed(3)),
        entryLow: lv.entryLow, entryHigh: lv.entryHigh, stopLevel: lv.stop, target1Level: lv.target,
        entryZone: `${lv.entryLow.toFixed(digits)}–${lv.entryHigh.toFixed(digits)} (market)`,
        stopZone: lv.stop.toFixed(digits),
        targetZone: lv.target.toFixed(digits),
        concepts: agreeing.join(", "),
        reasoning: `${poll.reason}. Agreeing: ${agreeing.join(", ")}.${opposing.length ? ` Against: ${opposing.join(", ")}.` : ""} Stop ${(POLL_STOP_FRACTION * 100).toFixed(1)}% from entry, target ${activeConfig.minRiskReward}x the stop after commission, closed after ${config.maxPositionHoldHours}h (or before Deriv's Friday close) if neither is reached.`,
      };

      // Only positions on the accounts this mode actually trades count: an old
      // open demo position must not use up a live account's allowance.
      const openNow = await db.select({ symbol: tradesTable.symbol, direction: tradesTable.direction })
        .from(tradesTable).where(and(
          eq(tradesTable.status, "open"),
          tradedAccountIds.length > 0 ? inArray(tradesTable.accountId, tradedAccountIds) : sql`true`,
        ));
      const pf = portfolioGate(
        openNow.map((o) => ({ symbol: o.symbol, direction: o.direction === "sell" ? "sell" as const : "buy" as const, group: getSyntheticSymbol(o.symbol)?.group })),
        { symbol, direction: result.direction, group: getSyntheticSymbol(symbol)?.group },
        activeConfig.maxPerAssetClass,
      );
      if (!pf.ok) {
        recordRejection({ symbol, stage: "portfolio", reason: pf.reason ?? "portfolio cap", metrics: pf.metrics });
        continue;
      }
      // ────────────────────────────────────────────────────────────────────────

      const expiresAt = new Date(Date.now() + POLL_SIGNAL_TTL_MS);

      const [inserted] = await db
        .insert(signalsTable)
        .values({
          symbol,
          direction: result.direction,
          confidence: String(result.confidence),
          strategy: POLL_STRATEGY_NAME,
          concepts: result.concepts,
          entryZone: result.entryZone,
          targetZone: result.targetZone,
          stopZone: result.stopZone,
          entryLow: String(result.entryLow),
          entryHigh: String(result.entryHigh),
          stopLevel: String(result.stopLevel),
          target1Level: String(result.target1Level),
          target2Level: null,
          levels: null,
          reasoning: result.reasoning,
          status: "active",
          executionStatus: "generated",
          executionReason: lock.locked ? LOCK_MSG : null,
          expiresAt,
        })
        .returning({ id: signalsTable.id });

      signalsGeneratedTotal++;
      generated++;
      logger.info({ symbol, signalId: inserted?.id, direction: result.direction, confidence: result.confidence }, "Signal generated");

      // A newer poll replaces an older signal on the same pair still waiting
      // for its order, so one pair never holds two pending orders. Only
      // signals that never reached the broker are touched.
      if (inserted?.id != null) {
        const superseded = await db.update(signalsTable)
          .set({ status: "cancelled", executionStatus: "rejected", executionReason: `Superseded by signal ${inserted.id} on the same pair` })
          .where(and(
            eq(signalsTable.symbol, symbol),
            ne(signalsTable.id, inserted.id),
            eq(signalsTable.status, "active"),
            eq(signalsTable.executionStatus, "generated"),
            isNull(signalsTable.dispatchedAt),
          ))
          .returning({ id: signalsTable.id });
        if (superseded.length > 0) {
          logger.info({ symbol, newSignalId: inserted.id, superseded: superseded.map((r) => r.id) }, "Older pending signals superseded");
        }
      }

      // Auto-execute trade if bot is in auto mode and a connected broker exists
      if (activeMode) {
        const signalRow: SignalRow = {
          id: inserted?.id,
          symbol,
          direction: result.direction,
          confidence: String(result.confidence),
          strategy: POLL_STRATEGY_NAME,
          reasoning: result.reasoning,
          stopLevel: String(result.stopLevel),
          target1Level: String(result.target1Level),
          entryLow: String(result.entryLow),
          entryHigh: String(result.entryHigh),
          expiresAt,
          executionStatus: "generated",
          executionReason: lock.locked ? LOCK_MSG : null,
        };
        dispatchTrade(
          signalRow,
          parseFloat(config.riskPerTradePct),
          config.maxConcurrentPositions,
          forexParams,
        ).catch((err) => {
          logger.error({ symbol, err }, "Trade dispatch error");
        });
      }
    }

    lastRunAt = new Date();
    logger.info({ generated }, "Signal worker tick complete");
  } catch (err: unknown) {
    lastError = err instanceof Error ? err.message : String(err);
    logger.error({ err: lastError }, "Signal worker tick error");
  } finally {
    workerRunning = false;
  }
}

// ── Start/stop ───────────────────────────────────────────────────────────────



export function startSignalWorker(): void {
  if (intervalHandle) return;
  logger.info({ intervalMs: SIGNAL_INTERVAL_MS }, "Starting signal worker");
  // Once shortly after boot, then just after every M30 close (:00:20, :30:20 UTC).
  setTimeout(() => runWorkerTick(), 10_000);
  const scheduleNext = () => {
    const at = nextAlignedScanAt(Date.now(), SIGNAL_INTERVAL_MS, SCAN_OFFSET_MS);
    nextScanAt = new Date(at);
    intervalHandle = setTimeout(() => {
      void Promise.resolve(runWorkerTick()).finally(() => { if (intervalHandle) scheduleNext(); });
    }, at - Date.now());
  };
  scheduleNext();
  entryWatchHandle ??= setInterval(() => { void runEntryWatch(); }, ENTRY_WATCH_MS);
}

export function stopSignalWorker(): void {
  if (intervalHandle) {
    clearTimeout(intervalHandle);
    intervalHandle = null;
    nextScanAt = null;
  }
  if (entryWatchHandle) {
    clearInterval(entryWatchHandle);
    entryWatchHandle = null;
  }
}

export { runWorkerTick };
