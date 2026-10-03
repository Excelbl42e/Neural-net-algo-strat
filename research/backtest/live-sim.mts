// Mirrors the worker: stored rows (Date + string prices, newest first, limit 4200) -> pollBars -> cross closes -> runPoll.
import fs from "node:fs";
import { runPoll, pollBars, pollLevels, POLL_HISTORY_BARS } from "../../artifacts/api-server/src/lib/poll-engine.ts";
const raw = JSON.parse(fs.readFileSync(new URL("./data", import.meta.url).pathname + "/candles2y.json", "utf8"));
const scanAt = Date.parse(process.env.AT ?? "2026-09-30T14:00:20Z");
const history = new Map();
for (const [sym, tf] of Object.entries<any>(raw)) {
  const rows = tf.M30.filter((r: number[]) => r[0] * 1000 + 1_800_000 <= scanAt).slice(-POLL_HISTORY_BARS).reverse()
    .map((r: number[]) => ({ t: new Date(r[0] * 1000), o: String(r[1]), h: String(r[2]), l: String(r[3]), c: String(r[4]) }));
  history.set(sym, pollBars(rows.reverse()));
}
const t0 = Date.now();
for (const [sym, bars] of history) {
  const index = new Map(bars.t.map((t: number, i: number) => [t, i])); const closes: Record<string, number[]> = {};
  for (const [o, ob] of history) { const a = new Array(bars.t.length).fill(NaN); ob.t.forEach((t: number, j: number) => { const i = index.get(t); if (i != null) a[i] = ob.c[j]; }); closes[o] = a; }
  const p = runPoll(bars, { symbol: sym, closes }, 0.7);
  const lv = p.direction ? pollLevels(p.direction, bars.c.at(-1), p.atr, 1.5) : null;
  console.log(sym.padEnd(10), new Date(bars.t.at(-1)).toISOString().slice(0, 16), p.reason, lv ? `stop ${lv.stop.toFixed(5)} target ${lv.target.toFixed(5)}` : "");
}
console.log("14 pairs polled in", Date.now() - t0, "ms");
