import fs from "node:fs";
import { m30, SYMS, SPLIT, START, aligned, loadTF, commissionBps, canOpen, exitIndex } from "./cand-lib.mts";
const TFS = (process.env.TFS ?? "M30,H1,H4").split(",");
for (const tf of TFS) loadTF(tf);
const H = [24, 48, 96, 144, 192]; // M30 bars: 12h, 24h, 48h, 72h, 96h
const rows: any[] = [];
for (const tf of TFS) for (const id of Object.keys(aligned[tf][SYMS[0]])) {
  const acc = H.map(() => ({ tr: [] as number[], te: [] as number[] }));
  for (const s of SYMS) {
    const b = m30[s], v = aligned[tf][s][id];
    for (let i = 1; i < b.t.length - 1; i += 2) { // hourly decision samples
      const d = v[i]; if (!d || b.t[i] < START || !canOpen(b.t[i] + 1800_000)) continue;
      if (b.t[i + 1] - b.t[i] > 1800_000) continue;
      const e0 = b.o[i + 1], cost = commissionBps(b.t[i + 1]);
      H.forEach((hb, k) => { const e = exitIndex(s, i, hb); const r = d * (b.c[e] - e0) / e0 * 1e4 - cost; (b.t[i] < SPLIT ? acc[k].tr : acc[k].te).push(r); });
    }
  }
  const st = (a: number[]) => { const n = a.length, m = a.reduce((x, y) => x + y, 0) / (n || 1); const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, n - 1)); return { n, m: +m.toFixed(2), sd: +sd.toFixed(1) }; };
  rows.push({ tf, id, h: H.map((hb, k) => ({ hours: hb / 2, tr: st(acc[k].tr), te: st(acc[k].te) })) });
}
fs.writeFileSync(new URL("./data", import.meta.url).pathname + "/cand-score.json", JSON.stringify(rows));
// Summary: per horizon, how many candidates are positive in selection, and how selection-positive ones did on test.
for (let k = 0; k < H.length; k++) {
  const pos = rows.filter((r) => r.h[k].tr.m > 0);
  const top = [...rows].sort((a, b) => b.h[k].tr.m - a.h[k].tr.m).slice(0, 20);
  const avg = (xs: any[], f: (r: any) => number) => (xs.reduce((a, r) => a + f(r), 0) / (xs.length || 1)).toFixed(2);
  console.log(`hold ${H[k] / 2}h: ${pos.length}/${rows.length} candidates positive in selection; top20 selection avg ${avg(top, (r) => r.h[k].tr.m)} bps -> test avg ${avg(top, (r) => r.h[k].te.m)} bps; all candidates test avg ${avg(rows, (r) => r.h[k].te.m)}`);
}
