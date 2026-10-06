// Weekly edge lab: 15 years of daily candles (Yahoo, Oct 2011 - Oct 2026), the owner's cycle: the signal is
// read at Friday's close, the trade opens at Monday's open and runs to Friday's close (or its stop / target).
// Candidates: the 60 live strategies and the 60 new quant strategies run on daily bars, the 60 fundamental
// voters, and classic FX factors. Choice on 2011-2019 only; 2020 - Oct 2026 is the test.
// Writes data/weekly-votes.json: { pair: { weeks: [mondayMs...], ret: [...], <signal>: [votes...] } } and a report.
import fs from "node:fs";
import { STRATEGIES, type Bars } from "../../artifacts/api-server/src/lib/poll-strategies.ts";
import { NEW_QUANT } from "../backtest/new-quant.mts";
import { DAYS, FUND_VOTERS, pairVote } from "../fundamental/fund-lib.mts";
import { cotFade } from "../backtest/r-extra.mts";

const raw: Record<string, number[][]> = JSON.parse(fs.readFileSync(new URL("./data/fx-1d.json", import.meta.url).pathname, "utf8"));
export const PAIRS = Object.keys(raw);
const dateOf = (sec: number) => new Date(sec * 1000 + 2 * 3_600_000).toISOString().slice(0, 10); // London trading date
/** Daily bars stamped at 00:00 UTC of their trading date (weekdays only). */
export const DB: Record<string, Bars> = {};
for (const p of PAIRS) { const b: Bars = { t: [], o: [], h: [], l: [], c: [] };
  for (const r of raw[p]) { const d = dateOf(r[0]); const t = Date.parse(d + "T00:00:00Z"); const wd = new Date(t).getUTCDay(); if (wd === 0 || wd === 6) continue; if (b.t.length && b.t[b.t.length - 1] === t) continue;
    b.t.push(t); b.o.push(r[1]); b.h.push(r[2]); b.l.push(r[3]); b.c.push(r[4]); }
  DB[p] = b; }
const DAYMS = 86_400_000;
/** The weeks: for each pair, Monday's bar index and Friday's bar index of the same week. */
export type Wk = { mon: number; fri: number; t: number };
export function weeksOf(b: Bars): Wk[] { const out: Wk[] = [];
  for (let i = 1; i < b.t.length; i++) { if (new Date(b.t[i]).getUTCDay() !== 1) continue; let j = i; while (j + 1 < b.t.length && b.t[j + 1] - b.t[i] < 5 * DAYMS) j++; if (new Date(b.t[j]).getUTCDay() !== 5) continue; out.push({ mon: i, fri: j, t: b.t[i] }); }
  return out; }
/** Live exit geometry on daily bars: stop 0.6%, target 1.5x + 6 bps allowance; stop first if both touched in one day. $ per $1 at x100 after 2 bps. */
export function weekPnl(b: Bars, w: Wk, d: number, stop = 0.006, rr: number | null = 1.5): number {
  const e0 = b.o[w.mon], sp = e0 * (1 - d * stop), tp = rr == null ? NaN : e0 + d * (rr * stop * e0 + 2.5 * 0.0006 * e0);
  for (let j = w.mon; j <= w.fri; j++) {
    if (d > 0 ? b.l[j] <= sp : b.h[j] >= sp) return Math.max(-0.8, -stop * 100 - 0.02);
    if (rr != null && (d > 0 ? b.h[j] >= tp : b.l[j] <= tp)) return d * (tp - e0) / e0 * 100 - 0.02;
  }
  return Math.max(-0.8, d * (b.c[w.fri] - e0) / e0 * 100 - 0.02);
}
export const rawRet = (b: Bars, w: Wk) => (b.c[w.fri] - b.o[w.mon]) / b.o[w.mon];

if (import.meta.url === `file://${process.argv[1]}`) {
  const out: Record<string, Record<string, number[]>> = {};
  const fundDir: Record<string, number> = Object.fromEntries((JSON.parse(fs.readFileSync(new URL("../fundamental/data/f-oos.json", import.meta.url).pathname, "utf8")) as any[]).map((r) => [r.id, 1]));
  const dayIdx = new Map(DAYS.map((d, i) => [d, i]));
  for (const p of PAIRS) {
    const b = DB[p], W = weeksOf(b), idx = new Map(b.t.map((t, i) => [t, i]));
    const closes: Record<string, number[]> = {}; for (const q of PAIRS) { const a = new Array(b.t.length).fill(NaN); DB[q].t.forEach((t, j) => { const i = idx.get(t); if (i != null) a[i] = DB[q].c[j]; }); closes["frx" + q] = a; }
    const o: Record<string, number[]> = { weeks: W.map((w) => w.t), ret: W.map((w) => rawRet(b, w)), live: W.map((w) => weekPnl(b, w, 1)), liveS: W.map((w) => weekPnl(b, w, -1)) };
    for (const s of [...STRATEGIES, ...NEW_QUANT]) { const v = s.compute(b, { symbol: "frx" + p, closes }); o["s:" + s.id] = W.map((w) => v[w.mon - 1]); }
    // fundamental voters at Friday's date (usable from Monday), follow direction (the sign is chosen later on 2011-2019)
    for (const fv of FUND_VOTERS) { const cache = new Map(); o["f:" + fv.id] = W.map((w) => { const d = new Date(b.t[w.mon - 1]).toISOString().slice(0, 10); const j = dayIdx.get(d); return j == null ? 0 : pairVote(fv, p, j, cache); }); }
    o["f:cot_live_veto_dir"] = W.map((w) => cotFade("frx" + p, b.t[w.mon] + 7 * 3_600_000)); // the live COT fade signal
    // classic factors on daily closes (Friday)
    const c = b.c, f = (w: Wk) => w.mon - 1;
    const vol = (i: number, n: number) => { let s = 0; for (let k = i - n + 1; k <= i; k++) s += Math.log(c[k] / c[k - 1]) ** 2; return Math.sqrt(s / n); };
    const mom = (n: number) => W.map((w) => { const i = f(w); if (i - n < 1) return 0; const z = Math.log(c[i] / c[i - n]) / (vol(i, 60) * Math.sqrt(n)); return z > 0.5 ? 1 : z < -0.5 ? -1 : 0; });
    o["c:tsmom_1w"] = mom(5); o["c:tsmom_1m"] = mom(21); o["c:tsmom_3m"] = mom(63); o["c:tsmom_6m"] = mom(126); o["c:tsmom_12m"] = mom(252);
    o["c:reversal_1w"] = mom(5).map((x) => -x); o["c:reversal_1m"] = mom(21).map((x) => -x);
    o["c:friday_dir"] = W.map((w) => Math.sign(c[f(w)] - b.o[f(w)]));
    o["c:last_week_dir"] = W.map((w) => { const i = f(w); return i >= 5 ? Math.sign(c[i] - c[i - 5]) : 0; });
    o["c:week_range_pos"] = W.map((w) => { const i = f(w); if (i < 5) return 0; let hi = -Infinity, lo = Infinity; for (let k = i - 4; k <= i; k++) { hi = Math.max(hi, b.h[k]); lo = Math.min(lo, b.l[k]); } const pos = (c[i] - lo) / (hi - lo); return pos > 0.8 ? 1 : pos < 0.2 ? -1 : 0; });
    o["c:ma_200d"] = W.map((w) => { const i = f(w); if (i < 200) return 0; let s = 0; for (let k = i - 199; k <= i; k++) s += c[k]; return Math.sign(c[i] - s / 200); });
    o["c:month_turn"] = W.map((w) => { const d = new Date(b.t[w.mon]); const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); return last - d.getUTCDate() < 5 ? -Math.sign(c[f(w)] - c[Math.max(1, f(w) - 15)]) : 0; });
    out[p] = o; process.stderr.write(p + " ");
  }
  fs.writeFileSync(new URL("./data/weekly-votes.json", import.meta.url).pathname, JSON.stringify(out));
  console.log("\nsignals:", Object.keys(out[PAIRS[0]]).length - 4, "weeks per pair:", out[PAIRS[0]].weeks.length);
}
