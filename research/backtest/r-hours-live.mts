// The live bot's entry hours depend on the "killzones" setting: blank (the default) = every open-market
// hour (Mon 00:00 .. Fri 16:00 UTC); "london,newyork" = 07:00-21:00 UTC, which is what every backtest used.
import { LIVE, decisions } from "./book-lib.mts";
import { m30, START, END, SPLIT, LIVE_RULES, runPairs, sumLine, account, type Rules } from "./r-lib.mts";
import { cotFade } from "./r-extra.mts";
const dec = decisions(LIVE), D = 86_400_000;
const hours = (from: number, to: number) => (ms: number) => { const d = new Date(ms), day = d.getUTCDay(), h = d.getUTCHours(); return day >= 1 && day <= 5 && h >= from && h < to && !(day === 5 && h >= 16); };
const veto = (s: string, i: number, x: { d: number }) => cotFade(s, m30[s].t[i] + 1800_000) !== -x.d;
const mons: number[] = []; for (let d = START; d + 5 * D <= END; d += D) if (new Date(d).getUTCDay() === 1) mons.push(d);
for (const [n, R] of [["07-21 UTC (backtests)", { ...LIVE_RULES, entry: veto }], ["all hours (blank killzones)", { ...LIVE_RULES, entry: veto, ok: hours(0, 24) }], ["asian,london,newyork 00-21", { ...LIVE_RULES, entry: veto, ok: hours(0, 21) }]] as [string, Rules][]) {
  const w = mons.map((s) => account(dec, R, s, s + 4 * D + 21 * 3600_000) - 10);
  console.log(n.padEnd(30), sumLine(runPairs(dec, R)), `| $10 Mon->Fri, 46 weeks withdrawn: ${w.reduce((a, b) => a + b, 0) >= 0 ? "+" : ""}$${w.reduce((a, b) => a + b, 0).toFixed(2)}, weeks up ${Math.round(100 * w.filter((x) => x > 0).length / w.length)}%`);
}
