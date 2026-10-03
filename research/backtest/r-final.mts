// The combined candidate ("weekly cycle") against the live setup, and its neighbours.
//   live:          every majority vote 07-21 UTC Mon-Fri (Fri until 16:00), until one stake is left; 4-day hold
//   weekly cycle:  new trades only Mon-Tue 07-21 UTC, at most 4 open, held until the Friday 20:30 close
//                  (or stop 0.6% / target 1.5x); everything else as live
// $10 account, balance including open positions; runs from 07:00 UTC on every weekday.
import { LIVE, decisions } from "./book-lib.mts";
import { m30, START, END, SPLIT, LIVE_RULES, runPairs, sumLine, account, type Rules, type Acct } from "./r-lib.mts";

const dec = decisions(LIVE);
const dow = (s: string, i: number) => new Date(m30[s].t[i] + 1800_000).getUTCDay();
const until = (last: number, hold = 300): Rules => ({ ...LIVE_RULES, hold, entry: (s, i) => dow(s, i) <= last });
const C: [string, Rules, Acct][] = [
  ["live (now)", LIVE_RULES, {}],
  ["live + max 4 open", LIVE_RULES, { maxOpen: 4 }],
  ["Mon-Tue, 4-day hold, max 4", until(2, 192), { maxOpen: 4 }],
  ["WEEKLY: Mon-Tue, to Friday, max 4", until(2), { maxOpen: 4 }],
  ["Mon-Tue, to Friday, max 3", until(2), { maxOpen: 3 }],
  ["Mon-Tue, to Friday, max 5", until(2), { maxOpen: 5 }],
  ["Mon-Tue, to Friday, every vote", until(2), {}],
  ["Mon only, to Friday, max 4", until(1), { maxOpen: 4 }],
  ["Mon-Wed, to Friday, max 4", until(3), { maxOpen: 4 }],
];
console.log("== per trade, one position per pair ==");
for (const [n, R] of C.filter((_, k) => [0, 2, 3, 7, 8].includes(k))) console.log(n.padEnd(36), sumLine(runPairs(dec, R)));

const D = 86_400_000, H = 3600_000;
const starts: number[] = []; for (let d = START; d < END; d += D) { const w = new Date(d).getUTCDay(); if (w >= 1 && w <= 5) starts.push(d + 7 * H); }
const MARKS: [string, number][] = [["1 day", D], ["4 days", 4 * D], ["1 week", 7 * D], ["2 weeks", 14 * D], ["4 weeks", 28 * D], ["8 weeks", 56 * D], ["12 weeks", 84 * D]];
console.log("\n== $10 after N days (median / geometric mean / share up / share under $5 / share $20+) ==");
for (const [n, R, A] of C) { const cells = MARKS.map(([m, ms]) => { const e = starts.filter((s) => s + ms <= END).map((s) => account(dec, R, s, s + ms, A)).sort((a, b) => a - b), k = e.length;
    return `${m}: $${e[k >> 1].toFixed(2)} x${Math.exp(e.reduce((a, x) => a + Math.log(Math.max(x, 0.01) / 10), 0) / k).toFixed(2)} ${Math.round(100 * e.filter((x) => x > 10).length / k)}%up ${Math.round(100 * e.filter((x) => x < 5).length / k)}%<5 ${Math.round(100 * e.filter((x) => x >= 20).length / k)}%20+`; });
  console.log(`${n}\n   ${cells.slice(0, 4).join(" | ")}\n   ${cells.slice(4).join(" | ")}`); }

console.log("\n== whole rest of the year from $10, no reset (start: first Monday of each month Nov-Jun) ==");
const firstMondays: number[] = []; for (let d = START; d < SPLIT; d += D) { const x = new Date(d); if (x.getUTCDay() === 1 && x.getUTCDate() <= 7) firstMondays.push(d + 7 * H); }
for (const [n, R, A] of C) console.log(n.padEnd(36), firstMondays.map((s) => `${new Date(s).toISOString().slice(2, 7)} $${account(dec, R, s, END, A).toFixed(0)}`).join("  "));

console.log("\n== 8-week runs, starts Nov-Jun (selection) vs Jul-Aug (test months) ==");
for (const [n, R, A] of C) { const f = (ss: number[]) => { const e = ss.map((s) => account(dec, R, s, s + 56 * D, A)).sort((a, b) => a - b), k = e.length; return `n ${k} median $${e[k >> 1].toFixed(2)} geo x${Math.exp(e.reduce((a, x) => a + Math.log(Math.max(x, 0.01) / 10), 0) / k).toFixed(2)} up ${Math.round(100 * e.filter((x) => x > 10).length / k)}%`; };
  const ok = starts.filter((s) => s + 56 * D <= END); console.log(n.padEnd(36), "sel:", f(ok.filter((s) => s < SPLIT)), "| test:", f(ok.filter((s) => s >= SPLIT))); }
