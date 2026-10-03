// $10 account over 4-day windows with the live poll (every vote until one stake of free balance is left,
// 5% risk, 0.6% stop, 1.5x target, 4-day hold, Friday close). Unlike book-lib's account(), positions still
// open at the end of the window are valued at that moment's price (what Deriv would show), not at their
// eventual exit. Windows start at 00:00 UTC on every weekday; Monday starts are also shown alone.
import { m30, SYMS, SPLIT, START, END, LIVE, decisions, simTrade, okTime, STOP } from "./book-lib.mts";
import { commissionBps } from "./cand-lib.mts";

const dec = decisions(LIVE);
const times = [...new Set(SYMS.flatMap((s) => m30[s].t))].sort((a, b) => a - b);
const idx: Record<string, Map<number, number>> = Object.fromEntries(SYMS.map((s) => [s, new Map(m30[s].t.map((t, i) => [t, i]))]));
const lastIdx = (s: string, t: number) => { const a = m30[s].t; let lo = 0, hi = a.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (a[m] < t) lo = m; else hi = m - 1; } return lo; };

function run(from: number, to: number, eq0 = 10) {
  let cash = eq0, trades = 0; const open: { s: string; d: number; i0: number; j: number; pnl: number; st: number; comm: number }[] = [];
  for (const t of times) { if (t < from || t >= to) continue;
    for (let k = open.length - 1; k >= 0; k--) { const p = open[k]; if (idx[p.s].get(t) === p.j) { cash += p.st + p.st * p.pnl; open.splice(k, 1); } }
    for (const s of SYMS) { const i = idx[s].get(t); if (i == null || i + 1 >= m30[s].t.length) continue; const x = dec[s][i];
      if (!x.d || !okTime(t + 1800_000) || m30[s].t[i + 1] - t > 1800_000 || open.some((p) => p.s === s)) continue;
      const comm = commissionBps(m30[s].t[i + 1]) / 100, eq = cash + open.reduce((a, p) => a + p.st, 0);
      const st = Math.floor(Math.max(1, 0.05 * eq / (STOP * 100 + comm)) * 100) / 100;
      if (cash - st < st || st < 1) continue;
      const r = simTrade(s, i, x.d); if (!r) continue;
      cash -= st; trades++; open.push({ s, d: x.d, i0: i, j: r.j, pnl: r.pnl, st, comm }); } }
  // value what is still open at the last closed M30 bar before `to`
  let openVal = 0;
  for (const p of open) { const b = m30[p.s], k = lastIdx(p.s, to - 1800_000 + 1), e0 = b.o[p.i0 + 1];
    const pnl = Math.max(-1, p.d * (b.c[k] - e0) / e0 * 100 - p.comm); openVal += p.st + p.st * pnl; }
  return { bal: cash + openVal, trades, stillOpen: open.length };
}

const W = 4 * 86_400_000, all: { st: number; bal: number; trades: number; stillOpen: number }[] = [];
for (let st = START; st + W <= END; st += 86_400_000) { const dw = new Date(st).getUTCDay(); if (dw === 0 || dw === 6) continue; all.push({ st, ...run(st, st + W) }); }
const report = (name: string, a: typeof all) => { const b = a.map((x) => x.bal).sort((x, y) => x - y), n = b.length, q = (p: number) => b[Math.min(n - 1, Math.floor(p * n))];
  const pct = (f: (x: number) => boolean) => `${Math.round(100 * b.filter(f).length / n)}%`;
  console.log(`${name.padEnd(30)} ${String(n).padStart(3)} windows | average $${(b.reduce((x, y) => x + y, 0) / n).toFixed(2)} | median $${q(0.5).toFixed(2)} | middle half $${q(0.25).toFixed(2)}-$${q(0.75).toFixed(2)} | up ${pct((x) => x > 10)} | $12+ ${pct((x) => x >= 12)} | under $8 ${pct((x) => x < 8)} | worst $${b[0].toFixed(2)} | best $${b[n - 1].toFixed(2)} | trades avg ${(a.reduce((x, y) => x + y.trades, 0) / n).toFixed(1)}, open at end avg ${(a.reduce((x, y) => x + y.stillOpen, 0) / n).toFixed(1)}`); };
console.log("== $10 after 4 days, live poll, open positions valued at day 4 ==");
report("every weekday start", all);
report("Monday starts (Mon-Fri 00:00)", all.filter((x) => new Date(x.st).getUTCDay() === 1));
report("  selection months (Nov-Jun)", all.filter((x) => x.st < SPLIT));
report("  test months (Jul-Sep)", all.filter((x) => x.st >= SPLIT));
console.log("\nMonday starts one by one:", all.filter((x) => new Date(x.st).getUTCDay() === 1).map((x) => `${new Date(x.st).toISOString().slice(5, 10)} $${x.bal.toFixed(2)}`).join(", "));

// the full trading week: Monday 00:00 to Saturday 00:00, after the Friday 20:30 close, so nothing is open
const wk: typeof all = []; for (let st = START; st + 5 * 86_400_000 <= END; st += 86_400_000) if (new Date(st).getUTCDay() === 1) wk.push({ st, ...run(st, st + 5 * 86_400_000) });
console.log("");
report("Monday to Friday close", wk);
