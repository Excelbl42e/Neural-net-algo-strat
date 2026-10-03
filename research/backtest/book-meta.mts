// Part 2: meta-labeling (AFML ch.3). The poll picks buy/sell; a second model (L2 logistic regression on
// 15 features known at the entry close) predicts whether the trade wins, and trades it predicts to lose are skipped.
// Judged with combinatorial purged cross-validation (AFML ch.12): 10 time groups, 2 held out at a time
// (45 fits, 9 complete out-of-sample histories), training trades overlapping a test group purged, 1-week embargo.
// Also: one fit on Nov-Jun tested on Jul-Sep, a random-skip null, and the $10 account with a monthly
// walk-forward model.
import { m30, SYMS, SPLIT, START, aligned, LIVE, decisions, runPairs, rollingRuns, type Trade, type Decision } from "./book-lib.mts";

const dec = decisions(LIVE);
const trades = runPairs(dec);
const H4 = LIVE.filter((v) => v.tf === "H4"), M30v = LIVE.filter((v) => v.tf === "M30");
const atr: Record<string, Float64Array> = {}, atrPct: Record<string, Float64Array> = {};
for (const s of SYMS) { const b = m30[s], n = b.t.length, a = new Float64Array(n), p = new Float64Array(n); let v = 0;
  for (let i = 1; i < n; i++) { const tr = Math.max(b.h[i] - b.l[i], Math.abs(b.h[i] - b.c[i - 1]), Math.abs(b.l[i] - b.c[i - 1])); v = i < 14 ? tr : (v * 13 + tr) / 14; a[i] = v / b.c[i]; }
  for (let i = 1000; i < n; i++) { let below = 0; for (let k = i - 1000; k < i; k += 5) if (a[k] < a[i]) below++; p[i] = below / 200; }
  atr[s] = a; atrPct[s] = p; }
export const FEATS = ["share", "voted", "dir", "atrPct", "hourSin", "hourCos", "weekday", "pairRecent", "allRecent", "er48", "stretch", "tfAgree", "trend96", "csSpread", "hlRatio"];
/** Features of a vote at bar i of pair s, using only trades closed by the entry time. */
export function features(s: string, i: number, x: Decision, closed: Trade[]): number[] {
  const b = m30[s], d = x.d, t = b.t[i] + 1800_000, dt = new Date(t), h = dt.getUTCHours() + dt.getUTCMinutes() / 60;
  const done = closed.filter((q) => q.t1 <= t), mine = done.filter((q) => q.s === s).slice(-10), last = done.slice(-30);
  const wr = (a: Trade[]) => (a.length ? a.filter((q) => q.pnl > 0).length / a.length : 0.5);
  let path = 0; for (let k = i - 47; k <= i; k++) path += Math.abs(b.c[k] - b.c[k - 1]);
  let m = 0, s2 = 0; for (let k = i - 47; k <= i; k++) { m += b.c[k]; s2 += b.c[k] ** 2; } m /= 48; const sd = Math.sqrt(Math.max(1e-18, s2 / 48 - m * m));
  const agree = (vs: typeof LIVE) => vs.reduce((a, v) => a + aligned[v.tf][s][v.id][i] * d, 0) / vs.length;
  let sr2 = 0; for (let k = i - 95; k <= i; k++) sr2 += Math.log(b.c[k] / b.c[k - 1]) ** 2;
  let beta = 0, gamma = 0; for (let k = i - 19; k <= i; k++) { beta += Math.log(b.h[k] / b.l[k]) ** 2 + Math.log(b.h[k - 1] / b.l[k - 1]) ** 2; gamma += Math.log(Math.max(b.h[k], b.h[k - 1]) / Math.min(b.l[k], b.l[k - 1])) ** 2; }
  beta /= 20; gamma /= 20; const den = 3 - 2 * Math.SQRT2, alpha = Math.max(0, (Math.SQRT2 - 1) * Math.sqrt(beta) / den - Math.sqrt(gamma / den));
  let hl = 0, cc = 0; for (let k = i - 47; k <= i; k++) { hl += Math.log(b.h[k] / b.l[k]) ** 2 / (4 * Math.LN2); cc += Math.log(b.c[k] / b.c[k - 1]) ** 2; }
  return [x.share, (x.buy + x.sell) / LIVE.length, d, atrPct[s][i], Math.sin(2 * Math.PI * h / 24), Math.cos(2 * Math.PI * h / 24), dt.getUTCDay() / 5,
    wr(mine), wr(last), path ? Math.abs(b.c[i] - b.c[i - 47]) / path : 0, d * (b.c[i] - m) / sd, agree(H4) - agree(M30v),
    d * Math.log(b.c[i] / b.c[i - 96]) / Math.sqrt(sr2), 2 * (Math.exp(alpha) - 1) / (1 + Math.exp(alpha)) * 1e4, cc ? hl / cc : 1];
}

/** L2 logistic regression, standardized inputs, weights |pnl| (AFML ch.4 return attribution). */
export function fit(X: number[][], y: number[], w: number[], lambda = 1) {
  const p = X[0].length, mu = new Array(p).fill(0), sg = new Array(p).fill(0);
  for (const r of X) r.forEach((v, k) => (mu[k] += v / X.length)); for (const r of X) r.forEach((v, k) => (sg[k] += (v - mu[k]) ** 2 / X.length));
  for (let k = 0; k < p; k++) sg[k] = Math.sqrt(sg[k]) || 1;
  const Z = X.map((r) => r.map((v, k) => (v - mu[k]) / sg[k])), W = w.reduce((a, b) => a + b, 0);
  let beta = new Array(p + 1).fill(0);
  for (let it = 0; it < 400; it++) { const g = new Array(p + 1).fill(0);
    Z.forEach((z, n) => { const e = 1 / (1 + Math.exp(-(beta[0] + z.reduce((a, v, k) => a + v * beta[k + 1], 0)))) - y[n]; g[0] += w[n] * e; z.forEach((v, k) => (g[k + 1] += w[n] * e * v)); });
    beta = beta.map((b, k) => b - 0.5 * (g[k] / W + (k ? lambda * b / Z.length : 0))); }
  return (x: number[]) => 1 / (1 + Math.exp(-(beta[0] + x.reduce((a, v, k) => a + ((v - mu[k]) / sg[k]) * beta[k + 1], 0))));
}

const X = trades.map((t) => features(t.s, t.i, t.dec, trades)), Y = trades.map((t) => (t.pnl > 0 ? 1 : 0)), Wt = trades.map((t) => Math.abs(t.pnl));
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
if (import.meta.url === `file://${process.argv[1]}`) {
  // --- one split: Nov-Jun -> Jul-Sep (training trades that close after the split are purged)
  const trI = trades.map((t, k) => k).filter((k) => trades[k].t1 < SPLIT), teI = trades.map((t, k) => k).filter((k) => trades[k].part === "test");
  const m1 = fit(trI.map((k) => X[k]), trI.map((k) => Y[k]), trI.map((k) => Wt[k]));
  const keep = teI.filter((k) => m1(X[k]) >= 0.5);
  console.log("== One split: train Nov-Jun, test Jul-Sep ==");
  console.log(`all test trades: n ${teI.length} total $${sum(teI.map((k) => trades[k].pnl)).toFixed(2)} | kept by the model: n ${keep.length} total $${sum(keep.map((k) => trades[k].pnl)).toFixed(2)} avg $${(sum(keep.map((k) => trades[k].pnl)) / keep.length).toFixed(3)} | skipped avg $${(sum(teI.filter((k) => !keep.includes(k)).map((k) => trades[k].pnl)) / (teI.length - keep.length)).toFixed(3)}`);

  // --- CPCV
  const N = 10, K = 2, G = trades.length, grp = trades.map((_, k) => Math.floor(k * N / G));
  const span = Array.from({ length: N }, (_, g) => { const ks = trades.map((_, k) => k).filter((k) => grp[k] === g); return { a: trades[ks[0]].t0, b: Math.max(...ks.map((k) => trades[k].t1)) }; });
  const preds: Map<number, number[]>[] = Array.from({ length: N }, () => new Map()); // group -> trade -> list of p (one per split)
  const splits: number[][] = []; for (let a = 0; a < N; a++) for (let b = a + 1; b < N; b++) splits.push([a, b]);
  const EMB = 7 * 86_400_000;
  for (const test of splits) {
    const tr = trades.map((_, k) => k).filter((k) => !test.includes(grp[k]) && !test.some((g) => trades[k].t1 > span[g].a && trades[k].t0 < span[g].b + EMB));
    const m = fit(tr.map((k) => X[k]), tr.map((k) => Y[k]), tr.map((k) => Wt[k]));
    for (const g of test) for (let k = 0; k < G; k++) if (grp[k] === g) { const l = preds[g].get(k) ?? []; l.push(m(X[k])); preds[g].set(k, l); }
  }
  const paths = N - 1; const res: { gain: number; skip: number }[] = [];
  const allPnl = sum(trades.map((t) => t.pnl));
  for (let p = 0; p < paths; p++) { let kept = 0, skipped = 0;
    for (let k = 0; k < G; k++) { const q = preds[grp[k]].get(k)![p]; if (q >= 0.5) kept += trades[k].pnl; else skipped++; }
    res.push({ gain: kept - allPnl, skip: skipped / G }); }
  // null: skip the same share of trades at random
  let rng = 12345; const rand = () => ((rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648);
  const nullGain: number[] = []; for (let r = 0; r < 2000; r++) { const f = res[r % paths].skip; let g = 0; for (const t of trades) if (rand() < f) g -= t.pnl; nullGain.push(g); }
  nullGain.sort((a, b) => a - b);
  console.log(`\n== CPCV: ${splits.length} fits, ${paths} out-of-sample histories of all ${G} trades (total without filter $${allPnl.toFixed(2)}) ==`);
  res.forEach((r, p) => console.log(`  history ${p + 1}: skips ${(100 * r.skip).toFixed(0)}% of trades, change in total $${r.gain >= 0 ? "+" : ""}${r.gain.toFixed(2)} (better than ${(100 * nullGain.filter((x) => x < r.gain).length / nullGain.length).toFixed(0)}% of random skips)`));
  console.log(`  mean change $${(sum(res.map((r) => r.gain)) / paths).toFixed(2)}, ${res.filter((r) => r.gain > 0).length}/${paths} histories better`);

  // --- $10 account with a walk-forward model (refit at each month start on trades closed before it)
  const months: number[] = []; for (let d = new Date(START); d.getTime() < Date.parse("2026-10-01"); d.setUTCMonth(d.getUTCMonth() + 1)) months.push(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const models = new Map<number, (x: number[]) => number>();
  for (const m0 of months) { const tr = trades.map((_, k) => k).filter((k) => trades[k].t1 <= m0); if (tr.length >= 150) models.set(m0, fit(tr.map((k) => X[k]), tr.map((k) => Y[k]), tr.map((k) => Wt[k]))); }
  const monthOf = (t: number) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
  const gate = (s: string, i: number) => { const t = m30[s].t[i] + 1800_000, m = models.get(monthOf(t)); return !m || m(features(s, i, dec[s][i], trades)) >= 0.5; };
  console.log("\n== $10 account, every vote until one stake is left (model in use from", new Date(Math.min(...models.keys())).toISOString().slice(0, 7), ") ==");
  for (const days of [12, 26]) { console.log("live poll     ", days, "days:", rollingRuns(dec, days)); console.log("+ meta filter ", days, "days:", rollingRuns(dec, days, gate)); }
}
