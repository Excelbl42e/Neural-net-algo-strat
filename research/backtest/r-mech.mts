// Mechanism check for the weekday effect: per-trade result by hours left until the Friday 20:30 close at entry.
import { LIVE, decisions } from "./book-lib.mts";
import { LIVE_RULES, runPairs } from "./r-lib.mts";
const t = runPairs(decisions(LIVE), LIVE_RULES);
const left = (ms: number) => { const d = new Date(ms); const fri = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7), 20, 30); return (fri - ms) / 3600_000; };
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
for (const [a, b] of [[96, 200], [84, 96], [72, 84], [60, 72], [48, 60], [36, 48], [24, 36], [0, 24]]) {
  const g = t.filter((x) => left(x.t0) >= a && left(x.t0) < b), s = g.filter((x) => x.part === "sel"), e = g.filter((x) => x.part === "test");
  console.log(`${String(a).padStart(3)}-${String(b).padStart(3)}h left: n ${String(g.length).padStart(3)} sel ${mean(s.map((x) => x.pnl)).toFixed(3).padStart(6)} test ${mean(e.map((x) => x.pnl)).toFixed(3).padStart(6)} | ended at Friday close ${Math.round(100 * g.filter((x) => x.reason === "friday").length / g.length)}%`); }
