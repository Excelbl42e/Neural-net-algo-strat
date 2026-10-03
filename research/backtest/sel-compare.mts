import fs from "node:fs";
import { m30, SYMS, SPLIT, START, aligned, loadTF, commissionBps, canOpen, exitIndex } from "./cand-lib.mts";
import { STRATEGIES } from "../../artifacts/api-server/src/lib/poll-strategies.ts";
for (const tf of ["M30", "H1", "H4"]) loadTF(tf);
const score: any[] = JSON.parse(fs.readFileSync("cand-score.json", "utf8"));
const fam = Object.fromEntries(STRATEGIES.map((s) => [s.id, s.family]));
const K = 3; // 96h column
function run(voters: { id: string; tf: string }[], q: number, from: number, to: number) {
  const out: number[] = [];
  for (const s of SYMS) { const b = m30[s], vs = voters.map((v) => aligned[v.tf][s][v.id]); let busy = -1;
    for (let i = 1; i < b.t.length - 1; i++) {
      if (i <= busy || b.t[i] < from || b.t[i] >= to || !canOpen(b.t[i] + 1800_000) || b.t[i + 1] - b.t[i] > 1800_000) continue;
      let up = 0, dn = 0; for (const v of vs) { if (v[i] > 0) up++; else if (v[i] < 0) dn++; }
      if (up + dn < q || up === dn) continue;
      const d = up > dn ? 1 : -1, e = exitIndex(s, i, 192), e0 = b.o[i + 1]; out.push(d * (b.c[e] - e0) / e0 * 1e4 - commissionBps(b.t[i + 1])); busy = e; } }
  return `${(out.reduce((a, x) => a + x, 0) / out.length).toFixed(1)} bps (${out.length})`;
}
const bestTf = STRATEGIES.map((st) => { const c = score.filter((r) => r.id === st.id).sort((a, b) => b.h[K].tr.m - a.h[K].tr.m)[0]; return { id: st.id, tf: c.tf }; });
const ranked = [...score].sort((a, b) => b.h[K].tr.m - a.h[K].tr.m);
const top = [...ranked.filter((r) => fam[r.id] === "quant").slice(0, 40), ...ranked.filter((r) => fam[r.id] === "ta").slice(0, 20)].map((r) => ({ id: r.id, tf: r.tf }));
for (const q of [25, 30, 35]) {
  console.log(`quorum ${q} | each strategy once, best TF: sel ${run(bestTf, q, START, SPLIT)} test ${run(bestTf, q, SPLIT, Infinity)} | top 40+20 of 180: sel ${run(top, q, START, SPLIT)} test ${run(top, q, SPLIT, Infinity)}`);
}
