// Each new quant candidate alone on each timeframe (as cand-score.mts): hourly decision samples in trading
// hours, 4-day hold cut at the Friday close, after commission; selection = Nov 2025 - Jun 2026, test = Jul - Sep.
// The timeframe is chosen on selection only. The 60 live strategies are scored the same way for comparison.
import fs from "node:fs";
import { m30, SYMS, SPLIT, START, aligned, loadTF, commissionBps, canOpen, exitIndex } from "./cand-lib.mts";
import { POLL_TIMEFRAME } from "../../artifacts/api-server/src/lib/poll-engine.ts";
const D = new URL("./data", import.meta.url).pathname;
for (const tf of ["M30", "H1", "H4"]) { loadTF(tf); loadTF(tf, `${D}/votes-nq-${tf}.json`); }
const HB = 192;
function score(tf: string, id: string) {
  const tr: number[] = [], te: number[] = [];
  for (const s of SYMS) { const b = m30[s], v = aligned[tf][s][id]; if (!v) continue;
    for (let i = 1; i < b.t.length - 1; i += 2) { const d = v[i]; if (!d || b.t[i] < START || !canOpen(b.t[i] + 1800_000) || b.t[i + 1] - b.t[i] > 1800_000) continue;
      const e0 = b.o[i + 1], e = exitIndex(s, i, HB); (b.t[i] < SPLIT ? tr : te).push(d * (b.c[e] - e0) / e0 * 1e4 - commissionBps(b.t[i + 1])); } }
  const m = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  return { tr: m(tr), te: m(te), n: tr.length + te.length };
}
const nq = Object.keys(JSON.parse(fs.readFileSync(`${D}/votes-nq-H4.json`, "utf8"))[SYMS[0]]).filter((k) => k !== "t");
const rows = nq.map((id) => { const by = ["M30", "H1", "H4"].map((tf) => ({ tf, ...score(tf, id) })); const best = by.reduce((a, b) => (b.tr > a.tr ? b : a)); return { id, ...best, by }; });
rows.sort((a, b) => b.tr - a.tr);
console.log("NEW QUANT CANDIDATES (best timeframe chosen on selection), bps per vote over 4 days after commission");
console.log("id".padEnd(26), "tf ", "  sel    test   votes | sel by tf M30/H1/H4");
for (const r of rows) console.log(r.id.padEnd(26), r.tf.padEnd(3), r.tr.toFixed(1).padStart(6), r.te.toFixed(1).padStart(7), String(r.n).padStart(7), " |", r.by.map((x) => x.tr.toFixed(1)).join(" / "));
const live = Object.entries(POLL_TIMEFRAME).map(([id, tf]) => ({ id, tf, ...score(tf, id) }));
const fam = (ids: string[]) => { const xs = live.filter((x) => ids.includes(x.id)); const m = (f: (x: any) => number) => (xs.reduce((a, x) => a + f(x), 0) / xs.length).toFixed(1); return `sel ${m((x) => x.tr)} test ${m((x) => x.te)}`; };
const TA = ["rsi_reversal", "macd_histogram", "ema_cross", "bollinger_reversion", "stochastic_cross", "adx_dmi", "ichimoku", "keltner_breakout", "roc_momentum", "williams_r", "cci_cross", "donchian_breakout", "parabolic_sar", "pivot_points", "fib_macd", "supertrend", "aroon", "heikin_ashi", "trix", "vortex"];
console.log(`\nLive 20 technical, alone: ${fam(TA)} | live 40 quant: ${fam(live.map((x) => x.id).filter((x) => !TA.includes(x)))}`);
const top = rows.filter((r) => r.tr > 0).slice(0, 20);
console.log(`Top 20 new by selection (${rows.filter((r) => r.tr > 0).length} of ${rows.length} positive in selection): sel ${(top.reduce((a, r) => a + r.tr, 0) / top.length).toFixed(1)} test ${(top.reduce((a, r) => a + r.te, 0) / top.length).toFixed(1)}`);
for (const x of live.filter((x) => TA.includes(x.id)).sort((a, b) => b.tr - a.tr)) process.stdout.write(`${x.id} ${x.tr.toFixed(1)}/${x.te.toFixed(1)}  `);
fs.writeFileSync(`${D}/nq-score.json`, JSON.stringify({ rows, top: top.map((r) => ({ id: r.id, tf: r.tf })) }));
console.log();
