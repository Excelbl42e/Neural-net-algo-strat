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
