// Risk per trade under the weekly cycle (only binds once $1 is under the risk amount, i.e. above ~$12.40 at 5%).
import { LIVE, decisions } from "./book-lib.mts";
import { m30, START, END, LIVE_RULES, account, type Rules } from "./r-lib.mts";
const dec = decisions(LIVE), D = 86_400_000;
const dow = (s: string, i: number) => new Date(m30[s].t[i] + 1800_000).getUTCDay();
const until = (last: number): Rules => ({ ...LIVE_RULES, hold: 300, entry: (s, i) => dow(s, i) <= last });
const starts: number[] = []; for (let d = START; d < END; d += D) { const w = new Date(d).getUTCDay(); if (w >= 1 && w <= 5) starts.push(d + 7 * 3600_000); }
const firstMondays: number[] = []; for (let d = START; d < Date.parse("2026-07-01"); d += D) { const x = new Date(d); if (x.getUTCDay() === 1 && x.getUTCDate() <= 7) firstMondays.push(d + 7 * 3600_000); }
for (const [n, R] of [["Mon-Tue", until(2)], ["Mon only", until(1)]] as const) for (const risk of [0.03, 0.05, 0.07, 0.1]) {
  const e = starts.filter((s) => s + 84 * D <= END).map((s) => account(dec, R, s, s + 84 * D, { maxOpen: 4, risk })).sort((a, b) => a - b), k = e.length;
  console.log(`${n.padEnd(8)} max 4 risk ${(risk * 100).toFixed(0).padStart(2)}% | 12 weeks: median $${e[k >> 1].toFixed(2)} geo x${Math.exp(e.reduce((a, x) => a + Math.log(x / 10), 0) / k).toFixed(2)} <$5 ${Math.round(100 * e.filter((x) => x < 5).length / k)}% $20+ ${Math.round(100 * e.filter((x) => x >= 20).length / k)}% | year: ${firstMondays.map((s) => "$" + account(dec, R, s, END, { maxOpen: 4, risk }).toFixed(0)).join(" ")}`); }
