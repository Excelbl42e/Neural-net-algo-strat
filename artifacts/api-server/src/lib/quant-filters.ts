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

// ── Extended indicators (confluence voters for the full strategy library) ────
// Each of these mirrors one entry in strategy-library.ts's 20 quant/TA
// strategies (or one of the ICT concepts not already covered by the
// sweep/FVG/premium-discount primitives above) and returns "buy"/"sell" when
// it has an opinion, null when it doesn't (insufficient history, or genuinely
// neutral) — never a forced direction. Four library entries are deliberately
// NOT implemented as voters and stay listed/self-learning-scored only:
// Parabolic SAR (rank 34, a stateful iterative indicator with real bug risk
// to hand-verify quickly), Pivot Point Confluence (rank 35, classically needs
// daily/weekly data this system no longer fetches), SMT Divergence (rank 17,
// needs a second correlated symbol's candles — a signature change this pass
// didn't make), and Inducement (rank 16, too fuzzy a definition to encode
// without guessing).

function smaSeries(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += values[j]!;
    out[i] = s / period;
  }
  return out;
}

/** Wilder RSI series aligned to closes; entries before `period` are NaN. */
export function rsiSeries(closes: number[], period = 14): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** RSI Divergence (rank 21): price sets a new swing extreme RSI doesn't confirm. */
export function rsiDivergenceSignal(c: OHLC[], k = 2): "buy" | "sell" | null {
  const closes = c.map((x) => x.close);
  const series = rsiSeries(closes);
  const sw = swingPoints(c, k);
  const highs = sw.filter((s) => s.kind === "high").slice(-2);
  const lows = sw.filter((s) => s.kind === "low").slice(-2);
  if (highs.length === 2) {
    const [a, b] = highs as [Swing, Swing];
    const ra = series[a.index], rb = series[b.index];
    if (Number.isFinite(ra) && Number.isFinite(rb) && b.price > a.price && rb! < ra!) return "sell";
  }
  if (lows.length === 2) {
    const [a, b] = lows as [Swing, Swing];
    const ra = series[a.index], rb = series[b.index];
    if (Number.isFinite(ra) && Number.isFinite(rb) && b.price < a.price && rb! > ra!) return "buy";
  }
  return null;
}

/** MACD Crossover (rank 22): signal-line cross on the latest closed bar. */
export function macdCrossSignal(closes: number[], fast = 12, slow = 26, signalPeriod = 9): "buy" | "sell" | null {
  if (closes.length < slow + signalPeriod + 1) return null;
  const emaFast = ema(closes, fast), emaSlow = ema(closes, slow);
  const macdLine = closes.map((_, i) => emaFast[i]! - emaSlow[i]!);
  const signalLine = ema(macdLine, signalPeriod);
  const n = closes.length;
  const prevDiff = macdLine[n - 2]! - signalLine[n - 2]!;
  const curDiff = macdLine[n - 1]! - signalLine[n - 1]!;
  if (prevDiff <= 0 && curDiff > 0) return "buy";
  if (prevDiff >= 0 && curDiff < 0) return "sell";
  return null;
}

/** Moving Average Confluence (rank 23): EMA 20/50/200 stack order. */
export function maStackSignal(closes: number[]): "buy" | "sell" | null {
  if (closes.length < 200) return null;
  const e20 = ema(closes, 20), e50 = ema(closes, 50), e200 = ema(closes, 200);
  const i = closes.length - 1;
  if (e20[i]! > e50[i]! && e50[i]! > e200[i]!) return "buy";
  if (e20[i]! < e50[i]! && e50[i]! < e200[i]!) return "sell";
  return null;
}

/** Bollinger Band Squeeze Breakout (rank 24): a close outside the bands after a width squeeze. */
export function bollingerBreakoutSignal(closes: number[], period = 20, mult = 2, lookback = 60): "buy" | "sell" | null {
  if (closes.length < period + lookback) return null;
  const widths: number[] = [];
  let latestUpper = 0, latestLower = 0;
  for (let i = period - 1; i < closes.length; i++) {
    const mean = smaSeries(closes.slice(0, i + 1), period)[i]!;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (closes[j]! - mean) ** 2;
    const sd = Math.sqrt(variance / period);
    widths.push((sd * mult * 2) / mean);
    if (i === closes.length - 1) { latestUpper = mean + mult * sd; latestLower = mean - mult * sd; }
  }
  const recentWidths = widths.slice(-lookback);
  const latestWidth = recentWidths[recentWidths.length - 1]!;
  const squeezed = recentWidths.filter((w) => w < latestWidth).length / recentWidths.length <= 0.2;
  if (!squeezed) return null;
  const price = closes[closes.length - 1]!;
  if (price > latestUpper) return "buy";
  if (price < latestLower) return "sell";
  return null;
}

/** Support/Resistance Flip (rank 26): price back-testing a broken swing level from the far side. */
export function srFlipSignal(c: OHLC[], k = 2): "buy" | "sell" | null {
  const sw = swingPoints(c, k);
  const price = c[c.length - 1]!.close;
  const tol = (atrPercentile(c)?.atr ?? 0) * 0.5;
  for (const s of [...sw].reverse().slice(0, 6)) {
    if (Math.abs(price - s.price) > tol) continue;
    // A broken prior high, retested from above, is now support (bullish).
    if (s.kind === "high" && price > s.price - tol && c.slice(s.index + 1).some((x) => x.close > s.price)) return "buy";
    if (s.kind === "low" && price < s.price + tol && c.slice(s.index + 1).some((x) => x.close < s.price)) return "sell";
  }
  return null;
}

/** Stochastic Oscillator Reversal (rank 31): %K crossing back out of an extreme zone. */
export function stochasticSignal(c: OHLC[], kPeriod = 14, smoothK = 3, dPeriod = 3): "buy" | "sell" | null {
  if (c.length < kPeriod + smoothK + dPeriod + 1) return null;
  const rawK: number[] = [];
  for (let i = kPeriod - 1; i < c.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) { hh = Math.max(hh, c[j]!.high); ll = Math.min(ll, c[j]!.low); }
    rawK.push(hh === ll ? 50 : ((c[i]!.close - ll) / (hh - ll)) * 100);
  }
  const kSeries = smaSeries(rawK, smoothK);
  const n = kSeries.length;
  const k1 = kSeries[n - 1]!, k0 = kSeries[n - 2]!;
  if (!Number.isFinite(k0) || !Number.isFinite(k1)) return null;
  if (k0 <= 20 && k1 > 20) return "buy";
  if (k0 >= 80 && k1 < 80) return "sell";
  return null;
}

/** ADX Trend Strength Filter (rank 32): ADX above threshold, direction from +DI/-DI. */
export function adxSignal(c: OHLC[], period = 14, minAdx = 20): "buy" | "sell" | null {
  if (c.length < period * 2 + 1) return null;
  const plusDM: number[] = [0], minusDM: number[] = [0], tr: number[] = [c[0]!.high - c[0]!.low];
  for (let i = 1; i < c.length; i++) {
    const upMove = c[i]!.high - c[i - 1]!.high;
    const downMove = c[i - 1]!.low - c[i]!.low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(c[i]!.high - c[i]!.low, Math.abs(c[i]!.high - c[i - 1]!.close), Math.abs(c[i]!.low - c[i - 1]!.close)));
  }
  const smooth = (values: number[]): number[] => {
    const out: number[] = new Array(values.length).fill(NaN);
    let prev = values.slice(1, period + 1).reduce((a, b) => a + b, 0);
    out[period] = prev;
    for (let i = period + 1; i < values.length; i++) { prev = prev - prev / period + values[i]!; out[i] = prev; }
    return out;
  };
  const trS = smooth(tr), plusS = smooth(plusDM), minusS = smooth(minusDM);
  const dx: number[] = new Array(c.length).fill(NaN);
  for (let i = period; i < c.length; i++) {
    if (!Number.isFinite(trS[i]) || trS[i] === 0) continue;
    const plusDI = (100 * plusS[i]!) / trS[i]!;
    const minusDI = (100 * minusS[i]!) / trS[i]!;
    const sum = plusDI + minusDI;
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / sum;
  }
  const validDx = dx.filter(Number.isFinite);
  if (validDx.length < period) return null;
  const adx = validDx.slice(-period).reduce((a, b) => a + b, 0) / period;
  if (adx < minAdx) return null;
  const i = c.length - 1;
  const plusDI = (100 * plusS[i]!) / trS[i]!, minusDI = (100 * minusS[i]!) / trS[i]!;
  return plusDI > minusDI ? "buy" : plusDI < minusDI ? "sell" : null;
}

/** Ichimoku Cloud Confluence (rank 33): price position relative to the Kumo. */
export function ichimokuSignal(c: OHLC[], tenkanP = 9, kijunP = 26, senkouP = 52): "buy" | "sell" | null {
  if (c.length < senkouP + kijunP) return null;
  const mid = (period: number, end: number): number => {
    let hh = -Infinity, ll = Infinity;
    for (let j = end - period + 1; j <= end; j++) { hh = Math.max(hh, c[j]!.high); ll = Math.min(ll, c[j]!.low); }
    return (hh + ll) / 2;
  };
  const i = c.length - 1 - kijunP; // Senkou spans are plotted kijunP bars ahead; compare price to the cloud as of "now" using the span formed kijunP bars ago
  if (i < senkouP - 1) return null;
  const senkouA = (mid(tenkanP, i) + mid(kijunP, i)) / 2;
  const senkouB = mid(senkouP, i);
  const cloudTop = Math.max(senkouA, senkouB), cloudBottom = Math.min(senkouA, senkouB);
  const price = c[c.length - 1]!.close;
  if (price > cloudTop) return "buy";
  if (price < cloudBottom) return "sell";
  return null;
}

/** Keltner Channel Breakout (rank 36): close outside EMA(20) ± ATR(10)*mult. */
export function keltnerBreakoutSignal(c: OHLC[], emaPeriod = 20, atrPeriod = 10, mult = 2): "buy" | "sell" | null {
  if (c.length < Math.max(emaPeriod, atrPeriod + 1)) return null;
  const e = ema(c.map((k) => k.close), emaPeriod);
  const a = atrSeries(c, atrPeriod);
  const i = c.length - 1;
  if (!Number.isFinite(a[i]!)) return null;
  const upper = e[i]! + mult * a[i]!, lower = e[i]! - mult * a[i]!;
  const price = c[i]!.close;
  if (price > upper) return "buy";
  if (price < lower) return "sell";
  return null;
}

/** Rate of Change Momentum Filter (rank 37): ROC accelerating in a direction. */
export function rocSignal(closes: number[], period = 10): "buy" | "sell" | null {
  if (closes.length < period + 2) return null;
  const n = closes.length;
  const rocNow = ((closes[n - 1]! - closes[n - 1 - period]!) / closes[n - 1 - period]!) * 100;
  const rocPrev = ((closes[n - 2]! - closes[n - 2 - period]!) / closes[n - 2 - period]!) * 100;
  if (rocNow > 0 && rocNow > rocPrev) return "buy";
  if (rocNow < 0 && rocNow < rocPrev) return "sell";
  return null;
}

/** Williams %R Extreme Reversal (rank 38): faster/noisier cousin of the Stochastic filter. */
export function williamsRSignal(c: OHLC[], period = 14): "buy" | "sell" | null {
  if (c.length < period + 2) return null;
  const wr = (end: number): number => {
    let hh = -Infinity, ll = Infinity;
    for (let j = end - period + 1; j <= end; j++) { hh = Math.max(hh, c[j]!.high); ll = Math.min(ll, c[j]!.low); }
    return hh === ll ? -50 : ((hh - c[end]!.close) / (hh - ll)) * -100;
  };
  const i = c.length - 1;
  const cur = wr(i), prev = wr(i - 1);
  if (prev <= -80 && cur > -80) return "buy";
  if (prev >= -20 && cur < -20) return "sell";
  return null;
}

/** Commodity Channel Index Extreme Filter (rank 40): turning back from beyond +/-100. */
export function cciSignal(c: OHLC[], period = 20): "buy" | "sell" | null {
  if (c.length < period + 2) return null;
  const typical = (k: OHLC): number => (k.high + k.low + k.close) / 3;
  const cciAt = (end: number): number => {
    const window = c.slice(end - period + 1, end + 1).map(typical);
    const mean = window.reduce((a, b) => a + b, 0) / period;
    const meanDev = window.reduce((a, b) => a + Math.abs(b - mean), 0) / period;
    if (meanDev === 0) return 0;
    return (typical(c[end]!) - mean) / (0.015 * meanDev);
  };
  const i = c.length - 1;
  const cur = cciAt(i), prev = cciAt(i - 1);
  if (prev <= -100 && cur > -100) return "buy";
  if (prev >= 100 && cur < 100) return "sell";
  return null;
}

/** Donchian Channel Breakout (rank 39): close beyond the N-period high/low channel. */
export function donchianBreakoutSignal(c: OHLC[], period = 20): "buy" | "sell" | null {
  if (c.length < period + 1) return null;
  const i = c.length - 1;
  let hh = -Infinity, ll = Infinity;
  for (let j = i - period; j < i; j++) { hh = Math.max(hh, c[j]!.high); ll = Math.min(ll, c[j]!.low); }
  const price = c[i]!.close;
  if (price > hh) return "buy";
  if (price < ll) return "sell";
  return null;
}

/** Order Block (rank 2): the last opposite-direction candle before a displacement move. */
export function orderBlockPresent(c: OHLC[], fromIndex: number, direction: "buy" | "sell"): boolean {
  for (let i = Math.max(1, fromIndex - 5); i < c.length; i++) {
    const isOpposite = direction === "buy" ? c[i]!.close < c[i]!.open : c[i]!.close > c[i]!.open;
    if (!isOpposite) continue;
    const next = c[i + 1];
    if (next && Math.abs(next.close - next.open) > Math.abs(c[i]!.close - c[i]!.open) * 1.5) return true;
  }
  return false;
}

/** Failure Swing (rank 13): a new extreme that fails to extend further — early reversal evidence. */
export function failureSwingSignal(c: OHLC[], k = 2): "buy" | "sell" | null {
  const sw = swingPoints(c, k);
  const lows = sw.filter((s) => s.kind === "low").slice(-2);
  const highs = sw.filter((s) => s.kind === "high").slice(-2);
  if (lows.length === 2 && lows[1]!.price > lows[0]!.price) return "buy";
  if (highs.length === 2 && highs[1]!.price < highs[0]!.price) return "sell";
  return null;
}

/** Judas Swing (rank 14): the manipulation candle landed inside the London or NY open hour. */
export function isJudasSwingTiming(timestampMs: number | undefined): boolean {
  if (timestampMs == null) return false;
  const hourUTC = new Date(timestampMs).getUTCHours();
  return (hourUTC >= 7 && hourUTC < 8) || (hourUTC >= 12 && hourUTC < 13);
}

export interface ConfluenceVote { concept: string; direction: "buy" | "sell" | null }

/**
 * Confluence votes across the strategy library's quant/TA and remaining ICT
 * concepts, computed on the "snappy" M30 entry timeframe plus H1 for the
 * indicators that genuinely need more history (MA200 stack, ADX). Every
 * entry always appears (direction null when the indicator has no opinion or
 * insufficient history) so a caller can see exactly what did and didn't vote.
 */
export function computeConfluence(h1: OHLC[], m30: OHLC[]): ConfluenceVote[] {
  const m30Closes = m30.map((k) => k.close);
  const h1Closes = h1.map((k) => k.close);
  return [
    { concept: "RSI Divergence", direction: rsiDivergenceSignal(m30) },
    { concept: "MACD Crossover", direction: macdCrossSignal(m30Closes) },
    { concept: "Moving Average Confluence", direction: maStackSignal(h1Closes) },
    { concept: "Bollinger Band Squeeze Breakout", direction: bollingerBreakoutSignal(m30Closes) },
    { concept: "Support/Resistance Flip", direction: srFlipSignal(m30) },
    { concept: "Stochastic Oscillator Overbought/Oversold Reversal", direction: stochasticSignal(m30) },
    { concept: "ADX Trend Strength Filter", direction: adxSignal(h1) },
    { concept: "Ichimoku Cloud Confluence", direction: ichimokuSignal(h1) },
    { concept: "Keltner Channel Breakout", direction: keltnerBreakoutSignal(m30) },
    { concept: "Rate of Change (ROC) Momentum Filter", direction: rocSignal(m30Closes) },
    { concept: "Williams %R Extreme Reversal", direction: williamsRSignal(m30) },
    { concept: "Commodity Channel Index (CCI) Extreme Filter", direction: cciSignal(m30) },
    { concept: "Donchian Channel Breakout", direction: donchianBreakoutSignal(m30) },
    { concept: "Failure Swing", direction: failureSwingSignal(m30) },
  ];
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

  // 4) Confluence across the rest of the strategy library (no LLM judgment):
  // every voter in computeConfluence() gets a say, alongside the core
  // setup's own structural confirmations. A voter that's silent (null) is
  // not held against the trade, but voters that DO have an opinion must, on
  // balance, favor this direction — "all strategies pulsing together" is a
  // real gate here, not just decoration on the core sweep/FVG trigger.
  const hasDisplacement = findDisplacements(m30).some(
    (d) => d.index >= sweep.index && d.direction === (bias === "buy" ? "up" : "down"),
  );
  const pd = premiumDiscount(m30, entry, 2, bias);
  const inOte = pd != null && entry >= Math.min(pd.oteLow, pd.oteHigh) && entry <= Math.max(pd.oteLow, pd.oteHigh);
  const hasOrderBlock = orderBlockPresent(m30, sweep.index, bias);
  const judasTiming = isJudasSwingTiming(m30[sweep.index]?.t);

  const votes = computeConfluence(h1, m30);
  const relevantVotes = votes.filter((v) => v.direction != null);
  const agreeingVotes = relevantVotes.filter((v) => v.direction === bias);
  const disagreeingVotes = relevantVotes.filter((v) => v.direction !== bias);
  if (relevantVotes.length > 0 && agreeingVotes.length < disagreeingVotes.length) return null;

  const structuralBonuses = [hasDisplacement, inOte, hasOrderBlock, judasTiming, h4Bias === bias].filter(Boolean).length;
  const agreementRatio = relevantVotes.length > 0 ? agreeingVotes.length / relevantVotes.length : 0.5;
  let confidence = 0.5 + agreementRatio * 0.25 + structuralBonuses * 0.04;
  confidence = Math.min(0.97, confidence);
  if (confidence < minConfidence) return null;

  // Accumulation-Manipulation-Distribution and Break of Structure are always
  // true by construction whenever this setup fires (the sweep IS the
  // manipulation phase, brokeStructure IS the BOS) — named here so the
  // self-learning system can actually score them, not just imply them.
  const concepts = [...new Set([
    "Liquidity Sweep", "Market Structure Shift (MSS)", "Fair Value Gap (FVG)", "2022 Entry Model",
    "Accumulation-Manipulation-Distribution (AMD)", "Break of Structure (BOS)",
    ...(hasOrderBlock ? ["Order Block (OB)"] : []),
    ...(judasTiming ? ["Judas Swing"] : []),
    ...(inOte ? ["Optimal Trade Entry (OTE)"] : []),
    ...(hasDisplacement ? ["Algo Candle"] : []),
    ...(h4Bias === bias ? ["Multi-Timeframe Trend Alignment"] : []),
    ...agreeingVotes.map((v) => v.concept),
  ])];
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
    reasoning: `Deterministic expert-system signal (no AI): ${bias} M30 ${wantedSweepSide.replace("_", "-")} liquidity sweep at ${sweep.level.toFixed(5)}, structure break confirmed, entry at ${wantedFvgKind} FVG midpoint ${entry.toFixed(5)}, stop beyond the sweep, target at the next opposing M30 swing ${target.toFixed(5)}. Confluence: ${agreeingVotes.length} agreeing / ${disagreeingVotes.length} disagreeing of ${relevantVotes.length} strategy-library voters with an opinion (${concepts.length} concepts total).`,
  };
}
