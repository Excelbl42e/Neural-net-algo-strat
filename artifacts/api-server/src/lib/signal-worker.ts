/**
 * AI signal generator worker.
 * Every SIGNAL_INTERVAL_MS, for each configured instrument, asks gpt-5.4 to
 * identify ICT/SMC patterns against a hardcoded strategy library (see
 * strategy-library.ts), and writes signals to the signals table when
 * confidence meets the threshold.
 *
 * GPT-based ICT analysis produces signals; the Node/TypeScript Deriv path is
 * the execution layer.
 */
import { eq, sql, and, or, gte, lt, lte, isNull, desc } from "drizzle-orm";
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
import { placeDerivTrade, getIndicativeCostPct } from "./deriv.js";
import { ALL_FOREX_INSTRUMENTS, getSyntheticSymbol, isForexCode } from "./synthetic-catalog.js";
import { calculateCappedStake, calculateDailyLossCappedStake, applyMultiplierFloor, effectiveRiskPcts, worstCaseLoss, MULTIPLIER_MIN_STAKE } from "./execution-risk.js";
import { forexPreScanGate, tradingCostGate } from "./forex-readiness.js";
import { getNewsEvents } from "./news-calendar.js";
import { scoreConcepts } from "./trade-review.js";
import { claimReason, getExecutionLock } from "./reconciler.js";
import { decryptSecret } from "./crypto.js";
import { getSecret } from "./secrets.js";
import { recordRejection } from "./rejections.js";
import {
  atrPercentile, conceptKey, geometryGate, portfolioGate, preTradeGate, premiumDiscount, runExpertJudge,
  verifyClaims, DEFAULT_THRESHOLDS,
  type AnalysisLevel, type AnalysisResult, type OHLC, type QuantThresholds,
} from "./quant-filters.js";
import { STRATEGY_LIBRARY } from "./strategy-library.js";

// M30 entry timing and 4h–1 day holding do not justify a paid GPT scan
// every five minutes; 30 minutes also lines up with each new M30 candle
// close. Feed and open-contract monitors run on their own schedules.
const SIGNAL_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_CONCEPT_SCORE_THRESHOLD = 0.4;
const DEFAULT_CONCEPT_MIN_SAMPLES = 8;
const DEFAULT_CONCEPT_PRIOR_SAMPLES = 4;
const STRATEGY_LIBRARY_NAME = "NeuralTrade Hardcoded Strategy Library";
// Only forex is traded and analyzed. The bot scans every forex major in the
// catalog unless the account has a custom allowedInstruments allow-list
// (which is itself filtered back down to forex — see below).
const DEFAULT_INSTRUMENTS = ALL_FOREX_INSTRUMENTS;

interface PromptConceptScore {
  name: string;
  category: "ict" | "quant";
  libraryRank: number;
  sampleAdjustedScore: number;
  historicalSamples: number;
}

function boundedEnvNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    logger.warn({ name, raw, fallback }, "Invalid concept-scoring environment setting; using safe default");
    return fallback;
  }
  return value;
}

function mentionsSuppressedConcept(returnedConcepts: string, suppressed: Set<string>): boolean {
  if (!returnedConcepts.trim()) return false;
  return returnedConcepts
    .split(/[,;\n]|\s+and\s+/i)
    .map(conceptKey)
    .filter(Boolean)
    .some((returned) => [...suppressed].some(
      (blocked) => returned === blocked || returned.includes(blocked) || blocked.includes(returned),
    ));
}

let workerRunning = false;
let lastRunAt: Date | null = null;
let lastError: string | null = null;
let signalsGeneratedTotal = 0;
let cachedEnabled: boolean | null = null;
let cachedAutotradeMode: string | null = null;
let activeMode: "auto_demo" | "auto_live" | null = null;
/** Extra confidence a setup must carry before it is worth taking on the stop-less binary path. */
const BINARY_CONFIDENCE_PREMIUM = 0.08;

let activeConfig: { smallAccountMaxRiskPct: number; minConfidence: number } = { smallAccountMaxRiskPct: 10, minConfidence: 0.7 };
let lastLock: { locked: boolean; reason: string | null } = { locked: false, reason: null };
const LOCK_MSG = "Autonomous dispatch waiting: the reconciler is resolving an unresolved Deriv order";

let intervalHandle: ReturnType<typeof setInterval> | null = null;

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
    nextRunAt: lastRunAt ? new Date(lastRunAt.getTime() + SIGNAL_INTERVAL_MS).toISOString() : null,
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

// ── Main analysis call ───────────────────────────────────────────────────────

async function analyzeSymbol(
  symbol: string,
  scoredConcepts: PromptConceptScore[],
  suppressedConcepts: Set<string>,
  knowledgeContext: string,
  minConfidence: number,
  currentPrice: number | null,
  candleContext: string | null,
  performanceFeedback: string | null,
): Promise<AnalysisResult | null> {

  const priceLine = currentPrice != null
    ? `Current market price: ${currentPrice}`
    : "Current market price: unavailable — do not invent price levels; set setup_found false";

  const conceptEvidence = JSON.stringify(scoredConcepts, null, 2);
  const systemPrompt = `You are an ICT (Inner Circle Trader) / SMC (Smart Money Concepts) analyst specialising in spot forex majors traded as Deriv multiplier contracts. Use only the supplied candle evidence and knowledge context. Analyze H4/H1 for directional bias, M30 for entry timing, and target an expected 4-hour to 1-day hold.

═══ CORE FRAMEWORK: THE ALGO MODEL ═══
Markets are engineered by a central bank algorithm (IPDA — Interbank Price Delivery Algorithm). Its only objective: seek liquidity, grab it, reverse. Every move follows: BUILD UP LIQUIDITY → AGGRESSIVE GRAB → REVERSAL → DISTRIBUTION.

─── LIQUIDITY HIERARCHY (most to least important) ───
• MAJOR: Previous weekly highs/lows, previous daily highs/lows, monthly highs/lows, long-term swing H&L
• MEDIUM: Hourly structure highs/lows, equal highs/lows (EQH/EQL)
• MINOR: 15m/5m/1m swing points (use for LTF confirmation only)

─── DRAW ON LIQUIDITY (DOL) — know this FIRST ───
Before any analysis, identify where price is DRAWING TO. Is the DOL bullish (targeting BSL above) or bearish (targeting SSL below)? Never trade against the DOL. DOL = the nearest major liquidity pool in the direction of HTF bias.

═══ WEEKLY CYCLE (forex trades Sun 21:00 UTC – Fri 21:00 UTC; sessions run on NY time) ═══
• Monday: Accumulation OR manipulation — the HOW or LOW of the week often forms Monday
• Tuesday: If Monday was accumulation → Tuesday grabs liquidity to set direction; if Monday swept → Tuesday continuation
• Wednesday: Reaccumulation OR reversal (check if HTF draw has been reached); most reversals happen Wed
• Thursday: Completes what Wednesday started — strong continuation
• Friday: Distribution / profit-taking — do NOT enter new longs at HOW or shorts at LOW on Friday

─── 90-MINUTE CYCLE (from midnight NY) ───
Every 90 minutes from 00:00 NY time, the algo seeks liquidity and may create a significant move. Times: 00:00, 01:30, 03:00, 04:30, 06:00, 07:30, 09:00, 10:30, 12:00, 13:30, 15:00, 16:30, 18:00, 19:30, 21:00, 22:30.

─── DAILY SESSION CYCLE (Asia → London → NY) ───
• ASIA (20:00–00:00 NY): BUILD UP — range forms, equal highs and lows accumulate. The Asia high and Asia low are MEDIUM liquidity.
• FRANKFURT (00:00–02:00 NY): FALSE MOVES — creates fake breakouts to induce traders. Frankfurt high/low = liquidity, not real direction.
• LONDON OPEN (02:00–05:00 NY): AGGRESSIVE GRAB — sweeps Asia low (bullish day) or Asia high (bearish day). The REAL move starts here. London sets HOD or LOD most of the time.
• NY OPEN (07:00–10:00 NY): COMPLETION or NY TRAP — either completes what London started, or creates a fake move (Judas swing) then reverses back into London direction. NY trap = fake BOS at NY open.
• LONDON CLOSE (10:00–12:00 NY): Partial profit-taking; sometimes reversal if London overdone.

═══ AMD — ACCUMULATION, MANIPULATION, DISTRIBUTION ═══
The most powerful repeating model on every timeframe:
1. ACCUMULATION: Price consolidates in a range. EQH/EQL form on both sides (visible liquidity pools). Smart money builds positions quietly.
2. MANIPULATION (Judas Swing): Price aggressively sweeps ONE side of the range (stops below lows = SSL grab for bullish, or stops above highs = BSL grab for bearish). This is the TRAP for retail.
3. DISTRIBUTION: Price violently reverses from the swept level and runs to the OPPOSITE liquidity. THIS is the leg to enter and ride.

Rule: ONLY trade the Distribution leg, AFTER the Manipulation grab is confirmed.

═══ STRONG vs WEAK HIGHS AND LOWS ═══
• STRONG HIGH: The high that caused a manipulation move AND broke structure below it (with FVG in the expansion leg). Strong highs are targets for future BSL raids then reversals.
• STRONG LOW: The low that caused a manipulation move AND broke structure above it (with FVG in expansion). Strong lows are SSL targets then reversals.
• WEAK HIGH: A high that FAILED to break any prior low. It will be taken out eventually as a liquidity grab.
• WEAK LOW: A low that FAILED to break any prior high. It will be targeted as a grab then reversed.
Rule: For every Strong Low there is a Weak High above it. For every Strong High there is a Weak Low below it.

═══ REAL vs FAKE BREAK OF MARKET STRUCTURE ═══
• REAL BMS (valid): The expansion candle that broke structure MUST contain a Fair Value Gap (FVG). Close below the swing low is preferred but not required if FVG is present. After real BMS → price retraces to the FVG = entry.
• FAKE BMS (trap): No FVG in the expansion leg that "broke" structure = it is a retail trap. Do NOT enter. Wait for price to reverse.
• ALGO CANDLE (strongest signal): A single candle that BOTH grabs liquidity (sweeps a high/low) AND leaves an FVG immediately after it. This is the highest-probability confluence — the algo has collected orders and repositioned.

═══ INSTITUTIONAL ORDER FLOW ENTRY MODELS ═══
After identifying a valid MSS/BMS with FVG confirmation, use ONE of these three entry models:

MODEL 1 — "2022 MODEL" (highest probability):
1. Wait for real BMS confirmed by FVG in the expansion leg
2. Price retraces back INTO the FVG created in that expansion
3. Enter at the CE (Consequent Encroachment = 50% of the FVG) or FVG high (shorts) / FVG low (longs)
4. Stop: beyond the candle that grabbed liquidity and created the MSS
5. Target: next major/medium external liquidity

MODEL 2 — "OFED" (Order Flow Entry Drill):
1. After BOS, identify the OB (last down-close candle before bullish BOS, or last up-close candle before bearish BOS)
2. Wait for price to retrace and mitigate that OB
3. Enter at the 50% or low of the OB (for longs) / 50% or high of OB (for shorts)
4. Confirmation: LTF CHoCH or MSS within the OB
5. Stop: below the OB low (longs) / above OB high (shorts)
6. Target: previous swing high/low (external liquidity)

MODEL 3 — "BREAKER + FVG":
1. Identify a failed swing: price made a new high, then broke BELOW the low that made that new high (bearish breaker) — or new low then broke ABOVE the high that made that new low (bullish breaker)
2. That swing low (bearish) / swing high (bullish) becomes the BREAKER BLOCK
3. Wait for price to return and mitigate the breaker block
4. Require FVG confluence inside the breaker
5. Stop: beyond the extreme of the breaker block
6. Target: next external liquidity in the breaker direction

═══ PREMIUM / DISCOUNT ZONES & OTE ═══
• Reference range: Most recent swing high (H) to swing low (L)
• DISCOUNT (buy zone): Price below 50% of range (Fibonacci 0.5 level and below) — look for longs here
• PREMIUM (sell zone): Price above 50% of range — look for shorts here
• OTE (Optimal Trade Entry): 61.8%–79% Fibonacci retracement — the highest probability entry inside premium/discount
• NEVER buy in premium. NEVER sell in discount. If price is in the wrong zone, wait.

═══ DEALING RANGE ═══
A range where BOTH buyside AND sellside liquidity have been taken. After both sides swept:
• Look for the bottom to form → bullish bias to dealing range EQ (equilibrium/midpoint)
• Or look for top to form → bearish bias to dealing range EQ
• After EQ reached, anticipate continuation to the full opposite side

═══ MARKET MAKER BUY/SELL MODEL (MMXM) ═══
BULLISH (Buy Model):
Phase 1 — Original Consolidation: Engineers pending SSL below and BSL above
Phase 2 — Accumulation: Buy orders filled at discount through accumulation
Phase 3 — Manipulation: AGGRESSIVE grab of SSL (sell stops below the range lows)
Phase 4 — SMR (Smart Money Reversal): MSS with FVG in expansion → buy signal
Phase 5 — Buyside Delivery: Price runs to BSL targets; re-accumulation pauses along the way

BEARISH (Sell Model):
Phase 1 — Original Consolidation: Engineers BSL and SSL
Phase 2 — Accumulation: Short orders filled at premium through re-accumulation
Phase 3 — Manipulation: AGGRESSIVE grab of BSL (buy stops above range highs)
Phase 4 — SMR: MSS below swing low with FVG → sell signal
Phase 5 — Sellside Delivery: Price runs to SSL targets; redistribution pauses along the way

═══ INTERNAL vs EXTERNAL LIQUIDITY ═══
• INTERNAL liquidity: EQH/EQL, FVGs, OBs, volume imbalances WITHIN a current range — these are swept during manipulation
• EXTERNAL liquidity: The HIGH or LOW of the entire leg (BSL above / SSL below) — this is the TARGET after the sweep

═══ HTF LIQUIDITY CYCLE ═══
Background context only — these are multi-day/multi-week cycles, longer than the H4/H1/M30 data you're actually given and longer than this trade's 4-hour to 1-day horizon. Do not count D1 candles or claim a specific day-count since no D1 series is supplied; use this only as a reason to be more cautious about counter-trend entries if the H4 structure you CAN see already looks stretched.
• Every 3–5 trading days, price changes direction (short-term algo cycle) — an informal reason for caution on an H4 trend that already looks extended, not something to count directly from unsupplied D1 data
• Every 20–40–60–90 days: major pivots (IPDA data range lookback)
• After a major liquidity grab + momentum shift, the next reversal typically occurs within 20 days

═══ FAILURE SWING ═══
• Bullish failure swing: Price makes a new low, then FAILS to create another lower low → buyers are defending → bullish reversal incoming
• Bearish failure swing: Price makes a new high, then FAILS to create a new higher high → sellers defending → bearish reversal

═══ OHLC-ONLY CANDLE HEURISTICS ═══
The supplied candles contain OHLC and UTC timestamps only. They do not contain verified volume, order flow, spread, order-book data, news, or evidence of operator intent. The flags below are mechanical comparisons within each supplied timeframe series; they are not proof of institutional activity, a liquidity sweep, or an FVG.

[DISPLACEMENT] — Candle body is greater than 2× the mean body size across the supplied series. It describes relative candle range only.

[ALGO_CANDLE] — A [DISPLACEMENT] candle whose direction-opposed wick is greater than 50% of its body. This is a wick/body heuristic only; verify any claimed sweep or FVG directly from the supplied OHLC sequence.

[ACCUMULATION] — The current and immediately preceding candle bodies are each below 0.4× the mean body size across the supplied series. This is a small-body heuristic only; it does not establish intent or equal highs/lows.

Usage rules:
- Confirm a structure break or FVG from the actual supplied OHLC values, not from a flag alone.
- Treat these flags as supporting descriptions, not evidence of an institutional order or a complete AMD sequence.
- Never invent volume, spread, order-flow, sweep, session, or FVG evidence that is not visible in the supplied data.

═══ ACADEMIC MICROSTRUCTURE FILTERS (Cartea, Jaimungal & Penalva — Cambridge, 2015) ═══
These five principles derive from stochastic optimal control and LOB microstructure research and directly validate — and sharpen — the ICT framework:

PRINCIPLE 1 — PERMANENT vs TEMPORARY PRICE IMPACT (Kyle 1985 / Glosten-Milgrom 1985):
Every price move has two components: PERMANENT impact (the efficient price shifts — a new informed order permanently changed fair value) and TEMPORARY impact (execution noise from liquidity traders that quickly mean-reverts). The FVG is the physical signature of PERMANENT impact — the region where the institutional algo had to execute faster than the LOB could absorb, leaving an unfilled gap. A BMS with a visible FVG = permanent price impact confirmed = follow it. A BMS with NO FVG = temporary impact only = retail noise = fade or skip.

PRINCIPLE 2 — ADVERSE SELECTION & ORDER IMBALANCE (Glosten-Milgrom / Cartea Ch.12):
The underlying research measures order imbalance from real order-book/order-flow data: when order flow is BUY-HEAVY (more buy market orders than sell orders arriving = bid > ask side dominance), future price jumps are biased UPWARD by ~28% more often than neutral; SELL-HEAVY biases downward 21% more often. The candles supplied to you carry no real order-flow, order-book, or volume data — large candle body is used here only as a PROXY for that imbalance, not a measurement of it. Apply it as a lower-confidence heuristic: a bullish DISPLACEMENT candle with a large body is treated as buy-heavy-regime evidence, making the resulting FVG/OB a higher-quality entry zone; a bearish DISPLACEMENT with large body is treated as sell-heavy-regime evidence for shorts. Weak, small-body breakouts get no imbalance-regime credit either way. Never state in your reasoning that order flow or order-book imbalance was directly observed — only that the candle-body proxy suggests it.

PRINCIPLE 3 — VOLUME-VOLATILITY CLUSTERING & SESSION TIMING (Cartea Ch.3-4):
Empirically: spreads are WIDEST at market open (high uncertainty, informed + noise traders both active), narrow through mid-session, then narrow again at close. Volume is U-shaped: peak at open, trough at mid-day, peak at close. Implication for entry timing: the London/NY sweep (Manipulation phase) fires at the SESSION OPEN spike. Do NOT enter on the very first candle of the session — that is the maximum-noise environment. Wait 1-3 candles (30-90 minutes) for the sweep to complete and the spread/noise to decline. The best entry candle is 1-3 periods AFTER the ALGO_CANDLE prints, when order imbalance has stabilised and the retracement into FVG begins.

PRINCIPLE 4 — OPTIMAL EXECUTION & OTE ENTRY (Almgren-Chriss / Cartea Ch.6):
The Optimal Trade Entry (OTE, 61.8–79% Fibonacci retracement) is mathematically equivalent to the stochastic optimal control solution for minimising execution cost while capturing a directional trend. Trading at OTE = the agent is waiting for temporary price impact to fully dissipate (the retracement) before the permanent impact trend resumes. Entering before OTE = paying the full execution cost = suboptimal. Entering AT OTE or deeper into the FVG = near-zero temporary impact cost = maximum expected profit per unit of risk. Never chase — let price retrace to OTE/FVG then enter.

PRINCIPLE 5 — ORNSTEIN-UHLENBECK MEAN REVERSION & FAILURE SWING TIMING (Cartea Ch.11):
Price around a mean-reverting level follows an OU process: dC = κ(θ − C)dt + σdW. The mean-reversion speed κ is HIGHEST when price is far from equilibrium. This mathematically explains the failure swing: when price makes a new high but FAILS to make a higher high, the OU pull (κ × distance) has overcome the trend drift (μ). This is the precise moment to enter a reversal. Exit your position BEFORE price reaches a distant liquidity pool (BSL/SSL) that is itself close to an opposite OU equilibrium — the mean-reversion force there will pull price back, cutting your profit. Always set Target 2 at the next MAJOR external liquidity (HOW/LOW), not beyond it. The OU model also validates the 3-5 day cycle: κ typically restores price to equilibrium within 3-5 trading days — perfectly matching the HTF liquidity cycle observation.

INTEGRATION RULES (apply these alongside ICT):
- FVG confirmation = REQUIRED (Principle 1: permanent impact). No FVG = no trade.
- DISPLACEMENT candle present = REQUIRED for real BMS (Principle 2: buy/sell-heavy imbalance regime confirmed)
- Enter 1–3 candles AFTER the sweep completes, NOT on the sweep candle itself (Principle 3)
- Entry must be at OTE (61.8–79%) or inside the FVG (Principle 4: optimal execution)
- Target = next major external liquidity; set TP there, not beyond it (Principle 5: OU reversion at target)

═══ MULTI-SOURCE ICT CONFLUENCE LIBRARY ═══
Distilled from four trading textbooks. Each rule below adds precision NOT already covered above.

▸ BOS vs CHoCH — PRECISE CANDLE-CLOSE RULES (Vasiliy Trader / SMC):
• BOS = candle CLOSE above the prior HH (bullish) or below prior LL (bearish). Wick-only = NOT a BOS — it is inducement/trap. BOS signals trend continuation: DO NOT counter-trade it.
• CHoCH = candle CLOSE below the last HL (bullish trend violated) or above the last LH (bearish trend violated). CHoCH alone ≠ new trend. A confirmed new trend requires TWO impulse legs forming HH+HL (bullish) or LL+LH (bearish). Treat first CHoCH as a caution flag, not an entry signal.
• TRAP setup: price CHoCHs above an old high (or below an old low) then FAILS to post a new HH/LL → retail is caught → this is the ideal reversal entry after the HL/LH forms. Wait for that HL/LH to confirm before entry.
• ZONE FLIP: when a supply zone is broken (candle CLOSE above it) → it flips to DEMAND. When a demand zone is broken (candle CLOSE below it) → it flips to SUPPLY. A flipped zone + overlapping FVG = very high probability entry.

▸ LRLR vs HRLR — TARGET QUALITY FILTER (LumiTraders ICT 2022):
• LRLR (Low Resistance Liquidity Run) = liquidity that price sweeps with minimal friction. These are the PREFERRED targets — fast, "knife through butter" moves.
  - In bullish context: a failure swing HIGH (high that failed to exceed prior high) = LRLR above → target it.
  - In bearish context: a failure swing LOW (low that failed to exceed prior low) = LRLR below → target it.
• HRLR (High Resistance Liquidity Run) = liquidity guarded by many obstacles. Expect slow grinding moves. Only target HRLR if the nearest LRLR has already been swept.
• RULE: always aim for the nearest LRLR as Target 1. Set Target 2 at the next external LRLR (HOW/LOW/previous week H or L). Never force a trade toward a HRLR as Target 1.

▸ ALGO CANDLE (AC) — STRENGTH GRADING (ICT Algo Concept Book):
Algo Candle = a single candle that SIMULTANEOUSLY sweeps liquidity (wick raids a key H/L) AND leaves a FVG in its body. This makes the high or low it created INSTITUTIONALLY DEFENDED (strong high/strong low).
VERY STRONG Algo Candle — all five must be present (justifies confidence ≥ 0.90):
  1. Sweeps a prior key high/low (liquidity grab wick)
  2. Breaks a STRONG high or low = momentum shift
  3. Has INDUCEMENT visible near the resulting OB (a small swing point retail will target)
  4. Leaves a clear FVG in the expansion body
  5. Forms at a SESSION boundary (London open or NY open high/low)
When all five are present the FVG left by this candle is the PRIMARY entry zone. No other confirmation needed.

▸ INDUCEMENT → OB VALIDITY (ICT Algo Concept Book):
Inducement = a small, visible liquidity pool (weak swing) positioned CLOSE TO the Order Block.
Rule: OB with nearby inducement = VALID (institutional orders defending it). OB with no inducement = lower confidence. When inducement gets swept AND price returns to the OB → entry trigger is active.

▸ STRICT PRICE DELIVERY SEQUENCE (ICT Algo Concept Book):
The algo ALWAYS follows: CONSOLIDATION → EXPANSION → (RETRACEMENT or REVERSAL).
Forbidden sequences: Consolidation→Consolidation, Consolidation→Reversal (without Expansion first), Expansion→Consolidation (without Retracement first).
Implication for entries: after a consolidation phase the NEXT move is ALWAYS expansion — trade it. After expansion, wait for retracement to OB/FVG before entering the continuation. NEVER enter mid-expansion from the open of the expansion candle — wait for the retracement.

▸ POWER OF THREE — PRECISE SESSION WINDOWS (LumiTraders ICT 2022):
Asia (20:00–00:00 NY)    → Consolidation = Price Equilibrium. Asia H/L = medium liquidity targets.
00:00–05:00 NY           → Manipulation = Judas Swing fires, sweeps Asia H or L. HOD/LOD most often forms here.
05:00–08:00 NY           → Consolidation return. DO NOT open new positions in this window.
08:00–08:30 NY           → Retracement pullback to OB/FVG from the London move. Ideal re-entry window.
08:30–11:00 NY           → NY Expansion: either continuation of London OR NY reversal trap (Judas Swing 2).
After 11:00 NY           → Distribution/profit-taking. Avoid new entries after 11am unless supplied candles show a clear valid setup.
WEEKLY: Bullish = expect Judas Swing BELOW weekly open Mon–Wed (week LOW forms Tue–Wed typically). Enter AFTER the low is confirmed + price reclaims weekly open. Bearish = opposite.

▸ SMART MONEY REVERSAL (SMR) TYPES (LumiTraders ICT 2022):
Type 1 (IDEAL): price sweeps BSL above old high → immediately breaks below old swing low with FVG in the expansion leg. Strongest reversal. FVG in that expansion leg = entry zone.
Type 2: price fails to reach previous high (lower high) → then breaks below old swing low with FVG. Valid but less aggressive. Requires FVG confirmation just like Type 1.
SMT Divergence: for extra confirmation, check a correlated forex pair sharing a leg (e.g. EURUSD vs GBPUSD, or an inverse pair like EURUSD vs USDCHF). If one makes a new high but the other makes a lower high → bearish SMT divergence → reversal signal is validated. Only use a pair actually supplied in the candle evidence — do not claim to have observed a pair that was not provided.

▸ FVG DIRECTION FILTER AT RETRACEMENT (LumiTraders ICT 2022):
When price returns INTO a FVG zone — do NOT enter on the first touch. Wait for the reaction candle:
  - DISPLACEMENT candle UP from inside FVG → bullish confirmation → price heading to BSL (external target). Enter long.
  - Price displaces DOWN through and beyond the FVG (full fill + continuation) → bearish → heading to SSL. Enter short or exit any longs.
  - Engulfing / V-shape reaction = strong conviction, entry valid.
  - Weak drift with no decisive candle = low conviction, DO NOT enter, wait for next candle.

▸ HTF FVG HIERARCHY (ICT Algo Concept Book):
HTF FVG (H4/H1) > entry-timeframe FVG (M30) in magnetic force.
When price approaches an H4 FVG, expect a strong reaction; a fully-filled H4 FVG has HIGH probability of reversal.
Always mark H4 FVGs first, then H1 FVGs. Only use the M30 FVG for entry precision inside the HTF zone.

▸ BREAK-EVEN SL MANAGEMENT (ICT Algo Concept Book):
Once price breaks structure in your direction (first BOS after entry), consider moving SL to break-even (entry price). Do not claim an outcome unless it is shown by the supplied candles.

═══ KEY RULES FOR FOREX ═══
Eligible strategy-library concepts and persisted sample-adjusted scores (structured evidence; ranks are fixed priority order from the hardcoded strategy library, not a live measurement):
${conceptEvidence}
- Prefer concepts with a lower (higher-priority) library rank and higher sample-adjusted historical score. Do not use a concept absent from this eligible list.
- Real institutional market: news events and spread widen at session opens and around high-impact releases — this signal was only generated because the code-side news blackout and session gate already passed for this instrument at scan time; still favour setups AWAY from the immediate post-release spike.
- Forex is closed Sat 00:00 UTC – Sun 21:00 UTC and thinly traded right at that reopen; a setup at the very start of the week deserves extra caution.
- EURUSD/GBPUSD: highest liquidity, tightest cost, cleanest London/NY structure.
- USDJPY: watch for BoJ-driven volatility spikes distinct from pure ICT structure.
- GBPJPY: wider ranges and faster liquidity grabs than the USD majors — widen the noise-stop assumption accordingly.

CRITICAL RULES:
- EVIDENCE BOUNDARY: the supplied data is OHLC and UTC timestamps only. Do not state that volume, order flow, order-book depth, institutional intent, or an unprovided timeframe was observed. Treat theoretical/microstructure descriptions above as hypotheses, not facts about these candles. Verify every claimed sweep, structure break, FVG, session time, stop, and target against supplied values; otherwise do not claim it.
- NEVER trade if DOL is unclear — always identify DOL first
- Only enter Distribution phase (after confirmed Manipulation grab)
- Real BMS requires FVG in the expansion leg — no FVG = fake, skip it
- Stop MUST be beyond the liquidity grab candle extreme (the wick that swept stops)
- Stop distance minimum 0.3% of price — tighter = noise level, will be stopped out
- Entry must be in premium zone for shorts, discount for longs
- OTE (61.8–79% fib) = highest probability entry within the zone
- 3–5 day cycle awareness: if 4+ days of trending without deep pullback, reversal probability high
- Only fire if confidence ≥ 0.70 and ALL conditions align

CONFIDENCE CALIBRATION:
Return a conservative confidence based on observable evidence in the supplied candles and knowledge. Confidence is recorded for signal quality reporting only; it does NOT increase stake size. A 0.95 score requires all listed structural conditions to be observable, not merely inferred. If any filter is missing or unclear, report lower confidence.

Respond ONLY with valid JSON matching this schema (no prose outside JSON):
{
  "setup_found": boolean,
  "direction": "buy" | "sell",
  "confidence": number (0.0–1.0),
  "entry_zone": string (human-readable, e.g. "31200–31350"),
  "target_zone": string,
  "stop_zone": string,
  "entry_low":  number,
  "entry_high": number,
  "stop_level": number,
  "target1":    number,
  "target2":    number (or same as target1 if only one),
  "levels": [
    { "kind": "fvg"|"ob"|"sweep"|"level", "low": number, "high": number, "label": string }
  ],
  "concepts_detected": string (comma-separated ICT concept names that fired),
  "reasoning": string (3–5 sentences: state the DOL, the liquidity grabbed, the entry model used, and why the setup is valid)
}
All numeric levels MUST be realistic prices anchored to current market price and candle data.
If the DOL is unclear, BMS has no FVG confirmation, or entry is in wrong premium/discount zone → set setup_found false, confidence below 0.5. Do not force a trade.`;

  const candleSection = candleContext
    ? `\nCandle data for ${symbol} — annotated with HFT statistical flags [DISPLACEMENT/ALGO_CANDLE/ACCUMULATION]:\n${candleContext}\n`
    : "";

  const performanceSection = performanceFeedback
    ? `\nBot self-learning — past trade performance (use this to guide concept selection):\n${performanceFeedback}\n`
    : "";

  const userPrompt = `Symbol: ${symbol}
${priceLine}
Expected hold: 4 hours to 1 day. Use H4/H1 candles for directional bias and M30 candles for entry timing. Do not assume a multi-day hold or refer to candle intervals not present below. Make every price claim traceable to the supplied data.
${candleSection}${performanceSection}
Hardcoded strategy library reference (ICT concept index + full quant/TA strategy rules):
---
${knowledgeContext}
---

TOP-DOWN ANALYSIS STEPS (work through these in order):
1. H4/H1 STRUCTURE & BIAS: Use only supplied H4/H1 candles. State observable swing structure and nearest supported liquidity draw; do not invent a level from a longer lookback absent from the series.
2. DOL: Identify the nearest supported buyside or sellside liquidity level from supplied H4/H1 candles and state why.
3. HTF BIAS: Assess H4/H1 direction and note whether an FVG-confirmed structure break is actually visible in those candles.
4. PHASE: Assess accumulation/manipulation/distribution only when the supplied candles support it; otherwise skip.
5. PREMIUM/DISCOUNT: Use a visible supplied swing range; if one cannot be identified, do not force a setup.
6. ENTRY TIMING: Use supplied M30 candles to assess retracement/reaction and select an entry; do not claim session or intraday evidence that the M30 timestamps/data do not show.
7. STOPS & TARGETS: Anchor stop and target to levels visible in supplied data. Target a plausible 4-hour to 1-day move, not a multi-day projection.

Apply these steps, use the candle data as evidence, then respond with your JSON.`;

  try {
    const response = await getOpenAI().chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 1024,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    // response_format: json_object should make the API itself guarantee
    // valid, complete JSON in content. This runs through a configurable AI
    // integration proxy (AI_INTEGRATIONS_OPENAI_BASE_URL), not necessarily
    // api.openai.com directly, so keep the old brace-match extraction as a
    // fallback in case that proxy doesn't honor response_format — evidence
    // label: code review only, not verified against the live endpoint.
    const raw = response.choices[0]?.message?.content ?? "";
    if (!raw.trim()) return null;
    const jsonSource = raw.trim().startsWith("{") ? raw : (raw.match(/\{[\s\S]*\}/)?.[0] ?? raw);

    const parsed = JSON.parse(jsonSource);
    if (
      !parsed.setup_found
      || !Number.isFinite(Number(parsed.confidence))
      || Number(parsed.confidence) < 0
      || Number(parsed.confidence) > 1
      || Number(parsed.confidence) < minConfidence
    ) return null;
    if (!["buy", "sell"].includes(parsed.direction)) return null;
    const returnedConcepts = String(parsed.concepts_detected ?? "");
    if (mentionsSuppressedConcept(returnedConcepts, suppressedConcepts)) {
      logger.info({ symbol, returnedConcepts }, "Signal rejected because it explicitly claimed a suppressed concept");
      return null;
    }
    const eligibleConceptKeys = new Set(scoredConcepts.map((concept) => conceptKey(concept.name)));
    const returnedConceptKeys = returnedConcepts.split(/[,;\n]|\s+and\s+/i).map(conceptKey).filter(Boolean);
    if (returnedConceptKeys.some((concept) => !eligibleConceptKeys.has(concept))) {
      logger.info({ symbol, returnedConcepts }, "Signal rejected because it claimed a concept not eligible for this prompt");
      return null;
    }

    const num = (v: unknown): number | null => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const rawLevels = Array.isArray(parsed.levels) ? parsed.levels : [];
    const levels: AnalysisLevel[] = rawLevels
      .map((l: { kind?: string; low?: unknown; high?: unknown; label?: unknown }) => ({
        kind: ["fvg", "ob", "sweep", "level"].includes(String(l.kind)) ? (l.kind as AnalysisLevel["kind"]) : "level",
        low: num(l.low),
        high: num(l.high),
        label: l.label != null ? String(l.label) : undefined,
      }))
      .filter((l: { low: number | null; high: number | null }) => l.low != null && l.high != null) as AnalysisLevel[];

    return {
      direction: parsed.direction,
      confidence: Math.min(1, Math.max(0, Number(parsed.confidence))),
      entryZone: String(parsed.entry_zone ?? ""),
      targetZone: String(parsed.target_zone ?? ""),
      stopZone: String(parsed.stop_zone ?? ""),
      entryLow: num(parsed.entry_low),
      entryHigh: num(parsed.entry_high),
      stopLevel: num(parsed.stop_level),
      target1Level: num(parsed.target1),
      target2Level: num(parsed.target2),
      levels,
      conceptsDetected: returnedConcepts,
      reasoning: String(parsed.reasoning ?? ""),
    };
  } catch (err) {
    logger.error({ symbol, err }, "OpenAI analysis failed");
    return null;
  }
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

async function recordGeneratedReason(signalId: number, reason: string): Promise<void> {
  await db
    .update(signalsTable)
    .set({ executionStatus: "generated", executionReason: reason })
    .where(and(eq(signalsTable.id, signalId), eq(signalsTable.executionStatus, "generated")));
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
}

let dispatchQueue: Promise<void> = Promise.resolve();

interface ForexDispatchParams {
  killzones: string;
  newsBlackoutBeforeMin: number;
  newsBlackoutAfterMin: number;
  maxSpreadCostPct: number;
}

async function dispatchTrade(
  signal: SignalRow,
  riskPerTradePct: number,
  maxConcurrentPositions: number,
  maxDailyLossPct: number,
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
    await dispatchTradeUnlocked(signal, riskPerTradePct, maxConcurrentPositions, maxDailyLossPct, forex);
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
  maxDailyLossPct: number,
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
    });
    if (!preDispatch.ok) {
      await recordGeneratedReason(signal.id, preDispatch.reason ?? "Forex readiness gate failed");
      recordRejection({ symbol: signal.symbol, stage: "forex_readiness", reason: preDispatch.reason ?? "Forex readiness gate failed" });
      logger.warn({ symbol: signal.symbol, reason: preDispatch.reason }, "Forex readiness gate refused dispatch");
      return;
    }
  }

  if (conn.accountId == null) {
    await recordGeneratedReason(signal.id, "Connected demo broker has no linked account");
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
  // Balance-adaptive ceiling. The configured percentages are what the operator
  // is willing to risk; the band is what the balance can survive. The lower of
  // the two applies, so a setting that made sense at $5 tapers on its own as
  // the account grows instead of waiting to be remembered.
  const eff = effectiveRiskPcts(equity, riskPerTradePct, maxDailyLossPct);
  if (eff.riskCappedByBand || eff.dailyCappedByBand) {
    logger.info(
      { symbol: signal.symbol, equity, band: eff.band, configuredRiskPct: riskPerTradePct, appliedRiskPct: eff.riskPct,
        configuredDailyLossPct: maxDailyLossPct, appliedDailyLossPct: eff.dailyLossPct, why: eff.why },
      "Balance band tightened the configured risk settings",
    );
  }
  const sizing = calculateCappedStake({
    equity,
    riskPerTradePct: eff.riskPct,
    maxConcurrentPositions,
    openPositions: openRow?.count ?? Number.NaN,
    smallAccountMaxRiskPct: activeConfig.smallAccountMaxRiskPct,
  });
  if (!sizing.ok) {
    await recordGeneratedReason(signal.id, `Risk sizing refused trade: ${sizing.reason}`);
    recordRejection({ symbol: signal.symbol, stage: "sizing", reason: sizing.reason, metrics: { equity } });
    logger.warn({ symbol: signal.symbol, equity, reason: sizing.reason }, "Risk sizing refused trade");
    return;
  }
  if (!Number.isFinite(maxDailyLossPct) || maxDailyLossPct <= 0 || maxDailyLossPct > 100) {
    const reason = "Maximum daily loss percentage is missing or invalid; refusing execution";
    await recordGeneratedReason(signal.id, reason);
    logger.warn({ symbol: signal.symbol, maxDailyLossPct }, reason);
    return;
  }

  const now = new Date();
  const utcDayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const utcNextDay = new Date(utcDayStart.getTime() + 24 * 60 * 60 * 1000);
  let closedToday: Array<{ pnl: string | null; closedAt: Date | null; lotSize: string | null }>;
  let openTrades: Array<{ lotSize: string }>;
  try {
    closedToday = await db
      .select({ pnl: tradesTable.pnl, closedAt: tradesTable.closedAt, lotSize: tradesTable.lotSize })
      .from(tradesTable)
      .where(and(
        eq(tradesTable.accountId, conn.accountId),
        eq(tradesTable.status, "closed"),
        or(
          isNull(tradesTable.closedAt),
          and(gte(tradesTable.closedAt, utcDayStart), lt(tradesTable.closedAt, utcNextDay)),
        ),
      ));
    openTrades = await db
      .select({ lotSize: tradesTable.lotSize })
      .from(tradesTable)
      .where(and(eq(tradesTable.accountId, conn.accountId), eq(tradesTable.status, "open")));
  } catch (err) {
    const reason = "Daily loss guard could not load today's closed P&L and open-trade exposure; refusing execution";
    await recordGeneratedReason(signal.id, reason);
    logger.error({ symbol: signal.symbol, accountId: conn.accountId, err }, reason);
    return;
  }

  // A settled trade whose P&L could not be determined (Deriv returned no
  // profit and no sell price, or the stored stake is unusable) used to refuse
  // every subsequent trade until the next UTC midnight. That is the wrong
  // trade-off: the guard exists to bound losses, and halting the account for
  // the rest of the day is a far bigger cost than the gap it is reacting to.
  // Count it at its true worst case instead — a full loss of the stake — which
  // is conservative for the budget and keeps the system running. Same for a
  // closed row with no timestamp, which used to block trading permanently
  // rather than only for the day, since such a row is never aged out.
  let realizedPnlToday = 0;
  let unknownSettlements = 0;
  for (const trade of closedToday) {
    const pnl = trade.pnl == null ? Number.NaN : Number(trade.pnl);
    if (Number.isFinite(pnl) && trade.closedAt != null) {
      realizedPnlToday += pnl;
      continue;
    }
    unknownSettlements++;
    const stake = Number(trade.lotSize);
    // No usable stake either: charge the largest stake this balance could have
    // funded, so an unreadable row can never understate the day's damage.
    const assumedLoss = Number.isFinite(stake) && stake > 0 ? stake : equity * eff.riskPct / 100;
    realizedPnlToday -= assumedLoss;
  }
  if (unknownSettlements > 0) {
    logger.warn(
      { symbol: signal.symbol, accountId: conn.accountId, unknownSettlements, realizedPnlToday },
      "Daily loss guard counted settlements with unknown P&L as full-stake losses; check the trade ledger",
    );
  }
  const openWorstCaseStake = openTrades.reduce((total, trade) => {
    const stake = Number(trade.lotSize);
    return Number.isFinite(stake) && stake >= 0 ? total + stake : Number.NaN;
  }, 0);
  const dailyLossSizing = calculateDailyLossCappedStake({
    equity,
    maxDailyLossPct: eff.dailyLossPct,
    realizedPnlToday,
    openWorstCaseStake,
    currentStakeCap: sizing.stake,
  });
  if (!dailyLossSizing.ok) {
    await recordGeneratedReason(signal.id, `Daily loss guard refused trade: ${dailyLossSizing.reason}`);
    logger.warn(
      { symbol: signal.symbol, equity, maxDailyLossPct, realizedPnlToday, openWorstCaseStake, reason: dailyLossSizing.reason },
      "Daily loss budget refused trade",
    );
    return;
  }

  // Last step, after both caps, because the daily-loss guard can shrink a stake
  // back under $1.00 and undo the lift otherwise. Under $1.00 Deriv opens a
  // binary, which has no stop-loss — so the smaller stake is the riskier order,
  // and lifting to $1.00 lowers money at risk rather than raising it.
  const floored = applyMultiplierFloor({ stake: dailyLossSizing.stake, equity });
  const stakeAmount = floored.stake;
  const forceBinary = stakeAmount < MULTIPLIER_MIN_STAKE;
  if (floored.lifted) {
    logger.info({ symbol: signal.symbol, equity, from: dailyLossSizing.stake, to: stakeAmount, reason: floored.reason }, "Stake lifted to the multiplier floor");
  }
  logger.info(
    {
      symbol: signal.symbol,
      equity,
      stakeAmount,
      band: eff.band,
      contract: forceBinary ? "binary" : "multiplier",
      worstCaseLoss: worstCaseLoss(stakeAmount, forceBinary ? "binary" : "multiplier"),
      riskCap: sizing.cap,
      dailyLossRemaining: dailyLossSizing.remainingBudget,
      slots: sizing.slots,
      confidence: signal.confidence,
    },
    "Strict trade and daily-loss caps computed; confidence does not increase stake",
  );

  // A binary has no stop-loss, no take-profit and no partial exit: a loser
  // costs the whole stake, where a multiplier of the same size costs its stop.
  // Paying that much more for being wrong is only worth it on a stronger setup,
  // so the binary path asks for more evidence than the multiplier path does.
  if (forceBinary) {
    const confidence = parseFloat(signal.confidence);
    const required = Math.min(0.98, activeConfig.minConfidence + BINARY_CONFIDENCE_PREMIUM);
    if (!Number.isFinite(confidence) || confidence < required) {
      const reason = `Binary fallback needs confidence >= ${required.toFixed(2)} (this setup: ${Number.isFinite(confidence) ? confidence.toFixed(2) : "unreadable"}); a binary risks the full $${stakeAmount.toFixed(2)} with no stop-loss`;
      await recordGeneratedReason(signal.id, reason);
      recordRejection({ symbol: signal.symbol, stage: "sizing", reason, metrics: { equity, stake: stakeAmount, confidence } });
      logger.info({ symbol: signal.symbol, equity, stakeAmount, confidence, required }, "Binary fallback refused: confidence below the binary bar");
      return;
    }
  }

  // Trading-cost gate, now that the stake and contract type are settled. It
  // quotes exactly what is about to be sent: asking for a $1 multiplier quote
  // on an account whose order is a sub-$1 binary measured an instrument that
  // would never be traded, and a refusal of that quote refused the trade.
  {
    const costPct = await getIndicativeCostPct(token, wantEnv, signal.symbol, { stakeAmount, binary: forceBinary });
    const costGate = tradingCostGate(costPct, forex.maxSpreadCostPct);
    if (!costGate.ok) {
      const reason = costGate.reason ?? "Trading-cost gate refused dispatch";
      await recordGeneratedReason(signal.id, reason);
      recordRejection({ symbol: signal.symbol, stage: "forex_readiness", reason, metrics: { costPct, stakeAmount, binary: forceBinary } });
      logger.warn({ symbol: signal.symbol, costPct, stakeAmount, forceBinary }, reason);
      return;
    }
  }

  // ── FIX 4: Validate numeric levels — NaN propagates to Deriv as invalid
  const entryLowNum  = signal.entryLow  != null ? parseFloat(signal.entryLow)  : null;
  const entryHighNum = signal.entryHigh != null ? parseFloat(signal.entryHigh) : null;
  const entryMid =
    entryLowNum != null && entryHighNum != null && Number.isFinite(entryLowNum) && Number.isFinite(entryHighNum)
      ? (entryLowNum + entryHighNum) / 2
      : (Number.isFinite(entryLowNum ?? NaN) ? entryLowNum : null) ??
        (Number.isFinite(entryHighNum ?? NaN) ? entryHighNum : null) ?? null;
  const stopNum   = signal.stopLevel    != null && Number.isFinite(parseFloat(signal.stopLevel))    ? parseFloat(signal.stopLevel)    : null;
  const targetNum = signal.target1Level != null && Number.isFinite(parseFloat(signal.target1Level)) ? parseFloat(signal.target1Level) : null;

  logger.info(
    { symbol: signal.symbol, direction: signal.direction, stakeAmount, broker: conn.label, entryMid, stopNum, targetNum },
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
    entryPrice: entryMid,
    stopPrice: stopNum,
    targetPrice: targetNum,
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
    openPrice: String(result.buyPrice ?? 0),
    lotSize: String(stakeAmount),
    stopLoss: signal.stopLevel,
    takeProfit: signal.target1Level,
    status: "open" as const,
    strategy: signal.strategy,
    reasonChain: signal.reasoning ?? "ICT/CRT auto-signal",
    annotations: JSON.stringify({
      contractId: result.contractId,
      contractType: result.contractType,
      confidence: signal.confidence,
      entryLow: signal.entryLow,
      entryHigh: signal.entryHigh,
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

async function runWorkerTick(): Promise<void> {
  if (workerRunning) return; // prevent overlap
  workerRunning = true;
  lastError = null;

  try {
    // Load bot config
    const [config] = await db.select().from(botConfigTable).where(eq(botConfigTable.id, 1));
    // Cache for getWorkerStatus() so the status endpoint always reflects current config
    if (config) {
      cachedEnabled = config.enabled;
      cachedAutotradeMode = config.autotradeMode;
    }
    if (!config?.enabled) {
      logger.info("Signal worker: bot disabled, skipping tick");
      return;
    }
    activeMode = config.autotradeMode === "auto_demo" || config.autotradeMode === "auto_live" ? config.autotradeMode : null;
    {
      // An unreadable threshold must not silently disable the binary bar: NaN
      // compares false against everything, which would wave every setup through.
      const parsedMinConfidence = parseFloat(config.minConfidence);
      activeConfig = {
        smallAccountMaxRiskPct: parseFloat(config.smallAccountMaxRiskPct),
        minConfidence: Number.isFinite(parsedMinConfidence) ? parsedMinConfidence : 0.7,
      };
    }
    const forexParams: ForexDispatchParams = {
      killzones: config.killzones,
      newsBlackoutBeforeMin: config.newsBlackoutBeforeMin,
      newsBlackoutAfterMin: config.newsBlackoutAfterMin,
      maxSpreadCostPct: parseFloat(config.maxSpreadCostPct),
    };
    const thresholds: QuantThresholds = {
      atrPercentileMin: parseFloat(config.atrPercentileMin),
      atrPercentileMax: parseFloat(config.atrPercentileMax),
      efficiencyRatioMin: parseFloat(config.efficiencyRatioMin),
      minRiskReward: parseFloat(config.minRiskReward),
      minStopAtr: parseFloat(config.minStopAtr),
      maxPerAssetClass: config.maxPerAssetClass,
    };
    const lock = await getExecutionLock();
    lastLock = lock;
    if (lock.locked) logger.warn({ reason: lock.reason }, "Execution locked: new autonomous orders wait for the reconciler");

    const minConfidence = parseFloat(config.minConfidence);
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

    // Hardcoded strategy library (see strategy-library.ts) is the source of
    // the concept eligibility list below (strategySummaryList()/
    // quantKnowledgeContext() built the GPT prompt's knowledge context; no
    // longer built here since runExpertJudge() below needs no prompt text).
    const conceptScoreOptions = {
      threshold: boundedEnvNumber("ICT_CONCEPT_SCORE_THRESHOLD", DEFAULT_CONCEPT_SCORE_THRESHOLD, 0, 1),
      minSamples: Math.floor(boundedEnvNumber("ICT_CONCEPT_MIN_SAMPLES", DEFAULT_CONCEPT_MIN_SAMPLES, 1, 10_000)),
      priorSamples: boundedEnvNumber("ICT_CONCEPT_PRIOR_SAMPLES", DEFAULT_CONCEPT_PRIOR_SAMPLES, 0.1, 100),
    };
    const scoreRows = await scoreConcepts(
      STRATEGY_LIBRARY.map((s) => conceptKey(s.name)),
      conceptScoreOptions,
    );
    const scoreByConcept = new Map(scoreRows.map((row) => [conceptKey(row.concept), row]));
    const suppressedConcepts = new Set(
      scoreRows.filter((row) => !row.eligible).map((row) => conceptKey(row.concept)),
    );
    const eligibleConcepts: PromptConceptScore[] = STRATEGY_LIBRARY
      .map((s) => {
        const score = scoreByConcept.get(conceptKey(s.name));
        return score?.eligible
          ? {
              name: s.name,
              category: s.category,
              libraryRank: s.rank,
              sampleAdjustedScore: score.score,
              historicalSamples: score.sampleCount,
            }
          : null;
      })
      .filter((concept): concept is PromptConceptScore => concept !== null)
      .sort((a, b) => a.libraryRank - b.libraryRank || b.sampleAdjustedScore - a.sampleAdjustedScore);
    if (eligibleConcepts.length === 0) {
      logger.info(
        { threshold: conceptScoreOptions.threshold },
        "Signal worker: persisted score gate suppressed every library concept, skipping analysis",
      );
      return;
    }


    logger.info(
      { instruments, concepts: eligibleConcepts.length, suppressedConcepts: suppressedConcepts.size, autotradeMode: config.autotradeMode, enabled: config.enabled },
      "Signal worker tick"
    );

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
        const replayRow: SignalRow = {
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
        };
        await dispatchTrade(
          replayRow,
          parseFloat(config.riskPerTradePct),
          config.maxConcurrentPositions,
          parseFloat(config.maxDailyLossPct),
          forexParams,
        ).catch((err) => {
          logger.error({ symbol: p.symbol, err }, "Replay dispatch error");
        });
      }
    }

    // Cooldown window: H4/H1 setups need time to develop — don't generate
    // a second signal on the same symbol within 1 hour. Scaled down from
    // the old 2 hours to stay proportionate to the new 4h-1day hold
    // (was 2h against a 1-4 day hold; kept roughly the same fraction).
    const COOLDOWN_MIN = 60;
    const cooldownCutoff = new Date(Date.now() - COOLDOWN_MIN * 60 * 1000);

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
      });
      if (!preScan.ok) {
        recordRejection({ symbol, stage: "forex_readiness", reason: preScan.reason ?? "Forex readiness gate failed" });
        logger.info({ symbol, reason: preScan.reason }, "Signal worker: forex readiness gate skipped this symbol");
        continue;
      }

      // ── FIX 3: Ensure the symbol is subscribed so we have real price data.
      // Without this, symbols beyond the boot set have no tick and the LLM
      // would fabricate levels — producing unsafe SL/TP values.
      const { getLastTick, ensureSymbolSubscribed } = await import("./candle-feeder.js");
      ensureSymbolSubscribed(symbol);
      const lastTick = getLastTick(symbol);

      // Skip analysis if the tick is stale (>5 min old) or missing — without a
      // current price there is nothing to anchor entry/stop/target against.
      const tickAgeMs = lastTick ? Date.now() - lastTick.at : Infinity;
      if (!lastTick || tickAgeMs > 5 * 60 * 1000) {
        const reason = lastTick
          ? `No fresh price tick: last one is ${Math.round(tickAgeMs / 1000)}s old (candle feed may be disconnected)`
          : "No price tick received yet for this symbol (candle feed may be disconnected)";
        logger.info({ symbol, tickAgeMs }, "Signal worker: no fresh tick yet — skipping this symbol this cycle");
        recordRejection({ symbol, stage: "no_tick", reason });
        continue;
      }

      // Fetch the actual H4 sample used for higher-timeframe directional bias.
      const h4Candles = await db
        .select({
          openTime: candlesTable.openTime,
          open: candlesTable.open,
          high: candlesTable.high,
          low: candlesTable.low,
          close: candlesTable.close,
        })
        .from(candlesTable)
        .where(and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, "H4")))
        .orderBy(desc(candlesTable.openTime))
        .limit(30);

      // Fetch the actual H1 sample for higher-timeframe structure.
      const h1Candles = await db
        .select({
          openTime: candlesTable.openTime,
          open: candlesTable.open,
          high: candlesTable.high,
          low: candlesTable.low,
          close: candlesTable.close,
        })
        .from(candlesTable)
        .where(and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, "H1")))
        .orderBy(desc(candlesTable.openTime))
        .limit(30);

      // Fetch M30 candles for entry timing; prompt claims must remain
      // anchored to this actual series rather than inferred lower-timeframe data.
      const m30Candles = await db
        .select({
          openTime: candlesTable.openTime,
          open: candlesTable.open,
          high: candlesTable.high,
          low: candlesTable.low,
          close: candlesTable.close,
        })
        .from(candlesTable)
        .where(and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, "M30")))
        .orderBy(desc(candlesTable.openTime))
        .limit(30);

      if (h4Candles.length === 0 || h1Candles.length === 0 || m30Candles.length === 0) {
        logger.info(
          { symbol, h4: h4Candles.length, h1: h1Candles.length, m30: m30Candles.length },
          "Signal worker: missing fetched H4/H1/M30 candle evidence; skipping analysis",
        );
        continue;
      }

      // ── Quant pre-filter (deterministic, before any paid GPT call) ─────────
      const loadAsc = async (tf: string, n: number): Promise<OHLC[]> => {
        const rows = await db
          .select({ t: candlesTable.openTime, o: candlesTable.open, h: candlesTable.high, l: candlesTable.low, c: candlesTable.close })
          .from(candlesTable)
          .where(and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, tf)))
          .orderBy(desc(candlesTable.openTime))
          .limit(n);
        return rows.reverse().map((r) => ({ open: +r.o, high: +r.h, low: +r.l, close: +r.c, t: r.t.getTime() }));
      };
      const h1Long = await loadAsc("H1", 250);
      const m30Long = await loadAsc("M30", 150);
      const pre = preTradeGate(h1Long, thresholds);
      if (!pre.ok) {
        logger.info({ symbol, reason: pre.reason }, "Quant pre-filter skipped symbol");
        recordRejection({ symbol, stage: "pre_gpt", reason: pre.reason ?? "pre-filter", metrics: pre.metrics });
        continue;
      }
      const h1Atr = atrPercentile(h1Long)!;
      const h4Asc: OHLC[] = [...h4Candles].reverse().map((r) => ({ open: +r.open, high: +r.high, low: +r.low, close: +r.close }));

      // No AI budget: analyzeSymbol() (GPT) is left in this file, unused.
      // runExpertJudge() is the active, deterministic, zero-cost replacement —
      // see its own comment above for what it does and how to swap GPT back.
      // A declined setup is the normal case, but it must still be visible:
      // silently continuing here is what made "the AI was never configured"
      // look identical to "the market just wasn't offering anything".
      const declined = { reason: "No qualifying setup" };
      const result = runExpertJudge(h1Long, m30Long, h4Asc, minConfidence, suppressedConcepts, declined);
      if (!result) {
        logger.info({ symbol, reason: declined.reason }, "Expert judge found no setup");
        recordRejection({ symbol, stage: "expert_judge", reason: declined.reason });
        continue;
      }

      // ── Hard structural filters: reject small-timeframe scalps ─────────────
      // These are mechanical guardrails enforced regardless of LLM output.
      // An H4/H1 setup must have a stop wide enough to sit beyond structure.
      const entryMid =
        result.entryLow != null && result.entryHigh != null
          ? (result.entryLow + result.entryHigh) / 2
          : result.entryLow ?? result.entryHigh ?? lastTick.price;

      if (entryMid == null || result.stopLevel == null || result.target1Level == null) {
        recordRejection({ symbol, stage: "post_gpt", reason: "Missing entry, stop or target level" });
        continue;
      }
      const pd = premiumDiscount(h1Long, entryMid, 2, result.direction);
      const geo = geometryGate(
        { direction: result.direction, entry: entryMid, stop: result.stopLevel, target: result.target1Level },
        h1Atr.atr, pd, thresholds,
      );
      if (!geo.ok) {
        logger.info({ symbol, reason: geo.reason }, "Signal rejected by geometry gate");
        recordRejection({ symbol, stage: "post_gpt", reason: geo.reason ?? "geometry", metrics: geo.metrics });
        continue;
      }
      const m30Atr = atrPercentile(m30Long)?.atr ?? h1Atr.atr / 2;
      const h4Atr = atrPercentile(h4Asc)?.atr ?? h1Atr.atr * 2;
      const claimFailures: string[] = [];
      for (const lvl of result.levels) {
        if (lvl.kind !== "fvg" && lvl.kind !== "sweep") continue;
        const found =
          verifyClaims([lvl], m30Long, m30Atr).ok || verifyClaims([lvl], h1Long, h1Atr.atr).ok || verifyClaims([lvl], h4Asc, h4Atr).ok;
        if (!found) claimFailures.push(`${lvl.kind} ${lvl.low}-${lvl.high}`);
      }
      if (claimFailures.length > 0) {
        logger.info({ symbol, claimFailures }, "Signal rejected: cited structures not found in candles");
        recordRejection({ symbol, stage: "post_gpt", reason: `Cited structures not found in candles: ${claimFailures.join("; ")}` });
        continue;
      }
      const openNow = await db.select({ symbol: tradesTable.symbol, direction: tradesTable.direction })
        .from(tradesTable).where(eq(tradesTable.status, "open"));
      const pf = portfolioGate(
        openNow.map((o) => ({ symbol: o.symbol, direction: o.direction === "sell" ? "sell" as const : "buy" as const, group: getSyntheticSymbol(o.symbol)?.group })),
        { symbol, direction: result.direction, group: getSyntheticSymbol(symbol)?.group },
        thresholds,
      );
      if (!pf.ok) {
        recordRejection({ symbol, stage: "portfolio", reason: pf.reason ?? "portfolio cap", metrics: pf.metrics });
        continue;
      }
      // ────────────────────────────────────────────────────────────────────────

      // Signals expire at the maximum intended 4-hour to 1-day analysis horizon.
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const [inserted] = await db
        .insert(signalsTable)
        .values({
          symbol,
          direction: result.direction,
          confidence: String(result.confidence),
          strategy: result.conceptsDetected || STRATEGY_LIBRARY_NAME,
          concepts: result.conceptsDetected,
          entryZone: result.entryZone,
          targetZone: result.targetZone || null,
          stopZone: result.stopZone || null,
          entryLow: result.entryLow != null ? String(result.entryLow) : null,
          entryHigh: result.entryHigh != null ? String(result.entryHigh) : null,
          stopLevel: result.stopLevel != null ? String(result.stopLevel) : null,
          target1Level: result.target1Level != null ? String(result.target1Level) : null,
          target2Level: result.target2Level != null ? String(result.target2Level) : null,
          levels: result.levels.length > 0 ? JSON.stringify(result.levels) : null,
          reasoning: result.reasoning || null,
          status: "active",
          executionStatus: "generated",
          executionReason: lock.locked ? LOCK_MSG : null,
          expiresAt,
        })
        .returning({ id: signalsTable.id });

      signalsGeneratedTotal++;
      generated++;
      logger.info({ symbol, signalId: inserted?.id, direction: result.direction, confidence: result.confidence }, "Signal generated");

      // Auto-execute trade if bot is in auto mode and a connected broker exists
      if (activeMode) {
        const signalRow: SignalRow = {
          id: inserted?.id,
          symbol,
          direction: result.direction,
          confidence: String(result.confidence),
          strategy: result.conceptsDetected || STRATEGY_LIBRARY_NAME,
          reasoning: result.reasoning || null,
          stopLevel: result.stopLevel != null ? String(result.stopLevel) : null,
          target1Level: result.target1Level != null ? String(result.target1Level) : null,
          entryLow: result.entryLow != null ? String(result.entryLow) : null,
          entryHigh: result.entryHigh != null ? String(result.entryHigh) : null,
          expiresAt,
          executionStatus: "generated",
          executionReason: lock.locked ? LOCK_MSG : null,
        };
        dispatchTrade(
          signalRow,
          parseFloat(config.riskPerTradePct),
          config.maxConcurrentPositions,
          parseFloat(config.maxDailyLossPct),
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
  // Run once after 10s, then every interval
  setTimeout(() => runWorkerTick(), 10_000);
  intervalHandle = setInterval(() => runWorkerTick(), SIGNAL_INTERVAL_MS);
}

export function stopSignalWorker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

export { runWorkerTick };
