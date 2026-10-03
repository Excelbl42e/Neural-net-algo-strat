// Part 3: CUSUM event filter (AFML ch.2): only trade a vote if the pair has just made a "real move".
// Part 4: correlation between open positions (Chan ch.6, AFML ch.16): limits for the $10 account.
// Part 5: sensitivity of the meta-labeling filter to its few fixed settings.
import { m30, SYMS, LIVE, decisions, runPairs, summary, rollingRuns, legs, type Open } from "./book-lib.mts";
import { features, fit } from "./book-meta.mts";

const dec = decisions(LIVE);
console.log("== 3. CUSUM event filter: trade a vote only if a CUSUM event (h x daily sigma) fired in the last L bars ==");
console.log("no filter".padEnd(34), summary(runPairs(dec)));
const ev: Record<string, Record<string, Int8Array>> = {};
for (const k of [0.5, 1]) for (const s of SYMS) { const c = m30[s].c, n = c.length, e = new Int8Array(n); let sp = 0, sn = 0, s2 = 0; const r = c.map((x, i) => (i ? Math.log(x / c[i - 1]) : 0));
  for (let i = 1; i < n; i++) { s2 += r[i] * r[i]; if (i > 100) s2 -= r[i - 100] ** 2; if (i < 100) continue; const h = k * Math.sqrt(s2 / 99 * 48);
    sp = Math.max(0, sp + r[i]); sn = Math.min(0, sn + r[i]); if (sp > h) { e[i] = 1; sp = sn = 0; } else if (sn < -h) { e[i] = -1; sp = sn = 0; } }
  (ev[k] ??= {})[s] = e; }
for (const k of [0.5, 1]) for (const L of [4, 16]) for (const same of [false, true]) {
  const f = (s: string, i: number, x: { d: number }) => { for (let j = i; j > i - L && j >= 0; j--) { const e = ev[k][s][j]; if (e && (!same || e === x.d)) return true; } return false; };
  console.log(`h ${k}σ, last ${L} bars, ${same ? "same side" : "any side"}`.padEnd(34), summary(runPairs(dec, f)));
}

console.log("\n== 4. Correlation between open positions, $10 account, every vote until one stake is left ==");
const legCap = (n: number) => (s: string, _i: number, d: number, open: Open[]) => {
  const ex: Record<string, number[]> = {}; const add = (sym: string, dd: number) => { const [a, b] = legs(sym); (ex[a] ??= [0, 0])[dd > 0 ? 0 : 1]++; (ex[b] ??= [0, 0])[dd > 0 ? 1 : 0]++; };
  for (const p of open) add(p.s, p.d); const [a, b] = legs(s); return (ex[a]?.[d > 0 ? 0 : 1] ?? 0) < n && (ex[b]?.[d > 0 ? 1 : 0] ?? 0) < n; };
const idx: Record<string, Map<number, number>> = Object.fromEntries(SYMS.map((s) => [s, new Map(m30[s].t.map((t, i) => [t, i]))]));
const cache = new Map<string, number>();
function corr(a: string, b: string, i: number) { // return correlation of a and b over the 240 M30 bars before bar i of a
  const key = `${a}|${b}|${i >> 4}`; if (cache.has(key)) return cache.get(key)!;
  const xs: number[] = [], ys: number[] = [];
  for (let k = i - 239; k <= i; k++) { const j = idx[b].get(m30[a].t[k]); if (j == null || j < 1 || k < 1) continue; xs.push(Math.log(m30[a].c[k] / m30[a].c[k - 1])); ys.push(Math.log(m30[b].c[j] / m30[b].c[j - 1])); }
  const n = xs.length, mx = xs.reduce((p, q) => p + q, 0) / n, my = ys.reduce((p, q) => p + q, 0) / n; let sxy = 0, sxx = 0, syy = 0;
  for (let k = 0; k < n; k++) { sxy += (xs[k] - mx) * (ys[k] - my); sxx += (xs[k] - mx) ** 2; syy += (ys[k] - my) ** 2; }
  const r = sxy / Math.sqrt(sxx * syy); cache.set(key, r); return r; }
const corrCap = (x: number) => (s: string, i: number, d: number, open: Open[]) => open.every((p) => d * p.d * corr(s, p.s, i) < x);
for (const days of [12, 26]) {
  console.log("no limit (now)".padEnd(40), days, "days:", rollingRuns(dec, days));
  for (const n of [2, 3]) console.log(`at most ${n} on the same side of a currency`.padEnd(40), days, "days:", rollingRuns(dec, days, legCap(n)));
  for (const x of [0.5, 0.7]) console.log(`skip if correlation with an open trade > ${x}`.padEnd(40), days, "days:", rollingRuns(dec, days, corrCap(x)));
}

console.log("\n== 5. Meta-labeling sensitivity: one split (train Nov-Jun, test Jul-Sep), kept trades ==");
const trades = runPairs(dec), X = trades.map((t) => features(t.s, t.i, t.dec, trades)), Y = trades.map((t) => (t.pnl > 0 ? 1 : 0)), W = trades.map((t) => Math.abs(t.pnl));
const tr = trades.map((_, k) => k).filter((k) => trades[k].t1 < Date.parse("2026-07-01")), te = trades.map((_, k) => k).filter((k) => trades[k].part === "test");
for (const lambda of [0.1, 1, 10, 100]) { const m = fit(tr.map((k) => X[k]), tr.map((k) => Y[k]), tr.map((k) => W[k]), lambda);
  console.log(`  lambda ${String(lambda).padEnd(4)}`, [0.45, 0.5, 0.55].map((th) => { const keep = te.filter((k) => m(X[k]) >= th); const s = keep.reduce((a, k) => a + trades[k].pnl, 0); return `threshold ${th}: keeps ${keep.length}/${te.length}, total $${s.toFixed(2)}, avg $${(s / (keep.length || 1)).toFixed(3)}`; }).join(" | ")); }
// which features carry the model: refit on everything, drop one feature at a time, one-split test total
const { FEATS } = await import("./book-meta.mts");
const full = (cols: number[]) => { const sel = (r: number[]) => cols.map((c) => r[c]); const m = fit(tr.map((k) => sel(X[k])), tr.map((k) => Y[k]), tr.map((k) => W[k])); return te.filter((k) => m(sel(X[k])) >= 0.5).reduce((a, k) => a + trades[k].pnl, 0); };
const allCols = FEATS.map((_, k) => k), base = full(allCols);
console.log(`  test total with all ${FEATS.length} features $${base.toFixed(2)}; without each feature:`, FEATS.map((f, k) => `${f} ${(full(allCols.filter((c) => c !== k)) - base).toFixed(2)}`).join(", "));
