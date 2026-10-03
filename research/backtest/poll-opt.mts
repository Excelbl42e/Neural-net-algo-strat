import fs from "node:fs";
import { m30, SYMS, SPLIT, START, aligned, loadTF, commissionBps, canOpen, exitIndex } from "./cand-lib.mts";
import { STRATEGIES } from "../../artifacts/api-server/src/lib/poll-strategies.ts";
for (const tf of ["M30", "H1", "H4"]) loadTF(tf);
const score: any[] = JSON.parse(fs.readFileSync(new URL("./data", import.meta.url).pathname + "/cand-score.json", "utf8"));
const HB = [24, 48, 96, 144, 192];
function run(voters: { id: string; tf: string }[], agree: number, quorum: number, hb: number, from: number, to: number) {
  const out: number[] = [];
  for (const s of SYMS) {
    const b = m30[s], vs = voters.map((v) => aligned[v.tf][s][v.id]); let busyTo = -1;
    for (let i = 1; i < b.t.length - 1; i++) {
      if (i <= busyTo || b.t[i] < from || b.t[i] >= to || !canOpen(b.t[i] + 1800_000) || b.t[i + 1] - b.t[i] > 1800_000) continue;
      let up = 0, dn = 0; for (const v of vs) { if (v[i] > 0) up++; else if (v[i] < 0) dn++; }
      const p = up + dn; if (p < quorum || up === dn || Math.max(up, dn) / p < agree) continue;
      const d = up > dn ? 1 : -1, e = exitIndex(s, i, hb), e0 = b.o[i + 1];
      out.push(d * (b.c[e] - e0) / e0 * 1e4 - commissionBps(b.t[i + 1])); busyTo = e;
    }
  }
  const n = out.length, m = out.reduce((a, x) => a + x, 0) / (n || 1);
  return { n, bps: +m.toFixed(2), win: +(100 * out.filter((x) => x > 0).length / (n || 1)).toFixed(1) };
}
const results: any[] = [];
for (const [k, hb] of HB.entries()) {
  // Each strategy on the timeframe that scored best on the selection period for this hold.
  const voters = STRATEGIES.map((st) => { const c = score.filter((r) => r.id === st.id).sort((a, b) => b.h[k].tr.m - a.h[k].tr.m)[0]; return { id: st.id, tf: c.tf }; });
  for (const agree of [0.5, 0.55, 0.6, 0.65, 0.7, 0.8]) for (const quorum of [10, 20, 30]) {
    const tr = run(voters, agree, quorum, hb, START, SPLIT);
    results.push({ hold: hb / 2, agree, quorum, tr, voters });
  }
}
results.sort((a, b) => b.tr.bps - a.tr.bps);
console.log("Top 8 by selection period (Nov-Jun), then their untouched Jul-Sep result:");
for (const r of results.slice(0, 8)) {
  const te = run(r.voters, r.agree, r.quorum, r.hold * 2, SPLIT, Infinity);
  console.log(`hold ${r.hold}h agree ${r.agree} quorum ${r.quorum} | selection n ${r.tr.n} ${r.tr.bps} bps/trade win ${r.tr.win}% | TEST n ${te.n} ${te.bps} bps/trade win ${te.win}%`);
}
const best = results[0];
console.log("chosen TFs:", JSON.stringify(best.voters.reduce((m: any, v: any) => { m[v.tf] = (m[v.tf] ?? 0) + 1; return m; }, {})));
fs.writeFileSync(new URL("./data", import.meta.url).pathname + "/poll-opt-best.json", JSON.stringify(best));
