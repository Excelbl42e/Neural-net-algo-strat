/**
 * The voting strategies.
 *
 * Every strategy is a pure, causal function over M30 bars: it returns one vote
 * per bar (+1 buy, -1 sell, 0 abstain), and the vote at bar i uses bars 0..i
 * only — bar i being the candle that has just closed. The live scan and the
 * backtest call exactly these functions, so what was tested is what trades.
 *
 * 40 quantitative strategies (Markov chains, Monte Carlo, Fourier analysis,
 * filtering, statistical tests, pattern matching, cross-currency) and 20
 * technical-analysis strategies. No imports: this file is a leaf, so it can be
 * unit-tested and backtested without the database or the network.
 */

export type Vote = 1 | -1 | 0;

export interface Bars {
  t: number[]; // open time, ms
  o: number[];
  h: number[];
  l: number[];
  c: number[];
}

/** Optional cross-pair context: the same M30 timestamps for every traded pair. */
export interface CrossContext {
  /** Symbol of the series being voted on, e.g. "frxEURUSD". */
  symbol: string;
  /** Close series of every pair, aligned to this series' timestamps (NaN where missing). */
  closes: Record<string, number[]>;
}

export interface StrategyDef {
  id: string;
  name: string;
  family: "quant" | "ta";
  summary: string;
  /**
   * Votes for every bar. `from` is the first bar whose vote the caller needs:
   * earlier entries may be left at 0. The live scan passes the newest closed
   * bar so the expensive strategies do one bar's work instead of thousands;
   * the vote at any bar is identical whatever `from` is.
   */
  compute(b: Bars, x?: CrossContext, from?: number): Int8Array;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (all causal)
// ─────────────────────────────────────────────────────────────────────────────

const N = (b: Bars) => b.c.length;

function sma(a: number[], n: number): number[] {
  const out = new Array(a.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i]!;
    if (i >= n) s -= a[i - n]!;
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

function ema(a: number[], n: number): number[] {
  const out = new Array(a.length).fill(NaN);
  const k = 2 / (n + 1);
  let e = NaN;
  for (let i = 0; i < a.length; i++) {
    const v = a[i]!;
    if (!Number.isFinite(v)) { out[i] = e; continue; }
    e = Number.isFinite(e) ? v * k + e * (1 - k) : v;
    if (i >= n - 1) out[i] = e;
  }
  return out;
}

function rollingStd(a: number[], n: number): number[] {
  const out = new Array(a.length).fill(NaN);
  let s = 0, s2 = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i]!; s2 += a[i]! * a[i]!;
    if (i >= n) { s -= a[i - n]!; s2 -= a[i - n]! * a[i - n]!; }
    if (i >= n - 1) out[i] = Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
  }
  return out;
}

function trueRange(b: Bars): number[] {
  return b.c.map((_, i) => i === 0 ? b.h[0]! - b.l[0]!
    : Math.max(b.h[i]! - b.l[i]!, Math.abs(b.h[i]! - b.c[i - 1]!), Math.abs(b.l[i]! - b.c[i - 1]!)));
}

/** Wilder ATR. */
export function atrSeries(b: Bars, n = 14): number[] {
  const tr = trueRange(b);
  const out = new Array(tr.length).fill(NaN);
  let a = NaN;
  for (let i = 0; i < tr.length; i++) {
    if (i === n - 1) { let s = 0; for (let k = 0; k < n; k++) s += tr[k]!; a = s / n; }
    else if (i >= n) a = (a * (n - 1) + tr[i]!) / n;
    if (i >= n - 1) out[i] = a;
  }
  return out;
}

function rsiSeries(c: number[], n = 14): number[] {
  const out = new Array(c.length).fill(NaN);
  let g = 0, l = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i]! - c[i - 1]!;
    const up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
    else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
  }
  return out;
}

const logReturns = (c: number[]) => c.map((v, i) => (i === 0 ? 0 : Math.log(v / c[i - 1]!)));

function out(n: number): Int8Array { return new Int8Array(n); }
const sign = (v: number, eps = 0): Vote => (v > eps ? 1 : v < -eps ? -1 : 0);

/** Deterministic PRNG so Monte Carlo votes are reproducible. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/** Seed for bar i taken from its own open time, so a Monte Carlo vote never depends on where computation started. */
const barSeed = (b: Bars, i: number) => Math.floor(b.t[i]! / 1_800_000) % 1_000_003;

function highest(a: number[], i: number, n: number) { let m = -Infinity; for (let k = Math.max(0, i - n + 1); k <= i; k++) m = Math.max(m, a[k]!); return m; }
function lowest(a: number[], i: number, n: number) { let m = Infinity; for (let k = Math.max(0, i - n + 1); k <= i; k++) m = Math.min(m, a[k]!); return m; }

// ─────────────────────────────────────────────────────────────────────────────
// Quantitative strategies (40)
// ─────────────────────────────────────────────────────────────────────────────

/** Generic first-order Markov chain over discrete states of the last bars. */
function markovVote(states: number[], nStates: number, upState: number, downState: number, window: number, edge: number, minObs: number, from = 0): Int8Array {
  const v = out(states.length);
  for (let i = Math.max(window + 1, from); i < states.length; i++) {
    const cnt = new Array(nStates * nStates).fill(0);
    for (let k = i - window + 1; k <= i; k++) cnt[states[k - 1]! * nStates + states[k]!]++;
    const cur = states[i]!;
    let row = 0; for (let s = 0; s < nStates; s++) row += cnt[cur * nStates + s];
    if (row < minObs) continue;
    const pUp = cnt[cur * nStates + upState] / row, pDn = cnt[cur * nStates + downState] / row;
    v[i] = sign(pUp - pDn, edge);
  }
  return v;
}

const Q: StrategyDef[] = [
  {
    id: "markov_updown", name: "Markov Chain (up/down)", family: "quant",
    summary: "Two-state first-order Markov chain on M30 candle direction; trades the more likely next state over the last 300 transitions.",
    compute: (b, _x, from) => markovVote(b.c.map((c, i) => (i && c > b.c[i - 1]! ? 1 : 0)), 2, 1, 0, 300, 0.08, 60, from),
  },
  {
    id: "markov_3state", name: "Markov Chain (up/flat/down)", family: "quant",
    summary: "Three-state Markov chain where moves under 0.15 ATR count as flat, so noise does not pose as direction.",
    compute: (b, _x, from) => {
      const a = atrSeries(b);
      const st = b.c.map((c, i) => { if (!i || !Number.isFinite(a[i]!)) return 1; const d = c - b.c[i - 1]!; return d > 0.15 * a[i]! ? 2 : d < -0.15 * a[i]! ? 0 : 1; });
      return markovVote(st, 3, 2, 0, 300, 0.08, 40, from);
    },
  },
  {
    id: "markov_2nd_order", name: "Second-order Markov Chain", family: "quant",
    summary: "Markov chain conditioned on the last two candle directions (four states).",
    compute: (b, _x, from) => {
      const d = b.c.map((c, i) => (i && c > b.c[i - 1]! ? 1 : 0));
      const st = d.map((x, i) => (i ? d[i - 1]! * 2 + x : 0));
      const v = out(N(b));
      for (let i = Math.max(402, from ?? 0); i < st.length; i++) {
        let up = 0, n = 0;
        for (let k = i - 400; k < i; k++) if (st[k] === st[i]) { n++; up += d[k + 1]!; }
        if (n >= 40) v[i] = sign(up / n - 0.5, 0.06);
      }
      return v;
    },
  },
  {
    id: "markov_candle_type", name: "Markov Chain (candle types)", family: "quant",
    summary: "Chain over bullish / bearish / indecision candles (body under 30% of range is indecision).",
    compute: (b, _x, from) => {
      const st = b.c.map((c, i) => { const r = b.h[i]! - b.l[i]!; const body = c - b.o[i]!; return r <= 0 || Math.abs(body) < 0.3 * r ? 1 : body > 0 ? 2 : 0; });
      return markovVote(st, 3, 2, 0, 300, 0.08, 40, from);
    },
  },
  {
    id: "markov_regime", name: "Markov Regime Switching", family: "quant",
    summary: "Regimes from the 8-bar move in ATR units (trend up / range / trend down); votes with the regime the chain expects next.",
    compute: (b, _x, from) => {
      const a = atrSeries(b);
      const st = b.c.map((c, i) => { if (i < 8 || !Number.isFinite(a[i]!)) return 1; const m = (c - b.c[i - 8]!) / a[i]!; return m > 1.5 ? 2 : m < -1.5 ? 0 : 1; });
      return markovVote(st, 3, 2, 0, 400, 0.1, 30, from);
    },
  },
  {
    id: "markov_run_length", name: "Markov Run-Length (uplift)", family: "quant",
    summary: "Uplift of continuing the current run of same-direction candles over the base rate, measured on the last 500 bars.",
    compute: (b, _x, from) => {
      const d = b.c.map((c, i) => (i && c > b.c[i - 1]! ? 1 : -1));
      const run = d.map(() => 0);
      for (let i = 1; i < d.length; i++) run[i] = d[i] === d[i - 1] ? Math.min(run[i - 1]! + 1, 5) : 1;
      const v = out(N(b));
      for (let i = Math.max(502, from ?? 0); i < d.length; i++) {
        let cont = 0, n = 0, base = 0;
        for (let k = i - 500; k < i; k++) { base += d[k + 1] === d[k] ? 1 : 0; if (run[k] === run[i]) { n++; cont += d[k + 1] === d[k] ? 1 : 0; } }
        if (n < 30) continue;
        const uplift = cont / n - base / 500;
        v[i] = uplift > 0.06 ? (d[i] as Vote) : uplift < -0.06 ? (-d[i]! as Vote) : 0;
      }
      return v;
    },
  },
  {
    id: "monte_carlo_bootstrap", name: "Monte Carlo (bootstrap)", family: "quant",
    summary: "Resamples the last 200 returns into 200 paths of 12 bars; votes when finishing beyond 0.5 ATR one way is clearly likelier.",
    compute: (b, _x, from) => {
      const r = logReturns(b.c), a = atrSeries(b), v = out(N(b));
      for (let i = Math.max(210, from ?? 0); i < r.length; i++) {
        if (!Number.isFinite(a[i]!)) continue;
        const rand = rng(7 + barSeed(b, i));
        const th = Math.log(1 + 0.5 * a[i]! / b.c[i]!);
        let up = 0, dn = 0;
        for (let p = 0; p < 200; p++) {
          let x = 0; for (let s = 0; s < 12; s++) x += r[i - Math.floor(rand() * 200)]!;
          if (x > th) up++; else if (x < -th) dn++;
        }
        v[i] = sign((up - dn) / 200, 0.08);
      }
      return v;
    },
  },
  {
    id: "monte_carlo_block", name: "Monte Carlo (block bootstrap)", family: "quant",
    summary: "Bootstrap in blocks of 6 returns, keeping short-term autocorrelation that a plain bootstrap destroys.",
    compute: (b, _x, from) => {
      const r = logReturns(b.c), a = atrSeries(b), v = out(N(b));
      for (let i = Math.max(210, from ?? 0); i < r.length; i++) {
        if (!Number.isFinite(a[i]!)) continue;
        const rand = rng(11 + barSeed(b, i));
        const th = Math.log(1 + 0.5 * a[i]! / b.c[i]!);
        let up = 0, dn = 0;
        for (let p = 0; p < 150; p++) {
          let x = 0;
          for (let blk = 0; blk < 2; blk++) { const st = i - 6 - Math.floor(rand() * 194); for (let s = 0; s < 6; s++) x += r[st + s]!; }
          if (x > th) up++; else if (x < -th) dn++;
        }
        v[i] = sign((up - dn) / 150, 0.08);
      }
      return v;
    },
  },
  {
    id: "brownian_barrier", name: "Brownian Barrier Probability", family: "quant",
    summary: "Drifted Brownian motion fitted to the last 100 returns: probability of touching +1 ATR before -1 ATR (closed form).",
    compute: (b) => {
      const r = logReturns(b.c), a = atrSeries(b), v = out(N(b));
      for (let i = 101; i < r.length; i++) {
        if (!Number.isFinite(a[i]!)) continue;
        let m = 0; for (let k = i - 99; k <= i; k++) m += r[k]!; m /= 100;
        let s2 = 0; for (let k = i - 99; k <= i; k++) s2 += (r[k]! - m) ** 2; s2 /= 99;
        if (s2 <= 0) continue;
        const bar = Math.log(1 + a[i]! / b.c[i]!);
        const p = 1 / (1 + Math.exp(-2 * m * bar / s2));
        v[i] = sign(p - 0.5, 0.05);
      }
      return v;
    },
  },
  {
    id: "fourier_dominant_cycle", name: "Fourier Dominant Cycle", family: "quant",
    summary: "DFT of the detrended last 128 closes; projects the strongest cycle (8-64 bars) two bars ahead and votes with its slope.",
    compute: (b, _x, from) => fourierVote(b, 1, from),
  },
  {
    id: "fourier_lowpass", name: "Fourier Low-pass Projection", family: "quant",
    summary: "Reconstructs price from its three strongest cycles plus trend and votes with the projected next move.",
    compute: (b, _x, from) => fourierVote(b, 3, from),
  },
  {
    id: "spectral_trend_dominance", name: "Spectral Trend Dominance", family: "quant",
    summary: "When most spectral energy sits in long cycles (over 32 bars) the market is trending: follow the 24-bar move.",
    compute: (b, _x, from) => {
      const v = out(N(b)), W = 128;
      for (let i = Math.max(W, from ?? 0); i < N(b); i++) {
        const x = detrended(b.c, i, W); let lo = 0, tot = 0;
        for (let k = 2; k <= W / 8; k++) { const p = dftPower(x, k); tot += p; if (W / k > 32) lo += p; }
        if (tot > 0 && lo / tot > 0.6) v[i] = sign(b.c[i]! - b.c[i - 24]!);
      }
      return v;
    },
  },
  {
    id: "linreg_tstat", name: "Regression Trend t-stat", family: "quant",
    summary: "OLS slope of the last 48 closes; votes when the slope is statistically significant (|t| over 3).",
    compute: (b) => {
      const v = out(N(b)), W = 48;
      for (let i = W - 1; i < N(b); i++) {
        let sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (let k = 0; k < W; k++) { const y = b.c[i - W + 1 + k]!; sx += k; sy += y; sxx += k * k; sxy += k * y; }
        const beta = (W * sxy - sx * sy) / (W * sxx - sx * sx), alpha = (sy - beta * sx) / W;
        let se = 0; for (let k = 0; k < W; k++) se += (b.c[i - W + 1 + k]! - alpha - beta * k) ** 2;
        const sb = Math.sqrt(se / (W - 2) / (sxx - sx * sx / W));
        if (sb > 0) v[i] = sign(beta / sb, 3);
      }
      return v;
    },
  },
  {
    id: "kalman_trend", name: "Kalman Filter Trend", family: "quant",
    summary: "Local-linear-trend Kalman filter; votes with the estimated velocity when it exceeds 0.05 ATR per bar.",
    compute: (b) => {
      const a = atrSeries(b), v = out(N(b));
      let lvl = b.c[0]!, vel = 0, P00 = 1, P01 = 0, P11 = 1;
      for (let i = 1; i < N(b); i++) {
        const q = Number.isFinite(a[i]!) ? (a[i]! * 0.05) ** 2 : 1e-10, R = Number.isFinite(a[i]!) ? (a[i]! * 0.5) ** 2 : 1e-8;
        lvl += vel; P00 += 2 * P01 + P11 + q; P01 += P11; P11 += q * 0.1;
        const S = P00 + R, K0 = P00 / S, K1 = P01 / S, y = b.c[i]! - lvl;
        lvl += K0 * y; vel += K1 * y;
        const n00 = (1 - K0) * P00, n01 = (1 - K0) * P01, n11 = P11 - K1 * P01; P00 = n00; P01 = n01; P11 = n11;
        if (i > 100 && Number.isFinite(a[i]!)) v[i] = sign(vel / a[i]!, 0.05);
      }
      return v;
    },
  },
  {
    id: "hurst_momentum", name: "Hurst Exponent Regime", family: "quant",
    summary: "Rescaled-range Hurst exponent over 128 returns: persistent (H>0.55) follows the 12-bar move, anti-persistent (H<0.45) fades it.",
    compute: (b, _x, from) => {
      const r = logReturns(b.c), v = out(N(b));
      for (let i = Math.max(130, from ?? 0); i < r.length; i++) {
        const H = hurstRS(r, i, 128); if (!Number.isFinite(H)) continue;
        const m = sign(b.c[i]! - b.c[i - 12]!);
        v[i] = H > 0.55 ? m : H < 0.45 ? (-m as Vote) : 0;
      }
      return v;
    },
  },
  {
    id: "dfa_regime", name: "Detrended Fluctuation Analysis", family: "quant",
    summary: "DFA scaling exponent of the last 128 returns; trending (alpha>0.55) follows the 12-bar move, mean-reverting (<0.45) fades it.",
    compute: (b, _x, from) => {
      const r = logReturns(b.c), v = out(N(b));
      for (let i = Math.max(130, from ?? 0); i < r.length; i++) {
        const al = dfaAlpha(r, i, 128); if (!Number.isFinite(al)) continue;
        const m = sign(b.c[i]! - b.c[i - 12]!);
        v[i] = al > 0.55 ? m : al < 0.45 ? (-m as Vote) : 0;
      }
      return v;
    },
  },
  {
    id: "ou_reversion", name: "Ornstein-Uhlenbeck Reversion", family: "quant",
    summary: "AR(1) fit of price over 100 bars; when it is mean-reverting with a half-life under 30 bars, fades a 2-sigma deviation from the OU mean.",
    compute: (b) => {
      const v = out(N(b)), W = 100;
      for (let i = W; i < N(b); i++) {
        let sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (let k = i - W + 1; k <= i; k++) { const x = b.c[k - 1]!, y = b.c[k]!; sx += x; sy += y; sxx += x * x; sxy += x * y; }
        const beta = (W * sxy - sx * sy) / (W * sxx - sx * sx); if (!(beta > 0 && beta < 1)) continue;
        const alpha = (sy - beta * sx) / W, mu = alpha / (1 - beta), hl = -Math.log(2) / Math.log(beta);
        if (hl > 30) continue;
        let se = 0; for (let k = i - W + 1; k <= i; k++) se += (b.c[k]! - alpha - beta * b.c[k - 1]!) ** 2;
        const sd = Math.sqrt(se / (W - 2) / (1 - beta * beta));
        v[i] = sign(-(b.c[i]! - mu) / sd, 2);
      }
      return v;
    },
  },
  {
    id: "zscore_reversion", name: "Z-score Mean Reversion", family: "quant",
    summary: "Fades closes more than 2 standard deviations from the 48-bar mean.",
    compute: (b) => {
      const m = sma(b.c, 48), s = rollingStd(b.c, 48), v = out(N(b));
      for (let i = 0; i < N(b); i++) if (s[i]! > 0) v[i] = sign(-(b.c[i]! - m[i]!) / s[i]!, 2);
      return v;
    },
  },
  {
    id: "autocorr_lag1", name: "Return Autocorrelation", family: "quant",
    summary: "Lag-1 autocorrelation of the last 100 returns: positive continues the last move, negative reverses it.",
    compute: (b) => {
      const r = logReturns(b.c), v = out(N(b));
      for (let i = 101; i < r.length; i++) {
        let m = 0; for (let k = i - 99; k <= i; k++) m += r[k]!; m /= 100;
        let num = 0, den = 0; for (let k = i - 98; k <= i; k++) { num += (r[k]! - m) * (r[k - 1]! - m); den += (r[k]! - m) ** 2; }
        const ac = den > 0 ? num / den : 0;
        v[i] = Math.abs(ac) > 0.1 ? ((sign(ac) * sign(r[i]!)) as Vote) : 0;
      }
      return v;
    },
  },
  {
    id: "tsmom_24h", name: "Time-series Momentum (24h)", family: "quant",
    summary: "Votes with the 48-bar (24 hour) return when it exceeds 1 ATR.",
    compute: (b) => { const a = atrSeries(b), v = out(N(b)); for (let i = 48; i < N(b); i++) if (Number.isFinite(a[i]!)) v[i] = sign((b.c[i]! - b.c[i - 48]!) / a[i]!, 1); return v; },
  },
  {
    id: "tsmom_multi", name: "Multi-horizon Momentum", family: "quant",
    summary: "Momentum over 12, 24, 48 and 96 bars; votes when at least three of the four agree.",
    compute: (b) => {
      const v = out(N(b));
      for (let i = 96; i < N(b); i++) { const s = [12, 24, 48, 96].reduce((t, h) => t + sign(b.c[i]! - b.c[i - h]!), 0); v[i] = s >= 2 ? 1 : s <= -2 ? -1 : 0; }
      return v;
    },
  },
  {
    id: "variance_ratio", name: "Variance Ratio Test", family: "quant",
    summary: "Lo-MacKinlay variance ratio VR(4) on 200 returns: trending (VR>1.15) follows the 8-bar move, mean-reverting (<0.85) fades it.",
    compute: (b) => {
      const r = logReturns(b.c), v = out(N(b));
      for (let i = 204; i < r.length; i++) {
        let m = 0; for (let k = i - 199; k <= i; k++) m += r[k]!; m /= 200;
        let v1 = 0; for (let k = i - 199; k <= i; k++) v1 += (r[k]! - m) ** 2;
        let v4 = 0; for (let k = i - 196; k <= i; k++) { const s = r[k]! + r[k - 1]! + r[k - 2]! + r[k - 3]! - 4 * m; v4 += s * s; }
        const vr = v1 > 0 ? (v4 / 197) / (4 * v1 / 200) : 1;
        const mv = sign(b.c[i]! - b.c[i - 8]!);
        v[i] = vr > 1.15 ? mv : vr < 0.85 ? (-mv as Vote) : 0;
      }
      return v;
    },
  },
  {
    id: "kama_slope", name: "Kaufman Adaptive MA", family: "quant",
    summary: "Slope of Kaufman's adaptive moving average (10, 2, 30) over 3 bars, in ATR units.",
    compute: (b) => {
      const k = new Array(N(b)).fill(NaN), a = atrSeries(b), v = out(N(b));
      for (let i = 10; i < N(b); i++) {
        let path = 0; for (let j = i - 9; j <= i; j++) path += Math.abs(b.c[j]! - b.c[j - 1]!);
        const er = path > 0 ? Math.abs(b.c[i]! - b.c[i - 10]!) / path : 0;
        const sc = (er * (2 / 3 - 2 / 31) + 2 / 31) ** 2;
        k[i] = Number.isFinite(k[i - 1]) ? k[i - 1] + sc * (b.c[i]! - k[i - 1]) : b.c[i]!;
        if (i > 13 && Number.isFinite(a[i]!)) v[i] = sign((k[i] - k[i - 3]) / a[i]!, 0.15);
      }
      return v;
    },
  },
  {
    id: "supersmoother_slope", name: "Ehlers Super Smoother", family: "quant",
    summary: "Two-pole Butterworth super smoother (period 20) and its 2-bar slope in ATR units.",
    compute: (b) => {
      const a1 = Math.exp(-1.414 * Math.PI / 20), b1 = 2 * a1 * Math.cos(1.414 * Math.PI / 20), c2 = b1, c3 = -a1 * a1, c1 = 1 - c2 - c3;
      const f = new Array(N(b)).fill(0), at = atrSeries(b), v = out(N(b));
      for (let i = 0; i < N(b); i++) {
        f[i] = i < 2 ? b.c[i]! : c1 * (b.c[i]! + b.c[i - 1]!) / 2 + c2 * f[i - 1] + c3 * f[i - 2];
        if (i > 40 && Number.isFinite(at[i]!)) v[i] = sign((f[i] - f[i - 2]) / at[i]!, 0.1);
      }
      return v;
    },
  },
  {
    id: "ehlers_itrend", name: "Ehlers Instantaneous Trendline", family: "quant",
    summary: "Ehlers' instantaneous trendline against its two-bar-lagged trigger.",
    compute: (b) => {
      const al = 0.07, it = new Array(N(b)).fill(0), v = out(N(b));
      const p = b.h.map((h, i) => (h + b.l[i]!) / 2);
      for (let i = 0; i < N(b); i++) {
        it[i] = i < 7 ? (p[i]! + 2 * (p[i - 1] ?? p[i]!) + (p[i - 2] ?? p[i]!)) / 4
          : (al - al * al / 4) * p[i]! + 0.5 * al * al * p[i - 1]! - (al - 0.75 * al * al) * p[i - 2]! + 2 * (1 - al) * it[i - 1] - (1 - al) ** 2 * it[i - 2];
        if (i > 40) v[i] = sign(2 * it[i] - it[i - 2] - it[i]);
      }
      return v;
    },
  },
  {
    id: "bayes_updown", name: "Bayesian Up/Down Posterior", family: "quant",
    summary: "Beta posterior on the probability of an up candle from the last 48; votes when that probability is over or under 0.5 with 85% posterior mass.",
    compute: (b) => {
      const v = out(N(b));
      for (let i = 49; i < N(b); i++) {
        let up = 0; for (let k = i - 47; k <= i; k++) up += b.c[k]! > b.c[k - 1]! ? 1 : 0;
        const al = up + 1, be = 48 - up + 1, mean = al / (al + be), sd = Math.sqrt(al * be / ((al + be) ** 2 * (al + be + 1)));
        const z = (mean - 0.5) / sd; v[i] = sign(z, 1.04);
      }
      return v;
    },
  },
  {
    id: "logistic_lags", name: "Logistic Regression (lagged returns)", family: "quant",
    summary: "Logistic model of next-bar direction on the last 5 returns, refitted every bar on the previous 300.",
    compute: (b, _x, from) => {
      const r = logReturns(b.c), sd = rollingStd(r, 100), v = out(N(b));
      for (let i = Math.max(400, from ?? 0); i < r.length; i++) {
        if (!(sd[i]! > 0)) continue;
        const w = new Array(6).fill(0);
        const z = (k: number) => r[k]! / sd[i]!;
        for (let it = 0; it < 3; it++) {
          for (let k = i - 300; k < i; k++) {
            const x = [1, z(k), z(k - 1), z(k - 2), z(k - 3), z(k - 4)];
            const p = 1 / (1 + Math.exp(-x.reduce((s, xi, j) => s + xi * w[j]!, 0)));
            const y = r[k + 1]! > 0 ? 1 : 0;
            for (let j = 0; j < 6; j++) w[j] += 0.01 * (y - p) * x[j]! - 0.001 * w[j]!;
          }
        }
        const x = [1, z(i), z(i - 1), z(i - 2), z(i - 3), z(i - 4)];
        const p = 1 / (1 + Math.exp(-x.reduce((s, xi, j) => s + xi * w[j]!, 0)));
        v[i] = sign(p - 0.5, 0.04);
      }
      return v;
    },
  },
  {
    id: "knn_pattern", name: "k-Nearest-Neighbour Patterns", family: "quant",
    summary: "Finds the 20 most similar 6-bar return patterns in the previous 1000 bars and votes with what followed them over 4 bars.",
    compute: (b, _x, from) => {
      const r = logReturns(b.c), sd = rollingStd(r, 200), v = out(N(b));
      for (let i = Math.max(1210, from ?? 0); i < r.length; i++) {
        if (!(sd[i]! > 0)) continue;
        const pat = [0, 1, 2, 3, 4, 5].map((j) => r[i - j]! / sd[i]!);
        const d: [number, number][] = [];
        for (let k = i - 1000; k < i - 4; k++) {
          let dist = 0; for (let j = 0; j < 6; j++) dist += (r[k - j]! / sd[i]! - pat[j]!) ** 2;
          d.push([dist, r[k + 1]! + r[k + 2]! + r[k + 3]! + r[k + 4]!]);
        }
        d.sort((x, y) => x[0] - y[0]);
        let up = 0; for (let j = 0; j < 20; j++) up += d[j]![1] > 0 ? 1 : -1;
        v[i] = sign(up, 6);
      }
      return v;
    },
  },
  {
    id: "hour_seasonality", name: "Intraday Seasonality", family: "quant",
    summary: "Average return of the next 4 bars after this half-hour over the last 4 weeks; votes when it is significant.",
    compute: (b, _x, from) => seasonalVote(b, (t) => new Date(t).getUTCHours() * 2 + (new Date(t).getUTCMinutes() >= 30 ? 1 : 0), 28, 2, from),
  },
  {
    id: "weekday_hour_seasonality", name: "Weekday-Hour Seasonality", family: "quant",
    summary: "Same as intraday seasonality but per weekday and hour, over the last 12 weeks.",
    compute: (b, _x, from) => seasonalVote(b, (t) => new Date(t).getUTCDay() * 24 + new Date(t).getUTCHours(), 84, 1.5, from),
  },
  {
    id: "currency_strength_momentum", name: "Currency Strength Momentum", family: "quant",
    summary: "Strength of each currency from all 14 pairs' 24-bar moves; buys the stronger currency against the weaker.",
    compute: (b, x) => currencyStrengthVote(b, x, 48, 1),
  },
  {
    id: "currency_strength_reversion", name: "Currency Strength Reversion", family: "quant",
    summary: "Fades extreme 8-bar currency-strength gaps across the 14 pairs.",
    compute: (b, x) => currencyStrengthVote(b, x, 8, -1),
  },
  {
    id: "cross_sectional_momentum", name: "Cross-sectional Momentum", family: "quant",
    summary: "Ranks the pair's 24-hour return (in volatility units) against the other 13; top 3 buy, bottom 3 sell.",
    compute: (b, x) => {
      const v = out(N(b)); if (!x) return v;
      const syms = Object.keys(x.closes); const me = x.closes[x.symbol]; if (!me) return v;
      for (let i = 48; i < N(b); i++) {
        const score = (c: number[]) => { const a = c[i], p = c[i - 48]; return Number.isFinite(a) && Number.isFinite(p) && p > 0 ? Math.log(a / p) : NaN; };
        const mine = score(me); if (!Number.isFinite(mine)) continue;
        let above = 0, valid = 0; for (const s of syms) { const sc = score(x.closes[s]!); if (!Number.isFinite(sc)) continue; valid++; if (sc > mine) above++; }
        if (valid >= 8) v[i] = above <= 2 ? 1 : above >= valid - 3 ? -1 : 0;
      }
      return v;
    },
  },
  {
    id: "volatility_breakout", name: "Statistical Volatility Breakout", family: "quant",
    summary: "Close beyond the 24-bar mean by more than 2.5 standard deviations of the 24-bar change: follows the break.",
    compute: (b) => {
      const m = sma(b.c, 24), s = rollingStd(b.c, 24), v = out(N(b));
      for (let i = 0; i < N(b); i++) if (s[i]! > 0) v[i] = sign((b.c[i]! - m[i]!) / s[i]!, 2.5);
      return v;
    },
  },
  {
    id: "haar_wavelet_trend", name: "Haar Wavelet Trend", family: "quant",
    summary: "Three-level Haar wavelet approximation of the last 64 closes; votes with the slope of the smooth component.",
    compute: (b) => {
      const a = atrSeries(b), v = out(N(b));
      for (let i = 64; i < N(b); i++) {
        let x = b.c.slice(i - 63, i + 1);
        for (let lv = 0; lv < 3; lv++) { const y: number[] = []; for (let k = 0; k + 1 < x.length; k += 2) y.push((x[k]! + x[k + 1]!) / 2); x = y; }
        if (Number.isFinite(a[i]!)) v[i] = sign((x[x.length - 1]! - x[x.length - 2]!) / a[i]!, 0.5);
      }
      return v;
    },
  },
  {
    id: "fractal_dimension", name: "Fractal Dimension Trend", family: "quant",
    summary: "Katz fractal dimension of the last 32 closes: a low dimension (smooth, trending path) follows the 12-bar move.",
    compute: (b) => {
      const v = out(N(b));
      for (let i = 32; i < N(b); i++) {
        let L = 0, dmax = 0; for (let k = i - 31; k <= i; k++) { L += Math.abs(b.c[k]! - b.c[k - 1]!); dmax = Math.max(dmax, Math.abs(b.c[k]! - b.c[i - 32]!)); }
        if (L <= 0 || dmax <= 0) continue;
        const n = 32, fd = Math.log10(n) / (Math.log10(n) + Math.log10(dmax / L));
        if (fd < 1.25) v[i] = sign(b.c[i]! - b.c[i - 12]!);
      }
      return v;
    },
  },
  {
    id: "sharpe_trend", name: "Rolling Sharpe Trend", family: "quant",
    summary: "Annualisation-free Sharpe of the last 48 returns (mean / sd x sqrt(48)); follows trends with a ratio over 1.5.",
    compute: (b) => {
      const r = logReturns(b.c), v = out(N(b));
      for (let i = 49; i < r.length; i++) {
        let m = 0; for (let k = i - 47; k <= i; k++) m += r[k]!; m /= 48;
        let s2 = 0; for (let k = i - 47; k <= i; k++) s2 += (r[k]! - m) ** 2;
        const sd = Math.sqrt(s2 / 47); if (sd > 0) v[i] = sign(m / sd * Math.sqrt(48), 1.5);
      }
      return v;
    },
  },
  {
    id: "permutation_trend", name: "Monte Carlo Permutation Test", family: "quant",
    summary: "Is the 48-bar trend real? Compares the longest same-direction drift against 100 random shuffles of the same returns; follows it when p < 0.05.",
    compute: (b, _x, from) => {
      const r = logReturns(b.c), v = out(N(b));
      const stat = (x: number[]) => { let best = 0, cur = 0; for (const y of x) { cur = Math.max(0, cur + y); best = Math.max(best, cur); } return best; };
      for (let i = Math.max(49, from ?? 0); i < r.length; i++) {
        const rand = rng(23 + barSeed(b, i));
        const w = r.slice(i - 47, i + 1); const dir = sign(w.reduce((s, y) => s + y, 0)); if (!dir) continue;
        const ws = w.map((y) => y * dir), obs = stat(ws);
        let ge = 0;
        for (let p = 0; p < 100; p++) {
          const sh = ws.slice(); for (let k = sh.length - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); [sh[k], sh[j]] = [sh[j]!, sh[k]!]; }
          if (stat(sh) >= obs) ge++;
        }
        if (ge < 5) v[i] = dir;
      }
      return v;
    },
  },
  {
    id: "entropy_regime", name: "Shannon Entropy Regime", family: "quant",
    summary: "Entropy of the last 32 candle directions; an ordered (low-entropy) sequence follows its majority direction.",
    compute: (b) => {
      const v = out(N(b));
      for (let i = 33; i < N(b); i++) {
        let up = 0; for (let k = i - 31; k <= i; k++) up += b.c[k]! > b.c[k - 1]! ? 1 : 0;
        const p = up / 32, h = p <= 0 || p >= 1 ? 0 : -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
        if (h < 0.9) v[i] = sign(p - 0.5);
      }
      return v;
    },
  },
  {
    id: "ewma_vol_momentum", name: "Volatility-scaled Momentum", family: "quant",
    summary: "24-bar return divided by an EWMA (RiskMetrics, 0.94) volatility forecast; follows moves over 1.5 forecast sigmas.",
    compute: (b, _x, from) => {
      const r = logReturns(b.c), v = out(N(b)); let s2 = 0;
      for (let i = 1; i < r.length; i++) {
        s2 = i === 1 ? r[i]! ** 2 : 0.94 * s2 + 0.06 * r[i]! ** 2;
        if (i > 60 && s2 > 0) v[i] = sign(Math.log(b.c[i]! / b.c[i - 24]!) / (Math.sqrt(s2) * Math.sqrt(24)), 1.5);
      }
      return v;
    },
  },
];

function detrended(c: number[], i: number, W: number): number[] {
  const y = c.slice(i - W + 1, i + 1);
  const n = y.length, mx = (n - 1) / 2; let my = 0; for (const t of y) my += t; my /= n;
  let num = 0, den = 0; y.forEach((t, k) => { num += (k - mx) * (t - my); den += (k - mx) ** 2; });
  const beta = num / den; return y.map((t, k) => t - (my + beta * (k - mx)));
}
function dftPower(x: number[], k: number) {
  let re = 0, im = 0; const n = x.length;
  for (let t = 0; t < n; t++) { const a = 2 * Math.PI * k * t / n; re += x[t]! * Math.cos(a); im -= x[t]! * Math.sin(a); }
  return re * re + im * im;
}
function fourierVote(b: Bars, comps: number, from = 0): Int8Array {
  const v = out(N(b)), W = 128, a = atrSeries(b);
  for (let i = Math.max(W, from); i < N(b); i++) {
    if (!Number.isFinite(a[i]!)) continue;
    const x = detrended(b.c, i, W);
    const coeffs: { k: number; re: number; im: number; p: number }[] = [];
    for (let k = 2; k <= W / 8; k++) {
      let re = 0, im = 0; for (let t = 0; t < W; t++) { const ang = 2 * Math.PI * k * t / W; re += x[t]! * Math.cos(ang); im -= x[t]! * Math.sin(ang); }
      coeffs.push({ k, re, im, p: re * re + im * im });
    }
    coeffs.sort((p, q) => q.p - p.p);
    const val = (t: number) => coeffs.slice(0, comps).reduce((s, c) => s + (2 / W) * (c.re * Math.cos(2 * Math.PI * c.k * t / W) - c.im * Math.sin(2 * Math.PI * c.k * t / W)), 0);
    v[i] = sign((val(W + 1) - val(W - 1)) / a[i]!, 0.1);
  }
  return v;
}
function hurstRS(r: number[], i: number, W: number): number {
  const xs: number[] = [], ys: number[] = [];
  for (const n of [8, 16, 32, 64]) {
    let acc = 0, cnt = 0;
    for (let s = i - W + 1; s + n - 1 <= i; s += n) {
      const seg = r.slice(s, s + n); const m = seg.reduce((a, b) => a + b, 0) / n;
      let cum = 0, mx = -Infinity, mn = Infinity, s2 = 0;
      for (const y of seg) { cum += y - m; mx = Math.max(mx, cum); mn = Math.min(mn, cum); s2 += (y - m) ** 2; }
      const sd = Math.sqrt(s2 / n); if (sd > 0) { acc += (mx - mn) / sd; cnt++; }
    }
    if (cnt) { xs.push(Math.log(n)); ys.push(Math.log(acc / cnt)); }
  }
  return slope(xs, ys);
}
function dfaAlpha(r: number[], i: number, W: number): number {
  const seg = r.slice(i - W + 1, i + 1); const m = seg.reduce((a, b) => a + b, 0) / W;
  const y: number[] = []; let c = 0; for (const v of seg) { c += v - m; y.push(c); }
  const xs: number[] = [], ys: number[] = [];
  for (const n of [8, 16, 32]) {
    let f2 = 0, cnt = 0;
    for (let s = 0; s + n <= W; s += n) {
      const part = y.slice(s, s + n); const tx = part.map((_, k) => k);
      const b = slope(tx, part), a = part.reduce((p, q) => p + q, 0) / n - b * (n - 1) / 2;
      part.forEach((p, k) => { f2 += (p - a - b * k) ** 2; cnt++; });
    }
    if (cnt) { xs.push(Math.log(n)); ys.push(0.5 * Math.log(f2 / cnt)); }
  }
  return slope(xs, ys);
}
function slope(xs: number[], ys: number[]): number {
  const n = xs.length; if (n < 2) return NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0; for (let k = 0; k < n; k++) { num += (xs[k]! - mx) * (ys[k]! - my); den += (xs[k]! - mx) ** 2; }
  return den > 0 ? num / den : NaN;
}
function seasonalVote(b: Bars, key: (t: number) => number, calendarDays: number, tCut: number, fromBar = 0): Int8Array {
  const v = out(N(b)), r = logReturns(b.c), fwd = r.map((_, i) => (i + 4 < r.length ? r[i + 1]! + r[i + 2]! + r[i + 3]! + r[i + 4]! : NaN));
  const lookbackMs = calendarDays * 86_400_000;
  for (let i = fromBar; i < N(b); i++) {
    const k = key(b.t[i]!), from = b.t[i]! - lookbackMs, xs: number[] = [];
    for (let j = i - 1; j >= 0 && b.t[j]! >= from; j--) {
      // Only outcomes already complete at bar i: their 4-bar window ends at or before i.
      if (j + 4 > i) continue;
      if (key(b.t[j]!) === k && Number.isFinite(fwd[j]!)) xs.push(fwd[j]!);
    }
    if (xs.length < 8) continue;
    const m = xs.reduce((a, c) => a + c, 0) / xs.length, sd = Math.sqrt(xs.reduce((a, c) => a + (c - m) ** 2, 0) / (xs.length - 1));
    if (sd > 0) v[i] = sign(m / (sd / Math.sqrt(xs.length)), tCut);
  }
  return v;
}
function currencyStrengthVote(b: Bars, x: CrossContext | undefined, look: number, dir: 1 | -1): Int8Array {
  const v = out(N(b)); if (!x) return v;
  const base = x.symbol.slice(3, 6), quote = x.symbol.slice(6, 9);
  for (let i = look; i < N(b); i++) {
    const str: Record<string, number[]> = {};
    for (const [s, c] of Object.entries(x.closes)) {
      const a = c[i], p = c[i - look]; if (!(a > 0 && p > 0)) continue;
      const lr = Math.log(a / p), bs = s.slice(3, 6), qs = s.slice(6, 9);
      (str[bs] ??= []).push(lr); (str[qs] ??= []).push(-lr);
    }
    const avg = (k: string) => (str[k]?.length ? str[k]!.reduce((p, q) => p + q, 0) / str[k]!.length : NaN);
    const gap = avg(base) - avg(quote);
    const all = Object.keys(str).map(avg).filter(Number.isFinite);
    const sd = Math.sqrt(all.reduce((p, q) => p + q * q, 0) / Math.max(1, all.length));
    if (!(sd > 0) || !Number.isFinite(gap)) continue;
    v[i] = (sign(gap / sd, 1) * dir) as Vote;
  }
  return v;
}

// ─────────────────────────────────────────────────────────────────────────────
// Technical-analysis strategies (20)
// ─────────────────────────────────────────────────────────────────────────────

function macd(c: number[]) {
  const f = ema(c, 12), s = ema(c, 26), m = f.map((x, i) => x - s[i]!), sig = ema(m.map((x) => (Number.isFinite(x) ? x : 0)), 9);
  return { m, sig, hist: m.map((x, i) => x - sig[i]!) };
}

const T: StrategyDef[] = [
  {
    id: "rsi_reversal", name: "RSI 30/70 Reversal", family: "ta",
    summary: "RSI(14) crossing back up through 30 buys, back down through 70 sells.",
    compute: (b) => { const r = rsiSeries(b.c), v = out(N(b)); for (let i = 1; i < N(b); i++) v[i] = r[i - 1]! < 30 && r[i]! >= 30 ? 1 : r[i - 1]! > 70 && r[i]! <= 70 ? -1 : 0; return v; },
  },
  {
    id: "macd_histogram", name: "MACD Histogram", family: "ta",
    summary: "MACD(12,26,9) histogram sign while it is growing in that direction.",
    compute: (b) => { const { hist } = macd(b.c), v = out(N(b)); for (let i = 40; i < N(b); i++) v[i] = hist[i]! > 0 && hist[i]! > hist[i - 1]! ? 1 : hist[i]! < 0 && hist[i]! < hist[i - 1]! ? -1 : 0; return v; },
  },
  {
    id: "ema_cross", name: "EMA 20/50 Trend", family: "ta",
    summary: "EMA 20 above EMA 50 with price above both buys; the mirror sells.",
    compute: (b) => { const f = ema(b.c, 20), s = ema(b.c, 50), v = out(N(b)); for (let i = 50; i < N(b); i++) v[i] = f[i]! > s[i]! && b.c[i]! > f[i]! ? 1 : f[i]! < s[i]! && b.c[i]! < f[i]! ? -1 : 0; return v; },
  },
  {
    id: "bollinger_reversion", name: "Bollinger Band Reversion", family: "ta",
    summary: "Close back inside the 20-bar 2-sigma Bollinger band after closing outside it: fades the excursion.",
    compute: (b) => {
      const m = sma(b.c, 20), s = rollingStd(b.c, 20), v = out(N(b));
      for (let i = 21; i < N(b); i++) { const up = (k: number) => m[k]! + 2 * s[k]!, dn = (k: number) => m[k]! - 2 * s[k]!; v[i] = b.c[i - 1]! < dn(i - 1) && b.c[i]! > dn(i) ? 1 : b.c[i - 1]! > up(i - 1) && b.c[i]! < up(i) ? -1 : 0; }
      return v;
    },
  },
  {
    id: "stochastic_cross", name: "Stochastic 20/80 Cross", family: "ta",
    summary: "Stochastic %K(14) crossing %D(3) below 20 buys, above 80 sells.",
    compute: (b) => {
      const k = b.c.map((c, i) => { if (i < 13) return NaN; const hi = highest(b.h, i, 14), lo = lowest(b.l, i, 14); return hi > lo ? 100 * (c - lo) / (hi - lo) : 50; });
      const d = sma(k.map((x) => (Number.isFinite(x) ? x : 50)), 3), v = out(N(b));
      for (let i = 16; i < N(b); i++) v[i] = k[i]! > d[i]! && k[i - 1]! <= d[i - 1]! && k[i]! < 20 ? 1 : k[i]! < d[i]! && k[i - 1]! >= d[i - 1]! && k[i]! > 80 ? -1 : 0;
      return v;
    },
  },
  {
    id: "adx_dmi", name: "ADX / DMI Trend", family: "ta",
    summary: "With ADX(14) above 25, votes with the stronger directional index.",
    compute: (b) => {
      const n = N(b), v = out(n), pdm: number[] = [0], mdm: number[] = [0], tr = trueRange(b);
      for (let i = 1; i < n; i++) { const u = b.h[i]! - b.h[i - 1]!, d = b.l[i - 1]! - b.l[i]!; pdm.push(u > d && u > 0 ? u : 0); mdm.push(d > u && d > 0 ? d : 0); }
      const w = (a: number[]) => { const o = new Array(n).fill(NaN); let s = 0; for (let i = 0; i < n; i++) { s = i < 14 ? s + a[i]! : s - s / 14 + a[i]!; if (i >= 13) o[i] = s; } return o; };
      const atr = w(tr), p = w(pdm), m = w(mdm);
      const pdi = p.map((x, i) => 100 * x / atr[i]!), mdi = m.map((x, i) => 100 * x / atr[i]!);
      const dx = pdi.map((x, i) => 100 * Math.abs(x - mdi[i]!) / (x + mdi[i]!));
      let adx = NaN;
      for (let i = 27; i < n; i++) { adx = Number.isFinite(adx) ? (adx * 13 + dx[i]!) / 14 : dx.slice(14, 28).reduce((a, c) => a + c, 0) / 14; if (adx > 25) v[i] = sign(pdi[i]! - mdi[i]!); }
      return v;
    },
  },
  {
    id: "ichimoku", name: "Ichimoku Cloud", family: "ta",
    summary: "Price above the cloud with Tenkan above Kijun buys; below the cloud with Tenkan below Kijun sells.",
    compute: (b) => {
      const v = out(N(b)), mid = (i: number, n: number) => (highest(b.h, i, n) + lowest(b.l, i, n)) / 2;
      for (let i = 78; i < N(b); i++) {
        const ten = mid(i, 9), kij = mid(i, 26), sa = (mid(i - 26, 9) + mid(i - 26, 26)) / 2, sb = mid(i - 26, 52);
        const top = Math.max(sa, sb), bot = Math.min(sa, sb);
        v[i] = b.c[i]! > top && ten > kij ? 1 : b.c[i]! < bot && ten < kij ? -1 : 0;
      }
      return v;
    },
  },
  {
    id: "keltner_breakout", name: "Keltner Channel Breakout", family: "ta",
    summary: "Close outside EMA(20) plus or minus 2 ATR: follows the breakout.",
    compute: (b) => { const e = ema(b.c, 20), a = atrSeries(b, 10), v = out(N(b)); for (let i = 21; i < N(b); i++) v[i] = b.c[i]! > e[i]! + 2 * a[i]! ? 1 : b.c[i]! < e[i]! - 2 * a[i]! ? -1 : 0; return v; },
  },
  {
    id: "roc_momentum", name: "Rate of Change", family: "ta",
    summary: "12-bar rate of change beyond plus or minus its 100-bar standard deviation.",
    compute: (b) => { const roc = b.c.map((c, i) => (i >= 12 ? c / b.c[i - 12]! - 1 : 0)), s = rollingStd(roc, 100), v = out(N(b)); for (let i = 112; i < N(b); i++) v[i] = sign(roc[i]! / s[i]!, 1); return v; },
  },
  {
    id: "williams_r", name: "Williams %R Reversal", family: "ta",
    summary: "Williams %R(14) leaving the -80 floor buys, leaving the -20 ceiling sells.",
    compute: (b) => {
      const w = b.c.map((c, i) => { if (i < 13) return -50; const hi = highest(b.h, i, 14), lo = lowest(b.l, i, 14); return hi > lo ? -100 * (hi - c) / (hi - lo) : -50; }), v = out(N(b));
      for (let i = 14; i < N(b); i++) v[i] = w[i - 1]! < -80 && w[i]! >= -80 ? 1 : w[i - 1]! > -20 && w[i]! <= -20 ? -1 : 0;
      return v;
    },
  },
  {
    id: "cci_cross", name: "CCI +/-100", family: "ta",
    summary: "CCI(20) crossing up through -100 buys, down through +100 sells.",
    compute: (b) => {
      const tp = b.c.map((c, i) => (c + b.h[i]! + b.l[i]!) / 3), m = sma(tp, 20), v = out(N(b)), cci = new Array(N(b)).fill(0);
      for (let i = 19; i < N(b); i++) { let md = 0; for (let k = i - 19; k <= i; k++) md += Math.abs(tp[k]! - m[i]!); md /= 20; cci[i] = md > 0 ? (tp[i]! - m[i]!) / (0.015 * md) : 0; }
      for (let i = 20; i < N(b); i++) v[i] = cci[i - 1] < -100 && cci[i] >= -100 ? 1 : cci[i - 1] > 100 && cci[i] <= 100 ? -1 : 0;
      return v;
    },
  },
  {
    id: "donchian_breakout", name: "Donchian 20 Breakout", family: "ta",
    summary: "Close above the prior 20-bar high buys, below the prior 20-bar low sells.",
    compute: (b) => { const v = out(N(b)); for (let i = 21; i < N(b); i++) v[i] = b.c[i]! > highest(b.h, i - 1, 20) ? 1 : b.c[i]! < lowest(b.l, i - 1, 20) ? -1 : 0; return v; },
  },
  {
    id: "parabolic_sar", name: "Parabolic SAR", family: "ta",
    summary: "Wilder's Parabolic SAR (0.02 / 0.2): votes with the side price is on.",
    compute: (b) => {
      const v = out(N(b)); if (N(b) < 3) return v;
      let up = b.c[1]! > b.c[0]!, sar = up ? b.l[0]! : b.h[0]!, ep = up ? b.h[1]! : b.l[1]!, af = 0.02;
      for (let i = 2; i < N(b); i++) {
        sar = sar + af * (ep - sar);
        if (up) { sar = Math.min(sar, b.l[i - 1]!, b.l[i - 2]!); if (b.l[i]! < sar) { up = false; sar = ep; ep = b.l[i]!; af = 0.02; } else if (b.h[i]! > ep) { ep = b.h[i]!; af = Math.min(0.2, af + 0.02); } }
        else { sar = Math.max(sar, b.h[i - 1]!, b.h[i - 2]!); if (b.h[i]! > sar) { up = true; sar = ep; ep = b.h[i]!; af = 0.02; } else if (b.l[i]! < ep) { ep = b.l[i]!; af = Math.min(0.2, af + 0.02); } }
        if (i > 20) v[i] = up ? 1 : -1;
      }
      return v;
    },
  },
  {
    id: "pivot_points", name: "Daily Pivot Points", family: "ta",
    summary: "Classic pivots from the previous UTC day: buys a bounce off S1, sells a rejection at R1.",
    compute: (b) => {
      const v = out(N(b)); let day = -1, H = -Infinity, L = Infinity, C = NaN, P = NaN, R1 = NaN, S1 = NaN;
      for (let i = 0; i < N(b); i++) {
        const d = Math.floor(b.t[i]! / 86_400_000);
        if (d !== day) { if (day >= 0 && Number.isFinite(C)) { P = (H + L + C) / 3; R1 = 2 * P - L; S1 = 2 * P - H; } day = d; H = -Infinity; L = Infinity; }
        if (Number.isFinite(P)) v[i] = b.l[i]! <= S1 && b.c[i]! > S1 ? 1 : b.h[i]! >= R1 && b.c[i]! < R1 ? -1 : 0;
        H = Math.max(H, b.h[i]!); L = Math.min(L, b.l[i]!); C = b.c[i]!;
      }
      return v;
    },
  },
  {
    id: "fib_macd", name: "Fibonacci Retracement + MACD", family: "ta",
    summary: "In a 48-bar swing, price back in the 50-61.8% retracement while the MACD histogram turns back with the swing.",
    compute: (b) => {
      const { hist } = macd(b.c), v = out(N(b));
      for (let i = 50; i < N(b); i++) {
        let hiI = i, loI = i; for (let k = i - 47; k <= i; k++) { if (b.h[k]! > b.h[hiI]!) hiI = k; if (b.l[k]! < b.l[loI]!) loI = k; }
        const hi = b.h[hiI]!, lo = b.l[loI]!, rng2 = hi - lo; if (rng2 <= 0) continue;
        const turnUp = hist[i]! > hist[i - 1]! && hist[i - 1]! <= hist[i - 2]!, turnDn = hist[i]! < hist[i - 1]! && hist[i - 1]! >= hist[i - 2]!;
        if (loI < hiI) { const lvl = (hi - b.c[i]!) / rng2; if (lvl >= 0.5 && lvl <= 0.618 && turnUp) v[i] = 1; }
        else { const lvl = (b.c[i]! - lo) / rng2; if (lvl >= 0.5 && lvl <= 0.618 && turnDn) v[i] = -1; }
      }
      return v;
    },
  },
  {
    id: "supertrend", name: "Supertrend (10 / 3)", family: "ta",
    summary: "ATR(10) x 3 trailing bands: votes with the side price is on.",
    compute: (b) => {
      const a = atrSeries(b, 10), v = out(N(b)); let upB = NaN, dnB = NaN, trend = 1;
      for (let i = 10; i < N(b); i++) {
        const m = (b.h[i]! + b.l[i]!) / 2, bu = m + 3 * a[i]!, bd = m - 3 * a[i]!;
        upB = !Number.isFinite(upB) || bu < upB || b.c[i - 1]! > upB ? bu : upB;
        dnB = !Number.isFinite(dnB) || bd > dnB || b.c[i - 1]! < dnB ? bd : dnB;
        if (b.c[i]! > upB) trend = 1; else if (b.c[i]! < dnB) trend = -1;
        if (i > 30) v[i] = trend as Vote;
      }
      return v;
    },
  },
  {
    id: "aroon", name: "Aroon (25)", family: "ta",
    summary: "Aroon Up above 70 with Aroon Down below 30 buys; the mirror sells.",
    compute: (b) => {
      const v = out(N(b));
      for (let i = 25; i < N(b); i++) {
        let hiI = i, loI = i; for (let k = i - 25; k <= i; k++) { if (b.h[k]! >= b.h[hiI]!) hiI = k; if (b.l[k]! <= b.l[loI]!) loI = k; }
        const up = 100 * (25 - (i - hiI)) / 25, dn = 100 * (25 - (i - loI)) / 25;
        v[i] = up > 70 && dn < 30 ? 1 : dn > 70 && up < 30 ? -1 : 0;
      }
      return v;
    },
  },
  {
    id: "heikin_ashi", name: "Heikin-Ashi Trend", family: "ta",
    summary: "Three consecutive Heikin-Ashi candles of one colour with no opposite wick.",
    compute: (b) => {
      const v = out(N(b)), ho: number[] = [], hc: number[] = [];
      for (let i = 0; i < N(b); i++) { hc.push((b.o[i]! + b.h[i]! + b.l[i]! + b.c[i]!) / 4); ho.push(i ? (ho[i - 1]! + hc[i - 1]!) / 2 : (b.o[0]! + b.c[0]!) / 2); }
      for (let i = 3; i < N(b); i++) {
        const bull = (k: number) => hc[k]! > ho[k]! && b.l[k]! >= Math.min(ho[k]!, hc[k]!) - 1e-12 && Math.min(ho[k]!, hc[k]!) - b.l[k]! < 0.1 * (b.h[k]! - b.l[k]!);
        const bear = (k: number) => hc[k]! < ho[k]! && b.h[k]! - Math.max(ho[k]!, hc[k]!) < 0.1 * (b.h[k]! - b.l[k]!);
        v[i] = bull(i) && bull(i - 1) && bull(i - 2) ? 1 : bear(i) && bear(i - 1) && bear(i - 2) ? -1 : 0;
      }
      return v;
    },
  },
  {
    id: "trix", name: "TRIX (15)", family: "ta",
    summary: "Triple-smoothed EMA rate of change crossing its 9-bar signal line.",
    compute: (b) => {
      const e3 = ema(ema(ema(b.c, 15).map((x, i) => (Number.isFinite(x) ? x : b.c[i]!)), 15).map((x, i) => (Number.isFinite(x) ? x : b.c[i]!)), 15);
      const tr = e3.map((x, i) => (i && Number.isFinite(x) && Number.isFinite(e3[i - 1]) ? (x - e3[i - 1]!) / e3[i - 1]! : 0)), sig = ema(tr, 9), v = out(N(b));
      for (let i = 60; i < N(b); i++) v[i] = tr[i]! > sig[i]! && tr[i]! > 0 ? 1 : tr[i]! < sig[i]! && tr[i]! < 0 ? -1 : 0;
      return v;
    },
  },
  {
    id: "vortex", name: "Vortex Indicator (14)", family: "ta",
    summary: "VI+ above VI- by more than 0.1 buys; the mirror sells.",
    compute: (b) => {
      const v = out(N(b)), tr = trueRange(b);
      for (let i = 15; i < N(b); i++) {
        let vp = 0, vm = 0, ts = 0; for (let k = i - 13; k <= i; k++) { vp += Math.abs(b.h[k]! - b.l[k - 1]!); vm += Math.abs(b.l[k]! - b.h[k - 1]!); ts += tr[k]!; }
        if (ts > 0) v[i] = sign((vp - vm) / ts, 0.1);
      }
      return v;
    },
  },
];

export const STRATEGIES: StrategyDef[] = [...Q, ...T];

/** Bars of history every strategy needs before its votes are meaningful. */
export const WARMUP_BARS = 1300;
