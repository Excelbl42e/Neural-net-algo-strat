// Ideas from Chan, "Quantitative Trading" (2008) and López de Prado, "Advances in Financial Machine Learning" (2018),
// tested on the live rules (same entry, stop, target, 4-day limit and Friday close as horizon2.mts).
//   1. Chan ch.7: exit when a newer vote points the other way (the entry model's own exit), with and without the target.
//   2. AFML ch.10: is the vote share informative enough to size bets by it? P&L by share bucket.
//   3. AFML ch.14: probabilistic and deflated Sharpe ratio of the per-trade results.
//   4. AFML ch.15: the win rate needed to break even, and the chance the real rate is below it.
import { m30, SYMS, SPLIT, START, aligned, loadTF, commissionBps } from "./cand-lib.mts";
import { tallyPoll, POLL_TIMEFRAME, POLL_QUORUM, POLL_COST_ALLOWANCE } from "../../artifacts/api-server/src/lib/poll-engine.ts";
for (const tf of ["M30", "H1", "H4"]) loadTF(tf);
const ids = Object.keys(POLL_TIMEFRAME), RR = 1.5, HOLD = 192, STOP = 0.006;
const okTime = (ms: number) => { const d = new Date(ms), day = d.getUTCDay(), h = d.getUTCHours(); return day >= 1 && day <= 5 && h >= 7 && h < 21 && !(day === 5 && h >= 16); };
type Tr = { pnl: number; part: string; share: number; hours: number; reason: string };
const votes: Record<string, Int8Array[]> = {};
for (const s of SYMS) votes[s] = ids.map((id) => aligned[POLL_TIMEFRAME[id]][s][id]);
const poll = (s: string, i: number) => tallyPoll(votes[s].map((v) => v[i] as any), 0.5, POLL_QUORUM);

function run(flipExit: boolean, useTarget: boolean): Tr[] {
  const out: Tr[] = [];
  for (const s of SYMS) {
    const b = m30[s]; let busyUntil = -1;
    for (let i = 0; i + 1 < b.t.length; i++) {
      if (b.t[i] < START || i <= busyUntil) continue;
      const r = poll(s, i), d = r.direction === "buy" ? 1 : r.direction === "sell" ? -1 : 0;
      if (!d || !okTime(b.t[i] + 1800_000) || b.t[i + 1] - b.t[i] > 1800_000) continue;
      const e0 = b.o[i + 1], comm = commissionBps(b.t[i + 1]) / 100, cost = POLL_COST_ALLOWANCE * e0;
      const sp = e0 * (1 - d * STOP), tp = e0 + d * (RR * STOP * e0 + (1 + RR) * cost);
      let reason = "", px = 0, j = i + 1;
      for (; j < b.t.length; j++) {
        const dt = new Date(b.t[j]), flat = dt.getUTCDay() === 5 && dt.getUTCHours() * 60 + dt.getUTCMinutes() >= 20 * 60 + 30;
        if (j > i + 1 && b.t[j] - b.t[j - 1] > 6 * 3600_000 && d * (b.o[j] - sp) <= 0) { px = b.o[j]; reason = "stop"; break; }
        if (d > 0 ? b.l[j] <= sp : b.h[j] >= sp) { px = sp; reason = "stop"; break; }
        if (useTarget && (d > 0 ? b.h[j] >= tp : b.l[j] <= tp)) { px = tp; reason = "target"; break; }
        if (j - (i + 1) >= HOLD) { px = b.c[j]; reason = "4-day"; break; }
        if (flat) { px = b.c[j]; reason = "friday"; break; }
        // the vote at this bar's close is known at its close; act on it at that close
        if (flipExit) { const rr = poll(s, j); const dd = rr.direction === "buy" ? 1 : rr.direction === "sell" ? -1 : 0; if (dd === -d) { px = b.c[j]; reason = "flip"; break; } }
      }
      if (!reason) break;
      const pnl = Math.max(-0.8, d * (px - e0) / e0 * 100 - comm);
      out.push({ pnl, part: b.t[i] < SPLIT ? "sel" : "test", share: r.share, hours: (b.t[j] - b.t[i + 1]) / 3600_000, reason });
      busyUntil = j;
    }
  }
  return out;
}

const f = (x: number, d = 3) => x.toFixed(d);
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
function line(name: string, t: Tr[]) {
  const parts = ["sel", "test"].map((p) => { const o = t.filter((x) => x.part === p).map((x) => x.pnl); return `${p} n ${o.length} avg $${f(mean(o))} win ${(100 * o.filter((x) => x > 0).length / o.length).toFixed(1)}%`; });
  const all = t.map((x) => x.pnl);
  console.log(`${name.padEnd(34)} ${parts.join(" | ")} | all avg $${f(mean(all))} sum $${all.reduce((a, b) => a + b, 0).toFixed(2)}`);
}

console.log("== 1. Exits (Chan ch.7) ==");
const base = run(false, true);
line("live rules (stop, target, 4 days)", base);
line("+ exit on opposite vote", run(true, true));
line("exit on opposite vote, no target", run(true, false));
const fl = run(true, true); console.log("  exits with flip:", ["stop", "target", "flip", "4-day", "friday"].map((r) => `${r} ${(100 * fl.filter((x) => x.reason === r).length / fl.length).toFixed(0)}%`).join(" "), `median hold ${[...fl.map((x) => x.hours)].sort((a, b) => a - b)[fl.length >> 1]}h`);

console.log("\n== 2. P&L by vote share (AFML ch.10 bet sizing) ==");
for (const [lo, hi] of [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 1.01]]) {
  const g = base.filter((x) => x.share > lo && x.share <= hi);
  const p = (part: string) => { const o = g.filter((x) => x.part === part).map((x) => x.pnl); return o.length ? `${part} n ${String(o.length).padStart(3)} avg $${f(mean(o)).padStart(6)}` : `${part} n   0`; };
  console.log(`  share ${lo.toFixed(2)}-${Math.min(hi, 1).toFixed(2)}: ${p("sel")} | ${p("test")}`);
}

// Standard normal CDF and inverse (Acklam).
const Phi = (x: number) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)), y = 1 - Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI) * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + 1.330274429 * t)))); return x >= 0 ? y : 1 - y; };
function Zinv(p: number) { const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239], b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572], c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783], d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416]; const q = Math.min(p, 1 - p); let x: number; if (q < 0.02425) { const r = Math.sqrt(-2 * Math.log(q)); x = (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1); } else { const r = q - 0.5, s2 = r * r; x = (((((a[0] * s2 + a[1]) * s2 + a[2]) * s2 + a[3]) * s2 + a[4]) * s2 + a[5]) * r / (((((b[0] * s2 + b[1]) * s2 + b[2]) * s2 + b[3]) * s2 + b[4]) * s2 + 1); return p < 0.5 ? x : -x; } return p < 0.5 ? x : -x; }

console.log("\n== 3. Probabilistic / deflated Sharpe (AFML ch.14), per trade ==");
for (const part of ["sel", "test", "all"]) {
  const r = base.filter((x) => part === "all" || x.part === part).map((x) => x.pnl), T = r.length, m = mean(r), s = sd(r), sr = m / s;
  const g3 = mean(r.map((x) => ((x - m) / s) ** 3)), g4 = mean(r.map((x) => ((x - m) / s) ** 4));
  const psr = (sr0: number) => Phi((sr - sr0) * Math.sqrt(T - 1) / Math.sqrt(1 - g3 * sr + (g4 - 1) / 4 * sr * sr));
  // Expected best Sharpe among N trials when the true Sharpe is 0 (trial Sharpe spread ~ 1/sqrt(T)).
  const sr0 = (N: number) => Math.sqrt(1 / T) * ((1 - 0.5772156649) * Zinv(1 - 1 / N) + 0.5772156649 * Zinv(1 - 1 / (N * Math.E)));
  console.log(`  ${part.padEnd(4)} n ${T} SR/trade ${f(sr)} skew ${f(g3, 2)} kurt ${f(g4, 2)} | PSR(>0) ${f(psr(0), 2)} | DSR if 10 / 100 / 1000 settings tried: ${[10, 100, 1000].map((N) => f(psr(sr0(N)), 2)).join(" / ")}`);
}

console.log("\n== 4. Win rate needed to break even (AFML ch.15) ==");
for (const part of ["sel", "test", "all"]) {
  const r = base.filter((x) => part === "all" || x.part === part).map((x) => x.pnl);
  const up = mean(r.filter((x) => x > 0)), dn = mean(r.filter((x) => x <= 0)), p = r.filter((x) => x > 0).length / r.length;
  const pBE = -dn / (up - dn), z = (p - pBE) / Math.sqrt(p * (1 - p) / r.length);
  console.log(`  ${part.padEnd(4)} avg win $${f(up)} avg loss $${f(dn)} | win rate ${(100 * p).toFixed(1)}% vs break-even ${(100 * pBE).toFixed(1)}% | chance the true rate is below break-even ${(100 * (1 - Phi(z))).toFixed(0)}%`);
}
