/**
 * The strategy poll: 60 strategies (40 quantitative, 20 technical) each vote
 * buy, sell or abstain, every strategy on its own timeframe (M30, H1 or H4).
 * Just after each M30 close the latest closed candle of each timeframe is
 * polled. Majority rules: when more strategies say buy than sell (or the
 * reverse) — by at least the configured share, 50% by default — and at least
 * 30 of the 60 have an opinion, the poll trades that direction at market.
 *
 * The position is held for up to four days (the bot's hold limit) with a stop
 * 0.6% from entry and a target 1.5 times the stop, and is always closed before
 * Deriv's Friday close. Everything here is pure so the backtest and the live
 * scan run the same code.
 *
 * How the settings were chosen (2026-10-01, every Deriv forex pair offering
 * multipliers — 14 pairs — and one year of Deriv candles, all Deriv serves):
 * each strategy's timeframe, the holding time (12h to 4 days), the majority
 * threshold (50% to 80%) and the quorum were chosen on Nov 2025 – Jun 2026
 * only, then tested once on Jul – Sep 2026. See CHANGES.md for the numbers.
 */

import { STRATEGIES, atrSeries, type Bars, type Vote } from "./poll-strategies.js";

export type PollTimeframe = "M30" | "H1" | "H4";
export const POLL_TIMEFRAMES: PollTimeframe[] = ["M30", "H1", "H4"];
export const POLL_TIMEFRAME_MS: Record<PollTimeframe, number> = { M30: 1_800_000, H1: 3_600_000, H4: 14_400_000 };

/**
 * The timeframe each strategy votes on — its best on the selection period at
 * the four-day hold. A strategy on H4 looks back eight times as long in time
 * as on M30, so this is also where each strategy's look-back was tuned.
 */
export const POLL_TIMEFRAME: Record<string, PollTimeframe> = {
  markov_updown: "M30", markov_3state: "M30", markov_2nd_order: "H1", markov_candle_type: "M30", markov_regime: "H1",
  markov_run_length: "H1", monte_carlo_bootstrap: "H4", monte_carlo_block: "M30", brownian_barrier: "M30",
  fourier_dominant_cycle: "H4", fourier_lowpass: "H4", spectral_trend_dominance: "M30", linreg_tstat: "H1",
  kalman_trend: "M30", hurst_momentum: "H4", dfa_regime: "H4", ou_reversion: "H4", zscore_reversion: "H4",
  autocorr_lag1: "H1", tsmom_24h: "H1", tsmom_multi: "M30", variance_ratio: "H4", kama_slope: "H1",
  supersmoother_slope: "H1", ehlers_itrend: "M30", bayes_updown: "H1", logistic_lags: "M30", knn_pattern: "H4",
  hour_seasonality: "M30", weekday_hour_seasonality: "H4", currency_strength_momentum: "H1",
  currency_strength_reversion: "H4", cross_sectional_momentum: "H1", volatility_breakout: "M30",
  haar_wavelet_trend: "H1", fractal_dimension: "M30", sharpe_trend: "M30", permutation_trend: "M30",
  entropy_regime: "M30", ewma_vol_momentum: "M30",
  rsi_reversal: "M30", macd_histogram: "H4", ema_cross: "M30", bollinger_reversion: "H4", stochastic_cross: "H4",
  adx_dmi: "M30", ichimoku: "M30", keltner_breakout: "M30", roc_momentum: "H1", williams_r: "H4", cci_cross: "H4",
  donchian_breakout: "M30", parabolic_sar: "M30", pivot_points: "H4", fib_macd: "M30", supertrend: "M30",
  aroon: "M30", heikin_ashi: "H4", trix: "M30", vortex: "H1",
};

/** Strategies that must hold an opinion (not abstain) for the poll to count. Half of the 60. */
export const POLL_QUORUM = 30;
/** Default share of the voting strategies that must agree: 0.5 = simple majority (a tie never trades). */
export const POLL_DEFAULT_AGREEMENT = 0.5;
/** Stop distance as a fraction of price. At x100 this is $0.60 on a $1 stake, inside the 80% stop cap with commission. */
export const POLL_STOP_FRACTION = 0.006;
/** Entry band either side of the scan price, in M30 ATR: the order goes in at market or not at all. */
export const POLL_ENTRY_BAND_ATR = 0.25;
/** Hours a poll trade is held at most: the strategy was chosen at this hold. */
export const POLL_HOLD_HOURS = 96;
/**
 * Candles read per timeframe: enough for the slowest strategy on each (k-NN's
 * 1,210 bars and weekday seasonality's 84 days are on H4; H1's slowest needs
 * about 500 bars; M30's about 400, plus room for the recursive averages).
 */
export const POLL_HISTORY_BARS: Record<PollTimeframe, number> = { M30: 2_000, H1: 1_500, H4: 1_600 };
/** Below this much history on a timeframe the poll does not run: much of its electorate would be silent. */
export const POLL_MIN_BARS: Record<PollTimeframe, number> = { M30: 600, H1: 600, H4: 400 };

export interface PollBallot { id: string; name: string; family: "quant" | "ta"; timeframe: PollTimeframe; vote: Vote }

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
  agreement = Number.isFinite(agreement) ? Math.min(1, Math.max(0.5, agreement)) : POLL_DEFAULT_AGREEMENT;
  let buy = 0, sell = 0;
  for (const v of votes) { if (v > 0) buy++; else if (v < 0) sell++; }
  const abstain = votes.length - buy - sell, voted = buy + sell;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const head = `${buy} buy / ${sell} sell / ${abstain} abstain`;
  if (voted < quorum) return { direction: null, buy, sell, abstain, share: 0, reason: `Poll ${head}: only ${voted} strategies have an opinion, ${quorum} needed` };
  const share = Math.max(buy, sell) / voted;
  if (buy === sell) return { direction: null, buy, sell, abstain, share, reason: `Poll ${head}: tied` };
  if (share < agreement) return { direction: null, buy, sell, abstain, share, reason: `Poll ${head}: ${pct(share)} ${buy > sell ? "buy" : "sell"}, ${pct(agreement)} needed` };
  return { direction: buy > sell ? "buy" : "sell", buy, sell, abstain, share, reason: `Poll ${head}: ${pct(share)} ${buy > sell ? "buy" : "sell"}` };
}

/** Closed candles of one pair per timeframe, and every pair's closes aligned to them (for the cross-pair strategies). */
export interface PollInput {
  symbol: string;
  bars: Record<PollTimeframe, Bars>;
  closes: Record<PollTimeframe, Record<string, number[]>>;
}

/** Polls every strategy on the last closed candle of its own timeframe. */
export function runPoll(input: PollInput, agreement: number): PollResult {
  const m30 = input.bars.M30, lastM30 = m30.c.length - 1;
  const atr = lastM30 >= 0 ? atrSeries(m30, 14)[lastM30] ?? Number.NaN : Number.NaN;
  for (const tf of POLL_TIMEFRAMES) {
    const have = input.bars[tf].c.length;
    if (have < POLL_MIN_BARS[tf]) {
      return { direction: null, buy: 0, sell: 0, abstain: STRATEGIES.length, share: 0, atr, ballots: [], reason: `Not enough ${tf} history to poll yet (${have}/${POLL_MIN_BARS[tf]} candles)` };
    }
  }
  if (!Number.isFinite(atr) || atr <= 0) {
    return { direction: null, buy: 0, sell: 0, abstain: STRATEGIES.length, share: 0, atr, ballots: [], reason: "M30 volatility unavailable" };
  }
  const ballots: PollBallot[] = STRATEGIES.map((s) => {
    const timeframe = POLL_TIMEFRAME[s.id] ?? "M30";
    const bars = input.bars[timeframe], last = bars.c.length - 1;
    const vote = (s.compute(bars, { symbol: input.symbol, closes: input.closes[timeframe] }, last)[last] ?? 0) as Vote;
    return { id: s.id, name: s.name, family: s.family, timeframe, vote };
  });
  return { ...tallyPoll(ballots.map((b) => b.vote), agreement), atr, ballots };
}

/** Every pair's closes aligned to `bars`' timestamps (NaN where a pair has no candle). */
export function alignCloses(bars: Bars, all: Map<string, Bars>): Record<string, number[]> {
  const index = new Map(bars.t.map((t, i) => [t, i]));
  const out: Record<string, number[]> = {};
  for (const [sym, b] of all) {
    const aligned = new Array<number>(bars.t.length).fill(Number.NaN);
    b.t.forEach((t, j) => { const i = index.get(t); if (i != null) aligned[i] = b.c[j]!; });
    out[sym] = aligned;
  }
  return out;
}

/**
 * Deriv's commission as a fraction of price, allowed for in the target. It is
 * charged on stake x multiplier, so per unit of price it is a fixed share of
 * price: measured at 2 bps in the London and New York sessions (the $0.02 on
 * $1 x100 the self-test reports) and 6 bps late in the day. 6 bps covers both,
 * so a vote in the last session hour is traded rather than held back.
 */
export const POLL_COST_ALLOWANCE = 0.0006;

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
  const stop = price * (1 - d * POLL_STOP_FRACTION);
  const worstFill = price + d * band;
  const target = worstFill + d * (rewardRisk * Math.abs(worstFill - stop) + (1 + rewardRisk) * cost);
  return { entryLow: price - band, entryHigh: price + band, stop, target };
}

/**
 * Stored candle rows (oldest first) to the poll's series. Rows off the
 * timeframe's grid are dropped: a partial candle under an off-grid time is not a bar.
 */
export function pollBars(rows: Array<{ t: Date; o: string | number; h: string | number; l: string | number; c: string | number }>, timeframe: PollTimeframe = "M30"): Bars {
  const len = POLL_TIMEFRAME_MS[timeframe];
  const b: Bars = { t: [], o: [], h: [], l: [], c: [] };
  for (const r of rows) {
    const t = r.t.getTime();
    if (t % len !== 0) continue;
    b.t.push(t); b.o.push(+r.o); b.h.push(+r.h); b.l.push(+r.l); b.c.push(+r.c);
  }
  return b;
}
