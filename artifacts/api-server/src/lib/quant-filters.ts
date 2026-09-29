/**
 * Pure, deterministic quant / ICT-structure filters over OHLC candles.
 * No I/O. Every threshold is passed in (they live in botConfigTable).
 * Candle arrays are ALWAYS oldest -> newest.
 */
export interface OHLC { open: number; high: number; low: number; close: number; t?: number }

export interface QuantThresholds {
  atrPercentileMin: number; // e.g. 15
  atrPercentileMax: number; // e.g. 90
  efficiencyRatioMin: number; // e.g. 0.15
  minRiskReward: number; // e.g. 1.5
  minStopAtr: number; // e.g. 1.0
  maxPerAssetClass: number; // e.g. 2
}

export const DEFAULT_THRESHOLDS: QuantThresholds = {
  atrPercentileMin: 15, atrPercentileMax: 90, efficiencyRatioMin: 0.15,
  minRiskReward: 2.0, minStopAtr: 1.0, maxPerAssetClass: 2,
};

// ── Indicators ──────────────────────────────────────────────────────────────
export function trueRanges(c: OHLC[]): number[] {
  return c.map((k, i) => i === 0 ? k.high - k.low
    : Math.max(k.high - k.low, Math.abs(k.high - c[i - 1]!.close), Math.abs(k.low - c[i - 1]!.close)));
}

/** Wilder ATR series aligned to candles; entries before `period-1` are NaN. */
export function atrSeries(c: OHLC[], period = 14): number[] {
  const tr = trueRanges(c);
  const out: number[] = new Array(c.length).fill(NaN);
  if (c.length < period) return out;
  let prev = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < c.length; i++) {
    prev = (prev * (period - 1) + tr[i]!) / period;
    out[i] = prev;
  }
  return out;
}

/** Percentile rank (0-100) of the latest ATR within its own last `lookback` valid ATR values. */
export function atrPercentile(c: OHLC[], period = 14, lookback = 200): { atr: number; percentile: number; samples: number } | null {
  const valid = atrSeries(c, period).filter(Number.isFinite);
  if (valid.length < 20) return null;
  const window = valid.slice(-lookback);
  const latest = window[window.length - 1]!;
  const below = window.filter((v) => v < latest).length;
  const equal = window.filter((v) => v === latest).length;
  return { atr: latest, percentile: ((below + 0.5 * equal) / window.length) * 100, samples: window.length };
}

/** Kaufman efficiency ratio over the last n changes: |net move| / sum(|moves|). 0 = chop, 1 = clean trend. */
export function efficiencyRatio(closes: number[], n = 10): number | null {
  if (closes.length < n + 1) return null;
  const w = closes.slice(-(n + 1));
  const net = Math.abs(w[w.length - 1]! - w[0]!);
  let path = 0;
  for (let i = 1; i < w.length; i++) path += Math.abs(w[i]! - w[i - 1]!);
  return path === 0 ? 0 : net / path;
}

export function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  values.forEach((v, i) => out.push(i === 0 ? v : v * k + out[i - 1]! * (1 - k)));
  return out;
}

/** (close - EMA(period)) / ATR: how many ATRs price is stretched from its mean. */
export function zScoreVsEma(c: OHLC[], emaPeriod = 50, atrPeriod = 14): number | null {
  if (c.length < Math.max(emaPeriod, atrPeriod + 1)) return null;
  const e = ema(c.map((k) => k.close), emaPeriod);
  const a = atrSeries(c, atrPeriod);
  const atr = a[a.length - 1]!;
  if (!Number.isFinite(atr) || atr <= 0) return null;
  return (c[c.length - 1]!.close - e[e.length - 1]!) / atr;
}

// ── Structure ───────────────────────────────────────────────────────────────
export interface Swing { index: number; price: number; kind: "high" | "low" }

/** Fractal swings: a high/low that is the extreme of `k` candles on each side. */
export function swingPoints(c: OHLC[], k = 2): Swing[] {
  const out: Swing[] = [];
  for (let i = k; i < c.length - k; i++) {
    let hi = true, lo = true;
    for (let j = 1; j <= k; j++) {
      if (!(c[i]!.high > c[i - j]!.high && c[i]!.high > c[i + j]!.high)) hi = false;
      if (!(c[i]!.low < c[i - j]!.low && c[i]!.low < c[i + j]!.low)) lo = false;
    }
    if (hi) out.push({ index: i, price: c[i]!.high, kind: "high" });
    if (lo) out.push({ index: i, price: c[i]!.low, kind: "low" });
  }
  return out;
}

export interface Fvg { kind: "bullish" | "bearish"; low: number; high: number; index: number }

/** 3-candle fair value gaps. Bullish: candle1.high < candle3.low. Bearish: candle1.low > candle3.high. */
export function findFvgs(c: OHLC[]): Fvg[] {
  const out: Fvg[] = [];
  for (let i = 2; i < c.length; i++) {
    const a = c[i - 2]!, k = c[i]!;
    if (a.high < k.low) out.push({ kind: "bullish", low: a.high, high: k.low, index: i - 1 });
    else if (a.low > k.high) out.push({ kind: "bearish", low: k.high, high: a.low, index: i - 1 });
  }
  return out;
}

/** Displacement candles: body >= mult * ATR at that candle. */
export function findDisplacements(c: OHLC[], mult = 1.5, atrPeriod = 14): Array<{ index: number; direction: "up" | "down" }> {
  const a = atrSeries(c, atrPeriod);
  const out: Array<{ index: number; direction: "up" | "down" }> = [];
  c.forEach((k, i) => {
    const atr = a[i - 1] ?? NaN; // ATR known BEFORE the candle, so it cannot inflate itself
    if (Number.isFinite(atr) && Math.abs(k.close - k.open) >= mult * atr) {
      out.push({ index: i, direction: k.close > k.open ? "up" : "down" });
    }
  });
  return out;
}

export interface Sweep { index: number; side: "buy_side" | "sell_side"; level: number }

/** Liquidity sweep: wick trades beyond an earlier swing, candle closes back inside. */
export function findSweeps(c: OHLC[], k = 2): Sweep[] {
  const swings = swingPoints(c, k);
  const out: Sweep[] = [];
  for (let i = k + 1; i < c.length; i++) {
    for (const s of swings) {
      if (s.index + k >= i) continue; // swing must be confirmed before the sweep candle
      if (s.kind === "high" && c[i]!.high > s.price && c[i]!.close < s.price) out.push({ index: i, side: "buy_side", level: s.price });
      if (s.kind === "low" && c[i]!.low < s.price && c[i]!.close > s.price) out.push({ index: i, side: "sell_side", level: s.price });
    }
  }
  return out;
}

export interface PremiumDiscount {
  rangeHigh: number; rangeLow: number; equilibrium: number;
  zone: "premium" | "discount" | "equilibrium";
  /** 0 = range low, 1 = range high */
  position: number;
  oteLow: number; oteHigh: number; // 62%-79% retracement band for the given bias
}

/** Premium/discount from the most recent confirmed swing high and low. */
export function premiumDiscount(c: OHLC[], price: number, k = 2, bias: "buy" | "sell" = "buy"): PremiumDiscount | null {
  const sw = swingPoints(c, k);
  const hi = [...sw].reverse().find((s) => s.kind === "high");
  const lo = [...sw].reverse().find((s) => s.kind === "low");
  if (!hi || !lo || hi.price <= lo.price) return null;
  const range = hi.price - lo.price;
  const eq = lo.price + range / 2;
  const position = (price - lo.price) / range;
  const zone = Math.abs(position - 0.5) < 0.02 ? "equilibrium" : position > 0.5 ? "premium" : "discount";
  // OTE for longs sits 62-79% down from the high; for shorts 62-79% up from the low.
  const oteLow = bias === "buy" ? hi.price - 0.79 * range : lo.price + 0.62 * range;
  const oteHigh = bias === "buy" ? hi.price - 0.62 * range : lo.price + 0.79 * range;
  return { rangeHigh: hi.price, rangeLow: lo.price, equilibrium: eq, zone, position, oteLow, oteHigh };
}

// ── Gates ───────────────────────────────────────────────────────────────────
export interface GateResult { ok: boolean; reason?: string; metrics: Record<string, number | string | null> }

/** Pre-GPT gate: skip dead or spiking volatility and pure chop. Called with H1 candles (the bias/entry-math timeframe). */
export function preTradeGate(candles: OHLC[], t: QuantThresholds): GateResult {
  const vol = atrPercentile(candles);
  const er = efficiencyRatio(candles.map((k) => k.close), 10);
  const metrics = { atrPercentile: vol?.percentile ?? null, atr: vol?.atr ?? null, efficiencyRatio: er, atrSamples: vol?.samples ?? 0 };
  if (!vol) return { ok: false, reason: "Insufficient H1 history for volatility percentile", metrics };
  if (vol.percentile < t.atrPercentileMin) return { ok: false, reason: `Dead volatility: ATR percentile ${vol.percentile.toFixed(0)} < ${t.atrPercentileMin}`, metrics };
  if (vol.percentile > t.atrPercentileMax) return { ok: false, reason: `Volatility spike: ATR percentile ${vol.percentile.toFixed(0)} > ${t.atrPercentileMax}`, metrics };
  if (er == null) return { ok: false, reason: "Insufficient H1 history for efficiency ratio", metrics };
  return { ok: true, metrics };
}

export interface SignalGeometry {
  direction: "buy" | "sell";
  entry: number; stop: number; target: number;
}

/** Post-GPT gate: level consistency, RR, noise-stop, premium/discount. */
export function geometryGate(g: SignalGeometry, atr: number, pd: PremiumDiscount | null, t: QuantThresholds): GateResult {
  const risk = Math.abs(g.entry - g.stop);
  const reward = Math.abs(g.target - g.entry);
  const rr = risk > 0 ? reward / risk : 0;
  const metrics = { risk, reward, rr, atr, zone: pd?.zone ?? null };
  const buy = g.direction === "buy";
  if (![g.entry, g.stop, g.target, atr].every(Number.isFinite) || atr <= 0) return { ok: false, reason: "Non-finite levels or ATR", metrics };
  if (buy && !(g.stop < g.entry && g.target > g.entry)) return { ok: false, reason: "Inconsistent long: need stop < entry < target", metrics };
  if (!buy && !(g.stop > g.entry && g.target < g.entry)) return { ok: false, reason: "Inconsistent short: need target < entry < stop", metrics };
  if (risk < t.minStopAtr * atr) return { ok: false, reason: `Noise stop: ${(risk / atr).toFixed(2)} ATR < ${t.minStopAtr}`, metrics };
  if (rr < t.minRiskReward) return { ok: false, reason: `RR ${rr.toFixed(2)} < ${t.minRiskReward}`, metrics };
  if (pd) {
    if (buy && pd.zone === "premium") return { ok: false, reason: "Buy in premium of the swing range", metrics };
    if (!buy && pd.zone === "discount") return { ok: false, reason: "Sell in discount of the swing range", metrics };
  }
  return { ok: true, metrics };
}

export interface ClaimedLevel { kind: string; low: number; high: number }

/**
 * Verify structures the LLM cites against the supplied candles. FVG and sweep claims must
 * exist within `tolAtr` ATRs of the claimed price; other kinds (ob, level) are not verifiable here.
 */
export function verifyClaims(levels: ClaimedLevel[], candles: OHLC[], atr: number, tolAtr = 0.25): { ok: boolean; failures: string[] } {
  const fvgs = findFvgs(candles);
  const sweeps = findSweeps(candles);
  const tol = tolAtr * atr;
  const failures: string[] = [];
  for (const l of levels) {
    if (l.kind === "fvg") {
      const hit = fvgs.some((f) => l.high >= f.low - tol && l.low <= f.high + tol);
      if (!hit) failures.push(`Claimed FVG ${l.low}-${l.high} not found in candles`);
    } else if (l.kind === "sweep") {
      const mid = (l.low + l.high) / 2;
      const hit = sweeps.some((s) => Math.abs(s.level - mid) <= tol + Math.abs(l.high - l.low) / 2);
      if (!hit) failures.push(`Claimed sweep near ${mid} not found in candles`);
    }
  }
  return { ok: failures.length === 0, failures };
}

// ── Portfolio ───────────────────────────────────────────────────────────────
export function assetClass(symbol: string, group?: string): string {
  if (group) return group;
  if (symbol.startsWith("frx")) return "Forex";
  if (symbol.startsWith("cry")) return "Crypto";
  return "Synthetic";
}

/** Signed USD-style exposure legs: long EURUSD => +EUR -USD. */
export function currencyLegs(symbol: string, direction: "buy" | "sell"): Record<string, number> {
  const m = symbol.match(/^frx([A-Z]{3})([A-Z]{3})$/);
  if (!m) return {};
  const s = direction === "buy" ? 1 : -1;
  return { [m[1]!]: s, [m[2]!]: -s };
}

export function portfolioGate(
  open: Array<{ symbol: string; direction: "buy" | "sell"; group?: string }>,
  next: { symbol: string; direction: "buy" | "sell"; group?: string },
  t: QuantThresholds,
): GateResult {
  const cls = assetClass(next.symbol, next.group);
  const sameClass = open.filter((o) => assetClass(o.symbol, o.group) === cls).length;
  const metrics = { assetClass: cls, sameClass };
  if (sameClass >= t.maxPerAssetClass) return { ok: false, reason: `Asset class cap: ${sameClass}/${t.maxPerAssetClass} open in ${cls}`, metrics };
  const legs = currencyLegs(next.symbol, next.direction);
  for (const [ccy, sign] of Object.entries(legs)) {
    const same = open.filter((o) => (currencyLegs(o.symbol, o.direction)[ccy] ?? 0) === sign).length;
    if (same >= 2) return { ok: false, reason: `Currency leg cap: ${same} open positions already ${sign > 0 ? "long" : "short"} ${ccy}`, metrics };
  }
  return { ok: true, metrics };
}

// ── Deterministic expert-system judge (no LLM, no API cost) ──────────────────
// Implements the single highest-conviction ICT setup the GPT-based prompt
// this replaced already treated as primary — liquidity sweep -> structure
// break -> FVG entry, i.e. the "2022 Entry Model" / AMD cycle (see
// strategy-library.ts ranks 4, 5, 8, 19) — using the detection primitives
// above, which originally existed only to verify an LLM's claims.

export function conceptKey(value: string): string {
  const normalized = value
    .replace(/\([^)]*\)/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  const aliases: Record<string, string> = {
    fvg: "fair value gap",
    "fair value gaps": "fair value gap",
    ob: "order block",
    "order blocks": "order block",
    "liquidity sweeps": "liquidity sweep",
    "stop hunt": "liquidity sweep",
    "stop hunts": "liquidity sweep",
    mss: "market structure shift",
    choch: "change of character",
    ote: "optimal trade entry",
    "premium discount": "premium and discount",
  };
  return aliases[normalized] ?? normalized;
}

export interface AnalysisLevel {
  kind: "fvg" | "ob" | "sweep" | "level";
  low: number;
  high: number;
  label?: string;
}
export interface AnalysisResult {
  direction: "buy" | "sell";
  confidence: number;
  entryZone: string;
  targetZone: string;
  stopZone: string;
  entryLow: number | null;
  entryHigh: number | null;
  stopLevel: number | null;
  target1Level: number | null;
  target2Level: number | null;
  levels: AnalysisLevel[];
  conceptsDetected: string;
  reasoning: string;
}

export function runExpertJudge(
  h1: OHLC[],
  m30: OHLC[],
  h4: OHLC[],
  minConfidence: number,
  suppressedConcepts: Set<string>,
): AnalysisResult | null {
  // 1) HTF bias from H1 swing structure: last two confirmed highs AND lows
  // both rising = bullish, both falling = bearish, anything else = no bias.
  const biasFromSwings = (candles: OHLC[]): "buy" | "sell" | null => {
    const sw = swingPoints(candles, 2);
    const highs = sw.filter((s) => s.kind === "high").slice(-2);
    const lows = sw.filter((s) => s.kind === "low").slice(-2);
    if (highs.length < 2 || lows.length < 2) return null;
    const risingHighs = highs[1]!.price > highs[0]!.price;
    const risingLows = lows[1]!.price > lows[0]!.price;
    if (risingHighs && risingLows) return "buy";
    if (!risingHighs && !risingLows) return "sell";
    return null;
  };
  const bias = biasFromSwings(h1);
  if (!bias) return null;
  // Multi-timeframe alignment (strategy-library rank 30): an H4 bias that
  // actively disagrees kills the setup; no clear H4 bias is fine (H1 leads).
  const h4Bias = biasFromSwings(h4);
  if (h4Bias && h4Bias !== bias) return null;

  // 2) M30 entry: most recent liquidity sweep opposite the bias, a structure
  // break back in the bias direction, then an FVG in that direction that
  // hasn't fully filled since it formed.
  const m30Swings = swingPoints(m30, 2);
  const wantedSweepSide = bias === "buy" ? "sell_side" : "buy_side";
  const recentSweeps = findSweeps(m30, 2).filter((s) => s.side === wantedSweepSide && s.index >= m30.length - 20);
  if (recentSweeps.length === 0) return null;
  const sweep = recentSweeps[recentSweeps.length - 1]!;

  const priorSwing = m30Swings
    .filter((s) => s.index < sweep.index && s.kind === (bias === "buy" ? "high" : "low"))
    .pop();
  if (!priorSwing) return null;
  const brokeStructure = m30.slice(sweep.index + 1).some((k) =>
    bias === "buy" ? k.close > priorSwing.price : k.close < priorSwing.price
  );
  if (!brokeStructure) return null;

  const wantedFvgKind = bias === "buy" ? "bullish" : "bearish";
  const candidateFvgs = findFvgs(m30).filter((f) => f.kind === wantedFvgKind && f.index >= sweep.index);
  if (candidateFvgs.length === 0) return null;
  const fvg = candidateFvgs[candidateFvgs.length - 1]!;
  const lastClose = m30[m30.length - 1]!.close;
  const fvgFilled = bias === "buy" ? lastClose < fvg.low : lastClose > fvg.high;
  if (fvgFilled) return null;

  // 3) Levels: entry at the FVG's consequent-encroachment midpoint, stop
  // beyond the sweep extreme, target at the next real opposing M30 swing.
  const entry = (fvg.low + fvg.high) / 2;
  const atr = atrPercentile(m30)?.atr ?? (fvg.high - fvg.low);
  const stopBuffer = 0.1 * atr;
  const stop = bias === "buy" ? sweep.level - stopBuffer : sweep.level + stopBuffer;
  const opposingSwings = m30Swings.filter((s) =>
    bias === "buy" ? (s.kind === "high" && s.price > entry) : (s.kind === "low" && s.price < entry)
  );
  if (opposingSwings.length === 0) return null;
  const target = bias === "buy"
    ? Math.min(...opposingSwings.map((s) => s.price))
    : Math.max(...opposingSwings.map((s) => s.price));

  // 4) Confidence from confluence (no LLM judgment): base + measurable bonuses.
  const hasDisplacement = findDisplacements(m30).some(
    (d) => d.index >= sweep.index && d.direction === (bias === "buy" ? "up" : "down"),
  );
  const pd = premiumDiscount(m30, entry, 2, bias);
  const inOte = pd != null && entry >= Math.min(pd.oteLow, pd.oteHigh) && entry <= Math.max(pd.oteLow, pd.oteHigh);
  const er = efficiencyRatio(h1.map((k) => k.close), 10) ?? 0;
  let confidence = 0.6;
  if (hasDisplacement) confidence += 0.1;
  if (inOte) confidence += 0.1;
  if (er >= 0.3) confidence += 0.1;
  if (h4Bias === bias) confidence += 0.05;
  confidence = Math.min(0.95, confidence);
  if (confidence < minConfidence) return null;

  const concepts = ["Liquidity Sweep", "Market Structure Shift (MSS)", "Fair Value Gap (FVG)", "2022 Entry Model"];
  if (concepts.some((c) => suppressedConcepts.has(conceptKey(c)))) return null;

  const levels: AnalysisLevel[] = [
    { kind: "sweep", low: sweep.level, high: sweep.level, label: "liquidity sweep" },
    { kind: "fvg", low: fvg.low, high: fvg.high, label: "entry FVG" },
  ];

  return {
    direction: bias,
    confidence,
    entryZone: entry.toFixed(5),
    targetZone: target.toFixed(5),
    stopZone: stop.toFixed(5),
    entryLow: entry,
    entryHigh: entry,
    stopLevel: stop,
    target1Level: target,
    target2Level: null,
    levels,
    conceptsDetected: concepts.join(", "),
    reasoning: `Deterministic expert-system signal (no AI): ${bias} M30 ${wantedSweepSide.replace("_", "-")} liquidity sweep at ${sweep.level.toFixed(5)}, structure break confirmed, entry at ${wantedFvgKind} FVG midpoint ${entry.toFixed(5)}, stop beyond the sweep, target at the next opposing M30 swing ${target.toFixed(5)}.`,
  };
}
