// Exit and timing rules, one at a time against the live poll. Per trade (one position per pair):
// $ per $1 stake and % of equity at 5% risk, Nov-Jun (sel) and Jul-Sep (test).
import { LIVE, decisions } from "./book-lib.mts";
import { m30, LIVE_RULES, runPairs, sumLine, type Rules } from "./r-lib.mts";

const dec = decisions(LIVE);
const show = (name: string, R: Rules) => console.log(name.padEnd(40), sumLine(runPairs(dec, R)));
console.log("== check: live rules (should be 1,041 trades, $18.01) ==");
show("live", LIVE_RULES);

console.log("\n== 1. stop x target (stop <= 0.78% at x100) ==");
for (const stop of [0.004, 0.005, 0.006, 0.007, 0.0078]) for (const rr of [1, 1.5, 2, 3, null]) show(`stop ${(stop * 100).toFixed(2)}% target ${rr ?? "none"}`, { ...LIVE_RULES, stop, rr });

console.log("\n== 2. stop to break-even after a move in favour ==");
for (const be of [0.002, 0.003, 0.004, 0.005, 0.006]) show(`break-even after +${(be * 100).toFixed(1)}%`, { ...LIVE_RULES, be });

console.log("\n== 3. trailing stop ==");
for (const a of [0.003, 0.005]) for (const d of [0.003, 0.005, 0.006]) show(`trail ${(d * 100).toFixed(1)}% after +${(a * 100).toFixed(1)}%`, { ...LIVE_RULES, trail: [a, d] });
for (const a of [0.003, 0.005]) for (const d of [0.003, 0.005]) show(`trail ${(d * 100).toFixed(1)}% after +${(a * 100).toFixed(1)}%, no target`, { ...LIVE_RULES, rr: null, trail: [a, d] });

console.log("\n== 4. last day for new entries / time left before the Friday close ==");
const dow = (s: string, i: number) => new Date(m30[s].t[i] + 1800_000).getUTCDay();
const hoursToFri = (s: string, i: number) => { const t = m30[s].t[i] + 1800_000, d = new Date(t); const fri = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7), 20, 30); return (fri - t) / 3600_000; };
for (const last of [1, 2, 3, 4]) show(`entries Mon..${["", "Mon", "Tue", "Wed", "Thu"][last]} only`, { ...LIVE_RULES, entry: (s, i) => dow(s, i) <= last });
for (const h of [24, 48, 72, 96]) show(`entries only with ${h}h+ before Fri close`, { ...LIVE_RULES, entry: (s, i) => hoursToFri(s, i) >= h });

console.log("\n== 5. hold through the weekend (no Friday flatten; Monday gaps fill at the open, loss capped at the stake) ==");
for (const hold of [192, 240, 288]) show(`weekend hold, ${hold / 48} trading days`, { ...LIVE_RULES, friday: false, hold });
show("weekend hold, no target, 4 days", { ...LIVE_RULES, friday: false, rr: null });

console.log("\n== 6. skip quiet markets: pair's 20-day average daily range below x% ==");
const adr: Record<string, Float64Array> = {};
for (const s of Object.keys(m30)) { const b = m30[s], n = b.t.length, a = new Float64Array(n); let v = 0;
  for (let i = 1; i < n; i++) { const tr = Math.max(b.h[i] - b.l[i], Math.abs(b.h[i] - b.c[i - 1]), Math.abs(b.l[i] - b.c[i - 1])) / b.c[i]; v = i < 50 ? tr : v + (tr - v) / 960; a[i] = v * 48 * 0.6; } adr[s] = a; } // M30 true range x 48 x 0.6 ~ daily range
for (const x of [0.004, 0.005, 0.006, 0.007, 0.008]) show(`skip if daily range < ${(x * 100).toFixed(1)}%`, { ...LIVE_RULES, entry: (s, i) => adr[s][i] >= x });
const med = (s: string) => { const a = [...adr[s].slice(2000)].sort((p, q) => p - q); return a[a.length >> 1]; };
console.log("typical daily range by pair:", Object.keys(m30).map((s) => `${s.slice(3)} ${(100 * med(s)).toFixed(2)}%`).join(", "));
