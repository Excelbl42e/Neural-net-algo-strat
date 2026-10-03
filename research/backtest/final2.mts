import { m30, SYMS, SPLIT, START, aligned, loadTF, commissionBps, canOpen } from "./cand-lib.mts";
import { tallyPoll, pollLevels, POLL_TIMEFRAME, POLL_QUORUM, POLL_HOLD_HOURS } from "../../artifacts/api-server/src/lib/poll-engine.ts";
import { atrSeries } from "../../artifacts/api-server/src/lib/poll-strategies.ts";
for (const tf of ["M30", "H1", "H4"]) loadTF(tf);
const ids = Object.keys(POLL_TIMEFRAME), RR = +(process.env.RR ?? 1.5), HOLD = POLL_HOLD_HOURS * 2, STOPF = process.env.STOPF ? +process.env.STOPF : null;
const atr: Record<string, number[]> = Object.fromEntries(SYMS.map((s) => [s, atrSeries(m30[s] as any, 14)]));
type T = { s: string; d: number; at: number; exitAt: number; usd: number; risk: number; out: string };
function trade(s: string, i: number, d: 1 | -1, stake: number): T | null {
  const b = m30[s], lv0 = pollLevels(d > 0 ? "buy" : "sell", b.c[i], atr[s][i], RR), e0 = b.o[i + 1];
  let lv = lv0;
  if (STOPF != null) { const band = lv0.entryHigh - b.c[i], cost = 0.0003 * b.c[i], stop = b.c[i] * (1 - d * STOPF), wf = b.c[i] + d * band; lv = { ...lv0, stop, target: wf + d * (RR * Math.abs(wf - stop) + (1 + RR) * cost) }; }
  if (e0 < lv.entryLow || e0 > lv.entryHigh) return null;
  const notional = stake * 100, comm = commissionBps(b.t[i + 1]) / 1e4 * notional;
  const stopUsd = Math.abs(e0 - lv.stop) / e0 * notional + comm, tpUsd = Math.abs(lv.target - e0) / e0 * notional - comm;
  if (stopUsd > 0.8 * stake || tpUsd / stopUsd < RR - 1e-9) return null; // planEntry: stop cap and reward:risk after commission
  for (let j = i + 1; j < b.t.length; j++) {
    const dt = new Date(b.t[j]), flat = dt.getUTCDay() === 5 && dt.getUTCHours() * 60 + dt.getUTCMinutes() >= 20 * 60 + 30;
    const base = { s, d, at: b.t[i + 1], risk: stopUsd };
    if (j > i + 1 && b.t[j] - b.t[j - 1] > 6 * 3600_000 && d * (b.o[j] - lv.stop) <= 0) return { ...base, exitAt: b.t[j], usd: Math.max(-stake, d * (b.o[j] - e0) / e0 * notional - comm), out: "gap" };
    if (d > 0 ? b.l[j] <= lv.stop : b.h[j] >= lv.stop) return { ...base, exitAt: b.t[j] + 1800_000, usd: -stopUsd, out: "stop" };
    if (d > 0 ? b.h[j] >= lv.target : b.l[j] <= lv.target) return { ...base, exitAt: b.t[j] + 1800_000, usd: tpUsd, out: "target" };
    if (j - i >= HOLD || flat) return { ...base, exitAt: b.t[j] + 1800_000, usd: d * (b.c[j] - e0) / e0 * notional - comm, out: flat ? "friday close" : "4-day limit" };
  }
  return null;
}
const sigs: { s: string; i: number; t: number; d: 1 | -1 }[] = [];
for (const s of SYMS) { const b = m30[s], vs = ids.map((id) => aligned[POLL_TIMEFRAME[id]][s][id]);
  for (let i = 1; i < b.t.length - 1; i++) {
    if (b.t[i] < START || !canOpen(b.t[i] + 1800_000) || b.t[i + 1] - b.t[i] > 1800_000) continue;
    const r = tallyPoll(vs.map((v) => v[i] as any), 0.5, POLL_QUORUM); if (r.direction) sigs.push({ s, i, t: b.t[i] + 1800_000, d: r.direction === "buy" ? 1 : -1 }); } }
sigs.sort((a, b) => a.t - b.t);
const band = (eq: number) => eq < 12 ? 20 : eq < 50 ? 15 : eq < 200 ? 10 : 6;
function run(from: number, to: number, equity0: number | null) {
  const open: T[] = [], done: T[] = [], last: Record<string, number> = {}; let eq = equity0 ?? 0, day = "", realized = 0;
  for (const g of sigs) {
    if (g.t < from || g.t >= to) continue;
    for (let k = open.length - 1; k >= 0; k--) if (open[k].exitAt <= g.t) { const f = open.splice(k, 1)[0]; eq += f.usd; if (new Date(f.exitAt).toISOString().slice(0, 10) === day) realized += f.usd; }
    const d = new Date(g.t).toISOString().slice(0, 10); if (d !== day) { day = d; realized = 0; }
    if (!process.env.NOCOOL) { if (last[g.s] != null && g.t - last[g.s] < 3600_000) continue; last[g.s] = g.t; }
    if (open.some((o) => o.s === g.s)) continue;
    const legs = (s: string, dd: number) => ({ [s.slice(3, 6)]: dd, [s.slice(6, 9)]: -dd });
    if (!process.env.NOLEG && Object.entries(legs(g.s, g.d)).some(([c, sg]) => open.filter((o) => legs(o.s, o.d)[c] === sg).length >= 2)) continue;
    if (equity0 != null) {
      if (open.length >= 2) continue; // maxPerAssetClass 2 (all forex)
      const remaining = band(eq) / 100 * eq - Math.max(0, -realized) - open.length * 1;
      if (remaining < 0.35 || eq < 4) continue;
      const f = trade(g.s, g.i, g.d, 1); if (!f || f.risk > Math.min(0.8, remaining)) continue; open.push(f); done.push(f);
    } else { const f = trade(g.s, g.i, g.d, 1); if (f) { open.push(f); done.push(f); } }
  }
  const net = done.reduce((a, f) => a + f.usd, 0); let c = 0, pk = 0, dd = 0; for (const f of done.sort((a, b) => a.exitAt - b.exitAt)) { c += f.usd; pk = Math.max(pk, c); dd = Math.max(dd, pk - c); }
  const oc: Record<string, number> = {}; for (const f of done) oc[f.out] = (oc[f.out] ?? 0) + 1;
  return `n ${done.length}, win ${(100 * done.filter((f) => f.usd > 0).length / (done.length || 1)).toFixed(0)}%, net $${net.toFixed(2)} (${(net / (done.length || 1) * 100).toFixed(1)}c/trade), worst drawdown $${dd.toFixed(2)}${equity0 != null ? `, ends $${(equity0 + net).toFixed(2)}` : ""} ${JSON.stringify(oc)}`;
}
console.log("Every signal, one position per pair, $1 x100 each:");
console.log("  Nov-Jun (selection):", run(START, SPLIT, null)); console.log("  Jul-Sep (unseen):  ", run(SPLIT, Infinity, null));
for (const e of [5, 20, 50]) { console.log(`$${e} account, live sizing rules:`); console.log("  Nov-Jun:", run(START, SPLIT, e)); console.log("  Jul-Sep:", run(SPLIT, Infinity, e)); console.log("  whole year from $" + e + ":", run(START, Infinity, e)); }
