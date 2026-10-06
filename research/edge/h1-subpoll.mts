// The live poll's 32 H1/H4 voters on Yahoo hourly candles, Dec 2023 - Oct 2026 (Deriv serves only the last
// year). Nov 2025 onward overlaps the period the strategies were chosen on; Dec 2023 - Oct 2025 was never used
// for any choice, so it is an honest out-of-sample test of that half of the poll.
// Live rules on hourly bars: decision at each H1 close 07-21 UTC (Fri until 16), quorum = half (16 of 32),
// one position per pair, entry at the next open, stop 0.6%, target 1.5x + commission allowance, 96h, Friday 20:30.
import fs from "node:fs";
import { STRATEGIES, type Bars } from "../../artifacts/api-server/src/lib/poll-strategies.ts";
import { POLL_TIMEFRAME, POLL_COST_ALLOWANCE } from "../../artifacts/api-server/src/lib/poll-engine.ts";
import { cotFade } from "../backtest/r-extra.mts";
const raw: Record<string, number[][]> = JSON.parse(fs.readFileSync(new URL("./data/fx-1h.json", import.meta.url).pathname, "utf8"));
const SRC = process.env.SRC ?? "yahoo";
const deriv = SRC === "deriv" ? JSON.parse(fs.readFileSync(new URL("../backtest/data/candles2y.json", import.meta.url).pathname, "utf8")) : null;
const PAIRS = Object.keys(raw);
const isOpen = (t: number) => { const d = new Date(t * 1000).getUTCDay(); return d >= 1 && d <= 5; };
function h1(p: string): Bars { const rows = deriv ? deriv["frx" + p].H1.filter((x: number[]) => x[0] % 3600 === 0) : raw[p].filter((r) => isOpen(r[0]) && r[0] % 3600 === 0);
  return { t: rows.map((r: number[]) => r[0] * 1000), o: rows.map((r: number[]) => r[1]), h: rows.map((r: number[]) => r[2]), l: rows.map((r: number[]) => r[3]), c: rows.map((r: number[]) => r[4]) }; }
function h4(b: Bars): Bars { const o: Bars = { t: [], o: [], h: [], l: [], c: [] };
  for (let i = 0; i < b.t.length; i++) { const t4 = Math.floor(b.t[i] / 14_400_000) * 14_400_000, n = o.t.length;
    if (n && o.t[n - 1] === t4) { o.h[n - 1] = Math.max(o.h[n - 1], b.h[i]); o.l[n - 1] = Math.min(o.l[n - 1], b.l[i]); o.c[n - 1] = b.c[i]; } else { o.t.push(t4); o.o.push(b.o[i]); o.h.push(b.h[i]); o.l.push(b.l[i]); o.c.push(b.c[i]); } }
  return o; }
const B1: Record<string, Bars> = Object.fromEntries(PAIRS.map((p) => [p, h1(p)])), B4: Record<string, Bars> = Object.fromEntries(PAIRS.map((p) => [p, h4(B1[p])]));
const VOTERS = STRATEGIES.filter((s) => POLL_TIMEFRAME[s.id] === "H1" || POLL_TIMEFRAME[s.id] === "H4");
function closesFor(bars: Record<string, Bars>, p: string) { const idx = new Map(bars[p].t.map((t, i) => [t, i])); const out: Record<string, number[]> = {};
  for (const q of PAIRS) { const a = new Array(bars[p].t.length).fill(NaN); bars[q].t.forEach((t, j) => { const i = idx.get(t); if (i != null) a[i] = bars[q].c[j]; }); out["frx" + q] = a; } return out; }
// votes aligned to each H1 close: an H4 voter uses the last H4 bar closed by then
const NET: Record<string, { buy: Int16Array; sell: Int16Array }> = {};
for (const p of PAIRS) { const b1 = B1[p], b4 = B4[p], n = b1.t.length; const buy = new Int16Array(n), sell = new Int16Array(n);
  const c1 = closesFor(B1, p), c4 = closesFor(B4, p); const map4 = new Int32Array(n).fill(-1); let j = -1;
  for (let i = 0; i < n; i++) { const close = b1.t[i] + 3_600_000; while (j + 1 < b4.t.length && b4.t[j + 1] + 14_400_000 <= close) j++; map4[i] = j; }
  for (const s of VOTERS) { const tf = POLL_TIMEFRAME[s.id]; const v = s.compute(tf === "H1" ? b1 : b4, { symbol: "frx" + p, closes: tf === "H1" ? c1 : c4 });
    for (let i = 0; i < n; i++) { const x = tf === "H1" ? v[i] : map4[i] >= 0 ? v[map4[i]] : 0; if (x > 0) buy[i]++; else if (x < 0) sell[i]++; } }
  NET[p] = { buy, sell }; }
const comm = (ms: number) => { const h = new Date(ms).getUTCHours(); return h >= 7 && h < 20 ? 2 : 6; };
const okTime = (ms: number) => { const d = new Date(ms), day = d.getUTCDay(), h = d.getUTCHours(); return day >= 1 && day <= 5 && h >= 7 && h < 21 && !(day === 5 && h >= 16); };
function simTrade(b: Bars, i: number, d: number) { const e0 = b.o[i + 1], c = comm(b.t[i + 1]) / 100, cost = POLL_COST_ALLOWANCE * e0, sp = e0 * (1 - d * 0.006), tp = e0 + d * (1.5 * 0.006 * e0 + 2.5 * cost);
  for (let j = i + 1; j < b.t.length; j++) { const dt = new Date(b.t[j]); let px: number | null = null;
    if (j > i + 1 && b.t[j] - b.t[j - 1] > 6 * 3_600_000 && d * (b.o[j] - sp) <= 0) px = b.o[j];
    else if (d > 0 ? b.l[j] <= sp : b.h[j] >= sp) px = sp; else if (d > 0 ? b.h[j] >= tp : b.l[j] <= tp) px = tp;
    else if (j - (i + 1) >= 96) px = b.c[j]; else if (dt.getUTCDay() === 5 && dt.getUTCHours() >= 20) px = b.o[j];
    if (px != null) return { j, pnl: Math.max(-0.8, d * (px - e0) / e0 * 100 - c) }; }
  return null; }
const Q = Math.ceil(VOTERS.length / 2), MONDAY = process.env.MONDAY === "1";
type T = { p: string; t0: number; pnl: number; d: number };
const trades: T[] = [];
for (const p of PAIRS) { const b = B1[p]; let busy = -1;
  for (let i = 0; i + 1 < b.t.length; i++) { if (i <= busy) continue; const close = b.t[i] + 3_600_000; if (!okTime(close) || b.t[i + 1] - b.t[i] > 3_600_000) continue;
    if (MONDAY && new Date(close).getUTCDay() !== 1) continue;
    const { buy, sell } = NET[p]; const bb = buy[i], ss = sell[i]; if (bb + ss < Q || bb === ss) continue; const d = bb > ss ? 1 : -1;
    if (cotFade("frx" + p, close) === -d) continue;
    const r = simTrade(b, i, d); if (!r) break; trades.push({ p, t0: b.t[i + 1], pnl: r.pnl, d }); busy = r.j; } }
const per = (a: string, z: string) => { const x = trades.filter((t) => t.t0 >= Date.parse(a) && t.t0 < Date.parse(z)).map((t) => t.pnl); return `${String(x.length).padStart(4)} trades  $${(x.reduce((q, y) => q + y, 0) / (x.length || 1)).toFixed(3).padStart(6)} per $1  total $${x.reduce((q, y) => q + y, 0).toFixed(2).padStart(6)}  win ${Math.round(100 * x.filter((y) => y > 0).length / (x.length || 1))}%`; };
console.log(`${VOTERS.length} H1/H4 voters, quorum ${Q}, source ${SRC}${MONDAY ? ", Monday entries only" : ""}`);
for (const [a, z, n] of [["2023-12-20", "2024-07-01", "Dec 23-Jun 24 (unseen)"], ["2024-07-01", "2025-01-01", "Jul-Dec 24 (unseen)"], ["2025-01-01", "2025-07-01", "Jan-Jun 25 (unseen)"], ["2025-07-01", "2025-11-10", "Jul-Nov 25 (unseen)"], ["2025-11-10", "2026-07-01", "Nov 25-Jun 26 (selection)"], ["2026-07-01", "2026-10-01", "Jul-Sep 26 (test)"]]) console.log(n.padEnd(26), per(a, z));
console.log("unseen total".padEnd(26), per("2023-12-20", "2025-11-10"));

if (process.env.DUMP) { const byWeek: Record<string, number[]> = {}; for (const t of trades) { const d = new Date(t.t0); const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7))).toISOString().slice(0, 10); (byWeek[mon] ??= []).push(+t.pnl.toFixed(4)); }
  fs.writeFileSync(new URL("./data/" + process.env.DUMP, import.meta.url).pathname, JSON.stringify(byWeek)); console.log("dumped", Object.keys(byWeek).length, "weeks"); }
