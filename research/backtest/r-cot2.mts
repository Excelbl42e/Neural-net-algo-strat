// The one COT rule that held up over 12 years (fade speculators' 3-year positioning extremes, r-cot.mts),
// combined with the live poll on the Deriv year, under the weekly cycle (Mon-Tue entries, to Friday, max 4):
// as a 61st voter, as a veto, and as the priority for the 4 slots.
import fs from "node:fs";
import { LIVE, decisions, aligned } from "./book-lib.mts";
import { m30, SYMS, START, END, SPLIT, LIVE_RULES, runPairs, sumLine, account, type Rules, type Acct } from "./r-lib.mts";

const B = new URL("./data", import.meta.url).pathname, WEEK = 7 * 86_400_000;
const CODE: Record<string, string> = { "099741": "EUR", "096742": "GBP", "097741": "JPY", "232741": "AUD", "090741": "CAD", "092741": "CHF" };
const mondayOf = (ms: number) => { const d = new Date(ms); const day = (d.getUTCDay() + 6) % 7; return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day); };
const cot: Record<string, Map<number, number>> = {};
for (const r of JSON.parse(fs.readFileSync(B + "/cot.json", "utf8"))) { const c = CODE[r.cftc_contract_market_code]; if (!c) continue;
  cot[c] ??= new Map(); cot[c].set(mondayOf(Date.parse(r.report_date_as_yyyy_mm_dd.slice(0, 10) + "T00:00:00Z")) + WEEK, (+r.noncomm_positions_long_all - +r.noncomm_positions_short_all) / Math.max(1, +r.open_interest_all)); }
const net = (c: string, w: number) => (c === "USD" ? 0 : cot[c]?.get(w));
const diff = (p: string, w: number) => { const a = net(p.slice(0, 3), w), b = net(p.slice(3), w); return a == null || b == null ? null : a - b; };
/** fade 3-year extremes: +1 buy / -1 sell / 0 */
const cotSig = (s: string, t: number) => { const p = s.slice(3), w = mondayOf(t), x = diff(p, w); if (x == null) return 0; const h: number[] = [];
  for (let k = 1; k <= 156; k++) { const v = diff(p, w - k * WEEK); if (v != null) h.push(v); } if (h.length < 125) return 0; const r = h.filter((v) => v < x).length / h.length; return r > 0.9 ? -1 : r < 0.1 ? 1 : 0; };
for (const s of SYMS) { const a = new Int8Array(m30[s].t.length); m30[s].t.forEach((t, i) => (a[i] = cotSig(s, t + 1800_000))); aligned.M30[s]["cot_fade_extremes"] = a; }
const cover = SYMS.reduce((z, s) => z + aligned.M30[s]["cot_fade_extremes"].filter((x) => x !== 0).length, 0) / SYMS.reduce((z, s) => z + m30[s].t.length, 0);
console.log(`COT signal speaks on ${(100 * cover).toFixed(0)}% of bars in the Deriv year`);

const dow = (s: string, i: number) => new Date(m30[s].t[i] + 1800_000).getUTCDay();
const WKR: Rules = { ...LIVE_RULES, hold: 300, entry: (s, i) => dow(s, i) <= 2 };
const dec = decisions(LIVE), dec61 = decisions([...LIVE, { id: "cot_fade_extremes", tf: "M30" }]);
const cs = (s: string, i: number) => aligned.M30[s]["cot_fade_extremes"][i];
const veto: Rules = { ...WKR, entry: (s, i, x) => dow(s, i) <= 2 && cs(s, i) !== -x.d };
const only: Rules = { ...WKR, entry: (s, i, x) => dow(s, i) <= 2 && cs(s, i) === x.d };
console.log("\n== per trade, one position per pair ==");
console.log("weekly cycle".padEnd(40), sumLine(runPairs(dec, WKR)));
console.log("+ COT as 61st voter".padEnd(40), sumLine(runPairs(dec61, WKR)));
console.log("+ COT veto (skip if COT says the opposite)".padEnd(40), sumLine(runPairs(dec, veto)));
console.log("only when COT agrees".padEnd(40), sumLine(runPairs(dec, only)));
// how poll trades do by COT stance
const t = runPairs(dec, WKR); for (const [n, f] of [["COT agrees", 1], ["COT silent", 0], ["COT opposes", -1]] as const) { const g = t.filter((x) => cs(x.s, x.i) * x.d === f); console.log(`  poll trades where ${n.padEnd(12)} n ${String(g.length).padStart(3)} avg $${(g.reduce((a, x) => a + x.pnl, 0) / (g.length || 1)).toFixed(3)}`); }

console.log("\n== $10, 12-week runs from every weekday 07:00 (median / geo / under $5 / $20+) and rest-of-year from 7 first Mondays ==");
const D = 86_400_000; const starts: number[] = []; for (let d = START; d + 84 * D <= END; d += D) { const w = new Date(d).getUTCDay(); if (w >= 1 && w <= 5) starts.push(d + 7 * 3600_000); }
const fm: number[] = []; for (let d = START; d < SPLIT; d += D) { const x = new Date(d); if (x.getUTCDay() === 1 && x.getUTCDate() <= 7) fm.push(d + 7 * 3600_000); }
const cotFirst = (c: { s: string; i: number; x: { d: number } }[]) => [...c].sort((a, b) => cs(b.s, b.i) * b.x.d - cs(a.s, a.i) * a.x.d);
const C: [string, Record<string, any>, Rules, Acct][] = [["weekly cycle", dec, WKR, { maxOpen: 4 }], ["+ COT 61st voter", dec61, WKR, { maxOpen: 4 }], ["+ COT veto", dec, veto, { maxOpen: 4 }], ["+ COT-agreeing pairs get the slots first", dec, WKR, { maxOpen: 4, order: cotFirst as any }]];
for (const [n, d, R, A] of C) { const e = starts.map((s) => account(d, R, s, s + 84 * D, A)).sort((a, b) => a - b), k = e.length;
  console.log(`${n.padEnd(42)} $${e[k >> 1].toFixed(2)} x${Math.exp(e.reduce((a, x) => a + Math.log(x / 10), 0) / k).toFixed(2)} ${Math.round(100 * e.filter((x) => x < 5).length / k)}%<5 ${Math.round(100 * e.filter((x) => x >= 20).length / k)}%20+ | year: ${fm.map((s) => "$" + account(d, R, s, END, A).toFixed(0)).join(" ")}`); }
