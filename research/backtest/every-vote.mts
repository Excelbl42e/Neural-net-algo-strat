// $5 account, a $1 x100 trade on every majority vote while the free balance allows it.
import { m30, SYMS, SPLIT, START, aligned, loadTF, commissionBps } from "./cand-lib.mts";
import { tallyPoll, pollLevels, POLL_TIMEFRAME, POLL_QUORUM } from "../../artifacts/api-server/src/lib/poll-engine.ts";
import { atrSeries } from "../../artifacts/api-server/src/lib/poll-strategies.ts";
for (const tf of ["M30", "H1", "H4"]) loadTF(tf);
const ATR: Record<string, number[]> = {};
const ids = Object.keys(POLL_TIMEFRAME), STOPF = 0.006, RR = 1.5, HOLD = 192;
type V = { name: string; sessions: boolean; fridayCut: boolean; stack: boolean; reverse: boolean; maxOpen?: number; legCap?: boolean };
function okTime(ms: number, v: V) { const d = new Date(ms), day = d.getUTCDay(), h = d.getUTCHours(), mi = h * 60 + d.getUTCMinutes();
  if (day === 0 || day === 6) return false; if (day === 5 && mi >= (v.fridayCut ? 16 * 60 : 20 * 60)) return false; if (v.sessions && (h < 7 || h >= 21)) return false; return true; }
// decision per pair per bar
const dec: Record<string, Int8Array> = {};
for (const s of SYMS) { const vs = ids.map((id) => aligned[POLL_TIMEFRAME[id]][s][id]); const n = m30[s].t.length, a = new Int8Array(n);
  for (let i = 0; i < n; i++) { const r = tallyPoll(vs.map((v) => v[i] as any), 0.5, POLL_QUORUM); a[i] = r.direction === "buy" ? 1 : r.direction === "sell" ? -1 : 0; } dec[s] = a; }
// global timeline of M30 closes
const times = [...new Set(SYMS.flatMap((s) => m30[s].t))].sort((a, b) => a - b);
const idx: Record<string, Map<number, number>> = Object.fromEntries(SYMS.map((s) => [s, new Map(m30[s].t.map((t, i) => [t, i]))]));
type P = { s: string; d: number; i0: number; e0: number; sp: number; tp: number; comm: number };
function run(v: V, from: number, to: number) {
  let cash = 5, peak = 5, dd = 0, trades = 0, wins = 0, minCash = 5; const open: P[] = []; let pnlSum = 0;
  const close = (p: P, px: number) => { const pnl = Math.max(-1, p.d * (px - p.e0) / p.e0 * 100 - p.comm); cash += 1 + pnl; pnlSum += pnl; trades++; if (pnl > 0) wins++; };
  for (const t of times) {
    if (t < from || t >= to) continue;
    // 1) manage open positions on this bar
    for (let k = open.length - 1; k >= 0; k--) { const p = open[k], i = idx[p.s].get(t); if (i == null || i <= p.i0) continue; const b = m30[p.s];
      const dt = new Date(t), flat = dt.getUTCDay() === 5 && dt.getUTCHours() * 60 + dt.getUTCMinutes() >= 20 * 60 + 30;
      let px: number | null = null;
      if (b.t[i] - b.t[i - 1] > 6 * 3600_000 && p.d * (b.o[i] - p.sp) <= 0) px = b.o[i];
      else if (p.d > 0 ? b.l[i] <= p.sp : b.h[i] >= p.sp) px = p.sp;
      else if (p.d > 0 ? b.h[i] >= p.tp : b.l[i] <= p.tp) px = p.tp;
      else if (i - p.i0 >= HOLD || flat) px = b.c[i];
      else if (v.reverse && dec[p.s][i] === -p.d && okTime(t + 1800_000, v)) px = b.c[i];
      if (px != null) { close(p, px); open.splice(k, 1); } }
    // equity mark for drawdown (cash + open stakes at cost)
    const eq = cash + open.length; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq);
    // 2) new trades at this close
    for (const s of SYMS) { const i = idx[s].get(t); if (i == null || i + 1 >= m30[s].t.length) continue; const d = dec[s][i];
      if (!d || !okTime(t + 1800_000, v) || m30[s].t[i + 1] - t > 1800_000) continue;
      if (!v.stack && open.some((p) => p.s === s)) continue;
      if (v.stack && open.some((p) => p.s === s && p.i0 === i)) continue;
      if (cash < 1) continue;
      if (v.maxOpen != null && open.length >= v.maxOpen) continue;
      if (v.legCap) { const L = (x: string, dd: number) => ({ [x.slice(3, 6)]: dd, [x.slice(6, 9)]: -dd }); if (Object.entries(L(s, d)).some(([c, sg]) => open.filter((o) => L(o.s, o.d)[c] === sg).length >= 1)) continue; }
      const b = m30[s], e0 = b.o[i + 1], comm = commissionBps(b.t[i + 1]) / 1e4 * 100;
      const lv = pollLevels(d > 0 ? "buy" : "sell", b.c[i], (ATR[s] ??= atrSeries(b as any, 14))[i], RR);
      if (e0 < lv.entryLow || e0 > lv.entryHigh) continue;
      const sp = lv.stop, tp = lv.target;
      cash -= 1; minCash = Math.min(minCash, cash); open.push({ s, d, i0: i, e0, sp, tp, comm }); }
  }
  for (const p of open) { const b = m30[p.s]; const i = Math.min(b.t.length - 1, p.i0 + HOLD); close(p, b.c[i]); }
  if (process.env.RAW) return (5 + pnlSum) as any;
  return `trades ${String(trades).padStart(4)}  win ${(100 * wins / (trades || 1)).toFixed(0)}%  $5 -> $${(5 + pnlSum).toFixed(2)}  worst drop $${dd.toFixed(2)}`;
}
const V: V[] = [
  { name: "LIVE: every vote, max 2 open, sessions", sessions: true, fridayCut: true, stack: false, reverse: false, maxOpen: 2 },
  { name: "same, max 1 open", sessions: true, fridayCut: true, stack: false, reverse: false, maxOpen: 1 },
  { name: "same, max 3 open", sessions: true, fridayCut: true, stack: false, reverse: false, maxOpen: 3 },
];
if (process.env.RAW) {
  for (const v of V) {
    const ends: number[] = [];
    for (let st = START; st + 91 * 86_400_000 <= Date.parse("2026-10-01T00:00:00Z"); st += 7 * 86_400_000) ends.push(run(v, st, st + 91 * 86_400_000) as any);
    ends.sort((a, b) => a - b);
    const pct = (f: (x: number) => boolean) => Math.round(100 * ends.filter(f).length / ends.length);
    console.log(v.name.padEnd(40), `${ends.length} three-month runs: ended above $5 in ${pct((x) => x > 5)}%, below $2 in ${pct((x) => x < 2)}%, median $${ends[ends.length >> 1].toFixed(2)}, worst $${ends[0].toFixed(2)}, best $${ends.at(-1)!.toFixed(2)}`);
  }
} else
for (const v of V) console.log(v.name.padEnd(40), "| Nov-Jun:", run(v, START, SPLIT), "| Jul-Sep:", run(v, SPLIT, Infinity), "| whole year:", run(v, START, Infinity));
