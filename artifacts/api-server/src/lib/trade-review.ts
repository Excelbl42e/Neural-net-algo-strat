import { and, asc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import {
  db,
  candlesTable,
  tradePerformanceTable,
  tradeReviewsTable,
  tradesTable,
  type Trade,
} from "@workspace/db";
import { STRATEGIES } from "./poll-strategies.js";

/**
 * The strategies that voted for the trade, read from the signal's reasoning
 * ("... Agreeing: A, B, C. Against: ..."), so each one's record reflects the
 * trades it actually supported. Trades from before the poll credit none.
 */
function claimedConcepts(trade: Trade): string[] {
  const m = /Agreeing: (.*?)\.(?: Against:| Stop )/.exec(trade.reasonChain ?? "");
  if (!m) return [];
  const listed = new Set(m[1]!.split(", "));
  return STRATEGIES.filter((s) => listed.has(s.name)).map((s) => s.name);
}

function outcomeFor(pnl: number | null): "win" | "loss" | "breakeven" | "unknown" {
  if (pnl == null || !Number.isFinite(pnl)) return "unknown";
  if (pnl > 0) return "win";
  if (pnl < 0) return "loss";
  return "breakeven";
}

function hasBrokerContractId(annotations: string | null): boolean {
  if (!annotations) return false;
  try {
    const parsed: unknown = JSON.parse(annotations);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const contractId = (parsed as Record<string, unknown>).contractId;
    return (typeof contractId === "number" && Number.isFinite(contractId))
      || (typeof contractId === "string" && contractId.trim().length > 0);
  } catch {
    // Free-form/manual annotations are not evidence of a broker contract.
    return false;
  }
}

/**
 * Broker trades placed by the current dispatcher store the underlying price the
 * order was placed against, marked `openPriceSource: "reference_spot"`. Older
 * broker trades stored the contract's purchase cost — the stake — in the same
 * column, which is not a price at all, so those still cannot be classified.
 */
function hasReferenceSpot(annotations: string | null): boolean {
  if (!annotations) return false;
  try {
    const parsed = JSON.parse(annotations) as Record<string, unknown> | null;
    return parsed != null && parsed.openPriceSource === "reference_spot";
  } catch {
    return false;
  }
}

function classify(
  trade: Trade,
  candles: Array<{ high: string; low: string; close: string }>,
  outcome: ReturnType<typeof outcomeFor>,
): { classification: string; evidenceStatus: "sufficient" | "insufficient"; evidenceSummary: string } {
  if (hasBrokerContractId(trade.annotations) && !hasReferenceSpot(trade.annotations)) {
    return {
      classification: "insufficient_evidence",
      evidenceStatus: "insufficient",
      evidenceSummary: `${candles.length} candles were available, but this trade has a broker contract ID and its stored open price is the contract purchase cost, not a verified underlying fill price. No stop, target, or directional causal classification was made.`,
    };
  }

  if (candles.length === 0) {
    return {
      classification: "insufficient_evidence",
      evidenceStatus: "insufficient",
      evidenceSummary: "No persisted candles were available for this symbol during the trade; no causal classification was made.",
    };
  }

  const entry = Number(trade.openPrice);
  const stop = trade.stopLoss == null ? null : Number(trade.stopLoss);
  const target = trade.takeProfit == null ? null : Number(trade.takeProfit);
  if (!Number.isFinite(entry)) {
    return {
      classification: "insufficient_evidence",
      evidenceStatus: "insufficient",
      evidenceSummary: `${candles.length} candles were available, but the stored entry price is not numeric.`,
    };
  }

  const buy = trade.direction.toLowerCase() === "buy";
  const stopIndex = stop == null ? -1 : candles.findIndex((c) => buy ? Number(c.low) <= stop : Number(c.high) >= stop);
  const targetIndex = target == null ? -1 : candles.findIndex((c) => buy ? Number(c.high) >= target : Number(c.low) <= target);
  if (stopIndex >= 0 && targetIndex >= 0 && stopIndex === targetIndex) {
    return {
      classification: "ambiguous_candle_path",
      evidenceStatus: "insufficient",
      evidenceSummary: `${candles.length} candles were available; stop and target were both inside the same OHLC candle, so their order cannot be established.`,
    };
  }
  if (stopIndex >= 0 && (targetIndex < 0 || stopIndex < targetIndex)) {
    return {
      classification: "stop_level_crossed_before_target",
      evidenceStatus: "sufficient",
      evidenceSummary: `A stored OHLC candle crossed the configured stop price before any candle crossed the target (${candles.length} candles examined); this is candle evidence, not proof that the broker executed a stop.`,
    };
  }
  if (targetIndex >= 0 && (stopIndex < 0 || targetIndex < stopIndex)) {
    return {
      classification: "target_reached",
      evidenceStatus: "sufficient",
      evidenceSummary: `A stored OHLC candle reached the configured target before the stop (${candles.length} candles examined).`,
    };
  }

  const maxFavorable = Math.max(...candles.map((c) => buy
    ? Number(c.high) - entry
    : entry - Number(c.low)));
  const maxAdverse = Math.max(...candles.map((c) => buy
    ? entry - Number(c.low)
    : Number(c.high) - entry));
  const favorable = Math.max(0, maxFavorable);
  const adverse = Math.max(0, maxAdverse);
  if (outcome === "loss" && adverse > favorable && favorable <= entry * 0.000001) {
    return {
      classification: "wrong_direction",
      evidenceStatus: "sufficient",
      evidenceSummary: `Price moved against the position without measurable favorable excursion in the available ${candles.length} candles.`,
    };
  }
  if (outcome === "loss" && target != null && Math.abs(target - entry) > 0) {
    const targetDistance = Math.abs(target - entry);
    if (favorable < targetDistance * 0.5) {
      return {
        classification: "target_too_far",
        evidenceStatus: "sufficient",
        evidenceSummary: `The trade lost and favorable excursion reached less than half the configured target distance across ${candles.length} candles.`,
      };
    }
  }
  return {
    classification: "unclassified",
    evidenceStatus: "insufficient",
    evidenceSummary: `${candles.length} candles were available, but they do not establish a stop-before-target, target-before-stop, or clear direction failure.`,
  };
}

async function recordPerformance(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  dimension: "concept" | "symbol",
  key: string,
  outcome: "win" | "loss" | "breakeven",
  pnl: number,
  at: Date,
): Promise<void> {
  const won = outcome === "win";
  const lost = outcome === "loss";
  const decay = sql`power(0.5, greatest(0, extract(epoch from (${at}::timestamptz - coalesce(${tradePerformanceTable.lastOutcomeAt}, ${at}::timestamptz))) / 2592000.0))`;
  const eventWeight = sql`power(0.5, greatest(0, extract(epoch from (coalesce(${tradePerformanceTable.lastOutcomeAt}, ${at}::timestamptz) - ${at}::timestamptz)) / 2592000.0))`;
  await tx.insert(tradePerformanceTable).values({
    dimension,
    key,
    tradeCount: 1,
    winCount: won ? 1 : 0,
    lossCount: lost ? 1 : 0,
    totalPnl: String(pnl),
    weightedTrades: "1",
    weightedWins: won ? "1" : "0",
    lastOutcomeAt: at,
    updatedAt: at,
  }).onConflictDoUpdate({
    target: [tradePerformanceTable.dimension, tradePerformanceTable.key],
    set: {
      tradeCount: sql`${tradePerformanceTable.tradeCount} + 1`,
      winCount: sql`${tradePerformanceTable.winCount} + ${won ? 1 : 0}`,
      lossCount: sql`${tradePerformanceTable.lossCount} + ${lost ? 1 : 0}`,
      totalPnl: sql`${tradePerformanceTable.totalPnl} + ${pnl}`,
      // 30-day half-life: retain recent evidence more strongly without
      // discarding the auditable lifetime totals above.
      weightedTrades: sql`(${tradePerformanceTable.weightedTrades} * ${decay}) + ${eventWeight}`,
      weightedWins: sql`(${tradePerformanceTable.weightedWins} * ${decay}) + (${eventWeight} * ${won ? 1 : 0})`,
      lastOutcomeAt: sql`greatest(coalesce(${tradePerformanceTable.lastOutcomeAt}, ${at}::timestamptz), ${at}::timestamptz)`,
      updatedAt: at,
    },
  });
}

/**
 * Backfills structured reviews for any closed trades not yet reviewed.
 * Unique trade_id plus transactionally inserting the review and metrics makes
 * this safe to call after settlement and repeatedly after service restarts.
 */
export async function reviewClosedTrade(trade: Trade): Promise<boolean> {
  if (trade.status !== "closed") return false;
  const [existingReview] = await db.select({ id: tradeReviewsTable.id }).from(tradeReviewsTable)
    .where(eq(tradeReviewsTable.tradeId, trade.id)).limit(1);
  if (existingReview) return false;
  const from = trade.openedAt;
  const to = trade.closedAt ?? trade.updatedAt;
  const candles = await db.select({
    high: candlesTable.high,
    low: candlesTable.low,
    close: candlesTable.close,
  }).from(candlesTable).where(and(
    eq(candlesTable.symbol, trade.symbol),
    gte(candlesTable.openTime, from),
    lte(candlesTable.openTime, to),
  )).orderBy(asc(candlesTable.openTime));
  const pnl = trade.pnl == null ? null : Number(trade.pnl);
  const outcome = outcomeFor(pnl);
  const concepts = claimedConcepts(trade);
  const judgment = classify(trade, candles, outcome);
  const at = trade.closedAt ?? trade.updatedAt;

  return db.transaction(async (tx) => {
    const [review] = await tx.insert(tradeReviewsTable).values({
      tradeId: trade.id,
      accountId: trade.accountId,
      symbol: trade.symbol,
      direction: trade.direction,
      strategy: trade.strategy,
      reasoning: trade.reasonChain,
      claimedConcepts: JSON.stringify(concepts),
      entryPrice: trade.openPrice,
      stopPrice: trade.stopLoss,
      targetPrice: trade.takeProfit,
      closePrice: trade.closePrice,
      outcome,
      pnl: trade.pnl,
      classification: judgment.classification,
      evidenceStatus: judgment.evidenceStatus,
      evidenceSummary: judgment.evidenceSummary,
      candlesExamined: candles.length,
      closedAt: trade.closedAt,
    }).onConflictDoNothing({ target: tradeReviewsTable.tradeId }).returning({ id: tradeReviewsTable.id });
    if (!review) return false;
    // Outcomes without a broker PnL are retained in the journal, not counted
    // as performance evidence.
    if (pnl != null && outcome !== "unknown") {
      await recordPerformance(tx, "symbol", trade.symbol, outcome, pnl, at);
      for (const concept of concepts) {
        await recordPerformance(tx, "concept", concept, outcome, pnl, at);
      }
    }
    return true;
  });
}

export async function rebuildMissingTradeReviews(): Promise<number> {
  const missing = await db.select({ trade: tradesTable }).from(tradesTable)
    .leftJoin(tradeReviewsTable, eq(tradeReviewsTable.tradeId, tradesTable.id))
    .where(and(eq(tradesTable.status, "closed"), isNull(tradeReviewsTable.id)));
  let created = 0;
  for (const row of missing) {
    if (await reviewClosedTrade(row.trade)) created++;
  }
  return created;
}