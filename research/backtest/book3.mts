// Ideas from the second set of books, judged with the same harness as book-poll/book-meta (book-lib.mts):
//  1. Aronson (Evidence-Based TA) ch.1/ch.6: is the poll's edge more than its long/short bias and luck?
//     Detrending, plus a Monte Carlo permutation test (Masters): same entries, random sides.
//  2. Aronson ch.7-9: three new rule types: channel-normalized divergence, Fisher-transformed channel
//     position, and nearness to the 20-day high/low (the "52-week high" anchoring effect).
//  3. Qian/Hua/Sorensen (Quantitative Equity Portfolio Management) ch.4/7/9: weight each voter by its
//     information coefficient (IC) instead of one vote each; optimal weights = (IC covariance)^-1 x mean IC,
//     refit every month on earlier data only. Also the "contextual" version (separate weights for quiet
//     and busy markets) and "drop the voters with negative IC".
//  4. Hull (Options, Futures and Other Derivatives) ch.22/23: EWMA volatility. Stop set to k x the EWMA
//     daily volatility instead of a fixed 0.6% (stake still sized so a stop loses 5% of equity).
import { m30, SYMS, SPLIT, START, aligned, LIVE, decisions, runPairs, summary, rollingRuns, simTrade, okTime, RR, HOLD, type Voter, type Decision } from "./book-lib.mts";
import { commissionBps, exitIndex } from "./cand-lib.mts";
import { POLL_COST_ALLOWANCE } from "../../artifacts/api-server/src/lib/poll-engine.ts";

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const dec = decisions(LIVE), base = runPairs(dec);
let rng = 987654321; const rand = () => ((rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648);

// ---------- 1. detrending and permutation test
console.log("== 1. Aronson: is the edge more than direction bias and luck? ==");
const longShare = base.filter((t) => t.d > 0).length / base.length;
// drift of each pair over the test window, in % per trade-length: what a rule earns from bias alone
const drift: Record<string, number> = {};
for (const s of SYMS) { const b = m30[s], i0 = b.t.findIndex((t) => t >= START); const n = b.t.length - i0; drift[s] = (b.c.at(-1)! / b.c[i0] - 1) * 100 / n; }
const biasPart = base.reduce((a, t) => a + t.d * drift[t.s] * (t.j - t.i), 0) / base.length;
console.log(`poll trades ${base.length}, ${(100 * longShare).toFixed(1)}% long; avg $${mean(base.map((t) => t.pnl)).toFixed(4)} per $1 stake, of which from leaning with each pair's 11-month drift: $${(biasPart / 100).toFixed(4)} -> detrended $${(mean(base.map((t) => t.pnl)) - biasPart / 100).toFixed(4)}`);
const other = base.map((t) => simTrade(t.s, t.i, -t.d)?.pnl ?? 0);
const real = base.reduce((a, t) => a + t.pnl, 0), realTest = base.filter((t) => t.part === "test").reduce((a, t) => a + t.pnl, 0);
let ge = 0, geT = 0; const R = 5000;
for (let r = 0; r < R; r++) { let s = 0, st = 0; base.forEach((t, k) => { const p = rand() < 0.5 ? t.pnl : other[k]; s += p; if (t.part === "test") st += p; }); if (s >= real) ge++; if (st >= realTest) geT++; }
console.log(`permutation test (same entry bars and exits rules, side by coin flip, ${R} runs): poll total $${real.toFixed(2)} beaten by ${(100 * ge / R).toFixed(1)}% of random-side runs; test months only $${realTest.toFixed(2)} beaten by ${(100 * geT / R).toFixed(1)}%`);

// ---------- 2. Aronson rule types as new voters (computed on M30 bars; lengths x2 and x8 stand in for H1/H4)
console.log("\n== 2. Aronson rule types as new voters ==");
function cn(x: number[], i: number, n: number) { let lo = Infinity, hi = -Infinity; for (let k = i - n + 1; k <= i; k++) { lo = Math.min(lo, x[k]); hi = Math.max(hi, x[k]); } return hi > lo ? (x[i] - lo) / (hi - lo) * 100 : 50; }
function rsi(c: number[], n: number) { const o = new Array(c.length).fill(50); let up = 0, dn = 0; for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1]; up = (up * (n - 1) + Math.max(d, 0)) / n; dn = (dn * (n - 1) + Math.max(-d, 0)) / n; o[i] = dn ? 100 - 100 / (1 + up / dn) : 100; } return o; }
const NEW: Record<string, (s: string, m: number) => Int8Array> = {
  // Aronson's divergence rule: double channel normalization of price and an indicator; when price makes a
  // channel high the indicator does not confirm (gap > 50 points), fade price; held while the gap persists
  aronson_divergence: (s, m) => { const c = m30[s].c, r = rsi(c, 14 * m), v = new Int8Array(c.length), n = 30 * m;
    for (let i = n; i < c.length; i++) { const g = cn(c, i, n) - cn(r, i, n); v[i] = g > 50 ? -1 : g < -50 ? 1 : 0; } return v; },
  // Ehlers/Aronson Fisher transform of the channel position; follow when it crosses its 1-bar lag, while |F| < 1.5
  fisher_channel: (s, m) => { const b = m30[s], v = new Int8Array(b.c.length), n = 10 * m; let x = 0, f = 0, fp = 0;
    for (let i = n; i < b.c.length; i++) { const p = cn(b.c, i, n) / 100 - 0.5; x = Math.max(-0.999, Math.min(0.999, 0.66 * p + 0.67 * x)); fp = f; f = 0.5 * Math.log((1 + x) / (1 - x)) + 0.5 * f;
      v[i] = Math.abs(f) < 1.5 ? (f > fp ? 1 : f < fp ? -1 : 0) : 0; } return v; },
  // George-Hwang / Cooper "52-week high" momentum, scaled to the data (20 trading days): buy within 10% of the
  // 20-day range from its high, sell within 10% of its low
  near_high_anchor: (s, m) => { const c = m30[s].c, v = new Int8Array(c.length), n = 20 * 48 * Math.max(1, m / 2);
    for (let i = n; i < c.length; i++) { const p = cn(c, i, n); v[i] = p > 90 ? 1 : p < 10 ? -1 : 0; } return v; },
};
const extra: Voter[] = [];
for (const [id, f] of Object.entries(NEW)) {
  const rows = [1, 2, 8].map((m) => { const vid = `${id}_x${m}`; for (const s of SYMS) aligned.M30[s][vid] = f(s, m);
    const tr: number[] = [], te: number[] = [];
    for (const s of SYMS) { const b = m30[s], a = aligned.M30[s][vid]; for (let i = 1; i < b.t.length - 1; i += 2) { if (b.t[i] < START || !okTime(b.t[i] + 1800_000) || !a[i]) continue;
      const e = exitIndex(s, i, 192), r = a[i] * (b.c[e] - b.o[i + 1]) / b.o[i + 1] * 1e4 - commissionBps(b.t[i + 1]); (b.t[i] < SPLIT ? tr : te).push(r); } }
    return { vid, sel: mean(tr), test: mean(te) }; });
  console.log(id.padEnd(20), rows.map((r) => `${r.vid.slice(-3)} sel ${r.sel.toFixed(1).padStart(6)} test ${r.test.toFixed(1).padStart(6)} bps`).join(" | "));
  const best = rows.reduce((a, r) => (r.sel > a.sel ? r : a)); extra.push({ id: best.vid, tf: "M30" });
}
console.log("live poll (60)".padEnd(34), summary(base));
for (const v of extra) console.log(`+ ${v.id}`.padEnd(34), summary(runPairs(decisions([...LIVE, v]))));
console.log("+ all three".padEnd(34), summary(runPairs(decisions([...LIVE, ...extra]))));

// ---------- 3. IC-weighted poll (walk-forward, monthly)
console.log("\n== 3. QEPM: weight voters by their information coefficient, refit monthly on earlier data ==");
const V = LIVE.length, MON = (t: number) => { const d = new Date(t); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
const atrQ: Record<string, Uint8Array> = {}; // context: 1 if 14-bar ATR above its 20-day median
for (const s of SYMS) { const b = m30[s], n = b.c.length, a = new Float64Array(n), q = new Uint8Array(n); let v = 0;
  for (let i = 1; i < n; i++) { const tr = Math.max(b.h[i] - b.l[i], Math.abs(b.h[i] - b.c[i - 1]), Math.abs(b.l[i] - b.c[i - 1])) / b.c[i]; v = i < 14 ? tr : (v * 13 + tr) / 14; a[i] = v; }
  for (let i = 960; i < n; i++) { let below = 0; for (let k = i - 960; k < i; k += 8) if (a[k] < a[i]) below++; q[i] = below > 60 ? 1 : 0; } atrQ[s] = q; }
// sample of (month, context, votes, forward return) every 4th bar from all history (Nov-2025 warm-up included)
type Row = { mo: number; ctx: number; v: Int8Array; r: number; t1: number };
const rows: Row[] = [];
for (const s of SYMS) { const b = m30[s]; for (let i = 1000; i < b.t.length - 1; i += 4) { if (!okTime(b.t[i] + 1800_000)) continue; const e = exitIndex(s, i, HOLD);
  const v = new Int8Array(V); LIVE.forEach((x, k) => (v[k] = aligned[x.tf][s][x.id][i])); rows.push({ mo: MON(b.t[i]), ctx: atrQ[s][i], v, r: (b.c[e] - b.o[i + 1]) / b.o[i + 1], t1: b.t[e] }); } }
// per-month IC of each voter (correlation of vote with forward return across all pairs and bars in the month)
function monthIC(rs: Row[]) { const by = new Map<number, Row[]>(); for (const r of rs) (by.get(r.mo) ?? by.set(r.mo, []).get(r.mo)!).push(r);
  const out: { mo: number; ic: number[] }[] = [];
  for (const [mo, g] of [...by].sort((a, b) => a[0] - b[0])) { if (g.length < 300) continue; const mr = mean(g.map((r) => r.r)), sr = Math.sqrt(mean(g.map((r) => (r.r - mr) ** 2)));
    out.push({ mo, ic: Array.from({ length: V }, (_, k) => { const mv = mean(g.map((r) => r.v[k])), sv = Math.sqrt(mean(g.map((r) => (r.v[k] - mv) ** 2))); return sv && sr ? mean(g.map((r) => (r.v[k] - mv) * (r.r - mr))) / (sv * sr) : 0; }) }); }
  return out; }
function solve(A: number[][], b: number[]) { const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) { let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; } }
  return M.map((r, i) => r[n] / r[i]); }
/** weights from monthly ICs: "ic" = mean IC, "icir" = mean/var (diagonal), "opt" = shrunk (Sigma^-1) mean, "pos" = 1 if mean IC > 0 */
function weights(ics: number[][], kind: string) { const mu = Array.from({ length: V }, (_, k) => mean(ics.map((x) => x[k])));
  if (kind === "ic") return mu; if (kind === "pos") return mu.map((m) => (m > 0 ? 1 : 0));
  const S = mu.map((_, a) => mu.map((_, b) => mean(ics.map((x) => (x[a] - mu[a]) * (x[b] - mu[b])))));
  if (kind === "icir") return mu.map((m, k) => m / (S[k][k] || 1));
  const tr = mean(S.map((r, k) => r[k])); const Sh = S.map((r, a) => r.map((v, b) => 0.5 * v + (a === b ? 0.5 * tr : 0))); // 50% shrink to diagonal
  return solve(Sh, mu); }
const months = [...new Set(rows.map((r) => r.mo))].sort((a, b) => a - b);
function weightedDec(kind: string, ctx: boolean, keep: number) {
  // weights for month m use only rows whose forward window ended before m began
  const W = new Map<number, number[][]>();
  for (const m of months) { const start = Date.UTC(Math.floor(m / 12), m % 12, 1); const past = rows.filter((r) => r.t1 < start);
    if (new Set(past.map((r) => r.mo)).size < 3) continue;
    W.set(m, ctx ? [0, 1].map((c) => weights(monthIC(past.filter((r) => r.ctx === c)).map((x) => x.ic), kind)) : [weights(monthIC(past).map((x) => x.ic), kind)]); }
  // threshold per month: the |score| quantile that keeps the same share of bars as the majority poll did in the past
  const out: Record<string, Decision[]> = {}; const scores: Record<string, Float64Array> = {};
  for (const s of SYMS) { const b = m30[s], sc = new Float64Array(b.t.length);
    for (let i = 0; i < b.t.length; i++) { const w = W.get(MON(b.t[i])); if (!w) continue; const ww = w[ctx ? atrQ[s][i] : 0], tot = ww.reduce((a, x) => a + Math.abs(x), 0) || 1;
      let z = 0; LIVE.forEach((x, k) => (z += ww[k] * aligned[x.tf][s][x.id][i])); sc[i] = z / tot; } scores[s] = sc; }
  const thr = new Map<number, number>();
  for (const m of months) { if (!W.has(m)) continue; const start = Date.UTC(Math.floor(m / 12), m % 12, 1), from = start - 60 * 86_400_000; const a: number[] = [];
    for (const s of SYMS) { const b = m30[s]; for (let i = 0; i < b.t.length; i += 3) if (b.t[i] >= from && b.t[i] < start && W.has(MON(b.t[i]))) a.push(Math.abs(scores[s][i])); }
    a.sort((x, y) => y - x); thr.set(m, a.length ? a[Math.floor(a.length * keep)] ?? 0 : Infinity); }
  for (const s of SYMS) { const sc = scores[s]; out[s] = m30[s].t.map((t, i) => { const th = thr.get(MON(t)); const d = th != null && sc[i] && Math.abs(sc[i]) > th ? Math.sign(sc[i]) : 0; return { d, share: Math.abs(sc[i]), buy: 0, sell: 0 }; }); }
  return out;
}
const firstW = months.find((m) => new Set(rows.filter((r) => r.t1 < Date.UTC(Math.floor(m / 12), m % 12, 1)).map((r) => r.mo)).size >= 3)!;
const fromW = Date.UTC(Math.floor(firstW / 12), firstW % 12, 1);
let barsMaj = 0, barsAll = 0; for (const s of SYMS) for (let i = 0; i < m30[s].t.length; i += 3) if (m30[s].t[i] >= START) { barsAll++; if (dec[s][i].d) barsMaj++; }
const keep = barsMaj / barsAll;
console.log(`weights usable from ${new Date(fromW).toISOString().slice(0, 7)}; majority poll is decided on ${(100 * keep).toFixed(0)}% of bars, IC polls are set to trade the same share`);
const sinceW = (t: typeof base) => t.filter((x) => x.t0 >= fromW);
console.log("majority poll (now)".padEnd(40), summary(sinceW(base)));
const variants: [string, string, boolean][] = [["mean-IC weights", "ic", false], ["IC/variance weights", "icir", false], ["optimal (Sigma^-1 IC, shrunk)", "opt", false], ["only voters with positive IC", "pos", false], ["contextual optimal (quiet/busy)", "opt", true], ["contextual mean-IC", "ic", true]];
const decs: Record<string, Record<string, Decision[]>> = {};
for (const [name, kind, ctx] of variants) { decs[name] = weightedDec(kind, ctx, keep); console.log(name.padEnd(40), summary(sinceW(runPairs(decs[name])))); }
console.log("$10 account, every vote until one stake left, runs starting after the weights exist:");
const runsFrom = (d: Record<string, Decision[]>, days: number) => rollingRuns(Object.fromEntries(SYMS.map((s) => [s, d[s].map((x, i) => (m30[s].t[i] < fromW ? { ...x, d: 0 } : x))])), days);
for (const days of [12, 26]) { console.log("  majority".padEnd(40), days, runsFrom(dec, days)); for (const [name] of variants) console.log(`  ${name}`.padEnd(40), days, runsFrom(decs[name], days)); }

// ---------- 4. EWMA-volatility stop
console.log("\n== 4. Hull: stop at k x EWMA daily volatility (lambda 0.94 per day) instead of a fixed 0.6% ==");
const ew: Record<string, Float64Array> = {}; const lam = Math.pow(0.94, 1 / 48);
for (const s of SYMS) { const c = m30[s].c, a = new Float64Array(c.length); let v = (0.006 / 1.5) ** 2 / 48; for (let i = 1; i < c.length; i++) { v = lam * v + (1 - lam) * Math.log(c[i] / c[i - 1]) ** 2; a[i] = Math.sqrt(48 * v); } ew[s] = a; }
function simStop(s: string, i: number, d: number, stop: number) { // as simTrade with a given stop fraction; returns equity % change at 5% risk
  const b = m30[s], e0 = b.o[i + 1], comm = commissionBps(b.t[i + 1]) / 100, cost = POLL_COST_ALLOWANCE * e0, sp = e0 * (1 - d * stop), tp = e0 + d * (RR * stop * e0 + (1 + RR) * cost);
  for (let j = i + 1; j < b.t.length; j++) { const dt = new Date(b.t[j]), flat = dt.getUTCDay() === 5 && dt.getUTCHours() * 60 + dt.getUTCMinutes() >= 20 * 60 + 30; let px: number | null = null;
    if (j > i + 1 && b.t[j] - b.t[j - 1] > 6 * 3600_000 && d * (b.o[j] - sp) <= 0) px = b.o[j]; else if (d > 0 ? b.l[j] <= sp : b.h[j] >= sp) px = sp; else if (d > 0 ? b.h[j] >= tp : b.l[j] <= tp) px = tp; else if (j - (i + 1) >= HOLD || flat) px = b.c[j];
    if (px != null) { const pnl = Math.max(-(stop * 100 + 0.2), d * (px - e0) / e0 * 100 - comm); return 5 * pnl / (stop * 100 + comm); } }
  return 0; }
const show = (name: string, f: (s: string, i: number) => number) => { const r = base.map((t) => ({ p: t.part, x: simStop(t.s, t.i, t.d, f(t.s, t.i)) }));
  const g = (p: string) => { const a = r.filter((q) => q.p === p).map((q) => q.x); return `${p} avg ${mean(a).toFixed(3).padStart(6)}% of equity, win ${(100 * a.filter((x) => x > 0).length / a.length).toFixed(1)}%`; };
  console.log(name.padEnd(30), g("sel"), "|", g("test")); };
show("fixed 0.6% (now)", () => 0.006);
console.log(`(EWMA daily vol at poll entries: median ${(100 * [...base.map((t) => ew[t.s][t.i])].sort((a, b) => a - b)[base.length >> 1]).toFixed(2)}%)`);
for (const k of [0.75, 1, 1.5, 2]) show(`${k} x EWMA daily vol`, (s, i) => Math.min(0.02, Math.max(0.002, k * ew[s][i])));

console.log("\n== 2b. $10 account with the two Aronson voters that added a little ==");
for (const days of [12, 26]) { console.log("live poll".padEnd(30), days, rollingRuns(dec, days));
  for (const v of extra.filter((x) => !x.id.startsWith("fisher"))) console.log(`+ ${v.id}`.padEnd(30), days, rollingRuns(decisions([...LIVE, v]), days)); }
