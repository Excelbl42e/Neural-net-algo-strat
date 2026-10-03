// Account-level rules with the live poll: how many positions may be open at once, the risk per trade,
// and the early-week entry cutoff, judged on long runs (the per-trade edge is small, so the account rules
// decide whether $10 grows). Balance includes open positions at the current price.
import { LIVE, decisions } from "./book-lib.mts";
import { m30, START, END, LIVE_RULES, runs, account, type Rules, type Acct } from "./r-lib.mts";

const dec = decisions(LIVE);
const dow = (s: string, i: number) => new Date(m30[s].t[i] + 1800_000).getUTCDay();
const cut = (last: number): Rules => ({ ...LIVE_RULES, entry: (s, i) => dow(s, i) <= last });
const RULES: [string, Rules][] = [["all days", LIVE_RULES], ["Mon-Tue", cut(2)], ["Mon only", cut(1)]];
const ACCTS: [string, Acct][] = [["every vote (now)", {}], ["max 6 open", { maxOpen: 6 }], ["max 4 open", { maxOpen: 4 }], ["max 3 open", { maxOpen: 3 }], ["max 2 open", { maxOpen: 2 }]];
const stat = (e: number[]) => { const n = e.length; return `avg $${(e.reduce((a, b) => a + b, 0) / n).toFixed(2).padStart(5)} med $${e[n >> 1].toFixed(2).padStart(5)} up ${String(Math.round(100 * e.filter((x) => x > 10).length / n)).padStart(3)}% <$5 ${String(Math.round(100 * e.filter((x) => x < 5).length / n)).padStart(2)}% worst $${e[0].toFixed(2)}`; };

// whole-year paths from 8 different starting Mondays in the first two months (no reset)
const starts: number[] = []; for (let t = START; starts.length < 8; t += 86_400_000) if (new Date(t).getUTCDay() === 1) starts.push(t);
console.log("== $10 runs: 26 days (every Monday start) | 12 weeks (every Monday start with 12 weeks of data) | rest-of-year from 8 starts ==");
for (const [rn, R] of RULES) for (const [an, A] of ACCTS) {
  const r26 = runs(dec, R, 26, A), r84 = runs(dec, R, 84, A), yr = starts.map((s) => account(dec, R, s, END, A)).sort((a, b) => a - b);
  console.log(`${rn.padEnd(9)} ${an.padEnd(17)} | 26d ${stat(r26)} | 12w ${stat(r84)} | year ${yr.map((x) => x.toFixed(0)).join(",")}`);
}
console.log("\n== risk per trade (only matters once the balance is above ~$12.40, where $1 is under 5%) ==");
for (const [rn, R] of RULES.slice(0, 2)) for (const risk of [0.03, 0.05, 0.08, 0.12]) for (const [an, A] of [ACCTS[0], ACCTS[3]]) {
  const a = { ...A, risk }; const r84 = runs(dec, R, 84, a), yr = starts.map((s) => account(dec, R, s, END, a)).sort((x, y) => x - y);
  console.log(`${rn.padEnd(9)} risk ${(risk * 100).toFixed(0).padStart(2)}% ${an.padEnd(17)} | 12w ${stat(r84)} | year ${yr.map((x) => x.toFixed(0)).join(",")}`); }
