// 40 candidate quantitative strategies to replace the 20 technical ones. Same contract as
// poll-strategies.ts: pure, causal (the vote at bar i uses bars 0..i), +1 / -1 / 0 per bar, and `from`
// only skips work. None of them repeats a live strategy; families: robust/statistical trend tests,
// signal processing, volatility regimes, distribution shape, session/calendar effects, cross-pair
// statistical arbitrage and short-horizon forecasting models.
import { atrSeries, type Bars, type CrossContext, type StrategyDef, type Vote } from "../../artifacts/api-server/src/lib/poll-strategies.ts";

const N = (b: Bars) => b.c.length;
const out = (n: number) => new Int8Array(n);
const sign = (v: number, eps = 0): Vote => (v > eps ? 1 : v < -eps ? -1 : 0);
const lr = (c: number[]) => c.map((v, i) => (i === 0 ? 0 : Math.log(v / c[i - 1]!)));
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const win = (a: number[], i: number, n: number) => a.slice(i - n + 1, i + 1);
const barMs = (b: Bars) => { const d: number[] = []; for (let i = 1; i < Math.min(N(b), 50); i++) d.push(b.t[i]! - b.t[i - 1]!); d.sort((x, y) => x - y); return d[d.length >> 1] ?? 1_800_000; };
function ema(a: number[], n: number): number[] { const k = 2 / (n + 1); let e = NaN; return a.map((v) => (e = Number.isFinite(e) ? v * k + e * (1 - k) : v)); }

/** Momentum over n bars in units of its own volatility (return / (sd * sqrt n)). */
function volMom(b: Bars, n: number, z: number, from = 0): Int8Array {
  const r = lr(b.c), v = out(N(b));
  for (let i = Math.max(n + 200, from); i < N(b); i++) { const s = sd(win(r, i, 200)); if (s > 0) v[i] = sign(Math.log(b.c[i]! / b.c[i - n]!) / (s * Math.sqrt(n)), z); }
  return v;
}
/** Theil-Sen slope over n bars vs the median absolute residual. */
function theilSen(b: Bars, n: number, from = 0): Int8Array {
  const v = out(N(b)), a = atrSeries(b);
  for (let i = Math.max(n, from); i < N(b); i++) {
    const y = win(b.c, i, n), sl: number[] = [];
    for (let p = 0; p < n; p += 2) for (let q = p + 1; q < n; q += 3) sl.push((y[q]! - y[p]!) / (q - p));
    sl.sort((x, z) => x - z); const m = sl[sl.length >> 1]!;
    if (a[i]! > 0) v[i] = sign(m * n / a[i]!, 2);
  }
  return v;
}
/** Mann-Kendall trend test z-score over n bars. */
function mannKendall(b: Bars, n: number, zc: number, from = 0): Int8Array {
  const v = out(N(b));
  for (let i = Math.max(n, from); i < N(b); i++) {
    const y = win(b.c, i, n); let s = 0;
    for (let p = 0; p < n - 1; p++) for (let q = p + 1; q < n; q++) s += Math.sign(y[q]! - y[p]!);
    const varS = n * (n - 1) * (2 * n + 5) / 18, z = (s - Math.sign(s)) / Math.sqrt(varS);
    v[i] = sign(z, zc);
  }
  return v;
}
/** Spearman rank correlation of price with time. */
function spearman(b: Bars, n: number, rc: number, from = 0): Int8Array {
  const v = out(N(b));
  for (let i = Math.max(n, from); i < N(b); i++) {
    const y = win(b.c, i, n).map((x, k) => [x, k] as const).sort((p, q) => p[0] - q[0]); const rank = new Array(n);
    y.forEach(([, k], r) => (rank[k] = r));
    let d2 = 0; for (let k = 0; k < n; k++) d2 += (rank[k] - k) ** 2;
    v[i] = sign(1 - 6 * d2 / (n * (n * n - 1)), rc);
  }
  return v;
}
/** Holt double exponential smoothing: vote with the trend component (in ATR per bar x horizon). */
function holt(b: Bars, alpha: number, beta: number, from = 0): Int8Array {
  const v = out(N(b)), a = atrSeries(b); let lvl = b.c[0]!, tr = 0;
  for (let i = 1; i < N(b); i++) {
    const prev = lvl; lvl = alpha * b.c[i]! + (1 - alpha) * (lvl + tr); tr = beta * (lvl - prev) + (1 - beta) * tr;
    if (i >= Math.max(200, from) && a[i]! > 0) v[i] = sign(tr * 12 / a[i]!, 0.6);
  }
  return v;
}
/** Least-squares polynomial fit over n bars, projected h bars ahead. */
function polyProject(b: Bars, n: number, deg: 1 | 2, h: number, k: number, from = 0): Int8Array {
  const v = out(N(b)), a = atrSeries(b);
  for (let i = Math.max(n, from); i < N(b); i++) {
    if (!(a[i]! > 0)) continue;
    const y = win(b.c, i, n), xs = y.map((_, j) => (j - (n - 1)) / n);
    // normal equations for degree 1 or 2
    const m = deg + 1, A = Array.from({ length: m }, () => new Array(m + 1).fill(0));
    for (let j = 0; j < n; j++) { const p = [1, xs[j]!, xs[j]! ** 2].slice(0, m); for (let r = 0; r < m; r++) { for (let c = 0; c < m; c++) A[r][c] += p[r]! * p[c]!; A[r][m] += p[r]! * y[j]!; } }
    for (let c = 0; c < m; c++) { let piv = c; for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r; [A[c], A[piv]] = [A[piv], A[c]]; for (let r = 0; r < m; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let q = c; q <= m; q++) A[r][q] -= f * A[c][q]; } }
    const coef = A.map((row, r) => row[m] / row[r]); const xf = h / n;
    const fit0 = coef[0]!, fitH = coef[0]! + coef[1]! * xf + (deg === 2 ? coef[2]! * xf * xf : 0);
    v[i] = sign((fitH - fit0) / a[i]!, k);
  }
  return v;
}
/** AR(p) on returns by least squares over a window; votes with the 4-bar forecast when it is large. */
function arForecast(b: Bars, p: number, W: number, from = 0): Int8Array {
  const r = lr(b.c), v = out(N(b));
  for (let i = Math.max(W + p + 1, from); i < N(b); i++) {
    const X: number[][] = [], Y: number[] = [];
    for (let t = i - W + 1; t <= i; t++) { X.push(Array.from({ length: p }, (_, k) => r[t - 1 - k]!)); Y.push(r[t]!); }
    // ridge-regularized normal equations
    const XtX = Array.from({ length: p }, () => new Array(p).fill(0)), XtY = new Array(p).fill(0); const s2 = sd(Y) ** 2;
    for (let t = 0; t < X.length; t++) for (let a = 0; a < p; a++) { XtY[a] += X[t]![a]! * Y[t]!; for (let c = 0; c < p; c++) XtX[a][c] += X[t]![a]! * X[t]![c]!; }
    for (let a = 0; a < p; a++) XtX[a][a] += s2 * W * 0.1;
    const M = XtX.map((row, k) => [...row, XtY[k]]);
    for (let c = 0; c < p; c++) for (let rr = 0; rr < p; rr++) if (rr !== c) { const f = M[rr][c] / M[c][c]; for (let q = c; q <= p; q++) M[rr][q] -= f * M[c][q]; }
    const beta = M.map((row, k) => row[p] / row[k]);
    let hist = Array.from({ length: p }, (_, k) => r[i - k]!), f = 0;
    for (let h = 0; h < 4; h++) { const nx = beta.reduce((s, bb, k) => s + bb * hist[k]!, 0); f += nx; hist = [nx, ...hist.slice(0, p - 1)]; }
    const s = Math.sqrt(s2); if (s > 0) v[i] = sign(f / (s * 2), 0.15);
  }
  return v;
}
/** Realized volatility percentile over the last `look` bars (of a 48-bar realized vol). */
function volPct(r: number[], i: number, look: number) {
  const cur = sd(win(r, i, 48)); let lo = 0, k = 0;
  for (let j = i - look; j < i; j += 6) { if (j < 48) continue; const x = sd(win(r, j, 48)); k++; if (x < cur) lo++; }
  return k ? lo / k : NaN;
}
function volRegime(b: Bars, mode: "trend_calm" | "revert_wild", from = 0): Int8Array {
  const r = lr(b.c), v = out(N(b));
  for (let i = Math.max(600, from); i < N(b); i++) {
    const p = volPct(r, i, 500), s = sd(win(r, i, 200)); if (!(s > 0)) continue;
    if (mode === "trend_calm" && p < 0.5) v[i] = sign(Math.log(b.c[i]! / b.c[i - 24]!) / (s * Math.sqrt(24)), 1);
    if (mode === "revert_wild" && p > 0.8) v[i] = (-sign(Math.log(b.c[i]! / b.c[i - 12]!) / (s * Math.sqrt(12)), 2)) as Vote;
  }
  return v;
}
function moments(b: Bars, n: number, which: "skew" | "semivar", from = 0): Int8Array {
  const r = lr(b.c), v = out(N(b));
  for (let i = Math.max(n + 1, from); i < N(b); i++) {
    const w = win(r, i, n), m = mean(w), s = sd(w); if (!(s > 0)) continue;
    if (which === "skew") { const sk = w.reduce((x, y) => x + ((y - m) / s) ** 3, 0) / n; v[i] = (-sign(sk, 0.5)) as Vote; }
    else { let up = 0, dn = 0; for (const x of w) { if (x > 0) up += x * x; else dn += x * x; } v[i] = sign((up - dn) / (up + dn), 0.25); }
  }
  return v;
}
/** Wald-Wolfowitz runs test on return signs: trending (few runs) -> follow, choppy (many runs) -> fade. */
function runsTest(b: Bars, n: number, from = 0): Int8Array {
  const r = lr(b.c), v = out(N(b));
  for (let i = Math.max(n + 12, from); i < N(b); i++) {
    const s = win(r, i, n).map((x) => (x > 0 ? 1 : 0)); const n1 = s.reduce((a, c) => a + c, 0), n0 = n - n1; if (!n1 || !n0) continue;
    let runs = 1; for (let k = 1; k < n; k++) if (s[k] !== s[k - 1]) runs++;
    const mu = 2 * n1 * n0 / n + 1, va = (mu - 1) * (mu - 2) / (n - 1), z = (runs - mu) / Math.sqrt(va);
    if (z < -1.5) v[i] = sign(b.c[i]! - b.c[i - 12]!); else if (z > 1.5) v[i] = (-sign(b.c[i]! - b.c[i - 4]!)) as Vote;
  }
  return v;
}
function binomialTrend(b: Bars, n: number, zc: number, from = 0): Int8Array {
  const v = out(N(b));
  for (let i = Math.max(n + 1, from); i < N(b); i++) { let up = 0; for (let k = i - n + 1; k <= i; k++) if (b.c[k]! > b.c[k - 1]!) up++; v[i] = sign((up - n / 2) / Math.sqrt(n / 4), zc); }
  return v;
}
function wilcoxon(b: Bars, n: number, from = 0): Int8Array {
  const r = lr(b.c), v = out(N(b));
  for (let i = Math.max(n + 1, from); i < N(b); i++) {
    const w = win(r, i, n).filter((x) => x !== 0).map((x) => [Math.abs(x), Math.sign(x)] as const).sort((p, q) => p[0] - q[0]);
    let W = 0; w.forEach(([, s], k) => (W += s * (k + 1))); const m = w.length; if (m < 10) continue;
    v[i] = sign(W / Math.sqrt(m * (m + 1) * (2 * m + 1) / 6), 2);
  }
  return v;
}
/** Local linear trend Kalman filter: vote when the filtered velocity and acceleration agree. */
function kalmanAccel(b: Bars, from = 0): Int8Array {
  const v = out(N(b)), a = atrSeries(b); let x = [b.c[0]!, 0, 0]; let P = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((r) => r.map((y) => y * 1e-4));
  const q = [1e-9, 1e-10, 1e-11], rN = 1e-7;
  for (let i = 1; i < N(b); i++) {
    // predict: pos += vel + acc/2, vel += acc
    const F = [[1, 1, 0.5], [0, 1, 1], [0, 0, 1]]; const xp = F.map((row) => row.reduce((s, f, k) => s + f * x[k]!, 0));
    const FP = F.map((row) => [0, 1, 2].map((c) => row.reduce((s, f, k) => s + f * P[k]![c]!, 0)));
    const Pp = FP.map((row, r) => [0, 1, 2].map((c) => row.reduce((s, f, k) => s + f * F[c]![k]!, 0) + (r === c ? q[r]! * b.c[i]! ** 2 : 0)));
    const S = Pp[0]![0]! + rN * b.c[i]! ** 2, K = [Pp[0]![0]! / S, Pp[1]![0]! / S, Pp[2]![0]! / S], y = b.c[i]! - xp[0]!;
    x = xp.map((val, k) => val + K[k]! * y); P = Pp.map((row, r) => row.map((val, c) => val - K[r]! * Pp[0]![c]!));
    if (i >= Math.max(100, from) && a[i]! > 0) { const vel = x[1]! * 12 / a[i]!, acc = x[2]! * 144 / a[i]!; if (Math.sign(vel) === Math.sign(acc)) v[i] = sign(vel, 0.4); }
  }
  return v;
}
function shockReversal(b: Bars, from = 0): Int8Array {
  const r = lr(b.c), v = out(N(b));
  for (let i = Math.max(300, from); i < N(b); i++) { const s = sd(win(r, i - 1, 300)); if (!(s > 0)) continue; for (let k = 0; k < 3; k++) { if (Math.abs(r[i - k]!) > 4 * s) { v[i] = (-Math.sign(r[i - k]!)) as Vote; break; } } }
  return v;
}
function r2Slope(b: Bars, n: number, from = 0): Int8Array {
  const v = out(N(b)), a = atrSeries(b);
  for (let i = Math.max(n, from); i < N(b); i++) {
    const y = win(b.c, i, n).map(Math.log), mx = (n - 1) / 2, my = mean(y); let sxy = 0, sxx = 0, syy = 0;
    y.forEach((t, k) => { sxy += (k - mx) * (t - my); sxx += (k - mx) ** 2; syy += (t - my) ** 2; });
    const beta = sxy / sxx, r2 = syy > 0 ? sxy * sxy / (sxx * syy) : 0;
    if (a[i]! > 0) v[i] = sign(beta * n * r2 * b.c[i]! / a[i]!, 1.5);
  }
  return v;
}
function shortReversal(b: Bars, n: number, z: number, from = 0): Int8Array {
  const r = lr(b.c), v = out(N(b));
  for (let i = Math.max(n + 200, from); i < N(b); i++) { const s = sd(win(r, i, 200)); if (s > 0) v[i] = (-sign(Math.log(b.c[i]! / b.c[i - n]!) / (s * Math.sqrt(n)), z)) as Vote; }
  return v;
}
function kernelSlope(b: Bars, bw: number, from = 0): Int8Array {
  const v = out(N(b)), a = atrSeries(b), W = Math.round(bw * 4);
  const nw = (i: number) => { let s = 0, w = 0; for (let k = 0; k < W; k++) { const g = Math.exp(-(k * k) / (2 * bw * bw)); s += g * b.c[i - k]!; w += g; } return s / w; };
  for (let i = Math.max(W + 6, from); i < N(b); i++) if (a[i]! > 0) v[i] = sign((nw(i) - nw(i - 6)) / a[i]!, 0.5);
  return v;
}
function medianTrend(b: Bars, f: number, s: number, from = 0): Int8Array {
  const v = out(N(b)), a = atrSeries(b);
  const med = (i: number, n: number) => { const w = win(b.c, i, n).sort((x, y) => x - y); return w[w.length >> 1]!; };
  for (let i = Math.max(s, from); i < N(b); i++) if (a[i]! > 0) v[i] = sign((med(i, f) - med(i, s)) / a[i]!, 1);
  return v;
}
/** Ehlers roofing filter (high-pass 48 + super smoother 10): votes with the filtered cycle's direction. */
function roofing(b: Bars, from = 0): Int8Array {
  const v = out(N(b)), c = b.c, hp = new Array(N(b)).fill(0), filt = new Array(N(b)).fill(0);
  const a1 = (Math.cos(0.707 * 2 * Math.PI / 48) + Math.sin(0.707 * 2 * Math.PI / 48) - 1) / Math.cos(0.707 * 2 * Math.PI / 48);
  const a2 = Math.exp(-1.414 * Math.PI / 10), b2 = 2 * a2 * Math.cos(1.414 * Math.PI / 10), c2 = b2, c3 = -a2 * a2, c1 = 1 - c2 - c3;
  for (let i = 2; i < N(b); i++) {
    hp[i] = (1 - a1 / 2) ** 2 * (c[i]! - 2 * c[i - 1]! + c[i - 2]!) + 2 * (1 - a1) * hp[i - 1] - (1 - a1) ** 2 * hp[i - 2];
    filt[i] = c1 * (hp[i] + hp[i - 1]) / 2 + c2 * filt[i - 1] + c3 * filt[i - 2];
    if (i >= Math.max(100, from)) { const rng = Math.max(...filt.slice(i - 48, i + 1).map(Math.abs)); if (rng > 0) v[i] = filt[i] > filt[i - 1] && filt[i] < -0.3 * rng ? 1 : filt[i] < filt[i - 1] && filt[i] > 0.3 * rng ? -1 : 0; }
  }
  return v;
}
/** Ehlers Laguerre filter slope. */
function laguerre(b: Bars, g: number, from = 0): Int8Array {
  const v = out(N(b)), a = atrSeries(b); let L0 = b.c[0]!, L1 = L0, L2 = L0, L3 = L0; const f: number[] = [];
  for (let i = 0; i < N(b); i++) {
    const p0 = L0, p1 = L1, p2 = L2; L0 = (1 - g) * b.c[i]! + g * L0; L1 = -g * L0 + p0 + g * L1; L2 = -g * L1 + p1 + g * L2; L3 = -g * L2 + p2 + g * L3;
    f.push((L0 + 2 * L1 + 2 * L2 + L3) / 6);
    if (i >= Math.max(60, from) && a[i]! > 0) v[i] = sign((f[i]! - f[i - 3]!) / a[i]!, 0.3);
  }
  return v;
}
function hourOf(t: number) { return new Date(t).getUTCHours() + new Date(t).getUTCMinutes() / 60; }
/** London-morning momentum: after 12:00 UTC, follow the 07:00-12:00 move when it was large. */
function sessionMomentum(b: Bars, from = 0): Int8Array {
  const v = out(N(b)), a = atrSeries(b), L = barMs(b);
  for (let i = Math.max(50, from); i < N(b); i++) {
    const closeH = hourOf(b.t[i]! + L); if (closeH < 12 || closeH > 20) continue;
    const day = Math.floor(b.t[i]! / 86_400_000) * 86_400_000; let o = NaN, c = NaN;
    for (let k = i; k >= 0 && b.t[k]! >= day; k--) { const h = hourOf(b.t[k]!); if (h >= 7 && h < 7 + L / 3_600_000) o = b.o[k]!; if (hourOf(b.t[k]! + L) <= 12 && Number.isNaN(c)) c = b.c[k]!; }
    if (Number.isFinite(o) && Number.isFinite(c) && a[i]! > 0) v[i] = sign((c - o) / (a[i]! * Math.sqrt(3_600_000 * 5 / L)), 0.8);
  }
  return v;
}
/** Asian session (00-07 UTC) move faded in the London morning (07-11 UTC). */
function asiaFade(b: Bars, from = 0): Int8Array {
  const v = out(N(b)), a = atrSeries(b), L = barMs(b);
  for (let i = Math.max(50, from); i < N(b); i++) {
    const closeH = hourOf(b.t[i]! + L); if (closeH < 7 || closeH > 11) continue;
    const day = Math.floor(b.t[i]! / 86_400_000) * 86_400_000; let o = NaN, c = NaN;
    for (let k = i; k >= 0 && b.t[k]! >= day; k--) { if (b.t[k]! === day) o = b.o[k]!; if (hourOf(b.t[k]! + L) <= 7 && Number.isNaN(c)) c = b.c[k]!; }
    if (Number.isFinite(o) && Number.isFinite(c) && a[i]! > 0) v[i] = (-sign((c - o) / (a[i]! * Math.sqrt(3_600_000 * 7 / L)), 1)) as Vote;
  }
  return v;
}
/** London 16:00 fix: fade the 14:00-16:00 UTC move for the rest of the day. */
function fixReversal(b: Bars, from = 0): Int8Array {
  const v = out(N(b)), a = atrSeries(b), L = barMs(b);
  for (let i = Math.max(50, from); i < N(b); i++) {
    const closeH = hourOf(b.t[i]! + L); if (closeH < 16 || closeH > 21) continue;
    const day = Math.floor(b.t[i]! / 86_400_000) * 86_400_000; let o = NaN, c = NaN;
    for (let k = i; k >= 0 && b.t[k]! >= day; k--) { const h = hourOf(b.t[k]!); if (h === 14) o = b.o[k]!; if (hourOf(b.t[k]! + L) === 16) c = b.c[k]!; }
    if (Number.isFinite(o) && Number.isFinite(c) && a[i]! > 0) v[i] = (-sign((c - o) / (a[i]! * Math.sqrt(3_600_000 * 2 / L)), 1)) as Vote;
  }
  return v;
}
/** Month-end rebalancing: in the last 3 days of a month, fade the month-to-date move. */
function monthEnd(b: Bars, from = 0): Int8Array {
  const v = out(N(b)), r = lr(b.c);
  for (let i = Math.max(300, from); i < N(b); i++) {
    const d = new Date(b.t[i]!), last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); if (last - d.getUTCDate() > 3) continue;
    const m0 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); let k = i; while (k > 0 && b.t[k - 1]! >= m0) k--;
    const s = sd(win(r, i, 300)), n = i - k + 1; if (s > 0 && n > 10) v[i] = (-sign(Math.log(b.c[i]! / b.o[k]!) / (s * Math.sqrt(n)), 1)) as Vote;
  }
  return v;
}
/** Residual of the pair against what the other pairs imply for its two currencies; fade large residuals. */
function basketResidual(b: Bars, x: CrossContext | undefined, look: number, from = 0): Int8Array {
  const v = out(N(b)); if (!x) return v; const base = x.symbol.slice(3, 6), quote = x.symbol.slice(6, 9);
  const res: number[] = new Array(N(b)).fill(NaN);
  for (let i = look; i < N(b); i++) {
    const str: Record<string, number[]> = {};
    for (const [s, c] of Object.entries(x.closes)) { if (s === x.symbol) continue; const a = c[i], p = c[i - look]; if (!(a! > 0 && p! > 0)) continue; const l = Math.log(a! / p!); (str[s.slice(3, 6)] ??= []).push(l); (str[s.slice(6, 9)] ??= []).push(-l); }
    const g = (k: string) => (str[k]?.length ? mean(str[k]!) : NaN); const implied = g(base) - g(quote);
    if (Number.isFinite(implied)) res[i] = Math.log(b.c[i]! / b.c[i - look]!) - implied;
  }
  for (let i = Math.max(look + 300, from); i < N(b); i++) { const w = win(res, i, 300).filter(Number.isFinite); if (w.length < 200) continue; const s = sd(w); if (s > 0 && Number.isFinite(res[i]!)) v[i] = (-sign(res[i]! / s, 1.5)) as Vote; }
  return v;
}
/** Dual momentum: the pair's own trend and its rank among the 14 pairs must agree. */
function dualMomentum(b: Bars, x: CrossContext | undefined, n: number, from = 0): Int8Array {
  const v = out(N(b)); if (!x) return v; const me = x.closes[x.symbol]; if (!me) return v; const r = lr(b.c);
  for (let i = Math.max(n + 200, from); i < N(b); i++) {
    const s = sd(win(r, i, 200)); if (!(s > 0)) continue; const own = Math.log(b.c[i]! / b.c[i - n]!) / (s * Math.sqrt(n));
    const sc = (c: number[]) => (c[i]! > 0 && c[i - n]! > 0 ? Math.log(c[i]! / c[i - n]!) : NaN); const mine = sc(me); let above = 0, k = 0;
    for (const c of Object.values(x.closes)) { const q = sc(c); if (!Number.isFinite(q)) continue; k++; if (Math.abs(q) > Math.abs(mine)) above++; }
    if (k >= 8 && above <= 4 && Math.abs(own) > 0.8) v[i] = sign(own);
  }
  return v;
}
/** GARCH(1,1) (fixed 0.05 / 0.9) volatility forecast: trend-follow only when forecast vol is falling. */
function garchTrend(b: Bars, from = 0): Int8Array {
  const r = lr(b.c), v = out(N(b)); let h = sd(r.slice(1, 200)) ** 2; const w0 = h * 0.05; const hs: number[] = [];
  for (let i = 1; i < N(b); i++) { h = w0 + 0.05 * r[i]! ** 2 + 0.9 * h; hs.push(h);
    if (i >= Math.max(250, from) && hs.length > 12) { const falling = h < hs[hs.length - 13]!; const z = Math.log(b.c[i]! / b.c[i - 24]!) / Math.sqrt(h * 24); if (falling) v[i] = sign(z, 1); } }
  return v;
}
/** Hilbert-transform cycle phase (Ehlers): buys near the cycle trough, sells near the peak, only in cycle mode. */
function hilbertPhase(b: Bars, from = 0): Int8Array {
  const v = out(N(b)), c = b.c, sm = new Array(N(b)).fill(0), dt = new Array(N(b)).fill(0), I1 = new Array(N(b)).fill(0), Q1 = new Array(N(b)).fill(0);
  for (let i = 6; i < N(b); i++) {
    sm[i] = (4 * c[i]! + 3 * c[i - 1]! + 2 * c[i - 2]! + c[i - 3]!) / 10;
    dt[i] = (0.0962 * sm[i] + 0.5769 * sm[i - 2] - 0.5769 * sm[i - 4] - 0.0962 * sm[i - 6]) * 0.6;
    Q1[i] = (0.0962 * dt[i] + 0.5769 * dt[i - 2] - 0.5769 * dt[i - 4] - 0.0962 * dt[i - 6]) * 0.6; I1[i] = dt[i - 3];
    if (i >= Math.max(60, from)) { const ph = Math.atan2(Q1[i], I1[i]) * 180 / Math.PI, pp = Math.atan2(Q1[i - 1], I1[i - 1]) * 180 / Math.PI; const dph = ((pp - ph) + 360) % 360;
      if (dph > 5 && dph < 60) { if (ph > -100 && ph < -60) v[i] = 1; else if (ph > 80 && ph < 120) v[i] = -1; } }
  }
  return v;
}

const C = (id: string, name: string, summary: string, compute: StrategyDef["compute"]): StrategyDef => ({ id, name, family: "quant", summary, compute });
export const NEW_QUANT: StrategyDef[] = [
  C("vol_mom_60", "Volatility-scaled Momentum (60 bars)", "60-bar return over its volatility; follows moves over 1 sigma.", (b, _x, f) => volMom(b, 60, 1, f)),
  C("vol_mom_120", "Volatility-scaled Momentum (120 bars)", "120-bar return over its volatility; follows moves over 1 sigma.", (b, _x, f) => volMom(b, 120, 1, f)),
  C("vol_mom_240", "Volatility-scaled Momentum (240 bars)", "240-bar return over its volatility; follows moves over 1 sigma.", (b, _x, f) => volMom(b, 240, 1, f)),
  C("theil_sen_48", "Theil-Sen Robust Trend", "Median pairwise slope over 48 bars (outlier-proof), in ATR.", (b, _x, f) => theilSen(b, 48, f)),
  C("mann_kendall_48", "Mann-Kendall Trend Test", "Non-parametric trend test over 48 bars; votes at |z| > 2.", (b, _x, f) => mannKendall(b, 48, 2, f)),
  C("mann_kendall_96", "Mann-Kendall Trend Test (96)", "Mann-Kendall over 96 bars; votes at |z| > 2.5.", (b, _x, f) => mannKendall(b, 96, 2.5, f)),
  C("spearman_64", "Spearman Rank Trend", "Rank correlation of price with time over 64 bars; votes above 0.6.", (b, _x, f) => spearman(b, 64, 0.6, f)),
  C("holt_trend", "Holt Double Exponential Smoothing", "Trend component of Holt's linear smoothing (0.1 / 0.05).", (b, _x, f) => holt(b, 0.1, 0.05, f)),
  C("linear_projection_48", "Linear Regression Projection", "Least-squares line over 48 bars projected 12 bars ahead, in ATR.", (b, _x, f) => polyProject(b, 48, 1, 12, 1, f)),
  C("quadratic_projection_64", "Quadratic Regression Projection", "Quadratic fit over 64 bars projected 8 bars ahead, in ATR.", (b, _x, f) => polyProject(b, 64, 2, 8, 0.7, f)),
  C("ar4_forecast", "AR(4) Return Forecast", "Ridge-fitted AR(4) on the last 300 returns; votes with large 4-bar forecasts.", (b, _x, f) => arForecast(b, 4, 300, f)),
  C("ar8_forecast", "AR(8) Return Forecast", "Ridge-fitted AR(8) on the last 500 returns.", (b, _x, f) => arForecast(b, 8, 500, f)),
  C("calm_trend", "Low-volatility Momentum", "24-bar momentum, only when volatility is below its median (calm trends persist).", (b, _x, f) => volRegime(b, "trend_calm", f)),
  C("wild_reversion", "High-volatility Reversion", "Fades 12-bar 2-sigma moves when volatility is in its top 20%.", (b, _x, f) => volRegime(b, "revert_wild", f)),
  C("skew_premium", "Skewness Premium", "Buys after negatively skewed returns, sells after positive skew (96 bars).", (b, _x, f) => moments(b, 96, "skew", f)),
  C("semivariance_asymmetry", "Up/Down Semivariance", "Follows the side with more volatility (96 bars).", (b, _x, f) => moments(b, 96, "semivar", f)),
  C("runs_test", "Wald-Wolfowitz Runs Test", "Few runs (trending) -> follow; many runs (choppy) -> fade.", (b, _x, f) => runsTest(b, 96, f)),
  C("binomial_trend_48", "Binomial Up-bar Test", "More up bars than chance allows in 48 (z > 2) -> follow.", (b, _x, f) => binomialTrend(b, 48, 2, f)),
  C("wilcoxon_trend_64", "Wilcoxon Signed-rank Trend", "Signed-rank test of the last 64 returns; votes at |z| > 2.", (b, _x, f) => wilcoxon(b, 64, f)),
  C("kalman_acceleration", "Kalman Velocity + Acceleration", "Local-linear-trend Kalman filter; votes when velocity and acceleration agree.", (b, _x, f) => kalmanAccel(b, f)),
  C("shock_reversal", "Liquidity Shock Reversal", "Fades a single bar beyond 4 sigma for the next 3 bars.", (b, _x, f) => shockReversal(b, f)),
  C("r2_weighted_slope", "R-squared Weighted Slope", "Log-regression slope times its R^2 over 90 bars, in ATR.", (b, _x, f) => r2Slope(b, 90, f)),
  C("short_reversal_12", "Short-term Reversal (12 bars)", "Fades 12-bar moves over 2 sigma.", (b, _x, f) => shortReversal(b, 12, 2, f)),
  C("short_reversal_48", "Short-term Reversal (48 bars)", "Fades 48-bar moves over 2 sigma.", (b, _x, f) => shortReversal(b, 48, 2, f)),
  C("kernel_regression", "Gaussian Kernel Regression", "Nadaraya-Watson smoother (bandwidth 8): slope over 6 bars, in ATR.", (b, _x, f) => kernelSlope(b, 8, f)),
  C("median_trend", "Rolling Median Trend", "Median of 24 bars vs median of 96 bars, in ATR (robust to spikes).", (b, _x, f) => medianTrend(b, 24, 96, f)),
  C("roofing_cycle", "Ehlers Roofing Filter Cycle", "High-pass + super-smoother cycle: buys turning up from a trough, sells turning down from a peak.", (b, _x, f) => roofing(b, f)),
  C("laguerre_slope", "Ehlers Laguerre Filter", "Slope of a 0.8 Laguerre filter, in ATR.", (b, _x, f) => laguerre(b, 0.8, f)),
  C("hilbert_phase", "Hilbert Cycle Phase", "Ehlers Hilbert-transform phase: votes near cycle troughs and peaks.", (b, _x, f) => hilbertPhase(b, f)),
  C("london_morning_momentum", "London Morning Momentum", "After 12:00 UTC follows a large 07:00-12:00 UTC move (intraday momentum).", (b, _x, f) => sessionMomentum(b, f)),
  C("asia_fade", "Asian Session Fade", "07:00-11:00 UTC: fades a large Asian-session (00-07 UTC) move.", (b, _x, f) => asiaFade(b, f)),
  C("fix_reversal", "London Fix Reversal", "After the 16:00 London fix, fades the 14:00-16:00 move.", (b, _x, f) => fixReversal(b, f)),
  C("month_end_rebalance", "Month-end Rebalancing", "Last 3 days of a month: fades the month-to-date move.", (b, _x, f) => monthEnd(b, f)),
  C("basket_residual_24", "Basket Residual Reversion (24)", "Fades the pair's 24-bar move not explained by its currencies' other pairs.", (b, x, f) => basketResidual(b, x, 24, f)),
  C("basket_residual_96", "Basket Residual Reversion (96)", "Same over 96 bars.", (b, x, f) => basketResidual(b, x, 96, f)),
  C("dual_momentum_96", "Dual Momentum", "Own 96-bar trend and a top-4 move among the 14 pairs must agree.", (b, x, f) => dualMomentum(b, x, 96, f)),
  C("garch_trend", "GARCH-filtered Momentum", "24-bar momentum, only while GARCH(1,1) forecast volatility is falling.", (b, _x, f) => garchTrend(b, f)),
  C("vol_mom_30", "Volatility-scaled Momentum (30 bars)", "30-bar return over its volatility; follows moves over 1.2 sigma.", (b, _x, f) => volMom(b, 30, 1.2, f)),
  C("binomial_trend_96", "Binomial Up-bar Test (96)", "Binomial test over 96 bars (z > 2.5).", (b, _x, f) => binomialTrend(b, 96, 2.5, f)),
  C("theil_sen_120", "Theil-Sen Robust Trend (120)", "Theil-Sen slope over 120 bars, in ATR.", (b, _x, f) => theilSen(b, 120, f)),
];
