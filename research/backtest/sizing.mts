// $10 account, live poll (current 60 voters), every majority vote, max 2 open, sessions + Friday rules.
// Varies only the stop distance and the stake.
import { m30, SYMS, SPLIT, START, aligned, loadTF, commissionBps } from "./cand-lib.mts";
import { tallyPoll, POLL_TIMEFRAME, POLL_QUORUM, POLL_COST_ALLOWANCE } from "../../artifacts/api-server/src/lib/poll-engine.ts";
for (const tf of ["M30", "H1", "H4"]) loadTF(tf);
const ids = Object.keys(POLL_TIMEFRAME), RR = 1.5, HOLD = 192, MAX_OPEN = 2;
// Decisions.
const dec: Record<string, Int8Array> = {};
for (const s of SYMS) { const vs = ids.map((id) => aligned[POLL_TIMEFRAME[id]][s][id]); const n = m30[s].t.length, a = new Int8Array(n);
  for (let i = 0; i < n; i++) { const r = tallyPoll(vs.map((v) => v[i] as any), 0.5, POLL_QUORUM); a[i] = r.direction === "buy" ? 1 : r.direction === "sell" ? -1 : 0; } dec[s] = a; }
// EWMA (RiskMetrics, lambda 0.94 per hour-equivalent) volatility forecast of M30 log returns, scaled to the 4-day hold.
const vol4d: Record<string, Float64Array> = {};
for (const s of SYMS) { const c = m30[s].c, out = new Float64Array(c.length); let v = NaN;
  for (let i = 1; i < c.length; i++) { const r = Math.log(c[i] / c[i - 1]); v = Number.isFinite(v) ? 0.97 * v + 0.03 * r * r : r * r; out[i] = i > 200 ? Math.sqrt(v * HOLD) : NaN; } vol4d[s] = out; }
const times = [...new Set(SYMS.flatMap((s) => m30[s].t))].sort((a, b) => a - b);
const idx: Record<string, Map<number, number>> = Object.fromEntries(SYMS.map((s) => [s, new Map(m30[s].t.map((t, i) => [t, i]))]));
function okTime(ms: number) { const d = new Date(ms), day = d.getUTCDay(), h = d.getUTCHours(); return day >= 1 && day <= 5 && h >= 7 && h < 21 && !(day === 5 && h >= 16); }
const band = (e: number) => (e < 12 ? 0.2 : e < 50 ? 0.1 : e < 200 ? 0.05 : 0.02);
type Cfg = { name: string; stop: (s: string, i: number) => number; stake: (eq: number, stopFrac: number, comm: number) => number };
type P = { s: string; d: number; i0: number; e0: number; sp: number; tp: number; comm: number; st: number };
function run(c: Cfg, from: number, to: number, eq0 = 10) {
  let cash = eq0, pnlSum = 0, trades = 0; const open: P[] = [];
  const close = (p: P, px: number) => { const pnl = Math.max(-0.8 * p.st, p.st * (p.d * (px - p.e0) / p.e0 * 100 - p.comm)); cash += p.st + pnl; pnlSum += pnl; trades++; };
  for (const t of times) { if (t < from || t >= to) continue;
    for (let k = open.length - 1; k >= 0; k--) { const p = open[k], i = idx[p.s].get(t); if (i == null || i <= p.i0) continue; const b = m30[p.s];
      const dt = new Date(t), flat = dt.getUTCDay() === 5 && dt.getUTCHours() * 60 + dt.getUTCMinutes() >= 20 * 60 + 30; let px: number | null = null;
      if (b.t[i] - b.t[i - 1] > 6 * 3600_000 && p.d * (b.o[i] - p.sp) <= 0) px = b.o[i];
      else if (p.d > 0 ? b.l[i] <= p.sp : b.h[i] >= p.sp) px = p.sp;
      else if (p.d > 0 ? b.h[i] >= p.tp : b.l[i] <= p.tp) px = p.tp;
      else if (i - p.i0 >= HOLD || flat) px = b.c[i];
      if (px != null) { close(p, px); open.splice(k, 1); } }
    for (const s of SYMS) { const i = idx[s].get(t); if (i == null || i + 1 >= m30[s].t.length) continue; const d = dec[s][i];
      if (!d || !okTime(t + 1800_000) || m30[s].t[i + 1] - t > 1800_000 || open.length >= MAX_OPEN || open.some((p) => p.s === s)) continue;
      const b = m30[s], e0 = b.o[i + 1], comm = commissionBps(b.t[i + 1]) / 100; // % of notional
      const stopFrac = c.stop(s, i); if (!Number.isFinite(stopFrac)) continue;
      if (stopFrac * 100 + comm > 0.8) continue;                          // stop cap: 80% of stake at x100
      const eq = cash + open.reduce((a, p) => a + p.st, 0);
      let st = Math.floor(c.stake(eq, stopFrac, comm) * 100) / 100; st = Math.min(st, Math.floor(cash * 100) / 100); if (st < 1) continue;
      const cost = POLL_COST_ALLOWANCE * e0, sp = e0 * (1 - d * stopFrac), tp = e0 + d * (RR * stopFrac * e0 + (1 + RR) * cost);
      cash -= st; open.push({ s, d, i0: i, e0, sp, tp, comm, st }); } }
  for (const p of open) { const b = m30[p.s]; close(p, b.c[Math.min(b.t.length - 1, p.i0 + HOLD)]); }
  return { end: eq0 + pnlSum, trades };
}
function rolling(c: Cfg, days: number, part: "sel" | "test") {
  const ends: number[] = []; const W = days * 86_400_000;
  for (let st = START; st + W <= Date.parse("2026-10-01T00:00:00Z"); st += 86_400_000) {
    if (new Date(st).getUTCDay() !== 1) continue; if ((part === "sel") !== (st < SPLIT)) continue;
    ends.push(run(c, st, st + W).end); }
  ends.sort((a, b) => a - b); const pct = (f: (x: number) => boolean) => Math.round(100 * ends.filter(f).length / ends.length);
  return { up: pct((x) => x > 10), wiped: pct((x) => x < 5), median: ends[ends.length >> 1], worst: ends[0], best: ends.at(-1)!, n: ends.length };
}
const fixed = (f: number) => () => f;
const volStop = (m: number) => (s: string, i: number) => Math.min(0.0075, Math.max(0.003, m * vol4d[s][i]));
const bandStake = (eq: number) => Math.max(1, eq * band(eq));
const riskStake = (frac: number) => (eq: number, stopFrac: number, comm: number) => Math.max(1, (frac * eq) / (stopFrac * 100 + comm));
const CFG: Cfg[] = [
  { name: "CURRENT: 0.6% stop, band stake", stop: fixed(0.006), stake: bandStake },
  { name: "0.6% stop, $1 stake", stop: fixed(0.006), stake: () => 1 },
  { name: "0.4% stop, $1 stake", stop: fixed(0.004), stake: () => 1 },
  { name: "0.3% stop, $1 stake", stop: fixed(0.003), stake: () => 1 },
  { name: "vol stop 0.5σ, band stake", stop: volStop(0.5), stake: bandStake },
  { name: "vol stop 0.75σ, band stake", stop: volStop(0.75), stake: bandStake },
  { name: "vol stop 1σ, band stake", stop: volStop(1), stake: bandStake },
  { name: "vol stop 0.75σ, $1 stake", stop: volStop(0.75), stake: () => 1 },
  { name: "vol stop 0.75σ, risk 5%/trade", stop: volStop(0.75), stake: riskStake(0.05) },
  { name: "vol stop 0.75σ, risk 8%/trade", stop: volStop(0.75), stake: riskStake(0.08) },
  { name: "0.6% stop, risk 5%/trade", stop: fixed(0.006), stake: riskStake(0.05) },
  { name: "0.6% stop, risk 8%/trade", stop: fixed(0.006), stake: riskStake(0.08) },
];
const f = (r: any) => `up ${String(r.up).padStart(3)}% | under $5 ${String(r.wiped).padStart(3)}% | median $${r.median.toFixed(2)} | worst $${r.worst.toFixed(2)} | best $${r.best.toFixed(2)}`;
for (const c of CFG) {
  const a = rolling(c, 26, "sel"), b = rolling(c, 26, "test");
  console.log(c.name.padEnd(34), "| starts Nov-Jun:", f(a), "|| starts Jul-Sep:", f(b));
}
