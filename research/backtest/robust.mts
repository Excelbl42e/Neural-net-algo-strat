import fs from "node:fs";
import { m30, SYMS, SPLIT, START, aligned, loadTF, commissionBps, canOpen, exitIndex } from "./cand-lib.mts";
for (const tf of ["M30", "H1", "H4"]) loadTF(tf);
const best = JSON.parse(fs.readFileSync(`${new URL("./data", import.meta.url).pathname + ""}/poll-opt-best.json`, "utf8"));
const voters: { id: string; tf: string }[] = best.voters;
function run(agree: number, quorum: number, hb: number, from: number, to: number) {
  const out: { s: string; t: number; r: number; d: number }[] = [];
  for (const s of SYMS) {
    const b = m30[s], vs = voters.map((v) => aligned[v.tf][s][v.id]); let busyTo = -1;
    for (let i = 1; i < b.t.length - 1; i++) {
      if (i <= busyTo || b.t[i] < from || b.t[i] >= to || !canOpen(b.t[i] + 1800_000) || b.t[i + 1] - b.t[i] > 1800_000) continue;
      let up = 0, dn = 0; for (const v of vs) { if (v[i] > 0) up++; else if (v[i] < 0) dn++; }
      const p = up + dn; if (p < quorum || up === dn || Math.max(up, dn) / p < agree) continue;
      const d = up > dn ? 1 : -1, e = exitIndex(s, i, hb), e0 = b.o[i + 1];
      out.push({ s, t: b.t[i], d, r: d * (b.c[e] - e0) / e0 * 1e4 - commissionBps(b.t[i + 1]) }); busyTo = e;
    }
  }
  return out;
}
const m = (a: number[]) => +(a.reduce((x, y) => x + y, 0) / (a.length || 1)).toFixed(1);
console.log("sensitivity (bps/trade selection | test), majority 0.5:");
for (const hb of [96, 144, 192, 240]) for (const q of [20, 25, 30, 35, 40]) {
  const a = run(0.5, q, hb, START, SPLIT).map((x) => x.r), b = run(0.5, q, hb, SPLIT, Infinity).map((x) => x.r);
  process.stdout.write(`hold ${hb / 2}h q${q}: ${m(a)} (${a.length}) | ${m(b)} (${b.length})   `); if (q === 40) console.log();
}
const all = run(0.5, 30, 192, START, Infinity);
const by = (f: (x: any) => string) => { const g: Record<string, number[]> = {}; for (const x of all) (g[f(x)] ??= []).push(x.r); return Object.entries(g).sort().map(([k, v]) => `${k}: ${m(v)} (${v.length})`).join("  "); };
console.log("\nby month:", by((x) => new Date(x.t).toISOString().slice(0, 7)));
console.log("\nby pair:", by((x) => x.s.slice(3)));
console.log("\nby side:", by((x) => (x.d > 0 ? "buy" : "sell")));
const rs = all.map((x) => x.r), mean = rs.reduce((a, b) => a + b, 0) / rs.length, sd = Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / rs.length);
console.log(`\nfull period n ${rs.length} mean ${mean.toFixed(1)} bps sd ${sd.toFixed(0)} t~${(mean / (sd / Math.sqrt(rs.length))).toFixed(2)}`);
