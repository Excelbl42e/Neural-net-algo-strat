// Votes for every strategy on a given timeframe (M30 | H1 | H4), all pairs, cached to votes-<TF>.json.
import fs from "node:fs";
import { STRATEGIES, type Bars } from "../../artifacts/api-server/src/lib/poll-strategies.ts";
const B = new URL("./data", import.meta.url).pathname + "";
const TF = process.argv[2] ?? "H1";
const raw: Record<string, Record<string, number[][]>> = JSON.parse(fs.readFileSync(B + "/candles2y.json", "utf8"));
export function barsFor(rows: number[][], tf: string): Bars {
  const sec = tf === "M30" ? 1800 : 3600;
  const r = rows.filter((x) => x[0] % sec === 0);
  if (tf !== "H4") return { t: r.map((x) => x[0] * 1000), o: r.map((x) => x[1]), h: r.map((x) => x[2]), l: r.map((x) => x[3]), c: r.map((x) => x[4]) };
  const b: Bars = { t: [], o: [], h: [], l: [], c: [] };
  for (const x of r) {
    const t4 = Math.floor(x[0] / 14400) * 14400 * 1000, n = b.t.length;
    if (n && b.t[n - 1] === t4) { b.h[n - 1] = Math.max(b.h[n - 1], x[2]); b.l[n - 1] = Math.min(b.l[n - 1], x[3]); b.c[n - 1] = x[4]; }
    else { b.t.push(t4); b.o.push(x[1]); b.h.push(x[2]); b.l.push(x[3]); b.c.push(x[4]); }
  }
  return b;
}
const bars: Record<string, Bars> = {};
for (const [s, tf] of Object.entries(raw)) bars[s] = barsFor(tf[TF === "M30" ? "M30" : "H1"], TF);
const syms = Object.keys(bars), out: Record<string, Record<string, number[]>> = {};
for (const s of syms) {
  const idx = new Map(bars[s].t.map((t, i) => [t, i])); const closes: Record<string, number[]> = {};
  for (const o of syms) { const a = new Array(bars[s].t.length).fill(NaN); bars[o].t.forEach((t, j) => { const i = idx.get(t); if (i != null) a[i] = bars[o].c[j]; }); closes[o] = a; }
  out[s] = { t: bars[s].t };
  for (const st of STRATEGIES) out[s][st.id] = Array.from(st.compute(bars[s], { symbol: s, closes }));
  process.stderr.write(s + " ");
}
fs.writeFileSync(`${B}/votes-${TF}.json`, JSON.stringify(out));
console.log("\n", TF, "done", syms.map((s) => bars[s].t.length).join(","));
