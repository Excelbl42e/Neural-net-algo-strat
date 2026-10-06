// The owner's design: drop the 20 technical voters, poll 100 quant strategies (40 live + 60 new), and use
// the fundamental voters as helpers (priority for the limited stakes, or a veto) rather than as voters.
// Judged as poll-compare.mts: live rules; per trade sel/test; Monday-only $10 weeks; month-by-month vs live 60.
import fs from "node:fs";
import { m30, SYMS, START, END, LIVE_RULES, runPairs, account, type Rules, type Tr, type Acct } from "./r-lib.mts";
import { aligned, LIVE, type Decision } from "./book-lib.mts";
import { loadTF } from "./cand-lib.mts";
import { cotFade } from "./r-extra.mts";
import { DAYS, FUND_VOTERS, pairVote } from "../fundamental/fund-lib.mts";
const D = new URL("./data", import.meta.url).pathname;
for (const tf of ["M30", "H1", "H4"]) loadTF(tf, `${D}/votes-nq-${tf}.json`);
const oos: any[] = JSON.parse(fs.readFileSync(new URL("../fundamental/data/f-oos.json", import.meta.url).pathname, "utf8"));
const kept = oos.filter((r) => r.kept);
const dayStart = DAYS.map((d) => Date.parse(d + "T00:00:00Z") + 86_400_000 + 3600_000);
/** Net fundamental agreement (kept voters, directions from 2012-2022) on the M30 timeline. */
const FNET: Record<string, Int8Array> = {};
for (const s of SYMS) { const b = m30[s], a = new Int8Array(b.t.length); const caches = kept.map(() => new Map()); let j = -1;
  for (let i = 0; i < b.t.length; i++) { const T = b.t[i] + 1800_000; while (j + 1 < DAYS.length && dayStart[j + 1] <= T) j++; if (j < 0) continue; let n = 0; kept.forEach((r, k) => { n += r.dir * pairVote(FUND_VOTERS.find((v) => v.id === r.id)!, s.slice(3), j, caches[k]); }); a[i] = n; }
  FNET[s] = a; }
type Voter = { id: string; tf: string };
function decisions(vs: Voter[]): Record<string, Decision[]> {
  const q = Math.ceil(vs.length / 2), out: Record<string, Decision[]> = {};
  for (const s of SYMS) { const arr = vs.map((v) => aligned[v.tf][s][v.id]), n = m30[s].t.length, a: Decision[] = new Array(n);
    for (let i = 0; i < n; i++) { let b = 0, se = 0; for (const x of arr) { const y = x[i]; if (y > 0) b++; else if (y < 0) se++; } a[i] = { d: b + se >= q && b !== se ? Math.sign(b - se) : 0, share: Math.max(b, se) / Math.max(1, b + se), buy: b, sell: se }; }
    out[s] = a; }
  return out;
}
const TA = new Set(["rsi_reversal", "macd_histogram", "ema_cross", "bollinger_reversion", "stochastic_cross", "adx_dmi", "ichimoku", "keltner_breakout", "roc_momentum", "williams_r", "cci_cross", "donchian_breakout", "parabolic_sar", "pivot_points", "fib_macd", "supertrend", "aroon", "heikin_ashi", "trix", "vortex"]);
const Q40 = LIVE.filter((v) => !TA.has(v.id));
const nq = JSON.parse(fs.readFileSync(`${D}/nq-score.json`, "utf8"));
const NEW60: Voter[] = nq.rows.map((r: any) => ({ id: r.id, tf: r.tf }));
const H = 3600_000, times: Record<string, Set<number>> = Object.fromEntries(SYMS.map((s) => [s, new Set(m30[s].t)]));
const closeOf = (s: string, i: number) => m30[s].t[i] + 1800_000;
const fresh = (s: string, i: number) => [H, 4 * H].every((len) => times[s].has(Math.floor(closeOf(s, i) / len) * len - len));
const base = (s: string, i: number, d: number) => fresh(s, i) && cotFade(s, closeOf(s, i)) !== -d;
const mk = (veto?: number): Rules => ({ ...LIVE_RULES, entry: (s, i, x) => base(s, i, x.d) && (veto == null || FNET[s][i] * x.d > -veto) });
const mon = (r: Rules): Rules => ({ ...r, entry: (s, i, x) => r.entry!(s, i, x) && new Date(closeOf(s, i)).getUTCDay() === 1 });
const PRIORITY: Acct = { order: (c) => [...c].sort((a, b) => FNET[b.s][b.i] * b.x.d - FNET[a.s][a.i] * a.x.d) };
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const mons: number[] = []; for (let d = START; d + 5 * 86_400_000 <= END; d += 86_400_000) if (new Date(d).getUTCDay() === 1) mons.push(d);
const week = (dec: Record<string, Decision[]>, r: Rules, acct: Acct, s: number) => account(dec, mon(r), s, s + 4 * 86_400_000 + 21 * H, acct) - 10;
const REF = decisions(LIVE), refW = mons.map((s) => week(REF, mk(), {}, s));
function report(name: string, dec: Record<string, Decision[]>, r: Rules = mk(), acct: Acct = {}) {
  const t: Tr[] = runPairs(dec, r); const sel = t.filter((x) => x.part === "sel").map((x) => x.pnl), te = t.filter((x) => x.part === "test").map((x) => x.pnl);
  const w = mons.map((s) => week(dec, r, acct, s)); const tot = w.reduce((a, x) => a + x, 0), jul = w.filter((_, k) => mons[k] >= Date.parse("2026-07-01")).reduce((a, x) => a + x, 0);
  const better = w.filter((x, k) => x > refW[k] + 0.01).length, worse = w.filter((x, k) => x < refW[k] - 0.01).length;
  console.log(`${name.padEnd(46)} ${String(t.length).padStart(4)} tr  sel ${mean(sel).toFixed(3).padStart(6)}  test ${mean(te).toFixed(3).padStart(6)}  yr $${t.reduce((a, x) => a + x.pnl, 0).toFixed(2).padStart(6)} | Mon $${(tot >= 0 ? "+" : "") + tot.toFixed(2)} up ${Math.round(100 * w.filter((x) => x > 0).length / w.length)}% Jul-Sep ${jul.toFixed(2)} worst wk ${Math.min(...w).toFixed(2)} | vs live: ${better} better / ${worse} worse wks`);
}
console.log("electorate / rule".padEnd(46), "per trade ($ per $1), year total | owner's Monday-only $10 weeks");
const Q100 = decisions([...Q40, ...NEW60]);
const Q100h1 = decisions([...Q40, ...NEW60.map((v) => ({ id: v.id, tf: "H1" }))]);
const Q40d = decisions(Q40);
report("live 60 (reference)", REF);
report("40 quant", Q40d);
report("100 quant (new at timeframe chosen on sel)", Q100);
report("100 quant (new all on H1, no choice)", Q100h1);
console.log("\nFundamentals as helpers (13 voters chosen on 2012-2022, net agreement):");
report("live 60 + priority to fundamental agreement", REF, mk(), PRIORITY);
report("40 quant + priority", Q40d, mk(), PRIORITY);
report("100 quant + priority", Q100, mk(), PRIORITY);
report("live 60 + veto when net >= 2 against", REF, mk(2));
report("100 quant + veto when net >= 2 against", Q100, mk(2));
report("100 quant + veto net >= 3 + priority", Q100, mk(3), PRIORITY);
