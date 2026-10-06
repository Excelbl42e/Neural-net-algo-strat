// The poll with different electorates, judged two ways:
//  1. live rules, every weekday 07-21 UTC, one position per pair: $ per $1 stake, selection (Nov-Jun) / test (Jul-Sep);
//  2. the owner's setup: Monday-only entries, every vote until one stake is left, COT veto, $10 each Monday,
//     everything closed or valued Friday 21:00 UTC, 46 weeks.
// Quorum = half the electorate (live: 30 of 60). New quant strategies vote on the timeframe chosen on the
// selection months (nq-score.mts); fundamental voters use the direction chosen on 2012-2022 (f-oos.mts).
import fs from "node:fs";
import { m30, SYMS, START, END, LIVE_RULES, runPairs, account, type Rules, type Tr } from "./r-lib.mts";
import { aligned, LIVE, type Decision } from "./book-lib.mts";
import { loadTF } from "./cand-lib.mts";
import { cotFade } from "./r-extra.mts";
import { DAYS, FUND_VOTERS, pairVote } from "../fundamental/fund-lib.mts";
const D = new URL("./data", import.meta.url).pathname;
for (const tf of ["M30", "H1", "H4"]) loadTF(tf, `${D}/votes-nq-${tf}.json`);
// fundamental votes on the M30 timeline: a daily value dated D is used from D+1 01:00 UTC
const oos: any[] = JSON.parse(fs.readFileSync(new URL("../fundamental/data/f-oos.json", import.meta.url).pathname, "utf8"));
const dayStart = DAYS.map((d) => Date.parse(d + "T00:00:00Z") + 86_400_000 + 3600_000);
aligned.F = {};
for (const s of SYMS) { aligned.F[s] = {}; const pair = s.slice(3); const b = m30[s];
  for (const v of FUND_VOTERS) { const dir = oos.find((r) => r.id === v.id)!.dir; const a = new Int8Array(b.t.length); const cache = new Map(); let j = -1;
    for (let i = 0; i < b.t.length; i++) { const T = b.t[i] + 1800_000; while (j + 1 < DAYS.length && dayStart[j + 1] <= T) j++; if (j >= 0) a[i] = dir * pairVote(v, pair, j, cache); }
    aligned.F[s][v.id] = a; } }
type Voter = { id: string; tf: string };
function decisions(vs: Voter[]): Record<string, Decision[]> {
  const q = Math.ceil(vs.length / 2), out: Record<string, Decision[]> = {};
  for (const s of SYMS) { const arr = vs.map((v) => aligned[v.tf][s][v.id]), n = m30[s].t.length, a: Decision[] = new Array(n);
    for (let i = 0; i < n; i++) { let b = 0, se = 0; for (const x of arr) { const y = x[i]; if (y > 0) b++; else if (y < 0) se++; } const d = b + se >= q && b !== se ? Math.sign(b - se) : 0; a[i] = { d, share: Math.max(b, se) / Math.max(1, b + se), buy: b, sell: se }; }
    out[s] = a; }
  return out;
}
const TA = new Set(["rsi_reversal", "macd_histogram", "ema_cross", "bollinger_reversion", "stochastic_cross", "adx_dmi", "ichimoku", "keltner_breakout", "roc_momentum", "williams_r", "cci_cross", "donchian_breakout", "parabolic_sar", "pivot_points", "fib_macd", "supertrend", "aroon", "heikin_ashi", "trix", "vortex"]);
const liveQ = LIVE.filter((v) => !TA.has(v.id));
const nq: { rows: any[]; top: Voter[] } = JSON.parse(fs.readFileSync(`${D}/nq-score.json`, "utf8"));
const fundKept = oos.filter((r) => r.kept).map((r) => ({ id: r.id, tf: "F" }));
const fund40 = [...oos].sort((a, b) => b.tSel - a.tSel).slice(0, 40).map((r) => ({ id: r.id, tf: "F" }));
// live-like rules: freshness of the H1/H4 candles, COT veto, trading hours 07-21
const H = 3600_000; const times: Record<string, Set<number>> = Object.fromEntries(SYMS.map((s) => [s, new Set(m30[s].t)]));
const closeOf = (s: string, i: number) => m30[s].t[i] + 1800_000;
const fresh = (s: string, i: number) => [H, 4 * H].every((len) => times[s].has(Math.floor(closeOf(s, i) / len) * len - len));
const veto = (s: string, i: number, d: number) => cotFade(s, closeOf(s, i)) === -d;
const RULES: Rules = { ...LIVE_RULES, entry: (s, i, x) => fresh(s, i) && !veto(s, i, x.d) };
const MONDAY: Rules = { ...RULES, entry: (s, i, x) => RULES.entry!(s, i, x) && new Date(closeOf(s, i)).getUTCDay() === 1 };
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const mons: number[] = []; for (let d = START; d + 5 * 86_400_000 <= END; d += 86_400_000) if (new Date(d).getUTCDay() === 1) mons.push(d);
function report(name: string, vs: Voter[]) {
  const dec = decisions(vs); const t: Tr[] = runPairs(dec, RULES);
  const sel = t.filter((x) => x.part === "sel").map((x) => x.pnl), te = t.filter((x) => x.part === "test").map((x) => x.pnl);
  const w = mons.map((s) => account(dec, MONDAY, s, s + 4 * 86_400_000 + 21 * H)); const wTe = mons.filter((s) => s >= Date.parse("2026-07-01")).map((s) => account(dec, MONDAY, s, s + 4 * 86_400_000 + 21 * H));
  console.log(`${name.padEnd(44)} ${String(vs.length).padStart(3)} | ${String(t.length).padStart(4)} trades  sel ${mean(sel).toFixed(3).padStart(6)}  test ${mean(te).toFixed(3).padStart(6)}  year $${t.reduce((a, x) => a + x.pnl, 0).toFixed(2).padStart(6)} | Mon-only: withdrawn ${(w.reduce((a, x) => a + x - 10, 0) >= 0 ? "+" : "") + w.reduce((a, x) => a + x - 10, 0).toFixed(2)}, up ${Math.round(100 * w.filter((x) => x > 10).length / w.length)}%, Jul-Sep ${(wTe.reduce((a, x) => a + x - 10, 0)).toFixed(2)}`);
}
/** Quorum counted on `core` only; `extra` voters add to the buy/sell tally. Optional veto by a voter block. */
function decisions2(core: Voter[], extra: Voter[], vetoBlock?: Voter[], vetoNet = 2): Record<string, Decision[]> {
  const q = Math.ceil(core.length / 2), out: Record<string, Decision[]> = {};
  for (const s of SYMS) { const c = core.map((v) => aligned[v.tf][s][v.id]), e = extra.map((v) => aligned[v.tf][s][v.id]), vb = (vetoBlock ?? []).map((v) => aligned[v.tf][s][v.id]); const n = m30[s].t.length, a: Decision[] = new Array(n);
    for (let i = 0; i < n; i++) { let b = 0, se = 0, cv = 0; for (const x of c) { const y = x[i]; if (y > 0) { b++; cv++; } else if (y < 0) { se++; cv++; } } for (const x of e) { const y = x[i]; if (y > 0) b++; else if (y < 0) se++; }
      let d = cv >= q && b !== se ? Math.sign(b - se) : 0;
      if (d && vb.length) { let net = 0; for (const x of vb) net += x[i]; if (net * d <= -vetoNet) d = 0; }
      a[i] = { d, share: Math.max(b, se) / Math.max(1, b + se), buy: b, sell: se }; }
    out[s] = a; }
  return out;
}
function reportDec(name: string, n: number, dec: Record<string, Decision[]>) {
  const t: Tr[] = runPairs(dec, RULES); const sel = t.filter((x) => x.part === "sel").map((x) => x.pnl), te = t.filter((x) => x.part === "test").map((x) => x.pnl);
  const w = mons.map((s) => account(dec, MONDAY, s, s + 4 * 86_400_000 + 21 * H)); const wTe = mons.filter((s) => s >= Date.parse("2026-07-01")).map((s) => account(dec, MONDAY, s, s + 4 * 86_400_000 + 21 * H));
  const tot = w.reduce((a, x) => a + x - 10, 0);
  console.log(`${name.padEnd(44)} ${String(n).padStart(3)} | ${String(t.length).padStart(4)} trades  sel ${mean(sel).toFixed(3).padStart(6)}  test ${mean(te).toFixed(3).padStart(6)}  year $${t.reduce((a, x) => a + x.pnl, 0).toFixed(2).padStart(6)} | Mon-only: withdrawn ${(tot >= 0 ? "+" : "") + tot.toFixed(2)}, up ${Math.round(100 * w.filter((x) => x > 10).length / w.length)}%, Jul-Sep ${(wTe.reduce((a, x) => a + x - 10, 0)).toFixed(2)}`);
  return t;
}
console.log("electorate".padEnd(44), "  n |  per trade ($ per $1 stake) and year total               | owner's Monday-only $10 weeks (46)");
report("A  live 60 (40 quant + 20 technical)", LIVE);
report("B  40 live quant + 20 new quant (swap)", [...liveQ, ...nq.top]);
report("   40 live quant only", liveQ);
report("C  live 60 + 13 fundamental (kept)", [...LIVE, ...fundKept]);
report("D  swap 60 + 13 fundamental (kept)", [...liveQ, ...nq.top, ...fundKept]);
report("E  swap 60 + 40 fundamental (owner's 100)", [...liveQ, ...nq.top, ...fund40]);
report("F  live 60 + 40 fundamental", [...LIVE, ...fund40]);
report("G  40 fundamental only", fund40);
report("H  13 fundamental only", fundKept);

console.log("\nFundamentals that add to the tally but do not count toward the quorum, or veto:");
reportDec("I  live 60, + 13 fund in the tally", 73, decisions2(LIVE, fundKept));
reportDec("J  live 60, + 40 fund in the tally", 100, decisions2(LIVE, fund40));
reportDec("K  40 quant, + 13 fund in the tally", 53, decisions2(liveQ, fundKept));
reportDec("L  40 quant, + 40 fund in the tally", 80, decisions2(liveQ, fund40));
reportDec("M  live 60, 13 fund veto (net 2 against)", 60, decisions2(LIVE, [], fundKept, 2));
reportDec("N  live 60, 40 fund veto (net 3 against)", 60, decisions2(LIVE, [], fund40, 3));
reportDec("O  40 quant, 13 fund veto (net 2 against)", 40, decisions2(liveQ, [], fundKept, 2));
// greedy: from the 40 live quant, add the new quant voter that most improves the selection-months total, up to 20
console.log("\nNew quant voters chosen by what they add to the poll (selection months only):");
const pool = nq.rows.map((r: any) => ({ id: r.id, tf: r.tf })); let cur = [...liveQ]; const selTot = (vs: Voter[]) => runPairs(decisions(vs), RULES).filter((x) => x.part === "sel").reduce((a, x) => a + x.pnl, 0);
let base = selTot(cur);
for (let k = 0; k < 20; k++) { let best: Voter | null = null, bv = base; for (const v of pool) { if (cur.some((c) => c.id === v.id)) continue; const val = selTot([...cur, v]); if (val > bv) { bv = val; best = v; } } if (!best) break; cur = [...cur, best]; base = bv; process.stdout.write(`+${best.id}(${best.tf}) sel $${bv.toFixed(2)}  `); }
console.log();
report("P  40 quant + greedy new quant", cur);
