// General trade simulator for the profit research: every exit and entry rule is a parameter, so one
// harness judges all of them. With LIVE_RULES it reproduces book-lib's simTrade/runPairs exactly
// (checked in r-exits.mts: 1,041 trades, +$18.01). The $10 account values positions still open at
// the end of a run at that moment's price (what Deriv would show).
import { m30, SYMS, SPLIT, START, END, okTime, type Decision } from "./book-lib.mts";
import { commissionBps } from "./cand-lib.mts";
import { POLL_COST_ALLOWANCE } from "../../artifacts/api-server/src/lib/poll-engine.ts";
export { m30, SYMS, SPLIT, START, END };

export type Rules = {
  stop: number;               // stop distance, fraction of entry price (live 0.006; Deriv's cap at x100 is ~0.0078)
  rr: number | null;          // target = rr x stop (+ commission allowance); null = no target
  hold: number;               // M30 bars (live 192 = 4 trading days)
  friday: boolean;            // flatten from Friday 20:30 UTC (live true); false = hold through the weekend
  be?: number;                // move the stop to entry + commission once price has gone this fraction in favour
  trail?: [number, number];   // [activate after this favour, then trail the stop this far behind the best price]
  entry?: (s: string, i: number, x: Decision) => boolean; // extra entry filter (on top of the live hours)
  ok?: (ms: number) => boolean; // replaces the live trading hours (okTime) for the open time of the entry
};
export const LIVE_RULES: Rules = { stop: 0.006, rr: 1.5, hold: 192, friday: true };
const isFriClose = (ms: number) => { const d = new Date(ms); return d.getUTCDay() === 5 && d.getUTCHours() * 60 + d.getUTCMinutes() >= 20 * 60 + 30; };

/** Trade entered at the open after bar i, side d. pnl = $ per $1 stake at x100 after commission (floor -1: stake lost). */
export function sim(s: string, i: number, d: number, R: Rules) {
  const b = m30[s], e0 = b.o[i + 1], comm = commissionBps(b.t[i + 1]) / 100, cost = POLL_COST_ALLOWANCE * e0;
  let sp = e0 * (1 - d * R.stop); const tp = R.rr == null ? NaN : e0 + d * (R.rr * R.stop * e0 + (1 + R.rr) * cost);
  let best = 0, moved = false;
  for (let j = i + 1; j < b.t.length; j++) {
    let px: number | null = null, reason = "";
    const gap = j > i + 1 && b.t[j] - b.t[j - 1] > 6 * 3600_000;
    if (gap && d * (b.o[j] - sp) <= 0) { px = b.o[j]; reason = "stop"; }
    else if (gap && R.rr != null && d * (b.o[j] - tp) >= 0) { px = tp; reason = "target"; }
    else if (d > 0 ? b.l[j] <= sp : b.h[j] >= sp) { px = sp; reason = moved ? "trail/be" : "stop"; }
    else if (R.rr != null && (d > 0 ? b.h[j] >= tp : b.l[j] <= tp)) { px = tp; reason = "target"; }
    else if (j - (i + 1) >= R.hold) { px = b.c[j]; reason = "hold"; }
    else if (R.friday && isFriClose(b.t[j])) { px = b.c[j]; reason = "friday"; }
    if (px != null) return { j, reason, pnl: Math.max(-1, d * (px - e0) / e0 * 100 - comm) };
    // stop adjustments use this bar's extreme, so they act from the next bar on
    best = Math.max(best, d * ((d > 0 ? b.h[j] : b.l[j]) - e0) / e0);
    if (R.be != null && !moved && best >= R.be) { sp = e0 * (1 + d * comm / 100 * 1.5); moved = true; }
    if (R.trail && best >= R.trail[0]) { const ns = e0 * (1 + d * (best - R.trail[1])); if (d * (ns - sp) > 0) { sp = ns; moved = true; } }
  }
  return null;
}

export type Tr = { s: string; i: number; j: number; d: number; t0: number; t1: number; pnl: number; part: "sel" | "test"; reason: string; risk: number };
/** One position per pair, no capital limit. */
export function runPairs(dec: Record<string, Decision[]>, R: Rules): Tr[] {
  const out: Tr[] = [];
  for (const s of SYMS) { const b = m30[s]; let busy = -1;
    for (let i = 0; i + 1 < b.t.length; i++) {
      if (b.t[i] < START || i <= busy) continue; const x = dec[s][i];
      if (!x.d || !(R.ok ?? okTime)(b.t[i] + 1800_000) || b.t[i + 1] - b.t[i] > 1800_000) continue;
      if (R.entry && !R.entry(s, i, x)) continue;
      const r = sim(s, i, x.d, R); if (!r) break;
      out.push({ s, i, j: r.j, d: x.d, t0: b.t[i + 1], t1: b.t[r.j] + 1800_000, pnl: r.pnl, part: b.t[i] < SPLIT ? "sel" : "test", reason: r.reason, risk: R.stop * 100 + commissionBps(b.t[i + 1]) / 100 });
      busy = r.j; } }
  return out.sort((a, b) => a.t0 - b.t0);
}
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
/** Per-trade summary in $ per $1 stake and in % of equity at the live 5% risk sizing. */
export function sumLine(t: Tr[]) {
  const g = (p: string) => { const a = t.filter((x) => x.part === p); return `${p} n ${String(a.length).padStart(4)} $${mean(a.map((x) => x.pnl)).toFixed(3).padStart(6)} (${mean(a.map((x) => 5 * x.pnl / x.risk)).toFixed(2).padStart(5)}%eq) win ${(100 * a.filter((x) => x.pnl > 0).length / (a.length || 1)).toFixed(0)}%`; };
  return `${g("sel")} | ${g("test")} | total $${t.reduce((a, x) => a + x.pnl, 0).toFixed(2).padStart(7)}`;
}

const times = [...new Set(SYMS.flatMap((s) => m30[s].t))].sort((a, b) => a - b);
const idx: Record<string, Map<number, number>> = Object.fromEntries(SYMS.map((s) => [s, new Map(m30[s].t.map((t, i) => [t, i]))]));
export type Acct = { risk?: number; maxOpen?: number; gate?: (s: string, i: number, d: number, open: { s: string; d: number }[]) => boolean;
  /** order in which pairs voting at the same close are considered (default: the live scan order, majors first) */
  order?: (cands: { s: string; i: number; x: Decision }[], open: { s: string; d: number }[]) => { s: string; i: number; x: Decision }[] };
/** $eq0 account from `from` to `to`: every allowed vote opens while free cash after it still covers one more stake. */
export function account(dec: Record<string, Decision[]>, R: Rules, from: number, to: number, A: Acct = {}, eq0 = 10) {
  let cash = eq0; const open: { s: string; d: number; i0: number; j: number; pnl: number; st: number; comm: number }[] = []; const last: Record<string, number> = {};
  for (const t of times) { if (t < from) continue; if (t >= to) break;
    for (const s of SYMS) { const i = idx[s].get(t); if (i != null) last[s] = i; }
    for (let k = open.length - 1; k >= 0; k--) { const p = open[k]; if (idx[p.s].get(t) === p.j) { cash += p.st + p.st * p.pnl; open.splice(k, 1); } }
    let cands: { s: string; i: number; x: Decision }[] = [];
    for (const s of SYMS) { const i = idx[s].get(t); if (i == null || i + 1 >= m30[s].t.length) continue; const x = dec[s][i];
      if (!x.d || !(R.ok ?? okTime)(t + 1800_000) || m30[s].t[i + 1] - t > 1800_000 || open.some((p) => p.s === s)) continue;
      if (R.entry && !R.entry(s, i, x)) continue; cands.push({ s, i, x }); }
    if (A.order && cands.length > 1) cands = A.order(cands, open);
    for (const { s, i, x } of cands) {
      if (A.maxOpen != null && open.length >= A.maxOpen) continue;
      if (A.gate && !A.gate(s, i, x.d, open)) continue;
      const comm = commissionBps(m30[s].t[i + 1]) / 100, eq = cash + open.reduce((a, p) => a + p.st, 0);
      const st = Math.floor(Math.max(1, (A.risk ?? 0.05) * eq / (R.stop * 100 + comm)) * 100) / 100;
      if (cash - st < st || st < 1) continue;
      const r = sim(s, i, x.d, R); if (!r) continue;
      cash -= st; open.push({ s, d: x.d, i0: i, j: r.j, pnl: r.pnl, st, comm }); } }
  let v = cash;
  for (const p of open) { const b = m30[p.s], k = last[p.s] ?? p.i0, e0 = b.o[p.i0 + 1]; v += p.st + p.st * Math.max(-1, p.d * (b.c[k] - e0) / e0 * 100 - p.comm); }
  return v;
}
/** $10 runs of `days` starting every Monday 00:00 UTC (all, or only sel/test starts). */
export function runs(dec: Record<string, Decision[]>, R: Rules, days: number, A: Acct = {}, part?: "sel" | "test") {
  const ends: number[] = []; const W = days * 86_400_000;
  for (let st = START; st + W <= END; st += 86_400_000) { if (new Date(st).getUTCDay() !== 1) continue; if (part && (part === "sel") !== (st < SPLIT)) continue; ends.push(account(dec, R, st, st + W, A)); }
  return ends.sort((a, b) => a - b);
}
export function runLine(e: number[]) {
  const n = e.length, pct = (f: (x: number) => boolean) => `${String(Math.round(100 * e.filter(f).length / n)).padStart(2)}%`;
  return `${String(n).padStart(2)} runs avg $${(e.reduce((a, b) => a + b, 0) / n).toFixed(2).padStart(5)} median $${e[n >> 1].toFixed(2).padStart(5)} up ${pct((x) => x > 10)} $15+ ${pct((x) => x >= 15)} <$5 ${pct((x) => x < 5)} worst $${e[0].toFixed(2)} best $${e[n - 1].toFixed(2).padStart(5)}`;
}
