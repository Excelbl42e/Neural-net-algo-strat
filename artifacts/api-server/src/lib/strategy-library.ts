/**
 * Hardcoded strategy library — replaces the old book-ingestion pipeline as
 * the source of both (a) the concept eligibility list the GPT signal prompt
 * is allowed to claim, and (b) the supplementary knowledge context injected
 * into that prompt. Nothing here is scanned or synthesized at runtime; it is
 * curated once, in code, reviewed like any other trading logic.
 *
 * The deep ICT framework (AMD, MMXM, entry models, session timing, the
 * Cartea/Jaimungal microstructure principles) already lives directly in
 * signal-worker.ts's system prompt — these 20 entries are the named concept
 * list that framework operates on, used for the self-learning eligibility
 * gate (scoreConcepts, keyed by concept name against real closed-trade
 * outcomes) and as a compact reference block in the prompt. The 10 quant/TA
 * entries cover ground the ICT system prompt does not: classical technical
 * analysis and market-microstructure filters, several of which have live
 * deterministic implementations in quant-filters.ts.
 */

export type StrategyCategory = "ict" | "quant";

export interface HardcodedStrategy {
  /** conceptKey()-normalized form: lowercase, spaced, no punctuation. */
  key: string;
  name: string;
  category: StrategyCategory;
  /** 1 = highest priority. Used only for stable ordering and prompt weight. */
  rank: number;
  /** One line — used in the compact eligibility list shown to GPT. */
  summary: string;
  /** Fuller write-up — used in the knowledge-context block and seeded into strategiesTable for the dashboard. */
  rules: string;
}

export const ICT_STRATEGIES: HardcodedStrategy[] = [
  { key: "fair value gap", name: "Fair Value Gap (FVG)", category: "ict", rank: 1,
    summary: "Three-candle imbalance left by a displacement move; price often returns to fill it before continuing.",
    rules: "A three-candle imbalance where candle 1's wick does not overlap candle 3's wick, left behind by a displacement candle. Marks where an institutional order outran available liquidity. Entry: on retracement into the gap (ideally the 50% consequent-encroachment level), in the direction of the displacement. Invalidated if price fully fills and continues through without reaction." },
  { key: "order block", name: "Order Block (OB)", category: "ict", rank: 2,
    summary: "Last opposite-direction candle before a strong displacement move; the origin of the institutional order.",
    rules: "The last down-close candle before a bullish break of structure (or last up-close candle before a bearish break). Considered the footprint of the order that caused the move. Entry: on mitigation (price returning into the OB's body/wick range), ideally with nearby inducement already swept. Stop beyond the OB extreme." },
  { key: "breaker block", name: "Breaker Block", category: "ict", rank: 3,
    summary: "A failed swing point that flips from support to resistance (or vice versa) once structure breaks through it.",
    rules: "Formed when a swing high/low that price failed to hold gets broken by an opposing move — the level flips polarity. Wait for price to return and mitigate the breaker with FVG confluence inside it before entering; stop beyond the breaker's extreme, target the next external liquidity." },
  { key: "liquidity sweep", name: "Liquidity Sweep", category: "ict", rank: 4,
    summary: "A wick that raids resting stops above/below a key level before reversing — the manipulation phase of AMD.",
    rules: "Price wicks through a prior high/low (where stop-loss and breakout orders cluster) and immediately reverses. Never trade the sweep candle itself; wait for confirmation (structure break + FVG) in the reversal direction before entering. A sweep with no reversal confirmation is a trend continuation, not a reversal." },
  { key: "market structure shift", name: "Market Structure Shift (MSS)", category: "ict", rank: 5,
    summary: "A decisive structure break, ideally with an FVG in the break leg, signaling a change in short-term control.",
    rules: "A candle close beyond the most recent counter-trend swing point. Only treated as valid (a 'real' MSS) when the breaking leg contains a Fair Value Gap — without an FVG it is treated as noise/inducement, not a signal." },
  { key: "change of character", name: "Change of Character (CHoCH)", category: "ict", rank: 6,
    summary: "The first break against the prevailing trend — a caution flag, not yet a confirmed reversal.",
    rules: "A close beyond the last higher-low (bullish trend) or lower-high (bearish trend). Signals the current trend is under threat but is NOT itself an entry signal — a confirmed new trend requires two full impulse legs (HH+HL or LL+LH) after the CHoCH." },
  { key: "break of structure", name: "Break of Structure (BOS)", category: "ict", rank: 7,
    summary: "A candle close beyond the prior swing high/low in the direction of the existing trend — continuation confirmation.",
    rules: "Distinct from CHoCH: BOS confirms the existing trend is continuing, so it should never be counter-traded. Must be a close beyond the prior swing extreme, not just a wick — a wick-only break is inducement, not BOS." },
  { key: "accumulation manipulation distribution", name: "Accumulation-Manipulation-Distribution (AMD)", category: "ict", rank: 8,
    summary: "The core repeating cycle: range-bound accumulation, a liquidity-grabbing manipulation wick, then a distribution trend leg.",
    rules: "1) Accumulation: price ranges, equal highs/lows form on both sides. 2) Manipulation: an aggressive sweep of one side of the range traps retail positioning. 3) Distribution: price reverses violently from the sweep and runs to the opposite liquidity — this leg is the only one to trade, entered only after the manipulation grab is confirmed." },
  { key: "market maker buy sell model", name: "Market Maker Buy/Sell Model (MMXM)", category: "ict", rank: 9,
    summary: "The five-phase institutional cycle — consolidation, accumulation, manipulation, reversal, delivery — that frames a full trading range.",
    rules: "Consolidation (stops engineered on both sides) → Accumulation (positions built at a discount/premium) → Manipulation (aggressive stop-run against the intended direction) → Smart Money Reversal (MSS with FVG confirms direction) → Delivery (price runs to the opposite liquidity pool, with pauses along the way)." },
  { key: "optimal trade entry", name: "Optimal Trade Entry (OTE)", category: "ict", rank: 10,
    summary: "The 61.8%-79% Fibonacci retracement zone of the most recent swing — the statistically best entry inside premium/discount.",
    rules: "Measured on the most recent significant swing leg. Entries taken before this zone pay the full cost of temporary price impact (chasing); entries at or beyond it capture the retracement at close to zero execution cost. Combine with FVG/OB confluence inside the same zone for the highest-quality entry." },
  { key: "premium and discount", name: "Premium and Discount", category: "ict", rank: 11,
    summary: "Price above the 50% midpoint of a swing range is premium (sell zone); below is discount (buy zone).",
    rules: "Never buy in premium, never sell in discount — this is a hard filter, not a preference. Combine with OTE: the highest-probability longs are in discount AND at the 61.8-79% retracement; the highest-probability shorts are in premium AND at that same retracement band measured from the opposite side." },
  { key: "algo candle", name: "Algo Candle", category: "ict", rank: 12,
    summary: "A single candle that both sweeps liquidity and leaves an FVG in its body — the highest-conviction single-candle signal.",
    rules: "Grades by how many of five conditions are present: sweeps a prior key level, breaks a strong high/low, has visible inducement nearby, leaves a clear FVG, and forms at a session boundary (London or NY open). All five present justifies the highest confidence tier; the FVG it leaves becomes the primary entry zone." },
  { key: "failure swing", name: "Failure Swing", category: "ict", rank: 13,
    summary: "A new high/low that fails to extend further before reversing — an early, high-value reversal signal.",
    rules: "Bullish: price makes a new low, then fails to make a lower low — buyers are defending, reversal likely. Bearish: price makes a new high, then fails to make a higher high. Best used as a target-quality filter (a failure-swing extreme is a low-resistance liquidity target) as well as an entry trigger." },
  { key: "judas swing", name: "Judas Swing", category: "ict", rank: 14,
    summary: "A false initial move at a session or weekly open designed to trap traders before the real move fires.",
    rules: "Most common at the London open (sweeps the Asia range) and the NY open (a secondary fake move — 'NY trap' — against the London direction before reverting). Never trade the Judas leg itself; wait for the confirmed reversal with structure-break + FVG evidence." },
  { key: "strong high strong low", name: "Strong High / Strong Low", category: "ict", rank: 15,
    summary: "A high or low that caused a manipulation move and broke structure with FVG confirmation — institutionally defended.",
    rules: "A strong high/low is a future liquidity target expected to hold on approach and reverse (institutionally defended). A weak high/low failed to break prior structure and is expected to be swept and taken out rather than defended. Every strong low implies a weak high above it, and vice versa." },
  { key: "inducement", name: "Inducement", category: "ict", rank: 16,
    summary: "A small, visible liquidity pool placed near an order block or breaker that retail is expected to target first.",
    rules: "Validates the OB/breaker it sits near: an OB with visible nearby inducement is treated as institutionally defended; one without it is lower confidence. Entry trigger fires once the inducement is swept AND price returns into the OB/breaker itself." },
  { key: "smt divergence", name: "SMT Divergence", category: "ict", rank: 17,
    summary: "Two correlated pairs diverge at a swing extreme (one makes a new high/low, the other doesn't) — a confirmation filter.",
    rules: "Only usable when both correlated instruments are actually present in the supplied candle evidence — never assumed. A divergence (one pair sets a new extreme, its correlated or inverse pair fails to) adds confirmation weight to a reversal signal but is never a standalone entry trigger." },
  { key: "dealing range equilibrium", name: "Dealing Range / Equilibrium", category: "ict", rank: 18,
    summary: "A range where both buyside and sellside liquidity have already been taken; price is expected to reach the midpoint (EQ) next.",
    rules: "Once both extremes of a range have been swept, bias shifts toward whichever side prints first — bottom forms first implies bullish bias to EQ, top forms first implies bearish bias to EQ. After EQ is reached, anticipate continuation toward the full opposite side of the original range." },
  { key: "2022 entry model", name: "2022 Entry Model", category: "ict", rank: 19,
    summary: "The highest-probability ICT entry sequence: confirmed BMS with FVG, retrace into that FVG, enter at consequent encroachment.",
    rules: "1) Wait for a real break of market structure confirmed by an FVG in the expansion leg. 2) Wait for price to retrace back into that same FVG. 3) Enter at the FVG's 50% (consequent encroachment) or its near edge. 4) Stop beyond the candle that caused the MSS. 5) Target the next major or medium external liquidity." },
  { key: "order flow entry drill", name: "Order Flow Entry Drill (OFED)", category: "ict", rank: 20,
    summary: "An order-block-based entry sequence used as an alternative to the 2022 model when the OB is cleaner than the FVG.",
    rules: "1) After a break of structure, identify the order block that caused it. 2) Wait for price to retrace and mitigate that OB. 3) Enter at the OB's 50% level or extreme. 4) Require a lower-timeframe CHoCH or MSS inside the OB as confirmation. 5) Stop beyond the OB extreme; target the previous swing high/low." },
];

export const QUANT_STRATEGIES: HardcodedStrategy[] = [
  { key: "rsi divergence", name: "RSI Divergence", category: "quant", rank: 21,
    summary: "Price makes a new high/low that the Relative Strength Index fails to confirm — a momentum-exhaustion warning.",
    rules: "Bearish: price prints a higher high while RSI(14) prints a lower high — momentum is fading despite price extension. Bullish: price prints a lower low while RSI prints a higher low. Strongest when it coincides with an ICT liquidity sweep at the same extreme — treat it as a confirmation filter on a structural reversal signal, not a standalone trigger." },
  { key: "macd crossover", name: "MACD Crossover", category: "quant", rank: 22,
    summary: "The MACD line crossing its signal line flags a shift in short-term momentum, especially away from the zero line.",
    rules: "A bullish crossover (MACD line crosses above signal) below the zero line, or a bearish crossover above the zero line, carries more weight than a crossover already extended far from zero (likely late). Use as a timing filter alongside a structural entry model (2022 Model / OFED), not in isolation." },
  { key: "moving average confluence", name: "Moving Average Confluence", category: "quant", rank: 23,
    summary: "Alignment of short, medium and long moving averages (e.g. 20/50/200) in one direction confirms trend regime.",
    rules: "All three averages stacked in order (20 > 50 > 200 for an uptrend, reversed for a downtrend) confirms a trending regime worth trading continuation setups in; a tangled/crossed stack signals a ranging regime where reversal setups (failure swings, liquidity sweeps at range extremes) are favored over continuation ones." },
  { key: "bollinger band squeeze breakout", name: "Bollinger Band Squeeze Breakout", category: "quant", rank: 24,
    summary: "A period of contracting band width (low volatility) followed by an expansion move — volatility mean-reverts.",
    rules: "Band width at a multi-period low signals compressed volatility likely to expand soon. The breakout direction (first strong close outside the bands after a squeeze) should align with the prevailing HTF bias; a breakout against HTF bias is treated as a likely false move / inducement rather than traded directly." },
  { key: "fibonacci retracement confluence", name: "Fibonacci Retracement Confluence", category: "quant", rank: 25,
    summary: "Classical Fib retracement levels (38.2/50/61.8%) that overlap with an ICT FVG or OB carry outsized weight.",
    rules: "Used as a confluence check, not a standalone strategy: when the OTE zone (61.8-79%) coincides closely with a 50% or 61.8% classical Fibonacci retracement of a larger swing, and both overlap an FVG or OB, treat that as the highest-conviction entry zone available." },
  { key: "support resistance flip", name: "Support/Resistance Flip", category: "quant", rank: 26,
    summary: "A broken horizontal support level becomes resistance (or vice versa) — the classical-TA analog of an ICT breaker block.",
    rules: "Identify horizontal levels from prior swing highs/lows that price has tested multiple times. Once decisively broken (candle close, not wick), the level is expected to flip polarity on retest. Strongest when it aligns with an ICT breaker block or order block at the same price." },
  { key: "atr volatility regime filter", name: "ATR Volatility Regime Filter", category: "quant", rank: 27,
    summary: "Trade only when ATR sits in a healthy percentile band — too low means no follow-through, too high means unpredictable whipsaw.",
    rules: "Implemented deterministically in quant-filters.ts (atrPercentile) and gated by bot_config's atrPercentileMin/atrPercentileMax. Below the floor, moves lack the energy to reach target; above the ceiling, stops get run by noise before the setup can play out. This is a hard pre-trade gate, not just a scoring input." },
  { key: "kaufman efficiency ratio trend filter", name: "Kaufman Efficiency Ratio Trend Filter", category: "quant", rank: 28,
    summary: "Ratio of net directional movement to total path length — distinguishes clean trends from choppy noise.",
    rules: "Implemented deterministically in quant-filters.ts and gated by bot_config's efficiencyRatioMin. A ratio near 1 means price moved efficiently in one direction (trend structure is reliable); a ratio near 0 means price churned sideways covering the same ground repeatedly (structure breaks in this regime are more likely to be noise/inducement than real MSS)." },
  { key: "ornstein uhlenbeck mean reversion", name: "Ornstein-Uhlenbeck Mean Reversion", category: "quant", rank: 29,
    summary: "Price pulled toward a rolling equilibrium at a rate proportional to its distance from it — governs reversal timing and target placement.",
    rules: "dC = κ(θ − C)dt + σdW. Mean-reversion pull (κ × distance from equilibrium θ) is strongest when price is furthest extended — this is the mathematical basis for the ICT failure swing and the 3-5 day HTF reversal cycle. Practical use: set Target 2 at the next major external liquidity, not beyond it — a level itself close to an opposing equilibrium will pull price back and erode unrealized profit if the target is set too far past it." },
  { key: "multi timeframe trend alignment", name: "Multi-Timeframe Trend Alignment", category: "quant", rank: 30,
    summary: "D1/H4 directional bias must agree with the H1 entry-timeframe structure before a trade is taken.",
    rules: "Establish bias on D1/H4 first (the HTF draw on liquidity). Only take H1 entries that align with that bias — an H1 setup that contradicts the D1/H4 direction is treated as a lower-timeframe liquidity grab/inducement within the larger move, not an independent trade idea, unless it is itself confirmed by a full HTF CHoCH with two impulse legs." },
];

export const STRATEGY_LIBRARY: HardcodedStrategy[] = [...ICT_STRATEGIES, ...QUANT_STRATEGIES];

/** Compact numbered list — used to build the GPT prompt's eligible-concepts evidence block. */
export function strategySummaryList(): string {
  return STRATEGY_LIBRARY
    .map((s) => `${s.rank}. [${s.category.toUpperCase()}] ${s.name} — ${s.summary}`)
    .join("\n");
}

/** Fuller reference text for the 10 quant/TA strategies — ICT depth already lives in the system prompt itself. */
export function quantKnowledgeContext(): string {
  return QUANT_STRATEGIES
    .map((s, i) => `[${i + 1}] ${s.name}: ${s.rules}`)
    .join("\n\n");
}
