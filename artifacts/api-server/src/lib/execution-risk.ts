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
  /**
   * Per-asset-class cap. This bot trades forex only, and every forex pair is
   * the same asset class, so in practice this is a second ceiling on total
   * concurrent positions — and a lower one than `maxConcurrentPositions` at
   * its defaults. Omitting it makes this function claim a position count the
   * portfolio gate will refuse.
   */
  maxPerAssetClass?: number;
}

export interface FundablePositionsResult {
  /** How many positions can actually be opened together at this equity. */
  fundable: number;
  /** What the account is configured to allow. */
  configured: number;
  /** Stake of each position that would actually fit, in order. */
  stakes: number[];
  /** Per stake, whether it was raised to $1.00 to keep the order off the binary path. */
  lifted: boolean[];
  /** Why the count stopped where it did, when it is short of `configured`. */
  limitedBy: "configured" | "daily_loss_budget" | "risk_sizing" | "equity" | "asset_class_cap";
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
  // The binding ceiling is whichever of the two caps is lower. Reporting
  // `maxConcurrentPositions` alone promised trades the portfolio gate blocks.
  const assetClassCap = input.maxPerAssetClass != null && Number.isFinite(input.maxPerAssetClass)
    ? Math.max(0, Math.floor(input.maxPerAssetClass))
    : Number.POSITIVE_INFINITY;
  const configured = Math.min(Math.max(0, Math.floor(input.maxConcurrentPositions)), assetClassCap);
  const stakes: number[] = [];
  const lifted: boolean[] = [];
  let reserved = 0;
  let limitedBy: FundablePositionsResult["limitedBy"] = "configured";
  // The band tapers both percentages before anything else sees them, exactly as
  // the dispatcher does, so the preview cannot claim a stake the worker refuses.
  const eff = effectiveRiskPcts(input.equity, input.riskPerTradePct, input.maxDailyLossPct);

  while (stakes.length < configured) {
    const sizing = calculateCappedStake({
      equity: input.equity,
      riskPerTradePct: eff.riskPct,
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
      maxDailyLossPct: eff.dailyLossPct,
      realizedPnlToday: 0,
      openWorstCaseStake: reserved,
      currentStakeCap: sizing.stake,
      minStake: input.minStake,
    });
    if (!daily.ok) { limitedBy = "daily_loss_budget"; break; }
    // The floor lift comes last, after both caps, because the daily-loss guard
    // can shrink a stake back under $1.00 and undo it otherwise.
    const floored = applyMultiplierFloor({ stake: daily.stake, equity: input.equity });
    stakes.push(floored.stake);
    lifted.push(floored.lifted);
    reserved += floored.stake;
  }

  if (limitedBy === "configured" && assetClassCap < Math.floor(input.maxConcurrentPositions)) {
    limitedBy = "asset_class_cap";
  }
  return { fundable: stakes.length, configured, stakes, lifted, limitedBy };
}

export interface StakePlanRow {
  equity: number;
  band: RiskBand;
  /** Risk-per-trade actually applied here, after the band ceiling. */
  riskPct: number;
  dailyLossPct: number;
  riskCappedByBand: boolean;
  stake: number | null;
  contract: "multiplier" | "binary" | null;
  /** True when the stake was raised to $1.00 to keep the order off the binary path. */
  lifted: boolean;
  typicalLoss: number | null;
  worstCaseLoss: number | null;
  /** Worst case as a share of the balance — the number that decides whether a losing run ends the account. */
  worstCasePctOfEquity: number | null;
  fundable: number;
  limitedBy: FundablePositionsResult["limitedBy"];
  /** Set when no trade is possible at this balance at all. */
  blocked: string | null;
}

/**
 * One row of the stake ladder: everything that follows from a balance.
 *
 * This exists so the number a person reads and the number the worker sends are
 * produced by the same code. It calls the real sizing functions rather than
 * restating their arithmetic, so the two cannot drift apart when one is edited.
 */
export function describeStakePlan(input: FundablePositionsInput): StakePlanRow {
  const eff = effectiveRiskPcts(input.equity, input.riskPerTradePct, input.maxDailyLossPct);
  const fit = maxFundablePositions(input);
  const stake = fit.stakes[0] ?? null;
  if (stake == null) {
    return {
      equity: input.equity, band: eff.band, riskPct: eff.riskPct, dailyLossPct: eff.dailyLossPct,
      riskCappedByBand: eff.riskCappedByBand, stake: null, contract: null, lifted: false,
      typicalLoss: null, worstCaseLoss: null, worstCasePctOfEquity: null,
      fundable: 0, limitedBy: fit.limitedBy,
      blocked: fit.limitedBy === "equity"
        ? `balance is under Deriv's $${(input.minStake ?? DERIV_MIN_STAKE).toFixed(2)} minimum stake`
        : "no stake survives the risk and daily-loss caps at this balance",
    };
  }
  const contract: "multiplier" | "binary" = stake >= MULTIPLIER_MIN_STAKE ? "multiplier" : "binary";
  const worst = worstCaseLoss(stake, contract);
  return {
    equity: input.equity, band: eff.band, riskPct: eff.riskPct, dailyLossPct: eff.dailyLossPct,
    riskCappedByBand: eff.riskCappedByBand, stake, contract,
    lifted: fit.lifted[0] ?? false,
    typicalLoss: typicalLoss(stake, contract),
    worstCaseLoss: worst,
    worstCasePctOfEquity: Number(((worst / input.equity) * 100).toFixed(1)),
    fundable: fit.fundable, limitedBy: fit.limitedBy, blocked: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Balance-adaptive risk
// ─────────────────────────────────────────────────────────────────────────────

/** Below this stake Deriv will not sell a multiplier, so the order becomes a binary. */
export const MULTIPLIER_MIN_STAKE = 1;
/** The attached stop-loss is capped here so the position exits before Deriv's 100% auto stop-out. */
export const MULTIPLIER_STOP_CAP_PCT = 0.8;

export type RiskBand = "floor" | "build" | "grow" | "steady" | "mature";

export interface RiskBandRule {
  band: RiskBand;
  /** Inclusive lower bound of the band, in USD. */
  from: number;
  /** Ceiling on risk-per-trade in this band. The configured setting still applies; the lower of the two wins. */
  riskPct: number;
  /** Ceiling on the daily-loss budget in this band, same rule. */
  dailyLossPct: number;
  why: string;
}

/**
 * How much of the account a single trade may risk, as a function of balance.
 *
 * A flat percentage cannot serve both ends of this account's life. At $5 a
 * 20% risk is not aggression, it is the *minimum* that reaches Deriv's $1.00
 * multiplier stake — anything less drops to a binary, which has no stop-loss
 * at all and is therefore strictly more dangerous. At $500 that same 20% is
 * a $100 swing per trade and is how an account dies. So the percentage is a
 * ceiling that steps down as the balance grows, and the bands are chosen so
 * that no step ever pushes the stake back under $1.00:
 *
 *   $12 x 10% = $1.20 · $50 x 5% = $2.50 · $200 x 2% = $4.00 · $1000 x 1% = $10
 *
 * This is the taper a person is supposed to remember to apply by hand as the
 * account grows, made automatic so forgetting is not possible.
 */
export const RISK_BANDS: readonly RiskBandRule[] = [
  { band: "floor",  from: 0,    riskPct: 20, dailyLossPct: 20, why: "clearing Deriv's $1.00 multiplier minimum is the binding constraint, not risk appetite" },
  { band: "build",  from: 12,   riskPct: 10, dailyLossPct: 15, why: "the $1.00 floor is comfortably cleared, so risk starts coming down" },
  { band: "grow",   from: 50,   riskPct: 5,  dailyLossPct: 10, why: "large enough that a losing run, not a single trade, is the real threat" },
  { band: "steady", from: 200,  riskPct: 2,  dailyLossPct: 6,  why: "conventional fixed-fractional territory" },
  { band: "mature", from: 1000, riskPct: 1,  dailyLossPct: 4,  why: "capital preservation outranks growth rate" },
] as const;

/** The band a balance falls into. Always returns a rule; the first band starts at 0. */
export function riskBandFor(equity: number): RiskBandRule {
  const safe = Number.isFinite(equity) ? equity : 0;
  let match = RISK_BANDS[0]!;
  for (const rule of RISK_BANDS) if (safe >= rule.from) match = rule;
  return match;
}

/**
 * The risk and daily-loss percentages actually used at this balance: the
 * configured setting, or the band's ceiling, whichever is lower. A deliberately
 * conservative setting is never overridden upward — the ladder can only tighten.
 */
export function effectiveRiskPcts(
  equity: number, configuredRiskPct: number, configuredDailyLossPct: number,
): { band: RiskBand; riskPct: number; dailyLossPct: number; riskCappedByBand: boolean; dailyCappedByBand: boolean; why: string } {
  const rule = riskBandFor(equity);
  const riskPct = Math.min(configuredRiskPct, rule.riskPct);
  const dailyLossPct = Math.min(configuredDailyLossPct, rule.dailyLossPct);
  return {
    band: rule.band, riskPct, dailyLossPct, why: rule.why,
    riskCappedByBand: rule.riskPct < configuredRiskPct,
    dailyCappedByBand: rule.dailyLossPct < configuredDailyLossPct,
  };
}

/** The most one trade can lose, by contract type. A binary has no stop, so the answer is the whole stake. */
export function worstCaseLoss(stake: number, contract: "multiplier" | "binary"): number {
  return contract === "binary" ? stake : Number((stake * MULTIPLIER_STOP_CAP_PCT).toFixed(2));
}

/** Roughly one H1 ATR on the forex majors, as a fraction of price. Used only to model a typical stop for display. */
export const TYPICAL_STOP_FRACTION_OF_PRICE = 0.001;

/**
 * What a losing trade normally costs.
 *
 * A binary loses the whole stake, always. A multiplier loses its attached
 * stop: the structural stop, at least one H1 ATR from entry, never under
 * Deriv's minimum stop-loss and never over 80% of stake. On a $1.00 stake a
 * 1-ATR stop works out near $0.10. This models with the minimum assumed when
 * Deriv reports none; where Deriv's real minimum is higher, the order is
 * widened to it or, if that ruins reward:risk, not sent at all.
 */
export function typicalLoss(
  stake: number,
  contract: "multiplier" | "binary",
  multiplier = 100,
  stopFractionOfPrice = TYPICAL_STOP_FRACTION_OF_PRICE,
): number {
  if (contract === "binary") return stake;
  const modelled = stake * multiplier * stopFractionOfPrice;
  const clamped = Math.min(stake * MULTIPLIER_STOP_CAP_PCT, Math.max(DEFAULT_MIN_LIMIT_ORDER_USD, modelled));
  return Number(clamped.toFixed(2));
}

export interface MultiplierFloorResult {
  stake: number;
  /** True when the stake was raised to $1.00 to keep the order on a multiplier. */
  lifted: boolean;
  reason: string;
}

/**
 * Raise a sub-$1.00 stake to exactly $1.00 when doing so keeps the order on a
 * multiplier, because on this broker the smaller stake is the more dangerous one.
 *
 * Under $1.00 Deriv will not open a multiplier, so the order falls through to a
 * binary — and a binary carries no stop-loss, no take-profit and no early exit
 * worth the name: a loser costs the entire stake. A $1.00 multiplier's loss is
 * bounded by its attached stop, capped at 80% of stake. So $1.00 as a multiplier
 * risks at most $0.80, while $0.99 as a binary risks a certain $0.99. Shrinking
 * the stake here *increases* money at risk, which is the opposite of what a risk
 * cap is for.
 *
 * The lift is therefore allowed only while the lifted worst case stays within
 * `maxWorstCasePctOfEquity` of the balance — at the default 20% that means
 * roughly $4.00 and up. Below that the account genuinely cannot afford a
 * multiplier and the binary path stands, with the tighter strategy gate that
 * goes with it.
 */
export function applyMultiplierFloor(input: {
  stake: number;
  equity: number;
  maxWorstCasePctOfEquity?: number;
}): MultiplierFloorResult {
  const { stake, equity } = input;
  const maxPct = input.maxWorstCasePctOfEquity ?? 20;
  if (!Number.isFinite(stake) || !Number.isFinite(equity) || equity <= 0) {
    return { stake, lifted: false, reason: "equity or stake unavailable" };
  }
  if (stake >= MULTIPLIER_MIN_STAKE) return { stake, lifted: false, reason: "already a multiplier stake" };

  const liftedWorstCase = worstCaseLoss(MULTIPLIER_MIN_STAKE, "multiplier");
  const sharePct = (liftedWorstCase / equity) * 100;
  if (MULTIPLIER_MIN_STAKE > equity || sharePct > maxPct) {
    return {
      stake, lifted: false,
      reason: `balance too small to hold the multiplier floor ($1.00 risks $${liftedWorstCase.toFixed(2)} = ${sharePct.toFixed(1)}% of equity, over the ${maxPct}% limit); trading as a binary`,
    };
  }
  return {
    stake: MULTIPLIER_MIN_STAKE, lifted: true,
    reason: `raised $${stake.toFixed(2)} to $1.00 to stay on a multiplier: $1.00 risks at most $${liftedWorstCase.toFixed(2)}, the binary it would otherwise become risks the full $${stake.toFixed(2)}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Settlement accounting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read a stored stake. Returns null for anything that is not a usable positive
 * number, rather than a plausible-looking wrong answer.
 *
 * Settlement code used to write `parseFloat(trade.lotSize ?? "10")`, which
 * invents a $10 stake for a row that has none — on a $1.00 trade that turns a
 * $0.50 profit into an $8.50 loss. Worse, a non-numeric value makes parseFloat
 * return NaN, and `NaN.toFixed(2)` is the string "NaN", which then goes into a
 * numeric P&L column. Both feed the daily-loss guard, so a fabricated or
 * corrupt stake does not just misreport history, it mis-sizes the next trade.
 */
export function parseStake(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Realised P&L of a settled contract: what came back, minus what went in.
 * Returns null when it genuinely cannot be determined, so callers record
 * "unknown" instead of a number nobody can stand behind.
 */
export function settlementPnl(
  proceeds: number | null | undefined,
  stakeRaw: string | null | undefined,
): number | null {
  const stake = parseStake(stakeRaw);
  if (stake == null || proceeds == null || !Number.isFinite(proceeds)) return null;
  return Number((proceeds - stake).toFixed(2));
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry timing and the executed bracket
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deriv's minimum stop-loss / take-profit amount assumed when its proposal does
 * not report one. The dispatcher always prefers Deriv's own figure.
 *
 * This used to be $0.50, carried over from the original import and never
 * verified. On the $1.00 minimum multiplier stake at x100 that forces every
 * stop to at least 0.5% of price — about 58 pips on EURUSD — and, with a 2:1
 * floor, every target to 117 pips or more: almost no M30 setup qualifies, so a
 * small account would sit idle. A lower minimum only ever permits a tighter
 * stop, which is less money at risk, never more; if Deriv's real minimum is
 * higher it refuses the order (nothing opens) and the dispatcher learns the
 * minimum from that refusal — see parseDerivLimitRejection.
 */
export const DEFAULT_MIN_LIMIT_ORDER_USD = 0.1;

/**
 * A stop-loss / take-profit amount Deriv is known to accept on the $1.00
 * multiplier stake: the demo self-test's round trip sends $0.50 for both and
 * Deriv opened the contract. Used when Deriv refuses a bracket without saying
 * what its minimum is.
 */
export const KNOWN_ACCEPTED_LIMIT_ORDER_USD = 0.5;

/**
 * Read a raised minimum out of Deriv's refusal of a multiplier bracket.
 *
 * Returns null when the refusal is not about the stop-loss / take-profit at
 * all, or when it gives nothing the dispatcher can act on (for example a
 * complaint that an amount is too large, which the stop cap already rules
 * out). A complaint about a limit that names no figure is answered with
 * KNOWN_ACCEPTED_LIMIT_ORDER_USD, an amount Deriv has accepted before.
 *
 * Deriv's exact wording for these refusals has not been observed from this
 * system, so the match is deliberately loose; the only consequence of a miss is
 * that the signal is cancelled as before, with no order opened.
 */
export function parseDerivLimitRejection(
  message: string | null | undefined,
): { stopLossMin?: number; takeProfitMin?: number } | null {
  if (!message) return null;
  // "cannot be more than X" states a ceiling; fold negated phrasing into
  // "exceed" first so it is not read as "more than X", a minimum.
  const text = message
    .replace(/_/g, " ")
    .replace(/\b(cannot|can't|can not|must not|may not|should not)\s+(be\s+)?(more|higher|greater)(\s+than)?/gi, " exceed ");
  const aboutStop = /stop\s?loss/i.test(text);
  const aboutTarget = /take\s?profit/i.test(text);
  const aboutLimit = /limit\s?order/i.test(text);
  if (!aboutStop && !aboutTarget && !aboutLimit) return null;
  // "must be lower than", "cannot be more than", "maximum": a ceiling, which a
  // higher minimum cannot fix.
  if (/(lower|less|smaller|below|at most|maximum|max\b|exceed)/i.test(text)
    && !/(higher|greater|more than|above|at least|minimum|min\b)/i.test(text)) {
    return null;
  }
  const m = text.match(/(?:higher|greater|more|above|at least|minimum|min\b)\D{0,40}?(\d+(?:\.\d+)?)/i);
  const figure = m ? Number(m[1]) : Number.NaN;
  // A figure over $100 is not a plausible minimum for these stakes; treat it
  // as "no usable figure" rather than learn a limit that blocks everything.
  const min = Number.isFinite(figure) && figure > 0 && figure <= 100 ? figure : KNOWN_ACCEPTED_LIMIT_ORDER_USD;
  const both = aboutLimit && !aboutStop && !aboutTarget;
  return {
    ...(aboutStop || both ? { stopLossMin: min } : {}),
    ...(aboutTarget || both ? { takeProfitMin: min } : {}),
  };
}

export interface EntryPlanInput {
  direction: "buy" | "sell";
  /** Live executable price — where a market order will actually fill. */
  price: number;
  /** The entry zone the judge approved (the FVG). */
  entryLow: number;
  entryHigh: number;
  /** Structural invalidation and liquidity target, as approved. */
  stop: number;
  target: number;
  minRiskReward: number;
  /**
   * Present for a multiplier, which carries a stop-loss and take-profit in USD.
   * Omitted for a binary, which has neither.
   */
  bracket?: {
    stake: number;
    multiplier: number;
    minStopUsd: number;
    minTakeProfitUsd: number;
    /** Ceiling on the stop as a fraction of stake: 80% so it fires before Deriv's 100% stop-out, lower when Deriv's maximum or the day's remaining loss budget is. */
    maxStopFraction: number;
    /**
     * Deriv's commission on this contract, when its quote reports one. Deriv
     * counts it as a loss from the moment the contract opens, so a stop-loss
     * amount of X fires after a price move worth only X - commission, and a
     * take-profit of Y needs a move worth Y + commission.
     */
    commissionUsd?: number;
  };
}

export type EntryPlan =
  | {
      action: "enter";
      /** Reward:risk measured from the live price, after any Deriv minimums. */
      rr: number;
      stopLossUsd: number | null;
      takeProfitUsd: number | null;
      /** The price levels the broker will actually act on. */
      stopPrice: number;
      targetPrice: number;
      /** True when Deriv's minimum stop pushed the stop beyond the structural level. */
      stopWidened: boolean;
    }
  /** Not yet — a later price may qualify. The signal stays pending. */
  | { action: "wait"; reason: string }
  /** The setup is over: invalidated, or the move already happened without us. */
  | { action: "cancel"; reason: string }
  /** Can never qualify for reasons waiting will not change. */
  | { action: "refuse"; reason: string };

const fmt = (n: number) => n.toFixed(5);

/**
 * Decide whether an approved setup should be entered at the live price, and if
 * so, with exactly which bracket.
 *
 * A multiplier fills at market. The dispatcher used to measure the stop-loss
 * and take-profit dollar distances from the FVG midpoint and send them with a
 * market order — but a signal fires while price is still above the FVG (it has
 * not retraced yet), so the whole bracket was shifted. On the judge's own test
 * setup the stop landed ~100 pips above the structural stop, right on top of
 * the FVG where the retrace is expected to go, and the target ~100 pips beyond
 * the liquidity pool: reward:risk approved as 2.73, executed as 0.59 from the
 * real fill. The strategy's normal entry would have stopped it out.
 *
 * Now the order waits for price to actually come into the approved zone, and
 * the bracket is measured from the real price to the real structural levels,
 * with reward:risk re-checked there — after any minimum Deriv imposes — so
 * the trade that executes is the trade that was approved.
 */
export function planEntry(input: EntryPlanInput): EntryPlan {
  const { direction, price, stop, target, minRiskReward, bracket } = input;
  const buy = direction === "buy";
  const lo = Math.min(input.entryLow, input.entryHigh);
  const hi = Math.max(input.entryLow, input.entryHigh);

  if (![price, lo, hi, stop, target, minRiskReward].every(Number.isFinite) || price <= 0) {
    return { action: "refuse", reason: "Live price or stored levels are not usable numbers" };
  }
  if (buy ? !(stop < lo && target > hi) : !(stop > hi && target < lo)) {
    return { action: "refuse", reason: `Stored levels are inconsistent for a ${direction}: stop ${fmt(stop)}, zone ${fmt(lo)}–${fmt(hi)}, target ${fmt(target)}` };
  }

  // Over, one way or the other.
  if (buy ? price <= stop : price >= stop) {
    return { action: "cancel", reason: `Price ${fmt(price)} is already through the stop ${fmt(stop)}; the setup is invalidated` };
  }
  if (buy ? price >= target : price <= target) {
    return { action: "cancel", reason: `Price ${fmt(price)} already reached the target ${fmt(target)}; the move happened without an entry` };
  }

  // Not yet: price has not come back into the zone. Entering here is chasing.
  if (buy ? price > hi : price < lo) {
    return { action: "wait", reason: `Waiting for price to retrace into the entry zone ${fmt(lo)}–${fmt(hi)} (now ${fmt(price)})` };
  }

  const risk = Math.abs(price - stop);
  const reward = Math.abs(target - price);
  const rr = reward / risk;
  if (rr < minRiskReward) {
    return { action: "wait", reason: `In the entry zone, but reward:risk from ${fmt(price)} is ${rr.toFixed(2)} < ${minRiskReward}; waiting for a deeper fill` };
  }

  if (!bracket) {
    return { action: "enter", rr, stopLossUsd: null, takeProfitUsd: null, stopPrice: stop, targetPrice: target, stopWidened: false };
  }

  const { stake, multiplier, minStopUsd, minTakeProfitUsd, maxStopFraction } = bracket;
  const commission = bracket.commissionUsd ?? 0;
  if (![stake, multiplier, minStopUsd, minTakeProfitUsd, maxStopFraction, commission].every(Number.isFinite)
    || stake <= 0 || multiplier <= 0 || commission < 0) {
    return { action: "refuse", reason: "Stake, multiplier, commission or Deriv limits are not usable numbers" };
  }
  // USD gained or lost per unit of price move, for this stake and multiplier.
  const usdPerUnit = (stake * multiplier) / price;
  const maxStopUsd = maxStopFraction * stake;

  if (minStopUsd > maxStopUsd) {
    return {
      action: "refuse",
      reason: `Deriv's minimum stop-loss ($${minStopUsd.toFixed(2)}) is above the $${maxStopUsd.toFixed(2)} stop cap on a $${stake.toFixed(2)} stake`,
    };
  }

  // Deriv books the commission as a loss at open, so the amounts it acts on
  // include it: the stop-loss that fires exactly at the structural stop is the
  // move plus the commission, and the take-profit that fires exactly at the
  // pool is the move less the commission. Reward:risk below is then measured
  // in the money actually won or lost.
  let stopUsd = risk * usdPerUnit + commission;
  const takeProfitUsd = reward * usdPerUnit - commission;
  // Moving further into the zone shrinks the stop distance, so these can resolve.
  if (stopUsd > maxStopUsd) {
    return { action: "wait", reason: `The structural stop is $${stopUsd.toFixed(2)} away, above the $${maxStopUsd.toFixed(2)} stop cap; waiting for a fill nearer the stop` };
  }
  if (takeProfitUsd < minTakeProfitUsd) {
    return { action: "wait", reason: `The target is worth only $${takeProfitUsd.toFixed(2)} after commission, below Deriv's $${minTakeProfitUsd.toFixed(2)} minimum take-profit; waiting for a deeper fill` };
  }

  const stopWidened = stopUsd < minStopUsd;
  if (stopWidened) stopUsd = minStopUsd;

  // Deriv takes amounts to the cent. Round the stop up and the target down so
  // the rounding can only ever make the recorded ratio conservative.
  const stopLossUsd = Math.ceil(stopUsd * 100 - 1e-9) / 100;
  const takeProfitRounded = Math.floor(takeProfitUsd * 100 + 1e-9) / 100;
  // Rounding the stop up can carry it a fraction of a cent past a cap that is
  // not itself a whole number of cents. The cap wins; a slightly deeper fill
  // will bring the stop back under it.
  if (stopLossUsd > maxStopUsd + 1e-9) {
    return { action: "wait", reason: `The stop rounds to $${stopLossUsd.toFixed(2)}, just over the $${maxStopUsd.toFixed(2)} stop cap; waiting for a fill nearer the stop` };
  }
  if (takeProfitRounded < minTakeProfitUsd - 1e-9) {
    return { action: "wait", reason: `The target rounds to $${takeProfitRounded.toFixed(2)}, under Deriv's $${minTakeProfitUsd.toFixed(2)} minimum take-profit; waiting for a deeper fill` };
  }
  const executedRr = takeProfitRounded / stopLossUsd;
  if (executedRr < minRiskReward) {
    return {
      action: "wait",
      reason: stopWidened
        ? `Deriv's $${minStopUsd.toFixed(2)} minimum stop widens the stop beyond structure and cuts reward:risk to ${executedRr.toFixed(2)} < ${minRiskReward}; waiting for a deeper fill`
        : `Reward:risk after rounding is ${executedRr.toFixed(2)} < ${minRiskReward}; waiting for a deeper fill`,
    };
  }

  // Where Deriv will actually close the contract, net of the commission.
  const stopMove = (stopLossUsd - commission) / usdPerUnit;
  const targetMove = (takeProfitRounded + commission) / usdPerUnit;
  const stopPrice = buy ? price - stopMove : price + stopMove;
  const targetPrice = buy ? price + targetMove : price - targetMove;
  return { action: "enter", rr: executedRr, stopLossUsd, takeProfitUsd: takeProfitRounded, stopPrice, targetPrice, stopWidened };
}

/**
 * Whether a pending setup is over, judged on every price traded since the
 * signal was created rather than only the price now.
 *
 * A buy whose stop was traded through is invalidated even if price has since
 * come back into the entry zone: the low it was built on has been taken. Same
 * for a target already reached — the move happened without an entry. Checking
 * only the live price missed both whenever it happened between two looks, or
 * while an account-level gate (outside the killzone, a news blackout) kept the
 * dispatcher from reaching its own check.
 */
export function setupInvalidation(
  direction: "buy" | "sell", stop: number, target: number, lowSince: number, highSince: number,
): string | null {
  if (![stop, target, lowSince, highSince].every(Number.isFinite)) return null;
  if (direction === "buy") {
    if (lowSince <= stop) return `Price traded down to ${fmt(lowSince)}, through the stop ${fmt(stop)}, before an entry; the setup is invalidated`;
    if (highSince >= target) return `Price reached ${fmt(highSince)}, the target ${fmt(target)}, before an entry; the move happened without us`;
  } else {
    if (highSince >= stop) return `Price traded up to ${fmt(highSince)}, through the stop ${fmt(stop)}, before an entry; the setup is invalidated`;
    if (lowSince <= target) return `Price reached ${fmt(lowSince)}, the target ${fmt(target)}, before an entry; the move happened without us`;
  }
  return null;
}

/**
 * The zone-only part of planEntry, cheap enough to run on every tick. The entry
 * watcher uses it to decide whether a pending signal is worth a full dispatch
 * attempt at all; the dispatcher still runs the complete plan.
 */
export function entryZoneState(
  direction: "buy" | "sell", price: number, entryLow: number, entryHigh: number, stop: number, target: number,
): "in_zone" | "wait" | "over" {
  if (![price, entryLow, entryHigh, stop, target].every(Number.isFinite)) return "wait";
  const buy = direction === "buy";
  const lo = Math.min(entryLow, entryHigh);
  const hi = Math.max(entryLow, entryHigh);
  if (buy ? price <= stop || price >= target : price >= stop || price <= target) return "over";
  if (buy ? price > hi : price < lo) return "wait";
  return "in_zone";
}

/**
 * Deriv's multiplier commission in dollars, from the `commission` field of a
 * proposal.
 *
 * Deriv's documentation disagrees with itself about the unit (the proposal
 * schema says "percentage (%)", proposal_open_contract says "payout currency
 * amount"). The demo self-test settled it on this account: the field read
 * 0.02 at a $1 stake and 0.2 at $10 — it scales with the stake, so it is a
 * dollar amount (2026-09-30). Reading it as a percentage as well, as this did
 * until then, would count ten times the real cost at a $10 stake and turn away
 * trades that clear reward:risk.
 *
 * `positionSize` is kept for callers and future checks; the value is used as is.
 */
export function commissionUsdFromQuote(raw: number | null, _positionSize: number): number | null {
  if (raw == null || !Number.isFinite(raw) || raw < 0) return null;
  return raw;
}

