// Live rules, one position per pair, no capital limit: how long trades last, how they end, and what the vote's direction is worth at each horizon.
import { m30, SYMS, SPLIT, START, aligned, loadTF, commissionBps } from "./cand-lib.mts";
import { tallyPoll, POLL_TIMEFRAME, POLL_QUORUM, POLL_COST_ALLOWANCE } from "../../artifacts/api-server/src/lib/poll-engine.ts";
for (const tf of ["M30", "H1", "H4"]) loadTF(tf);
const ids = Object.keys(POLL_TIMEFRAME), RR = 1.5, HOLD = 192, STOP = 0.006;
const okTime = (ms: number) => { const d = new Date(ms), day = d.getUTCDay(), h = d.getUTCHours(); return day >= 1 && day <= 5 && h >= 7 && h < 21 && !(day === 5 && h >= 16); };
type R = { reason: string; hours: number; pnl: number; part: string; dirAt: Record<number, number>; mfeDay: number };
const out: R[] = []; const H = [24, 48, 72, 96];
for (const s of SYMS) {
  const b = m30[s], vs = ids.map((id) => aligned[POLL_TIMEFRAME[id]][s][id]);
  let busyUntil = -1;
  for (let i = 0; i + 1 < b.t.length; i++) {
    if (b.t[i] < START || i <= busyUntil) continue;
    const r = tallyPoll(vs.map((v) => v[i] as any), 0.5, POLL_QUORUM); const d = r.direction === "buy" ? 1 : r.direction === "sell" ? -1 : 0;
    if (!d || !okTime(b.t[i] + 1800_000) || b.t[i + 1] - b.t[i] > 1800_000) continue;
    const e0 = b.o[i + 1], comm = commissionBps(b.t[i + 1]) / 100, cost = POLL_COST_ALLOWANCE * e0;
    const sp = e0 * (1 - d * STOP), tp = e0 + d * (RR * STOP * e0 + (1 + RR) * cost);
    // direction-only, clean of stops: price change at +24/48/72/96 market hours (skip if past data end)
    const dirAt: Record<number, number> = {};
    for (const h of H) { const j = i + 1 + h * 2; if (j < b.t.length) dirAt[h] = d * (b.c[j] - e0) / e0 * 1e4; }
    let reason = "", px = 0, j = i + 1, best = -Infinity, bestJ = i + 1;
    for (; j < b.t.length; j++) {
      const t = b.t[j], dt = new Date(t), flat = dt.getUTCDay() === 5 && dt.getUTCHours() * 60 + dt.getUTCMinutes() >= 20 * 60 + 30;
      const fav = d > 0 ? b.h[j] : b.l[j]; const m = d * (fav - e0) / e0; if (m > best) { best = m; bestJ = j; }
      if (j > i + 1 && b.t[j] - b.t[j - 1] > 6 * 3600_000 && d * (b.o[j] - sp) <= 0) { px = b.o[j]; reason = "stop (gap)"; break; }
      if (d > 0 ? b.l[j] <= sp : b.h[j] >= sp) { px = sp; reason = "stop"; break; }
      if (d > 0 ? b.h[j] >= tp : b.l[j] <= tp) { px = tp; reason = "target"; break; }
      if (j - (i + 1) >= HOLD) { px = b.c[j]; reason = "4-day limit"; break; }
      if (flat) { px = b.c[j]; reason = "Friday close"; break; }
    }
    if (!reason) break;
    const pnl = Math.max(-0.8, d * (px - e0) / e0 * 100 - comm); // $ per $1 stake at x100
    out.push({ reason, hours: (b.t[j] - b.t[i + 1]) / 3600_000, pnl, part: b.t[i] < SPLIT ? "sel" : "test", dirAt, mfeDay: Math.floor((b.t[bestJ] - b.t[i + 1]) / 86_400_000) });
    busyUntil = j; // one per pair: next vote only after this one closes
  }
}
const f = (x: number, d = 2) => x.toFixed(d);
console.log("trades", out.length, "sel", out.filter((o) => o.part === "sel").length, "test", out.filter((o) => o.part === "test").length);
for (const part of ["sel", "test", "all"]) {
  const o = out.filter((x) => part === "all" || x.part === part);
  console.log(`\n== ${part}: n ${o.length}, win ${f(100 * o.filter((x) => x.pnl > 0).length / o.length, 1)}%, avg $${f(o.reduce((a, x) => a + x.pnl, 0) / o.length, 3)} per $1, median hold ${f([...o.map((x) => x.hours)].sort((a, b) => a - b)[o.length >> 1], 1)}h`);
  for (const r of ["target", "stop", "stop (gap)", "4-day limit", "Friday close"]) {
    const g = o.filter((x) => x.reason === r); if (!g.length) continue;
    const hs = g.map((x) => x.hours).sort((a, b) => a - b);
    console.log(`  ${r.padEnd(13)} ${f(100 * g.length / o.length, 1).padStart(5)}%  avg $${f(g.reduce((a, x) => a + x.pnl, 0) / g.length, 3).padStart(6)}  median ${f(hs[hs.length >> 1], 1)}h  win ${f(100 * g.filter((x) => x.pnl > 0).length / g.length, 0)}%`);
  }
  const byDay = [0, 1, 2, 3, 4].map((d) => o.filter((x) => Math.min(4, Math.floor(x.hours / 24)) === d));
  console.log("  closed in day 1..5:", byDay.map((g) => `${f(100 * g.length / o.length, 0)}%`).join(" "), "| targets by day:", [0, 1, 2, 3].map((d) => o.filter((x) => x.reason === "target" && Math.floor(x.hours / 24) === d).length).join("/"));
  console.log("  direction (no stop/target), right% / avg bps:", H.map((h) => { const v = o.map((x) => x.dirAt[h]).filter((x) => x != null) as number[]; return `${h}h ${f(100 * v.filter((x) => x > 0).length / v.length, 1)}% ${f(v.reduce((a, b) => a + b, 0) / v.length, 1)}bps`; }).join("  "));
}
