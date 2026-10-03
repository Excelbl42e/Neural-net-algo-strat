import { openPublic } from "./bt-derivws.mts";
const c = await openPublic();
for (const count of [500, 1000, 3000, 5000]) {
  const m = await c.req({ ticks_history: "frxEURUSD", granularity: 1800, end: "latest", count, style: "candles" });
  console.log(count, m.error?.message ?? m.candles.length, m.candles && new Date(m.candles[0].epoch*1000).toISOString());
}
c.close(); process.exit(0);
