// Final backtest of the live poll as built: poll-engine's own tally and levels,
// the live account rules, Deriv's measured costs and limits.
import { bars, votes, SYMS, SPLIT, WARM, atr, commissionAt } from "./poll-lib.mts";
import { tallyPoll, pollLevels, POLL_QUORUM } from "../../artifacts/api-server/src/lib/poll-engine.ts";
import { STRATEGIES } from "../../artifacts/api-server/src/lib/poll-strategies.ts";
const IDS = STRATEGIES.map((s) => s.id);
const AGREE = +(process.env.AGREE ?? 0.7), RR = 1.5, HOLD = 48, MAX_OPEN = +(process.env.MAXOPEN ?? 2), STAKE = 1, MULT = 100;
const legs = (sym: string, d: number) => ({ [sym.slice(3, 6)]: d, [sym.slice(6, 9)]: -d });
function scanOk(ms: number) { // killzones london+newyork (07-21 UTC), Deriv hours, Friday cutoff 16:00
  const d = new Date(ms), day = d.getUTCDay(), h = d.getUTCHours();
  return day >= 1 && day <= 5 && h >= 7 && h < 21 && !(day === 5 && h >= 16);
}
type T = { sym: string; dir: number; at: number; exitAt: number; pnl: number; risk: number; outcome: string };
function trade(sym: string, i: number, dir: 1 | -1): T | null {
  const b = bars[sym], a = atr[sym][i]; if (i + 1 >= b.c.length || b.t[i + 1] - b.t[i] > 1800_000) return null;
  const entry = b.o[i + 1], lv = pollLevels(dir === 1 ? "buy" : "sell", b.c[i], a, RR);
  if (entry < lv.entryLow || entry > lv.entryHigh) return null;            // price left the band before the order
  const usd = STAKE * MULT / entry;
  const stopUsd = Math.abs(entry - lv.stop) * usd, tpUsd = Math.abs(lv.target - entry) * usd;
  if (stopUsd < 0.10 || stopUsd > 0.8 * STAKE || tpUsd < 0.10) return null; // Deriv minimum $0.10, 80% stake cap
  const comm = commissionAt(b.t[i + 1]) * STAKE * MULT / 100;
  for (let j = i + 1; j < b.c.length; j++) {
    const dt = new Date(b.t[j]); const flat = dt.getUTCDay() === 5 && dt.getUTCHours() * 60 + dt.getUTCMinutes() >= 20 * 60 + 30;
    const base = { sym, dir, at: b.t[i + 1], risk: stopUsd + comm };
    if (j > i + 1 && b.t[j] - b.t[j - 1] > 1800_000 && dir * (b.o[j] - lv.stop) <= 0) return { ...base, exitAt: b.t[j], pnl: Math.max(-STAKE, dir * (b.o[j] - entry) * usd - comm), outcome: "gap" };
    if (dir === 1 ? b.l[j] <= lv.stop : b.h[j] >= lv.stop) return { ...base, exitAt: b.t[j] + 1800_000, pnl: -stopUsd - comm, outcome: "stop" };
    if (dir === 1 ? b.h[j] >= lv.target : b.l[j] <= lv.target) return { ...base, exitAt: b.t[j] + 1800_000, pnl: tpUsd - comm, outcome: "target" };
    if (j - i >= HOLD || flat) return { ...base, exitAt: b.t[j] + 1800_000, pnl: dir * (b.c[j] - entry) * usd - comm, outcome: flat ? "friday" : "24h" };
  }
  return null;
}
function run(from: number, to: number) {
  const sigs: { s: string; i: number; t: number; dir: 1 | -1 }[] = [];
  for (const s of SYMS) { const b = bars[s], vs = IDS.map((id) => votes[s][id]);
    for (let i = 1; i < b.c.length - 1; i++) { const close = b.t[i] + 1800_000;
      if (b.t[i] < from || b.t[i] >= to || !scanOk(close)) continue;
      const r = tallyPoll(vs.map((v) => v[i] as any), AGREE, POLL_QUORUM); if (r.direction) sigs.push({ s, i, t: close, dir: r.direction === "buy" ? 1 : -1 }); } }
  sigs.sort((a, b) => a.t - b.t);
  const open: T[] = [], out: T[] = [], lastSig: Record<string, number> = {}; let equity = 5, day = "", realized = 0;
  for (const g of sigs) {
    for (let k = open.length - 1; k >= 0; k--) if (open[k].exitAt <= g.t) { const f = open.splice(k, 1)[0]; equity += f.pnl; if (new Date(f.exitAt).toISOString().slice(0, 10) === day) realized += f.pnl; }
    const d = new Date(g.t).toISOString().slice(0, 10); if (d !== day) { day = d; realized = 0; }
    if (lastSig[g.s] != null && g.t - lastSig[g.s] < 3600_000) continue; lastSig[g.s] = g.t;           // 60-min cooldown
    if (open.some((f) => f.sym === g.s) || open.length >= MAX_OPEN || (!process.env.NOACCT && equity < 1.5)) continue;
    const L = legs(g.s, g.dir); if (!process.env.NOACCT && Object.entries(L).some(([c, sg]) => open.filter((o) => legs(o.sym, o.dir)[c] === sg).length >= 2)) continue;
    const f = trade(g.s, g.i, g.dir); if (!f) continue;
    if (!process.env.NOACCT && -Math.min(0, realized) + open.reduce((x, o) => x + o.risk, 0) + f.risk > 0.2 * equity) continue; // floor band: 20% daily
    open.push(f); out.push(f);
  }
  const net = out.reduce((a, f) => a + f.pnl, 0); let eq = 0, pk = 0, dd = 0; for (const f of out) { eq += f.pnl; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }
  const oc: Record<string, number> = {}, mo: Record<string, number> = {}; for (const f of out) { oc[f.outcome] = (oc[f.outcome] ?? 0) + 1; const m = new Date(f.at).toISOString().slice(0, 7); mo[m] = +((mo[m] ?? 0) + f.pnl).toFixed(2); }
  return { signals: sigs.length, trades: out.length, win: +(100 * out.filter((f) => f.pnl > 0).length / (out.length || 1)).toFixed(1), netUsd: +net.toFixed(2), perTradeR: +(out.reduce((a, f) => a + f.pnl / f.risk, 0) / (out.length || 1)).toFixed(3), maxDD: +dd.toFixed(2), endEquity: +(5 + net).toFixed(2), outcomes: oc, months: mo };
}
console.log("agreement", AGREE, "quorum", POLL_QUORUM);
console.log("SELECTION (Nov-Jun):", JSON.stringify(run(WARM, SPLIT)));
console.log("OUT-OF-SAMPLE (Jul-Sep):", JSON.stringify(run(SPLIT, Infinity)));
console.log("FULL YEAR:", JSON.stringify(run(WARM, Infinity)));
