// $10 account with the live poll (every vote until one stake of free balance is left, 5% risk, live exits),
// followed bar by bar from a start at 07:00 UTC on every weekday (when the bot's trading hours begin).
// Balance = free cash + open positions at the current price (what Deriv shows).
// Reports the balance after 4h, 8h, 1 day ... 8 weeks, and how long it takes to first reach $20.
import { m30, SYMS, SPLIT, START, END, LIVE, decisions, simTrade, okTime, STOP } from "./book-lib.mts";
import { commissionBps } from "./cand-lib.mts";

const dec = decisions(LIVE);
const times = [...new Set(SYMS.flatMap((s) => m30[s].t))].sort((a, b) => a - b);
const idx: Record<string, Map<number, number>> = Object.fromEntries(SYMS.map((s) => [s, new Map(m30[s].t.map((t, i) => [t, i]))]));
const H = 3600_000, D = 24 * H;
const MARKS: [string, number][] = [["4 hours", 4 * H], ["8 hours", 8 * H], ["1 day", D], ["2 days", 2 * D], ["4 days", 4 * D], ["1 week", 7 * D], ["2 weeks", 14 * D], ["4 weeks", 28 * D], ["8 weeks", 56 * D]];
const MAXT = 56 * D;

function follow(from: number, eq0 = 10) {
  let cash = eq0; const open: { s: string; d: number; e0: number; j: number; pnl: number; st: number; comm: number }[] = [];
  const last: Record<string, number> = {}; const at: number[] = new Array(MARKS.length).fill(NaN); let hit20 = NaN, low = eq0, mi = 0;
  const equity = () => cash + open.reduce((a, p) => a + p.st + p.st * Math.max(-1, p.d * ((m30[p.s].c[last[p.s]] ?? p.e0) - p.e0) / p.e0 * 100 - p.comm), 0);
  for (const t of times) { if (t < from) continue; if (t >= from + MAXT || t >= END) break;
    while (mi < MARKS.length && t + 1800_000 > from + MARKS[mi][1]) at[mi++] = equity(); // balance just before this bar closes
    for (const s of SYMS) { const i = idx[s].get(t); if (i != null) last[s] = i; }
    for (let k = open.length - 1; k >= 0; k--) { const p = open[k]; if (idx[p.s].get(t) === p.j) { cash += p.st + p.st * p.pnl; open.splice(k, 1); } }
    for (const s of SYMS) { const i = idx[s].get(t); if (i == null || i + 1 >= m30[s].t.length) continue; const x = dec[s][i];
      if (!x.d || !okTime(t + 1800_000) || m30[s].t[i + 1] - t > 1800_000 || open.some((p) => p.s === s)) continue;
      const comm = commissionBps(m30[s].t[i + 1]) / 100, eq = cash + open.reduce((a, p) => a + p.st, 0);
      const st = Math.floor(Math.max(1, 0.05 * eq / (STOP * 100 + comm)) * 100) / 100;
      if (cash - st < st || st < 1) continue;
      const r = simTrade(s, i, x.d); if (!r) continue;
      cash -= st; open.push({ s, d: x.d, e0: m30[s].o[i + 1], j: r.j, pnl: r.pnl, st, comm }); }
    const e = equity(); low = Math.min(low, e); if (isNaN(hit20) && e >= 20) hit20 = t + 1800_000 - from; }
  while (mi < MARKS.length && from + MARKS[mi][1] <= Math.min(from + MAXT, END)) at[mi++] = equity();
  return { at, hit20, low };
}

const runs: { st: number; at: number[]; hit20: number; low: number }[] = [];
for (let d = START; d < END; d += D) { const dw = new Date(d).getUTCDay(); if (dw === 0 || dw === 6) continue; const st = d + 7 * H; runs.push({ st, ...follow(st) }); }
console.log(`== $10 from 07:00 UTC on every weekday (${runs.length} starts), balance incl. open positions ==`);
MARKS.forEach(([name, ms], k) => { const v = runs.filter((r) => r.st + ms <= END).map((r) => r.at[k]).sort((a, b) => a - b), n = v.length, q = (p: number) => v[Math.min(n - 1, Math.floor(p * n))];
  console.log(`${name.padEnd(9)} ${String(n).padStart(3)} starts | average $${(v.reduce((a, b) => a + b, 0) / n).toFixed(2)} | median $${q(0.5).toFixed(2)} | middle half $${q(0.25).toFixed(2)}-$${q(0.75).toFixed(2)} | up ${Math.round(100 * v.filter((x) => x > 10).length / n)}% | $20+ ${Math.round(100 * v.filter((x) => x >= 20).length / n)}% | under $5 ${Math.round(100 * v.filter((x) => x < 5).length / n)}% | worst $${v[0].toFixed(2)} | best $${v[n - 1].toFixed(2)}`); });

console.log("\n== When does $10 first reach $20? (only starts with the full 8 weeks of data after them) ==");
const full = runs.filter((r) => r.st + MAXT <= END), hits = full.filter((r) => !isNaN(r.hit20)).map((r) => r.hit20).sort((a, b) => a - b);
console.log(`${full.length} starts: reached $20 within 8 weeks in ${hits.length} (${Math.round(100 * hits.length / full.length)}%)`);
for (const [name, ms] of MARKS) console.log(`  by ${name.padEnd(9)} ${String(Math.round(100 * hits.filter((h) => h <= ms).length / full.length)).padStart(3)}% of starts`);
if (hits.length) console.log(`  when it did: fastest ${(hits[0] / D).toFixed(1)} days, median ${(hits[hits.length >> 1] / D).toFixed(1)} days, slowest ${(hits.at(-1)! / D).toFixed(1)} days`);
const lows = full.map((r) => r.low).sort((a, b) => a - b);
console.log(`  lowest balance along the way (8 weeks): median $${lows[lows.length >> 1].toFixed(2)}, under $5 at some point in ${Math.round(100 * lows.filter((x) => x < 5).length / full.length)}% of starts`);
console.log(`  test months only (starts from Jul): ${(() => { const f = full.filter((r) => r.st >= SPLIT); return `${f.length} starts, reached $20 in ${f.filter((r) => !isNaN(r.hit20)).length}`; })()}`);
