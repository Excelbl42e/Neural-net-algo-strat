// Why late-week entries lose, and whether "new trades only early in the week" holds up.
import { LIVE, decisions } from "./book-lib.mts";
import { m30, SYMS, SPLIT, START, END, LIVE_RULES, runPairs, runs, runLine, account, type Rules, type Tr } from "./r-lib.mts";
import { commissionBps } from "./cand-lib.mts";

const dec = decisions(LIVE);
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dow = (s: string, i: number) => new Date(m30[s].t[i] + 1800_000).getUTCDay();
const byDay = (t: Tr[]) => [1, 2, 3, 4, 5].map((d) => { const a = t.filter((x) => new Date(x.t0).getUTCDay() === d), s = a.filter((x) => x.part === "sel"), e = a.filter((x) => x.part === "test");
  return `${DOW[d]} ${mean(s.map((x) => x.pnl)).toFixed(3).padStart(6)}/${mean(e.map((x) => x.pnl)).toFixed(3).padStart(6)}`; }).join(" | ");

console.log("== avg $ per $1 trade by entry weekday (sel/test) ==");
console.log("live rules (Friday flatten)".padEnd(36), byDay(runPairs(dec, LIVE_RULES)));
console.log("weekend hold, 4 trading days".padEnd(36), byDay(runPairs(dec, { ...LIVE_RULES, friday: false })));
console.log("no stop/target, Friday flatten".padEnd(36), byDay(runPairs(dec, { ...LIVE_RULES, stop: 0.0099, rr: null })));

// The signal itself: direction value over the next 24h/48h/96h of trading (bars), ignoring the weekend, by entry weekday
console.log("\n== signal value: side x move over the next N trading hours, bps after commission, by entry weekday (sel/test) ==");
for (const hrs of [24, 48, 96]) { const acc: Record<number, { s: number[]; e: number[] }> = {};
  for (const s of SYMS) { const b = m30[s]; for (let i = 1; i + 1 + hrs * 2 < b.t.length; i += 2) { const x = dec[s][i]; if (!x.d || b.t[i] < START) continue; const d = dow(s, i); if (d < 1 || d > 5) continue;
    const e0 = b.o[i + 1], r = x.d * (b.c[i + hrs * 2] - e0) / e0 * 1e4 - commissionBps(b.t[i + 1]); const o = (acc[d] ??= { s: [], e: [] }); (b.t[i] < SPLIT ? o.s : o.e).push(r); } }
  console.log(`${hrs}h`.padEnd(6), [1, 2, 3, 4, 5].map((d) => `${DOW[d]} ${mean(acc[d].s).toFixed(1).padStart(5)}/${mean(acc[d].e).toFixed(1).padStart(5)}`).join(" | ")); }

console.log("\n== cutoffs by month: total $ per month (live | Mon-Tue only | Mon-Wed only) ==");
const cut = (last: number): Rules => ({ ...LIVE_RULES, entry: (s, i) => dow(s, i) <= last });
const L = runPairs(dec, LIVE_RULES), T2 = runPairs(dec, cut(2)), T3 = runPairs(dec, cut(3));
const months = [...new Set(L.map((x) => new Date(x.t0).toISOString().slice(0, 7)))].sort();
let w2 = 0, w3 = 0;
for (const m of months) { const f = (t: Tr[]) => t.filter((x) => new Date(x.t0).toISOString().slice(0, 7) === m).reduce((a, x) => a + x.pnl, 0); const a = f(L), b = f(T2), c = f(T3); if (b > a) w2++; if (c > a) w3++;
  console.log(m, a.toFixed(2).padStart(6), b.toFixed(2).padStart(6), c.toFixed(2).padStart(6)); }
console.log(`Mon-Tue better in ${w2}/${months.length} months, Mon-Wed better in ${w3}/${months.length}`);
// random-day null: drop the same share of trades at random (by day) many times
let rng = 7; const rand = () => ((rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648);
const days = [...new Set(L.map((x) => Math.floor(x.t0 / 86_400_000)))]; const keepShare = T2.length / L.length; let better = 0;
for (let r = 0; r < 2000; r++) { const keep = new Set(days.filter(() => rand() < keepShare)); const tot = L.filter((x) => keep.has(Math.floor(x.t0 / 86_400_000))).reduce((a, x) => a + x.pnl, 0); if (tot >= T2.reduce((a, x) => a + x.pnl, 0)) better++; }
console.log(`random whole days kept at the same rate beat Mon-Tue's total in ${(100 * better / 2000).toFixed(1)}% of 2,000 draws (note: the live trades it samples from already include the Friday cut)`);

console.log("\n== $10 account, every vote until one stake left, balance incl. open positions ==");
const sets: [string, Rules][] = [["live", LIVE_RULES], ["new trades Mon-Tue only", cut(2)], ["new trades Mon-Wed only", cut(3)], ["new trades Mon only", cut(1)]];
for (const [name, R] of sets) for (const d of [5, 12, 26]) console.log(name.padEnd(26), String(d).padStart(2), "days:", runLine(runs(dec, R, d)));
console.log("\nweekly (Mon 00:00 -> Sat 00:00), sel / test starts:");
for (const [name, R] of sets) for (const part of ["sel", "test"] as const) console.log(name.padEnd(26), part.padEnd(4), runLine(runs(dec, R, 5, {}, part)));
// one continuous run over the whole year (compounding, no reset)
console.log("\nwhole year from $10 (Nov 10 -> Oct 1, no reset):", sets.map(([n, R]) => `${n} $${account(dec, R, START, END).toFixed(2)}`).join(" | "));
