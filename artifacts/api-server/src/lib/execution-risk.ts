export const DERIV_MIN_STAKE = 0.35;

export interface StakeSizingInput {
  equity: number;
  riskPerTradePct: number;
  maxConcurrentPositions: number;
  openPositions: number;
  minStake?: number;
  /** Allow a minimum-stake trade when minStake/equity (%) is at most this. Default 10. */
  smallAccountMaxRiskPct?: number;
}

export type StakeSizingResult =
  | { ok: true; stake: number; slots: number; cap: number }
  | { ok: false; reason: string };

export interface DailyLossStakeInput {
  equity: number;
  maxDailyLossPct: number;
  realizedPnlToday: number;
  openWorstCaseStake: number;
  currentStakeCap: number;
  minStake?: number;
}

export type DailyLossStakeResult =
  | { ok: true; stake: number; remainingBudget: number }
  | { ok: false; reason: string };

/**
 * Applies the daily loss budget to an already risk-capped stake. This helper
 * can only reduce the existing cap; it never enlarges it.
 */
export function calculateDailyLossCappedStake(input: DailyLossStakeInput): DailyLossStakeResult {
  const minStake = input.minStake ?? DERIV_MIN_STAKE;
  const { equity, maxDailyLossPct, realizedPnlToday, openWorstCaseStake, currentStakeCap } = input;
  if (!Number.isFinite(equity) || equity <= 0) return { ok: false, reason: "account equity unavailable or invalid for daily loss budget" };
  if (!Number.isFinite(maxDailyLossPct) || maxDailyLossPct <= 0 || maxDailyLossPct > 100) {
    return { ok: false, reason: "maximum daily loss percentage is missing or invalid" };
  }
  if (!Number.isFinite(realizedPnlToday)) return { ok: false, reason: "today's realized P&L is unavailable or invalid" };
  if (!Number.isFinite(openWorstCaseStake) || openWorstCaseStake < 0) {
    return { ok: false, reason: "open-trade worst-case stake is unavailable or invalid" };
  }
  if (!Number.isFinite(currentStakeCap) || currentStakeCap < minStake) {
    return { ok: false, reason: "existing risk-capped stake is invalid or below the Deriv minimum" };
  }

  const dailyBudget = equity * maxDailyLossPct / 100;
  const realizedLoss = Math.max(0, -realizedPnlToday);
  const remainingBudget = dailyBudget - realizedLoss - openWorstCaseStake;
  if (!Number.isFinite(remainingBudget) || remainingBudget < minStake) {
    return { ok: false, reason: "remaining daily loss budget is below the Deriv minimum stake" };
  }

  const stake = Math.floor((Math.min(currentStakeCap, remainingBudget) + Number.EPSILON) * 100) / 100;
  if (!Number.isFinite(stake) || stake < minStake) {
    return { ok: false, reason: "daily-loss-capped stake is below the Deriv minimum stake" };
  }
  return { ok: true, stake, remainingBudget };
}

/**
 * Computes a conservative stake with every cap enforced. Confidence is
 * deliberately not an input: an LLM-reported score cannot enlarge exposure.
 */
export function calculateCappedStake(input: StakeSizingInput): StakeSizingResult {
  const minStake = input.minStake ?? DERIV_MIN_STAKE;
  const { equity, riskPerTradePct, maxConcurrentPositions, openPositions } = input;
  if (!Number.isFinite(equity) || equity <= 0) return { ok: false, reason: "account equity unavailable or invalid" };
  if (!Number.isFinite(riskPerTradePct) || riskPerTradePct <= 0 || riskPerTradePct > 100) {
    return { ok: false, reason: "risk-per-trade setting unavailable or invalid" };
  }
  if (!Number.isFinite(maxConcurrentPositions) || maxConcurrentPositions < 1) {
    return { ok: false, reason: "maximum concurrent positions unavailable or invalid" };
  }
  if (!Number.isFinite(openPositions) || openPositions < 0) {
    return { ok: false, reason: "open position count unavailable or invalid" };
  }
  if (equity < minStake) return { ok: false, reason: "equity is below the Deriv minimum stake" };

  const slots = Math.min(Math.floor(maxConcurrentPositions), Math.floor(equity / minStake));
  if (slots < 1 || openPositions >= slots) {
    return { ok: false, reason: "no funded concurrent position slot is available" };
  }

  const remainingSlots = Math.max(0, slots - Math.floor(openPositions) - 1);
  const riskCap = equity * riskPerTradePct / 100;
  const absoluteCap = equity * 0.4;
  const reserveCap = equity - remainingSlots * minStake;
  const cap = Math.min(equity / slots, riskCap, absoluteCap, reserveCap);
  // Round down, never up through a configured risk cap.
  let stake = Math.floor((cap + Number.EPSILON) * 100) / 100;
  if (!Number.isFinite(stake) || stake < minStake) {
    // Small-account rule: a minimum-stake trade is allowed only if its share of
    // equity stays under smallAccountMaxRiskPct (multiplier max loss == stake).
    const maxSmall = input.smallAccountMaxRiskPct ?? 10;
    const minShare = (minStake / equity) * 100;
    if (reserveCap >= minStake && absoluteCap >= minStake && minShare <= maxSmall) {
      stake = minStake;
    } else {
      return { ok: false, reason: `account too small for configured risk (min stake $${minStake.toFixed(2)} is ${minShare.toFixed(1)}% of equity; small-account cap ${maxSmall}%)` };
    }
  }
  return { ok: true, stake, slots, cap };
}
export interface FundablePositionsInput {
  equity: number;
  riskPerTradePct: number;
  maxConcurrentPositions: number;
  maxDailyLossPct: number;
  smallAccountMaxRiskPct?: number;
  minStake?: number;
}

export interface FundablePositionsResult {
  /** How many positions can actually be opened together at this equity. */
  fundable: number;
  /** What the account is configured to allow. */
  configured: number;
  /** Stake of each position that would actually fit, in order. */
  stakes: number[];
  /** Why the count stopped where it did, when it is short of `configured`. */
  limitedBy: "configured" | "daily_loss_budget" | "risk_sizing" | "equity";
}

/**
 * How many concurrent positions this account can genuinely fund right now.
 *
 * `maxConcurrentPositions` alone is aspirational: the daily-loss budget is
 * checked *after* per-trade sizing and reserves the stake of every open
 * position, so on a small account the first trade can consume the entire
 * day's budget and a second one is refused however high the configured cap
 * is. Rather than duplicating that interaction, this walks the real sizing
 * functions one position at a time, exactly as the dispatcher does, so the
 * number shown to a human is the number the trading path will actually
 * honour.
 */
export function maxFundablePositions(input: FundablePositionsInput): FundablePositionsResult {
  const configured = Math.max(0, Math.floor(input.maxConcurrentPositions));
  const stakes: number[] = [];
  let reserved = 0;
  let limitedBy: FundablePositionsResult["limitedBy"] = "configured";

  while (stakes.length < configured) {
    const sizing = calculateCappedStake({
      equity: input.equity,
      riskPerTradePct: input.riskPerTradePct,
      maxConcurrentPositions: input.maxConcurrentPositions,
      openPositions: stakes.length,
      smallAccountMaxRiskPct: input.smallAccountMaxRiskPct,
      minStake: input.minStake,
    });
    if (!sizing.ok) {
      limitedBy = stakes.length === 0 && input.equity < (input.minStake ?? DERIV_MIN_STAKE) ? "equity" : "risk_sizing";
      break;
    }
    const daily = calculateDailyLossCappedStake({
      equity: input.equity,
      maxDailyLossPct: input.maxDailyLossPct,
      realizedPnlToday: 0,
      openWorstCaseStake: reserved,
      currentStakeCap: sizing.stake,
      minStake: input.minStake,
    });
    if (!daily.ok) { limitedBy = "daily_loss_budget"; break; }
    stakes.push(daily.stake);
    reserved += daily.stake;
  }

  return { fundable: stakes.length, configured, stakes, limitedBy };
}
