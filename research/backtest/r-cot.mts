// COT (CFTC Commitments of Traders) as a weekly signal, tested on 12 years (2014-2026): trade each of the
// 14 Deriv pairs from the week's first open to its last close, side from speculators' positioning.
// Prices: Yahoo daily FX closes (not committed; fetched by the command in the README into
// $YAHOO_DIR/<PAIR>.json). COT: data/cot.json (non-commercial long - short, as a share of open interest,
// per currency future; USD counts as 0). A report (Tuesday) is used from the following Monday.
import fs from "node:fs";
const DIR = process.env.YAHOO_DIR!;
const B = new URL("./data", import.meta.url).pathname;
const CODE: Record<string, string> = { "099741": "EUR", "096742": "GBP", "097741": "JPY", "232741": "AUD", "090741": "CAD", "092741": "CHF" };
const PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "GBPJPY", "USDCHF", "EURGBP", "EURJPY", "EURAUD", "EURCAD", "EURCHF", "GBPAUD", "AUDJPY"];
const WEEK = 7 * 86_400_000;
const mondayOf = (ms: number) => { const d = new Date(ms); const day = (d.getUTCDay() + 6) % 7; return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day); };

// weekly open/close per pair
const wk: Record<string, Map<number, { o: number; c: number }>> = {};
for (const p of PAIRS) { const j = JSON.parse(fs.readFileSync(`${DIR}/${p}.json`, "utf8")).chart.result[0], q = j.indicators.quote[0]; const m = new Map<number, { o: number; c: number }>();
  j.timestamp.forEach((ts: number, k: number) => { const o = q.open[k], c = q.close[k]; if (!(o > 0 && c > 0)) return; const ms = ts * 1000 + 12 * 3600_000; const day = new Date(ms).getUTCDay(); if (day === 0 || day === 6) return;
    const w = mondayOf(ms), e = m.get(w); if (!e) m.set(w, { o, c }); else e.c = c; });
  wk[p] = m; }
// COT net per currency per Monday it becomes usable
const cot: Record<string, Map<number, number>> = {};
for (const r of JSON.parse(fs.readFileSync(B + "/cot.json", "utf8"))) { const ccy = CODE[r.cftc_contract_market_code]; if (!ccy) continue;
  const tue = Date.parse(r.report_date_as_yyyy_mm_dd.slice(0, 10) + "T00:00:00Z"); (cot[ccy] ??= new Map()).set(mondayOf(tue) + WEEK, (+r.noncomm_positions_long_all - +r.noncomm_positions_short_all) / Math.max(1, +r.open_interest_all)); }
const net = (ccy: string, w: number) => (ccy === "USD" ? 0 : cot[ccy]?.get(w));
const diff = (p: string, w: number) => { const a = net(p.slice(0, 3), w), b = net(p.slice(3), w); return a == null || b == null ? null : a - b; };

type Sig = (p: string, w: number) => number;
const pctRank = (p: string, w: number, n: number) => { const x = diff(p, w); if (x == null) return null; const h: number[] = []; for (let k = 1; k <= n; k++) { const v = diff(p, w - k * WEEK); if (v != null) h.push(v); } if (h.length < n * 0.8) return null; return h.filter((v) => v < x).length / h.length; };
const SIGS: [string, Sig][] = [
  ["follow positioning (sign of net difference)", (p, w) => Math.sign(diff(p, w) ?? 0)],
  ["fade positioning", (p, w) => -Math.sign(diff(p, w) ?? 0)],
  ["follow 1-week change in positioning", (p, w) => { const a = diff(p, w), b = diff(p, w - WEEK); return a == null || b == null ? 0 : Math.sign(a - b); }],
  ["follow 4-week change in positioning", (p, w) => { const a = diff(p, w), b = diff(p, w - 4 * WEEK); return a == null || b == null ? 0 : Math.sign(a - b); }],
  ["fade 3-year extremes (<10th buy, >90th sell)", (p, w) => { const r = pctRank(p, w, 156); return r == null ? 0 : r > 0.9 ? -1 : r < 0.1 ? 1 : 0; }],
  ["follow 3-year extremes", (p, w) => { const r = pctRank(p, w, 156); return r == null ? 0 : r > 0.9 ? 1 : r < 0.1 ? -1 : 0; }],
  ["fade 1-year extremes (<10th / >90th)", (p, w) => { const r = pctRank(p, w, 52); return r == null ? 0 : r > 0.9 ? -1 : r < 0.1 ? 1 : 0; }],
];
const COMM = 2; // bps per trade (Deriv, London/New York hours)
const weeks = [...new Set(PAIRS.flatMap((p) => [...wk[p].keys()]))].filter((w) => w >= Date.UTC(2014, 6, 1)).sort((a, b) => a - b);
console.log(`${weeks.length} weeks, ${new Date(weeks[0]).toISOString().slice(0, 10)} .. ${new Date(weeks.at(-1)!).toISOString().slice(0, 10)}; bps per trade after ${COMM} bps commission`);
const eras = [[2014, 2017], [2018, 2020], [2021, 2023], [2024, 2026]];
for (const [name, f] of SIGS) {
  const all: number[] = [], byEra: number[][] = eras.map(() => []), weekly: number[] = [];
  for (const w of weeks) { let sum = 0, n = 0; for (const p of PAIRS) { const x = wk[p].get(w); if (!x) continue; const d = f(p, w); if (!d) continue;
      const r = d * (x.c - x.o) / x.o * 1e4 - COMM; all.push(r); sum += r; n++; const y = new Date(w).getUTCFullYear(); eras.forEach(([a, b], k) => { if (y >= a && y <= b) byEra[k].push(r); }); }
    if (n) weekly.push(sum / n); }
  const m = all.reduce((a, b) => a + b, 0) / all.length, wm = weekly.reduce((a, b) => a + b, 0) / weekly.length, wsd = Math.sqrt(weekly.reduce((a, b) => a + (b - wm) ** 2, 0) / weekly.length);
  console.log(`${name.padEnd(46)} trades ${String(all.length).padStart(5)} avg ${m.toFixed(1).padStart(5)} bps win ${(100 * all.filter((x) => x > 0).length / all.length).toFixed(0)}% | weekly-basket t ${(wm / wsd * Math.sqrt(weekly.length)).toFixed(2).padStart(5)} | ${eras.map(([a, b], k) => `${a}-${String(b).slice(2)} ${(byEra[k].reduce((x, y) => x + y, 0) / (byEra[k].length || 1)).toFixed(1).padStart(5)}`).join(" ")}`);
}
// sanity: buy-and-hold every pair every week (direction bias of the period)
const bh: number[] = []; for (const w of weeks) for (const p of PAIRS) { const x = wk[p].get(w); if (x) bh.push((x.c - x.o) / x.o * 1e4); }
console.log(`(reference: always long, before commission, ${(bh.reduce((a, b) => a + b, 0) / bh.length).toFixed(1)} bps per pair-week)`);
