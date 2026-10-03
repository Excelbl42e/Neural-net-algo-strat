// Scores each strategy alone on the selection period (before SPLIT).
import fs from "node:fs";
import { B, bars, votes, SYMS, SPLIT, WARM, canOpen, simTrade, STRAT_IDS, FAMILY } from "./poll-lib.mts";
const br = { stopAtr: +(process.env.SA ?? 3), rr: +(process.env.RR ?? 1.5), holdBars: 48, stake: 1, mult: 100 };
const rows: any[] = [];
for (const id of STRAT_IDS) {
  const per = { train: [] as number[], test: [] as number[] };
  let dirHits = 0, dirN = 0;
  for (const s of SYMS) {
    const v = votes[s][id], b = bars[s];
    for (let i = 0; i < v.length - 1; i++) {
      if (!v[i] || b.t[i] < WARM || !canOpen(b.t[i] + 1800_000, true)) continue;
      if (v[i - 1] === v[i] && i % 4 !== 0) continue; // sample persistent votes every 2h, new votes always
      const f = simTrade(s, i, v[i] as 1 | -1, br); if (!f) continue;
      (b.t[i] < SPLIT ? per.train : per.test).push(f.pnl / f.risk);
      if (b.t[i] < SPLIT && i + 12 < b.c.length) { dirN++; if (Math.sign(b.c[i + 12] - b.c[i]) === v[i]) dirHits++; }
    }
  }
  const st = (a: number[]) => { const m = a.reduce((x, y) => x + y, 0) / (a.length || 1); const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); return { n: a.length, meanR: +m.toFixed(3), t: +(m / (sd / Math.sqrt(a.length || 1))).toFixed(2) }; };
  rows.push({ id, fam: FAMILY[id], train: st(per.train), test: st(per.test), hit6h: +(dirHits / (dirN || 1) * 100).toFixed(1) });
}
rows.sort((a, b) => b.train.meanR - a.train.meanR);
fs.writeFileSync(B + "/poll-score.json", JSON.stringify(rows, null, 1));
for (const r of rows) console.log(r.fam.padEnd(5), r.id.padEnd(30), "train", String(r.train.n).padStart(6), String(r.train.meanR).padStart(7), String(r.train.t).padStart(6), " | test", String(r.test.n).padStart(5), String(r.test.meanR).padStart(7), " hit6h", r.hit6h);
