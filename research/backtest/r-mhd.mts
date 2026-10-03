// Magnetohydrodynamics (MHD) and other physics/maths models turned into testable FX signals.
// MHD = a conducting fluid (Navier-Stokes) carrying a magnetic field (Maxwell). The FX mapping used here:
// the 14 pairs are the "fluid", the currencies they share are the "field lines" tying them together.
//   alfven_lag        Alfven waves carry a disturbance along field lines at finite speed. FX: does a cross
//                     (e.g. EURJPY) lag what EURUSD x USDJPY already implies? Diagnostic: size and
//                     autocorrelation of the cross's deviation from its implied rate, per M30 bar.
//   magnetic_tension  Field lines resist bending and snap back. FX: a pair's 4-day move NOT explained by the
//                     3 main market factors (PCA of 14 pairs, last 120 H4 bars) is a bent field line; fade it
//                     when its z-score is beyond 2.
//   dynamo_ising      Dynamo / Ising magnetisation: when the flows line up, the field grows. FX: when all 6
//                     USD pairs moved the same way for the dollar over the last day, follow the dollar.
//   hawkes_excite     Hawkes self-exciting process (earthquake aftershocks): big moves cluster. Follow the side
//                     whose recent large-move intensity (exp. kernel, half-life 12h) is higher.
// Plus random matrix theory (Marchenko-Pastur): how many truly independent bets the 14 pairs offer.
import { LIVE, decisions, aligned, okTime } from "./book-lib.mts";
import { m30, SYMS, START, SPLIT, END, LIVE_RULES, runPairs, sumLine, account, type Rules } from "./r-lib.mts";
import { commissionBps } from "./cand-lib.mts";

const mean = (a: ArrayLike<number>) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s / (a.length || 1); };
// common M30 clock and returns
const clock = [...new Set(SYMS.flatMap((s) => m30[s].t))].sort((a, b) => a - b);
const pos: Record<string, Map<number, number>> = Object.fromEntries(SYMS.map((s) => [s, new Map(m30[s].t.map((t, i) => [t, i]))]));
const closeAt = (s: string, t: number) => { const i = pos[s].get(t); return i == null ? null : m30[s].c[i]; };

// ---- Alfven: cross vs implied
console.log("== alfven_lag: does a cross lag what the USD pairs imply? ==");
const CROSS: [string, string, string, number, number][] = [["frxEURJPY", "frxEURUSD", "frxUSDJPY", 1, 1], ["frxGBPJPY", "frxGBPUSD", "frxUSDJPY", 1, 1], ["frxAUDJPY", "frxAUDUSD", "frxUSDJPY", 1, 1], ["frxEURGBP", "frxEURUSD", "frxGBPUSD", 1, -1], ["frxEURAUD", "frxEURUSD", "frxAUDUSD", 1, -1], ["frxEURCHF", "frxEURUSD", "frxUSDCHF", 1, 1], ["frxEURCAD", "frxEURUSD", "frxUSDCAD", 1, 1], ["frxGBPAUD", "frxGBPUSD", "frxAUDUSD", 1, -1]];
for (const [x, a, b, sa, sb] of CROSS) { const dev: number[] = []; let prev: number | null = null;
  for (const t of clock) { const cx = closeAt(x, t), ca = closeAt(a, t), cb = closeAt(b, t); if (cx == null || ca == null || cb == null) { prev = null; continue; }
    const d = Math.log(cx) - (sa * Math.log(ca) + sb * Math.log(cb)); if (prev != null) dev.push(d - prev); prev = d; }
  const m = mean(dev), v = mean(dev.map((z) => (z - m) ** 2)); let c1 = 0; for (let i = 1; i < dev.length; i++) c1 += (dev[i] - m) * (dev[i - 1] - m); c1 /= (dev.length - 1) * v;
  console.log(`  ${x.slice(3)}: typical deviation change per bar ${(Math.sqrt(v) * 1e4).toFixed(2)} bps, lag-1 autocorrelation ${c1.toFixed(2)} (commission is 2-6 bps per trade)`); }

// ---- H4 return matrix for PCA / RMT
const h4 = clock.filter((t) => (t + 1800_000) % 14_400_000 === 0);
const R: number[][] = []; const R_t: number[] = []; let last: (number | null)[] | null = null;
for (const t of h4) { const c = SYMS.map((s) => closeAt(s, t)); if (last && c.every((x, k) => x != null && last![k] != null)) { R.push(c.map((x, k) => Math.log(x! / last![k]!))); R_t.push(t); } last = c; }
function corrMat(X: number[][]) { const n = X[0].length, T = X.length, mu = Array.from({ length: n }, (_, k) => mean(X.map((r) => r[k]))), sd = mu.map((m, k) => Math.sqrt(mean(X.map((r) => (r[k] - m) ** 2))));
  const Z = X.map((r) => r.map((v, k) => (v - mu[k]) / (sd[k] || 1))); return { C: Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => Z.reduce((s, r) => s + r[a] * r[b], 0) / T)), Z, sd, mu }; }
function eig(C: number[][], k: number) { const n = C.length; const M = C.map((r) => [...r]); const vals: number[] = [], vecs: number[][] = [];
  for (let e = 0; e < k; e++) { let v = Array.from({ length: n }, (_, i) => 1 + i * 0.01); for (let it = 0; it < 300; it++) { const w = M.map((r) => r.reduce((s, x, j) => s + x * v[j], 0)); const nn = Math.sqrt(w.reduce((s, x) => s + x * x, 0)); v = w.map((x) => x / nn); }
    const lam = v.reduce((s, x, i) => s + x * M[i].reduce((q, y, j) => q + y * v[j], 0), 0); vals.push(lam); vecs.push(v); for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) M[i][j] -= lam * v[i] * v[j]; }
  return { vals, vecs }; }
// ---- RMT
{ const { C } = corrMat(R), T = R.length, N = SYMS.length, q = N / T, lp = (1 + Math.sqrt(q)) ** 2; const { vals } = eig(C, N);
  console.log(`\n== random matrix theory: ${N} pairs, ${T} H4 returns. Eigenvalues of the correlation matrix (pure noise would stay below ${lp.toFixed(2)}): ${vals.map((x) => x.toFixed(2)).join(", ")}`);
  console.log(`   ${vals.filter((x) => x > lp).length} independent market factors carry real structure; the first one alone explains ${(100 * vals[0] / N).toFixed(0)}% of all movement`); }

// ---- signals on M30 bars
const sig: Record<string, Record<string, Int8Array>> = { magnetic_tension: {}, dynamo_ising: {}, hawkes_excite: {} };
for (const s of SYMS) for (const k of Object.keys(sig)) sig[k][s] = new Int8Array(m30[s].t.length);
// magnetic tension: at each H4 close, PCA(3) on the previous 120 H4 returns; residual of the last 24 bars
const tension = new Map<number, number[]>();
for (let i = 120; i < R.length; i++) { const W = R.slice(i - 120, i), { Z, sd, mu } = corrMat(W), { C } = corrMat(W), { vecs } = eig(C, 3);
  const res = Z.map((z) => { const p = vecs.map((v) => v.reduce((s, x, k) => s + x * z[k], 0)); return z.map((x, k) => x - vecs.reduce((s, v, e) => s + p[e] * v[k], 0)); });
  const rs = SYMS.map((_, k) => Math.sqrt(mean(res.map((r) => r[k] ** 2))) || 1); const cum = SYMS.map((_, k) => res.slice(-24).reduce((s, r) => s + r[k], 0) / (rs[k] * Math.sqrt(24)));
  tension.set(R_t[i - 1], cum); void sd; void mu; }
for (const s of SYMS) { const k = SYMS.indexOf(s); let cur: number[] | undefined; m30[s].t.forEach((t, i) => { const v = tension.get(t); if (v) cur = v; if (cur) sig.magnetic_tension[s][i] = cur[k] > 2 ? -1 : cur[k] < -2 ? 1 : 0; }); }
// dynamo/Ising: dollar direction of each USD pair over the last 48 M30 bars
const USDP: [string, number][] = [["frxEURUSD", -1], ["frxGBPUSD", -1], ["frxAUDUSD", -1], ["frxUSDJPY", 1], ["frxUSDCAD", 1], ["frxUSDCHF", 1]];
const mag = new Map<number, number>(); for (const t of clock) { let m = 0, n = 0; for (const [s, sgn] of USDP) { const i = pos[s].get(t); if (i == null || i < 48) continue; n++; m += Math.sign(sgn * (m30[s].c[i] - m30[s].c[i - 48])); } if (n === 6) mag.set(t, m / 6); }
for (const [s, sgn] of USDP) m30[s].t.forEach((t, i) => { const m = mag.get(t); if (m != null && Math.abs(m) === 1) sig.dynamo_ising[s][i] = (sgn * m) as any; });
// Hawkes: large moves (>2.5 sd of the last 500 bars), exponential kernel half-life 24 bars
for (const s of SYMS) { const c = m30[s].c, lam = Math.pow(0.5, 1 / 24); let up = 0, dn = 0, s2 = 0; const r = c.map((x, i) => (i ? Math.log(x / c[i - 1]) : 0));
  for (let i = 1; i < c.length; i++) { s2 += r[i] ** 2; if (i > 500) s2 -= r[i - 500] ** 2; up *= lam; dn *= lam; if (i > 500) { const sd = Math.sqrt(s2 / 500); if (r[i] > 2.5 * sd) up += 1; if (r[i] < -2.5 * sd) dn += 1; }
    sig.hawkes_excite[s][i] = up + dn >= 1 && Math.abs(up - dn) >= 0.5 ? Math.sign(up - dn) as any : 0; } }

const dow = (s: string, i: number) => new Date(m30[s].t[i] + 1800_000).getUTCDay();
const WKR: Rules = { ...LIVE_RULES, hold: 300, entry: (s, i) => dow(s, i) <= 2 };
const dec = decisions(LIVE);
console.log("\n== each model alone (bps per vote over 4 days, after commission) and added to the poll (weekly cycle) ==");
console.log("weekly cycle, 60 voters".padEnd(30), sumLine(runPairs(dec, WKR)));
const D = 86_400_000; const mons: number[] = []; for (let d = START; d + 5 * D <= END; d += D) if (new Date(d).getUTCDay() === 1) mons.push(d + 7 * 3600_000);
const weekly = (d: any) => mons.reduce((a, s) => a + account(d, WKR, s, s + 4 * D + 14 * 3600_000, { maxOpen: 4 }) - 10, 0);
console.log(`  $10 every Monday, withdrawn Friday, 46 weeks: +$${weekly(dec).toFixed(2)}`);
for (const k of Object.keys(sig)) {
  const tr: number[] = [], te: number[] = []; let n = 0, vo = 0;
  for (const s of SYMS) { const b = m30[s], a = sig[k][s]; aligned.M30[s][k] = a; for (let i = 1; i + 193 < b.t.length; i += 2) { if (b.t[i] < START || !okTime(b.t[i] + 1800_000)) continue; n++; if (!a[i]) continue; vo++;
    (b.t[i] < SPLIT ? tr : te).push(a[i] * (b.c[i + 192] - b.o[i + 1]) / b.o[i + 1] * 1e4 - commissionBps(b.t[i + 1])); } }
  const d61 = decisions([...LIVE, { id: k, tf: "M30" }]);
  console.log(`${k.padEnd(18)} alone: sel ${mean(tr).toFixed(1)} test ${mean(te).toFixed(1)} bps (votes ${(100 * vo / n).toFixed(0)}%)\n  + in poll`.padEnd(30), sumLine(runPairs(d61, WKR)), `| weekly withdrawn +$${weekly(d61).toFixed(2)}`);
}
