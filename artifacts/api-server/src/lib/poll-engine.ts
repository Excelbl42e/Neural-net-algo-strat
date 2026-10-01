/**
 * The strategy poll: 60 strategies (40 quantitative, 20 technical) each vote
 * buy, sell or abstain on the M30 candle that has just closed. When at least
 * the configured share (70% by default) of the strategies that voted agree,
 * and enough of them voted at all, the poll trades that direction at market.
 *
 * Stop and target are fixed multiples of the M30 ATR, sized so most trades
 * resolve inside the 24-hour hold; the contract monitor closes whatever is
 * left at the hold limit and before Deriv's Friday close. Everything here is
 * pure so the backtest and the live scan run the same code.
 */

import { STRATEGIES, atrSeries, type Bars, type CrossContext, type Vote } from "./poll-strategies.js";

/** Strategies that must hold an opinion (not abstain) for the poll to count. Half of the 60. */
export const POLL_QUORUM = 30;
/** Stop distance in M30 ATR(14). About one day's typical range on the majors. */
export const POLL_STOP_ATR = 8;
/** Entry band either side of the scan price, in M30 ATR: the order goes in at market or not at all. */
export const POLL_ENTRY_BAND_ATR = 0.25;
/**
 * M30 candles the poll reads. The slowest strategy (weekday-hour seasonality)
 * looks back 84 calendar days; 4,200 candles is about 87 trading days.
 */
export const POLL_HISTORY_BARS = 4_200;
/** The poll is only meaningful once this much history exists (k-NN needs 1,210 bars). */
export const POLL_MIN_BARS = 1_300;

export interface PollBallot { id: string; name: string; family: "quant" | "ta"; vote: Vote }

export interface PollResult {
  direction: "buy" | "sell" | null;
  buy: number;
  sell: number;
  abstain: number;
  /** Share of the voting (non-abstaining) strategies on the winning side, 0..1. */
  share: number;
  /** M30 ATR(14) at the polled candle. */
  atr: number;
  ballots: PollBallot[];
  reason: string;
}

/** Tally of already-cast votes. Separate from runPoll so the rule itself is easy to test. */
export function tallyPoll(votes: Vote[], agreement: number, quorum = POLL_QUORUM): Pick<PollResult, "direction" | "buy" | "sell" | "abstain" | "share" | "reason"> {
  // Below half, both sides could "win"; an unreadable setting must never mean "trade anything".
  agreement = Number.isFinite(agreement) ? Math.min(1, Math.max(0.5, agreement)) : 0.7;
  let buy = 0, sell = 0;
  for (const v of votes) { if (v > 0) buy++; else if (v < 0) sell++; }
  const abstain = votes.length - buy - sell, voted = buy + sell;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const head = `${buy} buy / ${sell} sell / ${abstain} abstain`;
  if (voted < quorum) return { direction: null, buy, sell, abstain, share: 0, reason: `Poll ${head}: only ${voted} strategies have an opinion, ${quorum} needed` };
  const share = Math.max(buy, sell) / voted;
  if (share < agreement || buy === sell) return { direction: null, buy, sell, abstain, share, reason: `Poll ${head}: ${pct(share)} ${buy >= sell ? "buy" : "sell"}, ${pct(agreement)} needed` };
  return { direction: buy > sell ? "buy" : "sell", buy, sell, abstain, share, reason: `Poll ${head}: ${pct(share)} ${buy > sell ? "buy" : "sell"}` };
}

/** Polls every strategy on the last candle of `bars` (which must be closed). */
export function runPoll(bars: Bars, cross: CrossContext, agreement: number): PollResult {
  const last = bars.c.length - 1;
  const atr = atrSeries(bars, 14)[last] ?? NaN;
  if (bars.c.length < POLL_MIN_BARS || !Number.isFinite(atr) || atr <= 0) {
    return { direction: null, buy: 0, sell: 0, abstain: STRATEGIES.length, share: 0, atr, ballots: [], reason: `Not enough M30 history to poll (${bars.c.length}/${POLL_MIN_BARS} candles)` };
  }
  const ballots: PollBallot[] = STRATEGIES.map((s) => ({ id: s.id, name: s.name, family: s.family, vote: (s.compute(bars, cross, last)[last] ?? 0) as Vote }));
  return { ...tallyPoll(ballots.map((b) => b.vote), agreement), atr, ballots };
}

/**
 * Deriv's commission as a fraction of price, allowed for in the target. It is
 * charged on stake x multiplier, so per unit of price it is a fixed share of
 * price: measured at 2 bps in the London and New York sessions (the $0.02 on
 * $1 x100 the self-test reports). 3 bps leaves room for a dearer quote.
 */
export const POLL_COST_ALLOWANCE = 0.0003;

/**
 * Levels for a poll trade. The order path (planEntry) books Deriv's
 * commission inside the bracket — the stop costs the move plus commission, the
 * target pays the move less it — and demands the reward:risk in those money
 * terms. So the target is set from the far edge of the entry band with the
 * commission allowance added on both legs: a fill anywhere in the band still
 * clears `rewardRisk` after costs.
 */
export function pollLevels(direction: "buy" | "sell", price: number, atr: number, rewardRisk: number) {
  const d = direction === "buy" ? 1 : -1;
  const band = POLL_ENTRY_BAND_ATR * atr;
  const cost = POLL_COST_ALLOWANCE * price;
  const stop = price - d * POLL_STOP_ATR * atr;
  const worstFill = price + d * band;
  const target = worstFill + d * (rewardRisk * Math.abs(worstFill - stop) + (1 + rewardRisk) * cost);
  return { entryLow: price - band, entryHigh: price + band, stop, target };
}

/**
 * Stored candle rows (oldest first) to the poll's series. Rows off the M30
 * grid are dropped: a partial candle under an off-grid time is not a bar.
 */
export function pollBars(rows: Array<{ t: Date; o: string | number; h: string | number; l: string | number; c: string | number }>): Bars {
  const b: Bars = { t: [], o: [], h: [], l: [], c: [] };
  for (const r of rows) {
    const t = r.t.getTime();
    if (t % 1_800_000 !== 0) continue;
    b.t.push(t); b.o.push(+r.o); b.h.push(+r.h); b.l.push(+r.l); b.c.push(+r.c);
  }
  return b;
}
