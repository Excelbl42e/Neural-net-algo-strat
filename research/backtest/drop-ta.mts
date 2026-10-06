// Live 60 vs the 40 quant strategies alone (technical 20 dropped), month by month, owner's rules.
import { m30, SYMS, START, END, LIVE_RULES, runPairs, account, type Rules } from "./r-lib.mts";
import { LIVE, aligned, type Decision } from "./book-lib.mts";
import { cotFade } from "./r-extra.mts";
const TA = new Set(["rsi_reversal", "macd_histogram", "ema_cross", "bollinger_reversion", "stochastic_cross", "adx_dmi", "ichimoku", "keltner_breakout", "roc_momentum", "williams_r", "cci_cross", "donchian_breakout", "parabolic_sar", "pivot_points", "fib_macd", "supertrend", "aroon", "heikin_ashi", "trix", "vortex"]);
type V = { id: string; tf: string };
function decisions(vs: V[]): Record<string, Decision[]> { const q = Math.ceil(vs.length / 2), out: Record<string, Decision[]> = {};
  for (const s of SYMS) { const arr = vs.map((v) => aligned[v.tf][s][v.id]), n = m30[s].t.length, a: Decision[] = new Array(n);
    for (let i = 0; i < n; i++) { let b = 0, se = 0; for (const x of arr) { if (x[i] > 0) b++; else if (x[i] < 0) se++; } a[i] = { d: b + se >= q && b !== se ? Math.sign(b - se) : 0, share: Math.max(b, se) / Math.max(1, b + se), buy: b, sell: se }; } out[s] = a; }
  return out; }
const H = 3600_000, times: Record<string, Set<number>> = Object.fromEntries(SYMS.map((s) => [s, new Set(m30[s].t)]));
const closeOf = (s: string, i: number) => m30[s].t[i] + 1800_000;
const fresh = (s: string, i: number) => [H, 4 * H].every((len) => times[s].has(Math.floor(closeOf(s, i) / len) * len - len));
const RULES: Rules = { ...LIVE_RULES, entry: (s, i, x) => fresh(s, i) && cotFade(s, closeOf(s, i)) !== -x.d };
const MON: Rules = { ...RULES, entry: (s, i, x) => RULES.entry!(s, i, x) && new Date(closeOf(s, i)).getUTCDay() === 1 };
const A = decisions(LIVE), Q = decisions(LIVE.filter((v) => !TA.has(v.id)));
const ta = runPairs(A, RULES), tq = runPairs(Q, RULES);
const months = [...new Set(ta.map((t) => new Date(t.t0).toISOString().slice(0, 7)))].sort();
console.log("month    | every weekday: 60 / 40Q ($ per $1, summed) | Monday-only $10 weeks: 60 / 40Q");
let winsT = 0, winsW = 0;
const mons: number[] = []; for (let d = START; d + 5 * 86_400_000 <= END; d += 86_400_000) if (new Date(d).getUTCDay() === 1) mons.push(d);
for (const m of months) {
  const sa = ta.filter((t) => new Date(t.t0).toISOString().startsWith(m)).reduce((a, t) => a + t.pnl, 0), sq = tq.filter((t) => new Date(t.t0).toISOString().startsWith(m)).reduce((a, t) => a + t.pnl, 0);
  const wk = mons.filter((d) => new Date(d).toISOString().startsWith(m)); const wa = wk.reduce((a, d) => a + account(A, MON, d, d + 4 * 86_400_000 + 21 * H) - 10, 0), wq = wk.reduce((a, d) => a + account(Q, MON, d, d + 4 * 86_400_000 + 21 * H) - 10, 0);
  if (sq > sa) winsT++; if (wq > wa) winsW++;
  console.log(m, " |", sa.toFixed(2).padStart(7), sq.toFixed(2).padStart(7), "                              |", wa.toFixed(2).padStart(6), wq.toFixed(2).padStart(6));
}
console.log(`40Q better in ${winsT}/${months.length} months (every weekday) and ${winsW}/${months.length} (Monday-only). Weeks where they differ:`);
let better = 0, worse = 0; for (const d of mons) { const a = account(A, MON, d, d + 4 * 86_400_000 + 21 * H), q = account(Q, MON, d, d + 4 * 86_400_000 + 21 * H); if (q > a + 0.01) better++; else if (q < a - 0.01) worse++; }
console.log(`40Q better in ${better} weeks, worse in ${worse}, same in ${mons.length - better - worse}`);
// how often do the two polls disagree on direction or on trading at all
let both = 0, onlyA = 0, onlyQ = 0, flip = 0; for (const s of SYMS) for (let i = 0; i < m30[s].t.length; i++) { const a = A[s][i].d, q = Q[s][i].d; if (a && q) { both++; if (a !== q) flip++; } else if (a) onlyA++; else if (q) onlyQ++; }
console.log(`decisions: both trade ${both} (opposite side ${flip}), only 60 ${onlyA}, only 40Q ${onlyQ}`);
