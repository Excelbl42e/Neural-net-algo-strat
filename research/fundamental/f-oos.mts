// Direction and selection on 2012-2022 only; judged on 2023 - Sep 2026 (out of sample).
// A voter is kept if its 2012-2022 result (in its chosen direction) has t >= 1.5 and is positive in
// at least 2 of the 3 eras. The chosen direction is then frozen for the out-of-sample years.
import { DAYS, PAIRS, FUND_VOTERS, pairPrice, pairVote } from "./fund-lib.mts";
import fs from "node:fs";
const P = Object.fromEntries(PAIRS.map((p) => [p, pairPrice(p)]));
const ERAS: [string, string, string][] = [["2012-14", "2012-01-01", "2015-01-01"], ["2015-18", "2015-01-01", "2019-01-01"], ["2019-22", "2019-01-01", "2023-01-01"], ["2023-25", "2023-01-01", "2025-11-10"], ["Deriv yr", "2025-11-10", "2026-10-01"]];
const rows: any[] = [];
for (const v of FUND_VOTERS) {
  const acc = ERAS.map(() => [] as number[]); const cache = new Map();
  for (let i = 0; i + 5 < DAYS.length; i++) {
    const e = ERAS.findIndex(([, a, b]) => DAYS[i] >= a && DAYS[i] < b); if (e < 0) continue;
    for (const p of PAIRS) { const d = pairVote(v, p, i, cache); if (!d) continue; const a = P[p][i + 1], b = P[p][i + 5]; if (!(a > 0 && b > 0)) continue; acc[e].push(d * Math.log(b / a) * 1e4); }
  }
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const tstat = (a: number[], dir: number) => { const m = dir * mean(a) - 2, sd = Math.sqrt(a.reduce((x, y) => x + (y - mean(a)) ** 2, 0) / Math.max(1, a.length - 1)); return m / (sd / Math.sqrt(Math.max(1, a.length / 4))); };
  const sel = acc.slice(0, 3).flat(); const dir = mean(sel) >= 0 ? 1 : -1;
  const eraNet = acc.map((a) => (a.length ? dir * mean(a) - 2 : NaN));
  const tSel = tstat(sel, dir), posSel = eraNet.slice(0, 3).filter((x) => x > 0).length;
  const oos = acc.slice(3).flat(), tOos = tstat(oos, dir);
  rows.push({ id: v.id, family: v.family, dir, eraNet, tSel, posSel, oos: dir * mean(oos) - 2, tOos, nOos: oos.length, kept: tSel >= 1.5 && posSel >= 2 });
}
rows.sort((a, b) => b.tSel - a.tSel);
console.log("voter".padEnd(22), "dir   ", "2012-14 2015-18 2019-22 | t sel  | 2023-25 Deriv yr | OOS bps  t");
for (const r of rows) console.log((r.kept ? "* " : "  ") + r.id.padEnd(20), (r.dir > 0 ? "follow" : "fade  "), r.eraNet.slice(0, 3).map((x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-").padStart(7)).join(" "), "|", r.tSel.toFixed(1).padStart(5), " |", r.eraNet.slice(3).map((x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-").padStart(7)).join(" "), "  |", r.oos.toFixed(1).padStart(6), r.tOos.toFixed(1).padStart(5));
const kept = rows.filter((r) => r.kept);
const m = (f: (r: any) => number, xs: any[]) => (xs.reduce((a, r) => a + f(r), 0) / (xs.length || 1)).toFixed(1);
console.log(`\nkept on 2012-2022: ${kept.length} of ${rows.length}. Out of sample (2023-Sep 2026): avg ${m((r) => r.oos, kept)} bps per vote, ${kept.filter((r) => r.oos > 0).length} of ${kept.length} positive. Not kept: avg ${m((r) => r.oos, rows.filter((r) => !r.kept))} bps.`);
fs.writeFileSync(new URL("./data/f-oos.json", import.meta.url).pathname, JSON.stringify(rows));
