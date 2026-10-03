// Account rules again, with less noise: 8-week runs starting at 07:00 UTC on EVERY weekday (not just
// Mondays), from $10 and from $25. Reports the median end, the geometric-mean growth (what compounding
// actually delivers), and how often the account falls under half. Also split by start half-year.
import { LIVE, decisions } from "./book-lib.mts";
import { m30, START, END, SPLIT, LIVE_RULES, account, type Rules, type Acct } from "./r-lib.mts";

const dec = decisions(LIVE);
const dow = (s: string, i: number) => new Date(m30[s].t[i] + 1800_000).getUTCDay();
const cut = (last: number): Rules => ({ ...LIVE_RULES, entry: (s, i) => dow(s, i) <= last });
const RULES: [string, Rules][] = [["all days", LIVE_RULES], ["Mon-Wed", cut(3)], ["Mon-Tue", cut(2)], ["Mon only", cut(1)]];
const CAPS: [string, Acct][] = [["every vote", {}], ["max 8", { maxOpen: 8 }], ["max 6", { maxOpen: 6 }], ["max 5", { maxOpen: 5 }], ["max 4", { maxOpen: 4 }], ["max 3", { maxOpen: 3 }], ["max 2", { maxOpen: 2 }]];
const W = 56 * 86_400_000;
const startsAll: number[] = []; for (let d = START; d + W <= END; d += 86_400_000) { const w = new Date(d).getUTCDay(); if (w >= 1 && w <= 5) startsAll.push(d + 7 * 3600_000); }
function line(R: Rules, A: Acct, eq0: number, starts: number[]) {
  const e = starts.map((s) => account(dec, R, s, s + W, A, eq0)).sort((a, b) => a - b), n = e.length;
  const geo = Math.exp(e.reduce((a, x) => a + Math.log(Math.max(x, 0.01) / eq0), 0) / n);
  return `med ${(e[n >> 1] / eq0).toFixed(2)}x geo ${geo.toFixed(2)}x up ${String(Math.round(100 * e.filter((x) => x > eq0).length / n)).padStart(3)}% <half ${String(Math.round(100 * e.filter((x) => x < eq0 / 2).length / n)).padStart(2)}% 2x+ ${String(Math.round(100 * e.filter((x) => x >= 2 * eq0).length / n)).padStart(2)}%`;
}
console.log(`== 8-week runs from every weekday 07:00 UTC (${startsAll.length} starts; ends shown as multiples of the start) ==`);
for (const eq0 of [10, 25]) { console.log(`\n-- start $${eq0} --`);
  for (const [rn, R] of RULES) for (const [cn, A] of CAPS) console.log(`${rn.padEnd(9)} ${cn.padEnd(11)} all: ${line(R, A, eq0, startsAll)} | starts Nov-Mar: ${line(R, A, eq0, startsAll.filter((s) => s < Date.parse("2026-04-01")))} | starts Apr-Aug: ${line(R, A, eq0, startsAll.filter((s) => s >= Date.parse("2026-04-01")))}`); }
