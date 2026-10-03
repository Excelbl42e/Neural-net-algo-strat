import fs from "node:fs";
import { m30, SPLIT, commissionBps, exitIndex } from "./cand-lib.mts";
const c: any[] = JSON.parse(fs.readFileSync("candidates1y.json", "utf8"));
const r: Record<string, number[]> = { sel: [], test: [] }; let bars = 0;
for (const x of c) {
  const b = m30[x.sym]; let i = b.t.findIndex((t) => t + 1800_000 >= x.t); if (i < 0 || i + 1 >= b.t.length) continue; i = Math.max(0, i - 0);
  const d = x.dir === "buy" ? 1 : -1, e = exitIndex(x.sym, i, 192), e0 = b.o[i + 1];
  r[x.t < SPLIT ? "sel" : "test"].push(d * (b.c[e] - e0) / e0 * 1e4 - commissionBps(b.t[i + 1]));
}
for (const s of Object.values(m30)) bars += s.t.length;
const m = (a: number[]) => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1);
console.log(`ICT setups: ${c.length} over the year = votes on ${(100 * c.length / bars).toFixed(2)}% of pair-candles; 4-day hold after each: selection ${m(r.sel)} bps (${r.sel.length}), test ${m(r.test)} bps (${r.test.length})`);
