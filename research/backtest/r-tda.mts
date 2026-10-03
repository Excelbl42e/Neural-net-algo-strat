// Algebraic topology (topological data analysis): persistent homology of recent market moves, as in
// Gidea & Katz (2018), "Topological data analysis of financial time series: landscapes of crashes".
// Point cloud = the last 50 H4 bars, each a point in 7-D (standardized log returns of the 7 USD pairs).
// Vietoris-Rips filtration up to triangles; H1 (loops) persistence by Z/2 boundary-matrix reduction.
// "TDA norm" = total H1 persistence (sum of loop lifetimes). Per pair: the same on a 4-D delay embedding
// (Takens) of that pair's last 53 H1 returns. Used as a regime filter on the weekly cycle.
import { LIVE, decisions } from "./book-lib.mts";
import { m30, SYMS, START, END, SPLIT, LIVE_RULES, runPairs, sumLine, account, type Rules, type Tr } from "./r-lib.mts";

/** Total H1 persistence of the Rips filtration of points P. */
export function h1Persistence(P: number[][]) {
  const n = P.length, D: number[][] = P.map((a) => P.map((b) => Math.sqrt(a.reduce((s, x, k) => s + (x - b[k]) ** 2, 0))));
  const edges: [number, number, number][] = []; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) edges.push([D[i][j], i, j]);
  edges.sort((a, b) => a[0] - b[0]); const eid = new Map<number, number>(); edges.forEach((e, k) => eid.set(e[1] * n + e[2], k));
  const E = (i: number, j: number) => (i < j ? eid.get(i * n + j)! : eid.get(j * n + i)!);
  // H0 via union-find: edges that merge components are negative (not loop births)
  const par = Array.from({ length: n }, (_, i) => i), find = (x: number): number => (par[x] === x ? x : (par[x] = find(par[x])));
  const negEdge = new Uint8Array(edges.length); edges.forEach(([, i, j], k) => { const a = find(i), b = find(j); if (a !== b) { par[a] = b; negEdge[k] = 1; } });
  const tris: [number, number[]][] = []; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let k = j + 1; k < n; k++) { const b = [E(i, j), E(i, k), E(j, k)].sort((x, y) => x - y); tris.push([edges[b[2]][0], b]); }
  tris.sort((a, b) => a[0] - b[0] || a[1][2] - b[1][2]);
  const pivot = new Map<number, number[]>(); let total = 0;
  for (const [f, bd] of tris) { let col = bd;
    while (col.length) { const low = col[col.length - 1], other = pivot.get(low); if (!other) break; // XOR (sorted merge)
      const out: number[] = []; let a = 0, b = 0; while (a < col.length || b < other.length) { if (b >= other.length || (a < col.length && col[a] < other[b])) out.push(col[a++]); else if (a >= col.length || other[b] < col[a]) out.push(other[b++]); else { a++; b++; } } col = out; }
    if (col.length) { const low = col[col.length - 1]; pivot.set(low, col); if (!negEdge[low]) total += f - edges[low][0]; } }
  return total;
}
// self-check: points on a circle have one long loop; a tight blob has almost none
const circle = Array.from({ length: 20 }, (_, k) => [Math.cos(2 * Math.PI * k / 20), Math.sin(2 * Math.PI * k / 20)]);
let r0 = 1; const rnd = () => ((r0 = (r0 * 1103515245 + 12345) % 2147483648) / 2147483648);
console.log(`self-check: circle H1 total ${h1Persistence(circle).toFixed(2)} (expect ~1.4), random blob ${h1Persistence(Array.from({ length: 20 }, () => [rnd() * 0.2, rnd() * 0.2])).toFixed(3)} (expect small)`);

const USD = ["frxEURUSD", "frxGBPUSD", "frxUSDJPY", "frxAUDUSD", "frxUSDCAD", "frxUSDCHF"].filter((s) => SYMS.includes(s));
// H4 closes on a common clock
const clock = [...new Set(USD.flatMap((s) => m30[s].t.filter((t) => t % 14_400_000 === 14_400_000 - 1800_000)))].sort((a, b) => a - b);
const px: Record<string, Map<number, number>> = Object.fromEntries(USD.map((s) => [s, new Map(m30[s].t.map((t, i) => [t, m30[s].c[i]]))]));
const rows: { t: number; r: number[] }[] = []; let prev: number[] | null = null;
for (const t of clock) { const c = USD.map((s) => px[s].get(t)); if (c.some((x) => x == null)) continue; if (prev) rows.push({ t, r: c.map((x, k) => Math.log(x! / prev![k])) }); prev = c as number[]; }
const sd = USD.map((_, k) => Math.sqrt(rows.reduce((a, x) => a + x.r[k] ** 2, 0) / rows.length));
// market-wide TDA norm at each H4 close (window 50)
const norm = new Map<number, number>(); for (let i = 50; i < rows.length; i++) norm.set(rows[i].t, h1Persistence(rows.slice(i - 50, i).map((x) => x.r.map((v, k) => v / sd[k]))));
const nt = [...norm.keys()].sort((a, b) => a - b);
const normAt = (t: number) => { let lo = 0, hi = nt.length - 1; if (t < nt[0]) return null; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (nt[m] <= t) lo = m; else hi = m - 1; } return norm.get(nt[lo])!; };
const pctAt = (t: number) => { const x = normAt(t); if (x == null) return null; const hist = nt.filter((u) => u <= t && u > t - 120 * 86_400_000).map((u) => norm.get(u)!); return hist.length < 100 ? null : hist.filter((v) => v < x).length / hist.length; };

const dow = (s: string, i: number) => new Date(m30[s].t[i] + 1800_000).getUTCDay();
const WKR: Rules = { ...LIVE_RULES, hold: 300, entry: (s, i) => dow(s, i) <= 2 };
const dec = decisions(LIVE), base = runPairs(dec, WKR);
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
console.log("\n== weekly-cycle trades by market-wide TDA norm at entry (percentile vs the previous 120 days) ==");
const withP = base.map((x) => ({ x, p: pctAt(m30[x.s].t[x.i] + 1800_000) })).filter((z) => z.p != null) as { x: Tr; p: number }[];
for (const [a, b] of [[0, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 1.01]]) { const g = withP.filter((z) => z.p >= a && z.p < b); const s = g.filter((z) => z.x.part === "sel"), e = g.filter((z) => z.x.part === "test");
  console.log(`  ${(a * 100).toFixed(0).padStart(3)}-${Math.min(100, b * 100).toFixed(0)}th pct: n ${String(g.length).padStart(3)} sel $${mean(s.map((z) => z.x.pnl)).toFixed(3)} (${s.length}) test $${mean(e.map((z) => z.x.pnl)).toFixed(3)} (${e.length})`); }
const tdaOk = (th: number, above: boolean) => (s: string, i: number) => { const p = pctAt(m30[s].t[i] + 1800_000); return p == null || (above ? p <= th : p >= th); };
console.log("\n== as a filter (Gidea-Katz: high norm = turbulence ahead, so stand aside) ==");
console.log("weekly cycle".padEnd(40), sumLine(base));
for (const th of [0.7, 0.8, 0.9]) console.log(`skip when TDA norm > ${th * 100}th pct`.padEnd(40), sumLine(runPairs(dec, { ...WKR, entry: (s, i, x) => WKR.entry!(s, i, x) && tdaOk(th, true)(s, i) })));
for (const th of [0.2, 0.3]) console.log(`skip when TDA norm < ${th * 100}th pct`.padEnd(40), sumLine(runPairs(dec, { ...WKR, entry: (s, i, x) => WKR.entry!(s, i, x) && tdaOk(th, false)(s, i) })));
