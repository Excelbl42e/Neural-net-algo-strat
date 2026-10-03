// Computes every strategy's vote series for every pair and caches them.
import fs from "node:fs";
import { STRATEGIES, type Bars } from "../../artifacts/api-server/src/lib/poll-strategies.ts";
const B = new URL("./data", import.meta.url).pathname + "";
const raw: Record<string, Record<string, number[][]>> = JSON.parse(fs.readFileSync(B + "/candles2y.json", "utf8"));
const bars: Record<string, Bars> = {};
for (const [s, tf] of Object.entries(raw)) {
  const rows = tf.M30.filter((r) => r[0] % 1800 === 0);
  bars[s] = { t: rows.map((r) => r[0] * 1000), o: rows.map((r) => r[1]), h: rows.map((r) => r[2]), l: rows.map((r) => r[3]), c: rows.map((r) => r[4]) };
}
const syms = Object.keys(bars);
const only = process.env.ONLY?.split(",");
const outFile = B + "/votes.json";
const cache: Record<string, Record<string, number[]>> = fs.existsSync(outFile) && !process.env.FRESH ? JSON.parse(fs.readFileSync(outFile, "utf8")) : {};
const timing: Record<string, number> = {};
for (const s of syms) {
  const idx = new Map(bars[s].t.map((t, i) => [t, i]));
  const closes: Record<string, number[]> = {};
  for (const o of syms) { const arr = new Array(bars[s].t.length).fill(NaN); bars[o].t.forEach((t, j) => { const i = idx.get(t); if (i != null) arr[i] = bars[o].c[j]; }); closes[o] = arr; }
  cache[s] ??= {};
  for (const st of STRATEGIES) {
    if (only && !only.includes(st.id)) continue;
    if (!only && cache[s][st.id]) continue;
    const t0 = Date.now();
    cache[s][st.id] = Array.from(st.compute(bars[s], { symbol: s, closes }));
    timing[st.id] = (timing[st.id] ?? 0) + Date.now() - t0;
  }
  process.stderr.write(s + " ");
}
fs.writeFileSync(outFile, JSON.stringify(cache));
console.log("\n", STRATEGIES.length, "strategies;", Object.entries(timing).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}:${v}ms`).join(" "));
