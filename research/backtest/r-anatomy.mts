// Where the live poll makes and loses money: live rules, one position per pair (1,041 trades).
// Split by entry hour, weekday, pair, side, exit reason, vote share; sel = Nov-Jun, test = Jul-Sep.
import { m30, LIVE, decisions, runPairs, type Trade } from "./book-lib.mts";

const t = runPairs(decisions(LIVE));
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
function table(name: string, key: (x: Trade) => string, order?: string[]) {
  const g = new Map<string, Trade[]>(); for (const x of t) { const k = key(x); (g.get(k) ?? g.set(k, []).get(k)!).push(x); }
  console.log(`\n== by ${name} ==`);
  for (const k of order ?? [...g.keys()].sort()) { const a = g.get(k); if (!a) continue; const s = a.filter((x) => x.part === "sel"), e = a.filter((x) => x.part === "test");
    console.log(`${k.padEnd(12)} n ${String(a.length).padStart(4)} | sel ${String(s.length).padStart(3)} avg ${mean(s.map((x) => x.pnl)).toFixed(3).padStart(6)} | test ${String(e.length).padStart(3)} avg ${mean(e.map((x) => x.pnl)).toFixed(3).padStart(6)} | total $${a.reduce((p, x) => p + x.pnl, 0).toFixed(2).padStart(6)} | win ${(100 * a.filter((x) => x.pnl > 0).length / a.length).toFixed(0)}%`); }
}
table("entry hour (UTC)", (x) => String(new Date(x.t0).getUTCHours()).padStart(2, "0"));
table("weekday", (x) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(x.t0).getUTCDay()], ["Mon", "Tue", "Wed", "Thu", "Fri"]);
table("pair", (x) => x.s.slice(3));
table("side", (x) => (x.d > 0 ? "buy" : "sell"));
table("exit", (x) => x.reason);
table("vote share", (x) => (x.dec.share < 0.6 ? "50-60%" : x.dec.share < 0.7 ? "60-70%" : x.dec.share < 0.8 ? "70-80%" : "80%+"));
table("voters with an opinion", (x) => { const n = x.dec.buy + x.dec.sell; return n < 35 ? "30-34" : n < 40 ? "35-39" : n < 45 ? "40-44" : "45+"; });
table("month", (x) => new Date(x.t0).toISOString().slice(0, 7));
// how far trades go: max favourable / adverse excursion within the hold, in % of price
const mfe: number[] = [], mae: number[] = [];
for (const x of t) { const b = m30[x.s], e0 = b.o[x.i + 1]; let up = 0, dn = 0; for (let j = x.i + 1; j <= x.j; j++) { up = Math.max(up, x.d * ((x.d > 0 ? b.h[j] : b.l[j]) - e0) / e0 * 100); dn = Math.min(dn, x.d * ((x.d > 0 ? b.l[j] : b.h[j]) - e0) / e0 * 100); } mfe.push(up); mae.push(dn); }
const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.floor(p * a.length)];
console.log(`\nbest move in favour during the trade (% of price): median ${q(mfe, 0.5).toFixed(2)}, 75th pct ${q(mfe, 0.75).toFixed(2)}; worst move against: median ${q(mae, 0.5).toFixed(2)}, 25th pct ${q(mae, 0.25).toFixed(2)}`);
console.log(`stopped trades that had first been +0.3% or more in favour: ${t.filter((x, k) => x.reason === "stop" && mfe[k] >= 0.3).length} of ${t.filter((x) => x.reason === "stop").length}`);
