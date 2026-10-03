import fs from "node:fs";
import { openPublic } from "./bt-derivws.mts";
import { ALL_FOREX_INSTRUMENTS } from "../../artifacts/api-server/src/lib/synthetic-catalog.ts";
const OUT = new URL("./data", import.meta.url).pathname + "/candles.json";
const DAYS = 100;
const c = await openPublic();
const since = Math.floor(Date.now() / 1000) - DAYS * 86400;
const data: Record<string, Record<string, number[][]>> = {};
for (const sym of ALL_FOREX_INSTRUMENTS) {
  data[sym] = {};
  for (const [tf, g] of [["M5", 300], ["M30", 1800], ["H1", 3600], ["H4", 14400]] as const) {
    const all = new Map<number, number[]>();
    let end: number | "latest" = "latest";
    const startNeeded = tf === "H4" ? since - 60 * 86400 : tf === "H1" ? since - 20 * 86400 : since - 5 * 86400;
    for (let page = 0; page < 60; page++) {
      const m = await c.req({ ticks_history: sym, granularity: g, end: String(end), count: 5000, style: "candles" });
      if (m.error) { console.log(sym, tf, "error", m.error.message); break; }
      const cs = m.candles as any[];
      if (!cs.length) break;
      for (const k of cs) all.set(k.epoch, [k.epoch, +k.open, +k.high, +k.low, +k.close]);
      const first = cs[0].epoch;
      if (first <= startNeeded) break;
      if (end !== "latest" && first >= (end as number)) break;
      end = first - 1;
    }
    const arr = [...all.values()].sort((a, b) => a[0] - b[0]);
    data[sym][tf] = arr;
    console.log(sym, tf, arr.length, new Date(arr[0][0] * 1000).toISOString().slice(0, 16), "..", new Date(arr.at(-1)![0] * 1000).toISOString().slice(0, 16));
  }
}
c.close();
fs.writeFileSync(OUT, JSON.stringify(data));
console.log("saved", (fs.statSync(OUT).size / 1e6).toFixed(1), "MB");
process.exit(0);
