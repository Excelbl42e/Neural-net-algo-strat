// The two extra signals that survived their first tests, as reusable pieces:
//   cotFade(s, t)       fade speculators' 3-year COT positioning extremes (r-cot.mts: +7.6 bps/week over 12 years)
//   installFluid()      "fluid_reynolds" voter at 2x length (r-physics.mts), added as aligned.M30[s].fluid_reynolds
import fs from "node:fs";
import { aligned } from "./book-lib.mts";
import { m30, SYMS } from "./r-lib.mts";

const B = new URL("./data", import.meta.url).pathname, WEEK = 7 * 86_400_000;
const CODE: Record<string, string> = { "099741": "EUR", "096742": "GBP", "097741": "JPY", "232741": "AUD", "090741": "CAD", "092741": "CHF" };
const mondayOf = (ms: number) => { const d = new Date(ms); const day = (d.getUTCDay() + 6) % 7; return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day); };
const cot: Record<string, Map<number, number>> = {};
for (const r of JSON.parse(fs.readFileSync(B + "/cot.json", "utf8"))) { const c = CODE[r.cftc_contract_market_code]; if (!c) continue;
  (cot[c] ??= new Map()).set(mondayOf(Date.parse(r.report_date_as_yyyy_mm_dd.slice(0, 10) + "T00:00:00Z")) + WEEK, (+r.noncomm_positions_long_all - +r.noncomm_positions_short_all) / Math.max(1, +r.open_interest_all)); }
const net = (c: string, w: number) => (c === "USD" ? 0 : cot[c]?.get(w));
const diff = (p: string, w: number) => { const a = net(p.slice(0, 3), w), b = net(p.slice(3), w); return a == null || b == null ? null : a - b; };
const memo = new Map<string, number>();
/** +1 buy / -1 sell / 0: fade the pair's COT positioning when it is outside its 10th-90th percentile of the last 156 weeks. */
export function cotFade(s: string, t: number) { const p = s.slice(3), w = mondayOf(t), k = `${p}|${w}`; if (memo.has(k)) return memo.get(k)!;
  const x = diff(p, w); let v = 0; if (x != null) { const h: number[] = []; for (let j = 1; j <= 156; j++) { const y = diff(p, w - j * WEEK); if (y != null) h.push(y); }
    if (h.length >= 125) { const r = h.filter((y) => y < x).length / h.length; v = r > 0.9 ? -1 : r < 0.1 ? 1 : 0; } }
  memo.set(k, v); return v; }

export function installFluid(m = 2) {
  for (const s of SYMS) { const c = m30[s].c, L = 48 * m, v = new Int8Array(c.length), re: number[] = [];
    const r = c.map((x, i) => (i ? Math.log(x / c[i - 1]) : 0));
    for (let i = L; i < c.length; i++) { let a = 0, a2 = 0; for (let k = i - L + 1; k <= i; k++) { a += r[k]; a2 += r[k] ** 2; } const mu = a / L, va = Math.max(1e-14, a2 / L - mu * mu);
      const R = Math.abs(mu) / Math.sqrt(va); re.push(R); if (re.length > 2000) re.shift(); v[i] = re.length > 300 && re.filter((q) => q < R).length / re.length > 0.7 ? Math.sign(mu) : 0; }
    aligned.M30[s]["fluid_reynolds"] = v; }
}
