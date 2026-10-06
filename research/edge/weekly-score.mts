// Scores every weekly signal with the live exits (stop 0.6%, target 1.5x, Monday open -> Friday close), $ per $1.
// Direction (follow / fade) and selection on 2011-2019 only: kept if the week-clustered t >= 2 and positive in
// at least 2 of the 3 eras (2012-14, 2015-17, 2018-19). Test: 2020 - Oct 2026, year by year.
import fs from "node:fs";
const V: Record<string, Record<string, number[]>> = JSON.parse(fs.readFileSync(new URL("./data/weekly-votes.json", import.meta.url).pathname, "utf8"));
const PAIRS = Object.keys(V), SIG = Object.keys(V[PAIRS[0]]).filter((k) => !["weeks", "ret", "live", "liveS"].includes(k));
const yr = (t: number) => new Date(t).getUTCFullYear();
export function signalWeeks(sig: string, dir = 1, from = 0, to = 9e15) {
  // pnl per vote, grouped by week (to get a week-clustered t-stat)
  const byWeek = new Map<number, number[]>();
  for (const p of PAIRS) { const v = V[p]; v[sig].forEach((x, k) => { const t = v.weeks[k]; if (!x || t < from || t >= to) return; const d = x * dir; const pnl = d > 0 ? v.live[k] : v.liveS[k]; (byWeek.get(t) ?? byWeek.set(t, []).get(t)!).push(pnl); }); }
  return byWeek;
}
export function stats(byWeek: Map<number, number[]>) {
  const all = [...byWeek.values()].flat(), n = all.length, m = all.reduce((a, b) => a + b, 0) / (n || 1);
  const wsum = [...byWeek.values()].map((a) => a.reduce((x, y) => x + y, 0)), W = wsum.length, wm = wsum.reduce((a, b) => a + b, 0) / (W || 1);
  const wsd = Math.sqrt(wsum.reduce((a, b) => a + (b - wm) ** 2, 0) / Math.max(1, W - 1)); return { n, m, t: W > 2 ? wm / (wsd / Math.sqrt(W)) : 0, perWeek: n / Math.max(1, W) };
}
const D = (s: string) => Date.parse(s + "-01-01T00:00:00Z");
if (import.meta.url === `file://${process.argv[1]}`) {
  const rows: any[] = [];
  for (const sig of SIG) {
    const sel = stats(signalWeeks(sig, 1, D("2011"), D("2020"))); const dir = sel.m >= 0 ? 1 : -1;
    const s2 = stats(signalWeeks(sig, dir, D("2011"), D("2020")));
    const eras = [["2011", "2015"], ["2015", "2018"], ["2018", "2020"]].map(([a, b]) => stats(signalWeeks(sig, dir, D(a), D(b))).m);
    const test = stats(signalWeeks(sig, dir, D("2020"), D("2027")));
    const years = [2020, 2021, 2022, 2023, 2024, 2025, 2026].map((y) => stats(signalWeeks(sig, dir, D(String(y)), D(String(y + 1)))).m);
    rows.push({ sig, dir, sel: s2, eras, test, years, kept: s2.t >= 2 && eras.filter((x) => x > 0).length >= 2 });
  }
  rows.sort((a, b) => b.sel.t - a.sel.t);
  console.log("signal".padEnd(34), "dir   sel $/vote   t  | eras+ | TEST 2020-26 $/vote   t  | 2020  2021  2022  2023  2024  2025  2026");
  for (const r of rows.slice(0, 45)) console.log((r.kept ? "* " : "  ") + r.sig.padEnd(32), (r.dir > 0 ? "follow" : "fade  "), r.sel.m.toFixed(3).padStart(7), r.sel.t.toFixed(1).padStart(5), " | ", r.eras.filter((x: number) => x > 0).length, "/3 |", r.test.m.toFixed(3).padStart(10), r.test.t.toFixed(1).padStart(6), " |", r.years.map((x: number) => (Number.isFinite(x) ? x.toFixed(2) : "  -").padStart(6)).join(""));
  const kept = rows.filter((r) => r.kept);
  console.log(`\nkept on 2011-2019: ${kept.length} of ${rows.length}. TEST 2020-26: ${kept.filter((r) => r.test.m > 0).length} positive; average $${(kept.reduce((a, r) => a + r.test.m, 0) / (kept.length || 1)).toFixed(3)} per vote; with test t >= 2: ${kept.filter((r) => r.test.t >= 2).map((r) => r.sig).join(", ") || "none"}`);
  console.log(`baseline: always-buy-base and always-sell-base cost about -$0.02 (commission) per vote`);
  fs.writeFileSync(new URL("./data/weekly-score.json", import.meta.url).pathname, JSON.stringify(rows.map((r) => ({ sig: r.sig, dir: r.dir, kept: r.kept, selT: r.sel.t, selM: r.sel.m, testM: r.test.m, testT: r.test.t, years: r.years }))));
}
