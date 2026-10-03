// Would more voters help? Random subsets of the 60 live voters (each on its live timeframe), majority with
// a quorum of half the subset (live: 30 of 60), traded with the weekly cycle (Mon-Tue entries, to Friday),
// one position per pair. If results still climb at 60, more (different) voters should help; if flat, not.
import { LIVE, aligned, type Decision } from "./book-lib.mts";
import { m30, SYMS, LIVE_RULES, runPairs, type Rules } from "./r-lib.mts";

const dow = (s: string, i: number) => new Date(m30[s].t[i] + 1800_000).getUTCDay();
const WKR: Rules = { ...LIVE_RULES, hold: 300, entry: (s: string, i: number) => dow(s, i) <= 2 };
function dec(vs: typeof LIVE): Record<string, Decision[]> {
  const q = Math.ceil(vs.length / 2), out: Record<string, Decision[]> = {};
  for (const s of SYMS) { const arr = vs.map((v) => aligned[v.tf][s][v.id]), n = m30[s].t.length, a: Decision[] = new Array(n);
    for (let i = 0; i < n; i++) { let b = 0, se = 0; for (const x of arr) { if (x[i] > 0) b++; else if (x[i] < 0) se++; } const d = b + se >= q ? Math.sign(b - se) : 0; a[i] = { d, share: Math.max(b, se) / Math.max(1, b + se), buy: b, sell: se }; }
    out[s] = a; }
  return out;
}
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a: number[]) => Math.sqrt(mean(a.map((x) => (x - mean(a)) ** 2)));
const full = runPairs(dec(LIVE), WKR); console.log(`check: all 60 -> ${full.length} trades, total $${full.reduce((a, x) => a + x.pnl, 0).toFixed(2)} (weekly cycle reference $35.06)`);
let r = 12345; const rnd = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648);
for (const n of [5, 10, 20, 30, 40, 50]) { const sel: number[] = [], te: number[] = [], tot: number[] = [];
  for (let k = 0; k < 40; k++) { const vs = [...LIVE].map((v) => [rnd(), v] as const).sort((a, b) => a[0] - b[0]).slice(0, n).map((z) => z[1]); const t = runPairs(dec(vs), WKR);
    sel.push(mean(t.filter((x) => x.part === "sel").map((x) => x.pnl))); te.push(mean(t.filter((x) => x.part === "test").map((x) => x.pnl))); tot.push(t.reduce((a, x) => a + x.pnl, 0)); }
  console.log(`${String(n).padStart(2)} voters (40 random sets): per trade sel $${mean(sel).toFixed(3)} test $${mean(te).toFixed(3)} | year total $${mean(tot).toFixed(2)} (spread ±${sd(tot).toFixed(2)}, worst $${Math.min(...tot).toFixed(2)})`); }
const t60 = full; console.log(`60 voters (the live set):          per trade sel $${mean(t60.filter((x) => x.part === "sel").map((x) => x.pnl)).toFixed(3)} test $${mean(t60.filter((x) => x.part === "test").map((x) => x.pnl)).toFixed(3)} | year total $${t60.reduce((a, x) => a + x.pnl, 0).toFixed(2)}`);
// how alike are the voters? average pairwise agreement among voters that both have an opinion
let agree = 0, both = 0; for (const s of SYMS) for (let i = 2000; i < m30[s].t.length; i += 7) { const v = LIVE.map((x) => aligned[x.tf][s][x.id][i]);
  for (let a = 0; a < v.length; a++) for (let b = a + 1; b < v.length; b++) if (v[a] && v[b]) { both++; if (v[a] === v[b]) agree++; } }
console.log(`voters agree with each other ${(100 * agree / both).toFixed(0)}% of the time when both have an opinion (50% = independent)`);
