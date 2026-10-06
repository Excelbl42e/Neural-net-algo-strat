// Each fundamental voter alone, 2012-2026, 14 pairs, daily: a vote on day i is entered at the close of
// day i+1 and held 4 trading days (to the close of i+5), less 2 bps commission. Mean bps per vote by era.
import { DAYS, PAIRS, FUND_VOTERS, pairPrice, pairVote } from "./fund-lib.mts";
const P = Object.fromEntries(PAIRS.map((p) => [p, pairPrice(p)]));
const ERAS: [string, string, string][] = [["2012-14", "2012-01-01", "2015-01-01"], ["2015-18", "2015-01-01", "2019-01-01"], ["2019-22", "2019-01-01", "2023-01-01"], ["2023-25", "2023-01-01", "2025-11-10"], ["Deriv yr", "2025-11-10", "2026-10-01"]];
const out: any[] = [];
for (const v of FUND_VOTERS) {
  const acc = ERAS.map(() => [] as number[]); const cache = new Map();
  for (let i = 0; i + 5 < DAYS.length; i++) {
    const e = ERAS.findIndex(([, a, b]) => DAYS[i] >= a && DAYS[i] < b); if (e < 0) continue;
    for (const p of PAIRS) { const d = pairVote(v, p, i, cache); if (!d) continue; const a = P[p][i + 1], b = P[p][i + 5]; if (!(a > 0 && b > 0)) continue; acc[e].push(d * Math.log(b / a) * 1e4 - 2); }
  }
  const m = acc.map((a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN));
  const all = acc.slice(0, 4).flat(), mAll = all.reduce((x, y) => x + y, 0) / (all.length || 1);
  const sd = Math.sqrt(all.reduce((x, y) => x + (y - mAll) ** 2, 0) / Math.max(1, all.length - 1));
  const t = mAll / (sd / Math.sqrt(Math.max(1, all.length / 4))); // overlapping 4-day holds: ~n/4 independent
  out.push({ id: v.id, family: v.family, eras: m, n: acc.map((a) => a.length), mAll, t, posEras: m.slice(0, 4).filter((x) => x > 0).length });
}
console.log("voter".padEnd(22), "family".padEnd(13), ERAS.map((e) => e[0].padStart(9)).join(""), "  2012-25  t    eras+  votes/day");
for (const r of out.sort((a, b) => b.t - a.t))
  console.log(r.id.padEnd(22), r.family.padEnd(13), r.eras.map((x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-").padStart(9)).join(""), r.mAll.toFixed(1).padStart(8), r.t.toFixed(1).padStart(5), String(r.posEras).padStart(5), "/4", (r.n.slice(0, 4).reduce((a: number, b: number) => a + b, 0) / (DAYS.length * 0.95)).toFixed(1).padStart(6));

