import fs from "node:fs";
import { STRATEGIES, type Bars, type CotPoint } from "../../artifacts/api-server/src/lib/poll-strategies.ts";
const B = new URL("./data", import.meta.url).pathname + "";
const NEW = ["cot_extremes", "cot_flow_reversal", "lyapunov_regime", "recurrence_determinism", "phase_space_analogues"];
const code: Record<string, string> = { "099741": "EUR", "096742": "GBP", "097741": "JPY", "232741": "AUD", "090741": "CAD", "092741": "CHF" };
const cot: Record<string, CotPoint[]> = {};
for (const r of JSON.parse(fs.readFileSync(B + "/cot.json", "utf8"))) {
  const ccy = code[r.cftc_contract_market_code]; const tue = Date.parse(r.report_date_as_yyyy_mm_dd.slice(0, 10) + "T00:00:00Z");
  (cot[ccy] ??= []).push({ usableFrom: tue + 6 * 86_400_000, net: (+r.noncomm_positions_long_all - +r.noncomm_positions_short_all) / Math.max(1, +r.open_interest_all) });
}
for (const k of Object.keys(cot)) cot[k].sort((a, b) => a.usableFrom - b.usableFrom);
fs.writeFileSync(B + "/cot-points.json", JSON.stringify(cot));
const raw = JSON.parse(fs.readFileSync(B + "/candles2y.json", "utf8"));
function barsFor(rows: number[][], tf: string): Bars {
  const sec = tf === "M30" ? 1800 : 3600; const r = rows.filter((x) => x[0] % sec === 0);
  if (tf !== "H4") return { t: r.map((x) => x[0] * 1000), o: r.map((x) => x[1]), h: r.map((x) => x[2]), l: r.map((x) => x[3]), c: r.map((x) => x[4]) };
  const b: Bars = { t: [], o: [], h: [], l: [], c: [] };
  for (const x of r) { const t4 = Math.floor(x[0] / 14400) * 14400 * 1000, n = b.t.length;
    if (n && b.t[n - 1] === t4) { b.h[n - 1] = Math.max(b.h[n - 1], x[2]); b.l[n - 1] = Math.min(b.l[n - 1], x[3]); b.c[n - 1] = x[4]; }
    else { b.t.push(t4); b.o.push(x[1]); b.h.push(x[2]); b.l.push(x[3]); b.c.push(x[4]); } }
  return b;
}
for (const TF of ["M30", "H1", "H4"]) {
  const bars: Record<string, Bars> = {}; for (const [s, tf] of Object.entries<any>(raw)) bars[s] = barsFor(tf[TF === "M30" ? "M30" : "H1"], TF);
  const out: Record<string, Record<string, number[]>> = {};
  for (const s of Object.keys(bars)) {
    out[s] = { t: bars[s].t };
    for (const id of NEW) out[s][id] = Array.from(STRATEGIES.find((x) => x.id === id)!.compute(bars[s], { symbol: s, closes: {}, cot }));
  }
  fs.writeFileSync(`${B}/votes-new-${TF}.json`, JSON.stringify(out)); console.log(TF, "done");
}
