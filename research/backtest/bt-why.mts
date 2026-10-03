import fs from "node:fs";
import { planEntry } from "../../artifacts/api-server/src/lib/execution-risk.ts";
const c = JSON.parse(fs.readFileSync(new URL("./data", import.meta.url).pathname + "/candidates.json", "utf8"));
const reasons: Record<string, number> = {};
const pipsOf = (sym: string, d: number) => d / (/JPY/.test(sym) ? 0.01 : 0.0001);
const stopP: number[] = [], tgtP: number[] = [];
for (const x of c) {
  const mid = (x.lo + x.hi) / 2;
  stopP.push(pipsOf(x.sym, Math.abs(mid - x.stop))); tgtP.push(pipsOf(x.sym, Math.abs(x.target - mid)));
  let entered = false; const last: string[] = [];
  for (let k = 0; k <= 200; k++) {
    const p = x.dir === "buy" ? x.hi - k * (x.hi - x.lo) / 200 : x.lo + k * (x.hi - x.lo) / 200;
    const r = planEntry({ direction: x.dir, price: p, entryLow: x.lo, entryHigh: x.hi, stop: x.stop, target: x.target, minRiskReward: 1.0,
      bracket: { stake: 1, multiplier: 100, minStopUsd: 0.1, minTakeProfitUsd: 0.1, maxStopFraction: 0.8, commissionUsd: 0.02 } });
    if (r.action === "enter") { entered = true; break; }
    last.push((r as any).reason.replace(/[0-9.]+/g, "#").slice(0, 70));
  }
  const k = entered ? "ENTERS somewhere in zone" : last[last.length - 1];
  reasons[k] = (reasons[k] ?? 0) + 1;
}
const q = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return [0.25, 0.5, 0.75].map((f) => s[Math.floor(f * s.length)].toFixed(1)); };
console.log("stop distance from FVG mid, pips (25/50/75%):", q(stopP).join(" / "));
console.log("target distance from FVG mid, pips (25/50/75%):", q(tgtP).join(" / "));
console.log(Object.entries(reasons).sort((a, b) => b[1] - a[1]));
