// Part 1: do the book strategies (book-voters.mts) earn their place in the poll?
//  a) each alone: value of its vote over the 4-day hold, net of commission (as cand-score.mts), per timeframe;
//  b) each added to the 60 live voters at its best selection-period timeframe, traded with the live rules;
//  c) the $10 account with the passing ones added.
import { m30, SYMS, SPLIT, START, aligned, LIVE, decisions, runPairs, summary, rollingRuns, okTime, type Voter } from "./book-lib.mts";
import { commissionBps, exitIndex } from "./cand-lib.mts";
import { BOOK_IDS } from "./book-voters.mts";

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
function alone(v: Voter) {
  const tr: number[] = [], te: number[] = []; let n = 0, voted = 0;
  for (const s of SYMS) { const b = m30[s], a = aligned[v.tf][s][v.id];
    for (let i = 1; i < b.t.length - 1; i += 2) { if (b.t[i] < START || !okTime(b.t[i] + 1800_000) || b.t[i + 1] - b.t[i] > 1800_000) continue; n++;
      const d = a[i]; if (!d) continue; voted++;
      const e0 = b.o[i + 1], e = exitIndex(s, i, 192), r = d * (b.c[e] - e0) / e0 * 1e4 - commissionBps(b.t[i + 1]); (b.t[i] < SPLIT ? tr : te).push(r); } }
  return { sel: mean(tr), test: mean(te), cover: voted / n };
}
console.log("== a) Each book strategy alone: bps per vote over the 4-day hold, after commission ==");
const best: Voter[] = [];
for (const id of BOOK_IDS) {
  const rows = ["M30", "H1", "H4"].map((tf) => ({ tf, ...alone({ id, tf }) }));
  console.log(id.padEnd(22), rows.map((r) => `${r.tf} sel ${r.sel.toFixed(1).padStart(6)} test ${r.test.toFixed(1).padStart(6)} (votes ${(100 * r.cover).toFixed(0)}%)`).join(" | "));
  const b = rows.reduce((a, r) => (r.sel > a.sel ? r : a)); best.push({ id, tf: b.tf });
}
const liveAlone = LIVE.map((v) => alone(v));
console.log(`for comparison, the 60 live voters alone: sel avg ${mean(liveAlone.map((x) => x.sel)).toFixed(1)} bps, test avg ${mean(liveAlone.map((x) => x.test)).toFixed(1)} bps`);

console.log("\n== b) Added to the live poll (61 voters), live rules, one trade per pair ==");
const base = runPairs(decisions(LIVE));
console.log("live poll (60)".padEnd(36), summary(base));
const passed: Voter[] = [];
for (const v of best) {
  const t = runPairs(decisions([...LIVE, v]));
  const selAvg = mean(t.filter((x) => x.part === "sel").map((x) => x.pnl)), baseSel = mean(base.filter((x) => x.part === "sel").map((x) => x.pnl));
  if (selAvg > baseSel) passed.push(v);
  console.log(`+ ${v.id} (${v.tf})`.padEnd(36), summary(t));
}
const allBook = runPairs(decisions([...LIVE, ...best]));
console.log("+ all 7 book strategies".padEnd(36), summary(allBook));
if (passed.length) console.log(`+ the ${passed.length} that beat the live poll on sel`.padEnd(36), summary(runPairs(decisions([...LIVE, ...passed]))), passed.map((p) => p.id).join(", "));

console.log("\n== c) $10 account, every vote until one stake is left ==");
const decs: [string, Voter[]][] = [["live poll", LIVE], ["+ all 7", [...LIVE, ...best]]]; if (passed.length) decs.push(["+ sel winners", [...LIVE, ...passed]]);
for (const [name, vs] of decs) { const d = decisions(vs); for (const days of [12, 26]) console.log(name.padEnd(14), String(days).padStart(2), "days:", rollingRuns(d, days)); }
