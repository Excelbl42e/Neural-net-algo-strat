import fs from "node:fs";
import { STRATEGIES, type Bars } from "../../artifacts/api-server/src/lib/poll-strategies.ts";
const raw = JSON.parse(fs.readFileSync(new URL("./data", import.meta.url).pathname + "/candles2y.json", "utf8"));
const rows = raw.frxEURUSD.M30.filter((r: number[]) => r[0] % 1800 === 0);
const b: Bars = { t: rows.map((r: number[]) => r[0] * 1000), o: rows.map((r: number[]) => r[1]), h: rows.map((r: number[]) => r[2]), l: rows.map((r: number[]) => r[3]), c: rows.map((r: number[]) => r[4]) };
for (const id of ["lyapunov_regime", "recurrence_determinism", "phase_space_analogues"]) {
  const st = STRATEGIES.find((s) => s.id === id)!; const t0 = Date.now(); const v = st.compute(b, { symbol: "frxEURUSD", closes: {} });
  let n = 0; for (const x of v) if (x) n++; console.log(id, Date.now() - t0, "ms, votes on", (100 * n / v.length).toFixed(1) + "% of bars");
}
