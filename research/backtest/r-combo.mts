// Weekly cycle (Mon-Tue entries, to Friday, max 4 open) with the COT veto and/or the fluid_reynolds voter.
// Per trade, then the $10 account: 12-week runs from every weekday (scan order and random order pooled),
// rest-of-year runs, and split by start half.
import { LIVE, decisions } from "./book-lib.mts";
import { m30, START, END, SPLIT, LIVE_RULES, runPairs, sumLine, account, type Rules, type Acct } from "./r-lib.mts";
import { cotFade, installFluid } from "./r-extra.mts";

installFluid(2);
const dow = (s: string, i: number) => new Date(m30[s].t[i] + 1800_000).getUTCDay();
const WKR: Rules = { ...LIVE_RULES, hold: 300, entry: (s, i) => dow(s, i) <= 2 };
const VETO: Rules = { ...WKR, entry: (s, i, x) => dow(s, i) <= 2 && cotFade(s, m30[s].t[i] + 1800_000) !== -x.d };
const d60 = decisions(LIVE), d61 = decisions([...LIVE, { id: "fluid_reynolds", tf: "M30" }]);
const C: [string, any, Rules][] = [["weekly cycle", d60, WKR], ["+ COT veto", d60, VETO], ["+ fluid voter", d61, WKR], ["+ COT veto + fluid voter", d61, VETO]];
console.log("== per trade ==");
for (const [n, d, R] of C) console.log(n.padEnd(28), sumLine(runPairs(d, R)));
const D = 86_400_000; const st: number[] = []; for (let x = START; x + 84 * D <= END; x += D) { const w = new Date(x).getUTCDay(); if (w >= 1 && w <= 5) st.push(x + 7 * 3600_000); }
const fm: number[] = []; for (let x = START; x < SPLIT; x += D) { const y = new Date(x); if (y.getUTCDay() === 1 && y.getUTCDate() <= 7) fm.push(x + 7 * 3600_000); }
const line = (e: number[]) => { e.sort((a, b) => a - b); const k = e.length; return `median $${e[k >> 1].toFixed(2)} geo x${Math.exp(e.reduce((a, x) => a + Math.log(x / 10), 0) / k).toFixed(2)} <$5 ${Math.round(100 * e.filter((x) => x < 5).length / k)}% $20+ ${Math.round(100 * e.filter((x) => x >= 20).length / k)}%`; };
console.log("\n== $10, 12-week runs, max 4 open ==");
for (const [n, d, R] of C) {
  const A: Acct = { maxOpen: 4 }; const e = st.map((s) => account(d, R, s, s + 84 * D, A));
  const pool: number[] = []; for (let seed = 1; seed <= 5; seed++) { let r = seed * 7919; const rnd = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648);
    pool.push(...st.map((s) => account(d, R, s, s + 84 * D, { maxOpen: 4, order: (c) => c.map((x) => [rnd(), x] as const).sort((a, b) => a[0] - b[0]).map((z) => z[1]) }))); }
  console.log(`${n.padEnd(28)} scan order: ${line(e)} | random order: ${line(pool)}`);
  console.log(`${"".padEnd(28)} starts Nov-Mar: ${line(st.filter((s) => s < Date.parse("2026-04-01")).map((s) => account(d, R, s, s + 84 * D, A)))} | starts Apr-Jul: ${line(st.filter((s) => s >= Date.parse("2026-04-01")).map((s) => account(d, R, s, s + 84 * D, A)))}`);
  console.log(`${"".padEnd(28)} rest of year from 1st Mondays: ${fm.map((s) => "$" + account(d, R, s, END, A).toFixed(0)).join(" ")}`); }
