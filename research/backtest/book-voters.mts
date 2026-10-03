// Candidate voters taken from the two books, computed on M30, H1 and H4 for every pair.
// Each uses only closed bars up to the one it votes on. Writes data/votes-book-{M30,H1,H4}.json
// (same layout as votes-M30.json, so cand-lib's loadTF can read it).
//   chan_turning_point   Chan ex.7.1: a strong bar that reverses from a fresh 10-bar extreme; held 10 bars.
//   pair_spread_reversion Chan ch.7: spread against the most correlated pair (OLS hedge ratio, 500 bars);
//                         fade at |z|>2, exit at |z|<0.5 (Chan's GLD/GDX rule).
//   sadf_explosive        AFML ch.17: supremum ADF on log prices; when the series is explosive, follow it.
//   csw_cusum_break       AFML ch.17: Chu-Stinchcombe-White CUSUM on log levels; follow a significant break.
//   fracdiff_reversion    AFML ch.5: fractionally differentiated log price (d=0.4) keeps memory but is
//                         stationary; fade it at |z|>2.
//   cusum_filter_trend    AFML ch.2 / Fama-Blume filter rule: symmetric CUSUM of returns; side of the last event.
//   low_entropy_momentum  AFML ch.18: follow the 20-bar move only when the sign sequence is unusually predictable.
import fs from "node:fs";
type Bars = { t: number[]; o: number[]; h: number[]; l: number[]; c: number[] };
const B = new URL("./data", import.meta.url).pathname;
const raw = JSON.parse(fs.readFileSync(B + "/candles2y.json", "utf8"));
function barsFor(rows: number[][], tf: string): Bars {
  const sec = tf === "M30" ? 1800 : 3600; const r = rows.filter((x) => x[0] % sec === 0);
  if (tf !== "H4") return { t: r.map((x) => x[0] * 1000), o: r.map((x) => x[1]), h: r.map((x) => x[2]), l: r.map((x) => x[3]), c: r.map((x) => x[4]) };
  const b: Bars = { t: [], o: [], h: [], l: [], c: [] };
  for (const x of r) { const t4 = Math.floor(x[0] / 14400) * 14400 * 1000, n = b.t.length;
    if (n && b.t[n - 1] === t4) { b.h[n - 1] = Math.max(b.h[n - 1], x[2]); b.l[n - 1] = Math.min(b.l[n - 1], x[3]); b.c[n - 1] = x[4]; }
    else { b.t.push(t4); b.o.push(x[1]); b.h.push(x[2]); b.l.push(x[3]); b.c.push(x[4]); } }
  return b;
}
const rets = (c: number[]) => c.map((x, i) => (i ? Math.log(x / c[i - 1]) : 0));
function rollStd(x: number[], n: number) { const o = new Array(x.length).fill(NaN); let s = 0, s2 = 0;
  for (let i = 0; i < x.length; i++) { s += x[i]; s2 += x[i] * x[i]; if (i >= n) { s -= x[i - n]; s2 -= x[i - n] ** 2; } if (i >= n - 1) o[i] = Math.sqrt(Math.max(0, (s2 - s * s / n) / (n - 1))); } return o; }

function chanTurningPoint(b: Bars) {
  const r = rets(b.c), sd = rollStd(r, 100), v = new Int8Array(b.c.length); let state = 0, left = 0;
  for (let i = 100; i < b.c.length; i++) {
    let lo = Infinity, hi = -Infinity; for (let k = i - 9; k <= i; k++) { lo = Math.min(lo, b.l[k]); hi = Math.max(hi, b.h[k]); }
    if (r[i] > 1.5 * sd[i] && b.l[i] <= lo) { state = 1; left = 10; }
    else if (r[i] < -1.5 * sd[i] && b.h[i] >= hi) { state = -1; left = 10; }
    v[i] = left > 0 ? state : 0; if (left > 0) left--;
  }
  return v;
}
function pairSpreadReversion(s: string, all: Record<string, Bars>) {
  const b = all[s], n = b.c.length, v = new Int8Array(n), L = 500, y = b.c.map(Math.log);
  const others = Object.keys(all).filter((o) => o !== s).map((o) => { const m = new Map(all[o].t.map((t, i) => [t, all[o].c[i]])); return { o, x: b.t.map((t) => m.get(t) ?? NaN) }; });
  for (const o of others) for (let i = 1; i < n; i++) if (!Number.isFinite(o.x[i])) o.x[i] = o.x[i - 1]; // carry last close
  let partner = -1, state = 0;
  for (let i = L; i < n; i++) {
    if ((i - L) % 48 === 0 || partner < 0) { // re-pick the partner every 48 bars by return correlation
      let best = 0; partner = -1;
      others.forEach((o, k) => { let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, m = 0;
        for (let j = i - L + 1; j <= i; j++) { const a = Math.log(o.x[j] / o.x[j - 1]), c = y[j] - y[j - 1]; if (!Number.isFinite(a)) continue; sx += a; sy += c; sxx += a * a; syy += c * c; sxy += a * c; m++; }
        const cr = (m * sxy - sx * sy) / Math.sqrt((m * sxx - sx * sx) * (m * syy - sy * sy)); if (Math.abs(cr) > best) { best = Math.abs(cr); partner = k; } });
    }
    const x = others[partner].x.slice(i - L + 1, i + 1).map(Math.log), yy = y.slice(i - L + 1, i + 1);
    if (x.some((q) => !Number.isFinite(q))) { v[i] = 0; continue; }
    const mx = x.reduce((a, q) => a + q, 0) / L, my = yy.reduce((a, q) => a + q, 0) / L;
    let cov = 0, vx = 0; for (let j = 0; j < L; j++) { cov += (x[j] - mx) * (yy[j] - my); vx += (x[j] - mx) ** 2; }
    const beta = cov / vx, e = yy.map((q, j) => q - my - beta * (x[j] - mx)), sd = Math.sqrt(e.reduce((a, q) => a + q * q, 0) / (L - 2)), z = e[L - 1] / sd;
    if (z > 2) state = -1; else if (z < -2) state = 1; else if (Math.abs(z) < 0.5) state = 0;
    v[i] = state;
  }
  return v;
}
function sadfExplosive(b: Bars) {
  const y = b.c.map(Math.log), n = y.length, v = new Int8Array(n), W = 120, MIN = 30;
  for (let i = W; i < n; i++) {
    let sup = -Infinity;
    for (let s0 = i - W + 1; s0 <= i - MIN; s0 += 6) { // regress dy_t = a + b*y_{t-1} on [s0, i]
      let m = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (let t = s0 + 1; t <= i; t++) { const x = y[t - 1], d = y[t] - y[t - 1]; m++; sx += x; sy += d; sxx += x * x; sxy += x * d; }
      const den = m * sxx - sx * sx; if (den <= 0) continue; const bb = (m * sxy - sx * sy) / den, a = (sy - bb * sx) / m;
      let se = 0; for (let t = s0 + 1; t <= i; t++) se += (y[t] - y[t - 1] - a - bb * y[t - 1]) ** 2;
      const tstat = bb / Math.sqrt(se / (m - 2) * m / den); if (tstat > sup) sup = tstat;
    }
    if (sup > 1.2) v[i] = Math.sign(y[i] - y[i - 10]) as any;
  }
  return v;
}
function cswCusum(b: Bars) {
  const y = b.c.map(Math.log), r = rets(b.c), n = y.length, v = new Int8Array(n), W = 200;
  for (let i = W; i < n; i++) {
    let s2 = 0; for (let k = i - W + 1; k <= i; k++) s2 += r[k] * r[k]; const sd = Math.sqrt(s2 / (W - 1));
    let up = false, dn = false;
    for (let j = i - W; j <= i - 5; j++) { const S = (y[i] - y[j]) / (sd * Math.sqrt(i - j)), c = Math.sqrt(4.6 + Math.log(i - j)); if (S > c) up = true; if (S < -c) dn = true; }
    v[i] = up && !dn ? 1 : dn && !up ? -1 : 0;
  }
  return v;
}
function fracdiffReversion(b: Bars) {
  const d = 0.4, w = [1]; while (w.length < 400) { const k = w.length, nx = -w[k - 1] * (d - k + 1) / k; if (Math.abs(nx) < 1e-3) break; w.push(nx); }
  const y = b.c.map(Math.log), n = y.length, f = new Array(n).fill(NaN), v = new Int8Array(n);
  for (let i = w.length - 1; i < n; i++) { let s = 0; for (let k = 0; k < w.length; k++) s += w[k] * y[i - k]; f[i] = s; }
  const Z = 200;
  for (let i = w.length + Z; i < n; i++) { let s = 0, s2 = 0; for (let k = i - Z + 1; k <= i; k++) { s += f[k]; s2 += f[k] * f[k]; }
    const m = s / Z, sd = Math.sqrt(Math.max(0, s2 / Z - m * m)), z = (f[i] - m) / sd; if (z > 2) v[i] = -1; else if (z < -2) v[i] = 1; }
  return v;
}
function cusumFilterTrend(b: Bars) {
  const r = rets(b.c), sd = rollStd(r, 100), n = r.length, v = new Int8Array(n); let sp = 0, sn = 0, state = 0;
  for (let i = 100; i < n; i++) { const h = 3 * sd[i]; sp = Math.max(0, sp + r[i]); sn = Math.min(0, sn + r[i]);
    if (sp > h) { state = 1; sp = 0; sn = 0; } else if (sn < -h) { state = -1; sp = 0; sn = 0; } v[i] = state; }
  return v;
}
function lowEntropyMomentum(b: Bars) {
  const r = rets(b.c), n = r.length, v = new Int8Array(n), W = 64, H: number[] = new Array(n).fill(NaN);
  for (let i = W; i < n; i++) { const cnt = [0, 0, 0, 0]; for (let k = i - W + 2; k <= i; k++) cnt[(r[k - 1] > 0 ? 2 : 0) + (r[k] > 0 ? 1 : 0)]++;
    const tot = W - 1; H[i] = -cnt.reduce((a, c) => a + (c ? (c / tot) * Math.log2(c / tot) : 0), 0) / 2; }
  for (let i = W + 500; i < n; i++) { let below = 0; for (let k = i - 500; k < i; k++) if (H[k] < H[i]) below++;
    if (below / 500 < 0.2) v[i] = Math.sign(b.c[i] - b.c[i - 20]) as any; }
  return v;
}

export const BOOK_IDS = ["chan_turning_point", "pair_spread_reversion", "sadf_explosive", "csw_cusum_break", "fracdiff_reversion", "cusum_filter_trend", "low_entropy_momentum"];
if (import.meta.url === `file://${process.argv[1]}`) {
  for (const TF of ["M30", "H1", "H4"]) {
    const bars: Record<string, Bars> = {}; for (const [s, tf] of Object.entries<any>(raw)) bars[s] = barsFor(tf[TF === "M30" ? "M30" : "H1"], TF);
    const out: Record<string, Record<string, number[]>> = {};
    for (const s of Object.keys(bars)) {
      const b = bars[s];
      out[s] = { t: b.t, chan_turning_point: [...chanTurningPoint(b)], pair_spread_reversion: [...pairSpreadReversion(s, bars)], sadf_explosive: [...sadfExplosive(b)],
        csw_cusum_break: [...cswCusum(b)], fracdiff_reversion: [...fracdiffReversion(b)], cusum_filter_trend: [...cusumFilterTrend(b)], low_entropy_momentum: [...lowEntropyMomentum(b)] };
    }
    fs.writeFileSync(`${B}/votes-book-${TF}.json`, JSON.stringify(out)); console.log(TF, "done");
  }
}
