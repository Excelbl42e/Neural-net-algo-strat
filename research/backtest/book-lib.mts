// Shared pieces for the book tests: the live trade rules (one position per pair) and the $10 account
// (every majority vote until one stake of free balance is left, 5% risk sizing, 0.6% stop), both taking
// a voter list and an optional entry filter, so every idea is judged by the same rules.
import { m30, SYMS, SPLIT, START, aligned, loadTF, commissionBps } from "./cand-lib.mts";
import { tallyPoll, POLL_TIMEFRAME, POLL_QUORUM, POLL_COST_ALLOWANCE } from "../../artifacts/api-server/src/lib/poll-engine.ts";
export { m30, SYMS, SPLIT, START, aligned, POLL_TIMEFRAME };
for (const tf of ["M30", "H1", "H4"]) { loadTF(tf); loadTF(tf, new URL(`./data/votes-book-${tf}.json`, import.meta.url).pathname); }

export type Voter = { id: string; tf: string };
export const LIVE: Voter[] = Object.entries(POLL_TIMEFRAME).map(([id, tf]) => ({ id, tf }));
export const RR = 1.5, HOLD = 192, STOP = 0.006, END = Date.parse("2026-10-01T00:00:00Z");
export const okTime = (ms: number) => { const d = new Date(ms), day = d.getUTCDay(), h = d.getUTCHours(); return day >= 1 && day <= 5 && h >= 7 && h < 21 && !(day === 5 && h >= 16); };

export type Decision = { d: number; share: number; buy: number; sell: number };
/** Poll decisions at every M30 close for every pair, for a voter list. */
export function decisions(voters: Voter[]): Record<string, Decision[]> {
  const out: Record<string, Decision[]> = {};
  for (const s of SYMS) {
    const vs = voters.map((v) => aligned[v.tf][s][v.id]); const n = m30[s].t.length; const a: Decision[] = new Array(n);
    for (let i = 0; i < n; i++) { const r = tallyPoll(vs.map((v) => v[i] as any), 0.5, POLL_QUORUM); a[i] = { d: r.direction === "buy" ? 1 : r.direction === "sell" ? -1 : 0, share: r.share, buy: r.buy, sell: r.sell }; }
    out[s] = a;
  }
  return out;
}

/** Simulate one trade entered at the open after bar i in direction d; returns exit bar, reason and $ per $1 stake. */
export function simTrade(s: string, i: number, d: number) {
  const b = m30[s], e0 = b.o[i + 1], comm = commissionBps(b.t[i + 1]) / 100, cost = POLL_COST_ALLOWANCE * e0;
  const sp = e0 * (1 - d * STOP), tp = e0 + d * (RR * STOP * e0 + (1 + RR) * cost);
  for (let j = i + 1; j < b.t.length; j++) {
    const dt = new Date(b.t[j]), flat = dt.getUTCDay() === 5 && dt.getUTCHours() * 60 + dt.getUTCMinutes() >= 20 * 60 + 30;
    let px: number | null = null, reason = "";
    if (j > i + 1 && b.t[j] - b.t[j - 1] > 6 * 3600_000 && d * (b.o[j] - sp) <= 0) { px = b.o[j]; reason = "stop"; }
    else if (d > 0 ? b.l[j] <= sp : b.h[j] >= sp) { px = sp; reason = "stop"; }
    else if (d > 0 ? b.h[j] >= tp : b.l[j] <= tp) { px = tp; reason = "target"; }
    else if (j - (i + 1) >= HOLD) { px = b.c[j]; reason = "4-day"; }
    else if (flat) { px = b.c[j]; reason = "friday"; }
    if (px != null) return { j, reason, pnl: Math.max(-0.8, d * (px - e0) / e0 * 100 - comm) };
  }
  return null;
}

export type Trade = { s: string; i: number; j: number; d: number; t0: number; t1: number; pnl: number; part: "sel" | "test"; dec: Decision; reason: string };
export type Filter = (s: string, i: number, dec: Decision) => boolean;
/** Live rules, one position per pair, no capital limit (as horizon2.mts). */
export function runPairs(dec: Record<string, Decision[]>, filter?: Filter): Trade[] {
  const out: Trade[] = [];
  for (const s of SYMS) {
    const b = m30[s]; let busy = -1;
    for (let i = 0; i + 1 < b.t.length; i++) {
      if (b.t[i] < START || i <= busy) continue; const x = dec[s][i];
      if (!x.d || !okTime(b.t[i] + 1800_000) || b.t[i + 1] - b.t[i] > 1800_000) continue;
      if (filter && !filter(s, i, x)) continue;
      const r = simTrade(s, i, x.d); if (!r) break;
      out.push({ s, i, j: r.j, d: x.d, t0: b.t[i + 1], t1: b.t[r.j] + 1800_000, pnl: r.pnl, part: b.t[i] < SPLIT ? "sel" : "test", dec: x, reason: r.reason });
      busy = r.j;
    }
  }
  return out.sort((a, b) => a.t0 - b.t0);
}

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
export function summary(t: Trade[]) {
  const p = (part: string) => { const o = t.filter((x) => x.part === part).map((x) => x.pnl); return `${part} n ${String(o.length).padStart(4)} avg $${mean(o).toFixed(3).padStart(6)} win ${(100 * o.filter((x) => x > 0).length / (o.length || 1)).toFixed(1)}%`; };
  return `${p("sel")} | ${p("test")} | total $${t.reduce((a, x) => a + x.pnl, 0).toFixed(2).padStart(6)}`;
}

/** Ccy legs of a pair symbol like "frxEURUSD". */
export const legs = (s: string) => [s.slice(3, 6), s.slice(6, 9)];
export type Open = { s: string; d: number; i0: number; j: number; pnl: number; st: number };
/** Account gate: may this trade open, given what is open? */
export type Gate = (s: string, i: number, d: number, open: Open[]) => boolean;

const times = [...new Set(SYMS.flatMap((s) => m30[s].t))].sort((a, b) => a - b);
const idx: Record<string, Map<number, number>> = Object.fromEntries(SYMS.map((s) => [s, new Map(m30[s].t.map((t, i) => [t, i]))]));
/** $10 account from `from` to `to`: every allowed vote opens while free cash after it still covers one more stake. */
export function account(dec: Record<string, Decision[]>, from: number, to: number, gate?: Gate, eq0 = 10) {
  let cash = eq0, pnlSum = 0; const open: Open[] = [];
  for (const t of times) { if (t < from || t >= to) continue;
    for (let k = open.length - 1; k >= 0; k--) { const p = open[k]; if (idx[p.s].get(t) === p.j) { cash += p.st + p.st * p.pnl; pnlSum += p.st * p.pnl; open.splice(k, 1); } }
    for (const s of SYMS) { const i = idx[s].get(t); if (i == null || i + 1 >= m30[s].t.length) continue; const x = dec[s][i];
      if (!x.d || !okTime(t + 1800_000) || m30[s].t[i + 1] - t > 1800_000 || open.some((p) => p.s === s)) continue;
      if (gate && !gate(s, i, x.d, open)) continue;
      const comm = commissionBps(m30[s].t[i + 1]) / 100, eq = cash + open.reduce((a, p) => a + p.st, 0);
      const st = Math.floor(Math.max(1, 0.05 * eq / (STOP * 100 + comm)) * 100) / 100;
      if (cash - st < st || st < 1) continue; // keep one stake free
      const r = simTrade(s, i, x.d); if (!r) continue;
      cash -= st; open.push({ s, d: x.d, i0: i, j: r.j, pnl: r.pnl, st }); } }
  for (const p of open) pnlSum += p.st * p.pnl; // still open at the end: book at its eventual exit
  return eq0 + pnlSum;
}
/** $10 runs of `days` starting every Monday; returns the CHANGES.md table row. */
export function rollingRuns(dec: Record<string, Decision[]>, days: number, gate?: Gate, part?: "sel" | "test") {
  const ends: number[] = []; const W = days * 86_400_000;
  for (let st = START; st + W <= END; st += 86_400_000) { if (new Date(st).getUTCDay() !== 1) continue; if (part && (part === "sel") !== (st < SPLIT)) continue; ends.push(account(dec, st, st + W, gate)); }
  ends.sort((a, b) => a - b); const pct = (f: (x: number) => boolean) => Math.round(100 * ends.filter(f).length / ends.length);
  return `${String(ends.length).padStart(2)} runs: up ${String(pct((x) => x > 10)).padStart(2)}% | $15+ ${String(pct((x) => x >= 15)).padStart(2)}% | under $5 ${String(pct((x) => x < 5)).padStart(2)}% | typical $${ends[ends.length >> 1].toFixed(2)} | worst $${ends[0].toFixed(2)} | best $${ends.at(-1)!.toFixed(2)}`;
}
