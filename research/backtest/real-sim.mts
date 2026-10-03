import fs from "node:fs";
import { m30, SYMS, SPLIT, START, aligned, loadTF, commissionBps, canOpen } from "./cand-lib.mts";
for (const tf of ["M30", "H1", "H4"]) loadTF(tf);
const best = JSON.parse(fs.readFileSync(new URL("./data", import.meta.url).pathname + "/poll-opt-best.json", "utf8"));
const voters: { id: string; tf: string }[] = best.voters;
const AGREE = 0.5, QUORUM = 30, HOLD = 192;
type T = { s: string; at: number; exitAt: number; usd: number; risk: number; out: string };
function sim(s: string, i: number, d: number, stopPct: number, rr: number): T | null {
  const b = m30[s]; const e0 = b.o[i + 1], notional = 100; // $1 x100
  const comm = commissionBps(b.t[i + 1]) / 1e4 * notional;
  const stopUsd = stopPct / 100 * notional + comm; if (stopUsd > 0.8) return null;
  const sp = e0 * (1 - d * stopPct / 100), tp = rr > 0 ? e0 * (1 + d * rr * (stopPct / 100 + comm / notional)) : NaN;
  for (let j = i + 1; j < b.t.length; j++) {
    const dt = new Date(b.t[j]), flat = dt.getUTCDay() === 5 && dt.getUTCHours() * 60 + dt.getUTCMinutes() >= 20 * 60 + 30;
    if (j > i + 1 && b.t[j] - b.t[j - 1] > 6 * 3600_000 && d * (b.o[j] - sp) <= 0) return { s, at: b.t[i + 1], exitAt: b.t[j], usd: Math.max(-1, d * (b.o[j] - e0) / e0 * notional - comm), risk: stopUsd, out: "gap" };
    if (d > 0 ? b.l[j] <= sp : b.h[j] >= sp) return { s, at: b.t[i + 1], exitAt: b.t[j] + 1800_000, usd: -stopUsd, risk: stopUsd, out: "stop" };
    if (rr > 0 && (d > 0 ? b.h[j] >= tp : b.l[j] <= tp)) return { s, at: b.t[i + 1], exitAt: b.t[j] + 1800_000, usd: d * (tp - e0) / e0 * notional - comm, risk: stopUsd, out: "target" };
    if (j - i >= HOLD || flat) return { s, at: b.t[i + 1], exitAt: b.t[j] + 1800_000, usd: d * (b.c[j] - e0) / e0 * notional - comm, risk: stopUsd, out: flat ? "friday" : "hold" };
  }
  return null;
}
function signals(from: number, to: number) {
  const sg: { s: string; i: number; t: number; d: number }[] = [];
  for (const s of SYMS) { const b = m30[s], vs = voters.map((v) => aligned[v.tf][s][v.id]);
    for (let i = 1; i < b.t.length - 1; i++) {
      if (b.t[i] < from || b.t[i] >= to || !canOpen(b.t[i] + 1800_000) || b.t[i + 1] - b.t[i] > 1800_000) continue;
      let up = 0, dn = 0; for (const v of vs) { if (v[i] > 0) up++; else if (v[i] < 0) dn++; }
      const p = up + dn; if (p < QUORUM || up === dn || Math.max(up, dn) / p < AGREE) continue;
      sg.push({ s, i, t: b.t[i] + 1800_000, d: up > dn ? 1 : -1 }); } }
  return sg.sort((a, b) => a.t - b.t);
}
function account(from: number, to: number, stopPct: number, rr: number, maxOpen: number, equity0: number | null) {
  const open: T[] = [], done: T[] = []; let eq = equity0 ?? 0, day = "", realized = 0;
  for (const g of signals(from, to)) {
    for (let k = open.length - 1; k >= 0; k--) if (open[k].exitAt <= g.t) { const f = open.splice(k, 1)[0]; eq += f.usd; if (new Date(f.exitAt).toISOString().slice(0, 10) === day) realized += f.usd; }
    const d = new Date(g.t).toISOString().slice(0, 10); if (d !== day) { day = d; realized = 0; }
    if (open.length >= maxOpen || open.some((o) => o.s === g.s)) continue;
    let cap = 0.8;
    if (equity0 != null) {
      // Live rules: daily budget 20% of equity minus today's realized loss minus open stakes (counted in full);
      // >= $0.35 left to trade; stake lifted to $1 only while $0.80 is <= 20% of equity (else it would be a binary: not modelled, skip);
      // the stop may not exceed what is left of the budget.
      const remaining = 0.2 * eq - Math.max(0, -realized) - open.length * 1;
      if (remaining < 0.35 || eq < 4) continue;
      cap = Math.min(0.8, remaining);
    }
    const f = sim(g.s, g.i, g.d, stopPct, rr); if (!f || f.risk > cap) continue; open.push(f); done.push(f);
  }
  const net = done.reduce((a, f) => a + f.usd, 0); let c = 0, pk = 0, dd = 0; for (const f of done) { c += f.usd; pk = Math.max(pk, c); dd = Math.max(dd, pk - c); }
  const oc: Record<string, number> = {}; for (const f of done) oc[f.out] = (oc[f.out] ?? 0) + 1;
  return { n: done.length, win: +(100 * done.filter((f) => f.usd > 0).length / (done.length || 1)).toFixed(0), net: +net.toFixed(2), perTrade: +(net / (done.length || 1)).toFixed(3), dd: +dd.toFixed(2), oc };
}
console.log("one position per pair, no account limits ($1 x100 each):");
for (const sp of [0.4, 0.6, 0.75]) for (const rr of [0, 1.5, 2, 3]) {
  const a = account(START, SPLIT, sp, rr, 99, null), b = account(SPLIT, Infinity, sp, rr, 99, null);
  console.log(`stop ${sp}% target ${rr ? rr + "x" : "none"} | sel n ${a.n} net $${a.net} (${a.perTrade}/trade, win ${a.win}%) | TEST n ${b.n} net $${b.net} (${b.perTrade}/trade, win ${b.win}%) ${JSON.stringify(b.oc)}`);
}
console.log("\n$5 account under the live daily-loss rule (one $1 position at a time):");
for (const [sp, rr] of [[0.75, 0], [0.75, 2], [0.6, 0], [0.6, 3]] as const) {
  const a = account(START, SPLIT, sp, rr, 99, 5), b = account(SPLIT, Infinity, sp, rr, 99, 5);
  console.log(`stop ${sp}% target ${rr || "none"} | Nov-Jun n ${a.n} net $${a.net} dd $${a.dd} | Jul-Sep n ${b.n} net $${b.net} dd $${b.dd}`);
}
