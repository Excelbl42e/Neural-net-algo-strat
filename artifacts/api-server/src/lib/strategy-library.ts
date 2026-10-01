/**
 * The strategy library shown on the Strategy page: the 60 strategies that vote
 * in the poll (poll-strategies.ts), 40 quantitative and 20 technical. It is
 * generated from the voting code itself, so the page cannot describe a
 * strategy that is not the one actually voting.
 */

import { STRATEGIES } from "./poll-strategies.js";

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
  rules: `${s.summary} It votes buy, sell or abstain on every closed M30 candle, using only candles that have closed. `
    + "Its vote is one of 60 in the poll: a trade needs 70% of the strategies with an opinion (and at least 30 of them) to agree.",
}));
