/**
 * The strategy library shown on the Strategy page: the 60 strategies that vote
 * in the poll (poll-strategies.ts), 40 quantitative and 20 technical. It is
 * generated from the voting code itself, so the page cannot describe a
 * strategy that is not the one actually voting.
 */

import { STRATEGIES } from "./poll-strategies.js";
import { POLL_TIMEFRAME } from "./poll-engine.js";

const TF_NAME = { M30: "30-minute", H1: "1-hour", H4: "4-hour" } as const;

export type StrategyCategory = "quant" | "ta";

export interface HardcodedStrategy {
  name: string;
  category: StrategyCategory;
  /** Display order: quantitative first, then technical, in poll order. */
  rank: number;
  summary: string;
  rules: string;
}

export const STRATEGY_LIBRARY: HardcodedStrategy[] = STRATEGIES.map((s, i) => ({
  name: s.name,
  category: s.family,
  rank: i + 1,
  summary: s.summary,
  rules: `${s.summary} It votes on ${TF_NAME[POLL_TIMEFRAME[s.id] ?? "M30"]} candles (the timeframe it scored best on in the backtest's selection period; `
    + "lookbacks are counted in that timeframe's candles), using only candles that have closed. "
    + "Its vote is one of 60: majority rules — more buy than sell votes (a tie never trades), with at least 30 of the 60 holding an opinion.",
}));
