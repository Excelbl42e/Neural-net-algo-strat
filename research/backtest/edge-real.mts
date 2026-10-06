// Is the live poll's edge real? (1) Random side: the same entries (same pairs, same bars) with a coin-flip
// side, 2,000 times; where does the real poll rank? (2) Bootstrap by week of the owner's Monday-only $10
// weeks: how often is the mean week below zero? (3) The same for every-weekday trades, by week.
import { m30, SYMS, START, END, LIVE_RULES, runPairs, account, sim, type Rules } from "./r-lib.mts";
import { LIVE, decisions } from "./book-lib.mts";
import { cotFade } from "./r-extra.mts";
const H = 3600_000, times: Record<string, Set<number>> = Object.fromEntries(SYMS.map((s) => [s, new Set(m30[s].t)]));
const closeOf = (s: string, i: number) => m30[s].t[i] + 1800_000;
const fresh = (s: string, i: number) => [H, 4 * H].every((len) => times[s].has(Math.floor(closeOf(s, i) / len) * len - len));
const RULES: Rules = { ...LIVE_RULES, entry: (s, i, x) => fresh(s, i) && cotFade(s, closeOf(s, i)) !== -x.d };
const dec = decisions(LIVE), trades = runPairs(dec, RULES);
const real = trades.reduce((a, t) => a + t.pnl, 0);
let rs = 42; const rnd = () => ((rs = (rs * 1103515245 + 12345) % 2147483648) / 2147483648);
const randTot: number[] = [];
for (let k = 0; k < 2000; k++) { let tot = 0; for (const t of trades) { const d = rnd() < 0.5 ? 1 : -1; const r = sim(t.s, t.i, d, RULES); if (r) tot += r.pnl; } randTot.push(tot); }
randTot.sort((a, b) => a - b);
const beat = randTot.filter((x) => x < real).length / randTot.length;
console.log(`every-weekday trades: ${trades.length}, real total $${real.toFixed(2)} per $1 stake; random sides: median $${randTot[1000].toFixed(2)}, 95th pct $${randTot[1900].toFixed(2)}, 99th $${randTot[1980].toFixed(2)} -> real beats ${(100 * beat).toFixed(1)}%`);
// by week
const wk = (t: number) => Math.floor((t - START) / (7 * 86_400_000));
const byWeek = new Map<number, number>(); for (const t of trades) byWeek.set(wk(t.t0), (byWeek.get(wk(t.t0)) ?? 0) + t.pnl);
const weeks = [...byWeek.values()];
function boot(xs: number[], n = 10000) { const m: number[] = []; for (let k = 0; k < n; k++) { let s = 0; for (let j = 0; j < xs.length; j++) s += xs[Math.floor(rnd() * xs.length)]; m.push(s / xs.length); } m.sort((a, b) => a - b); return { lo: m[Math.floor(n * 0.05)], hi: m[Math.floor(n * 0.95)], pNeg: m.filter((x) => x <= 0).length / n }; }
const bw = boot(weeks); console.log(`by week (${weeks.length} weeks): mean $${(weeks.reduce((a, b) => a + b, 0) / weeks.length).toFixed(2)} per week; 90% interval $${bw.lo.toFixed(2)} to $${bw.hi.toFixed(2)}; chance the true mean is <= 0: ${(100 * bw.pNeg).toFixed(1)}%`);
const MON: Rules = { ...RULES, entry: (s, i, x) => RULES.entry!(s, i, x) && new Date(closeOf(s, i)).getUTCDay() === 1 };
const mons: number[] = []; for (let d = START; d + 5 * 86_400_000 <= END; d += 86_400_000) if (new Date(d).getUTCDay() === 1) mons.push(d);
const mw = mons.map((s) => account(dec, MON, s, s + 4 * 86_400_000 + 21 * H) - 10);
const bm = boot(mw); console.log(`owner's Monday-only $10 weeks (${mw.length}): mean $${(mw.reduce((a, b) => a + b, 0) / mw.length).toFixed(3)} per week; 90% interval $${bm.lo.toFixed(2)} to $${bm.hi.toFixed(2)}; chance the true mean is <= 0: ${(100 * bm.pNeg).toFixed(1)}%`);
// Monday-only, random sides at the same Monday entries
const monTrades = runPairs(dec, MON); const realMon = monTrades.reduce((a, t) => a + t.pnl, 0); const rm: number[] = [];
for (let k = 0; k < 2000; k++) { let tot = 0; for (const t of monTrades) { const r = sim(t.s, t.i, rnd() < 0.5 ? 1 : -1, MON); if (r) tot += r.pnl; } rm.push(tot); }
rm.sort((a, b) => a - b); console.log(`Monday-only trades: ${monTrades.length}, real $${realMon.toFixed(2)} per $1; random sides median $${rm[1000].toFixed(2)}, 95th $${rm[1900].toFixed(2)} -> real beats ${(100 * rm.filter((x) => x < realMon).length / rm.length).toFixed(1)}%`);
