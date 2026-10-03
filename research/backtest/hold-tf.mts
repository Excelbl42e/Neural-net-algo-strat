// Holding time (2, 3, 4 days) crossed with timeframe choices, live rules otherwise (0.6% stop, 1.5x target,
// Friday 20:30 close, simple majority, quorum 30, one position per pair), plus the $10 account
// (every vote until one stake of free balance is left, 5% risk).
// Timeframe choices:
//   live mix          each voter on the timeframe the search picked for the 4-day hold (28 M30, 14 H1, 18 H4)
//   all M30/H1/H4     every voter on one timeframe
//   re-tuned mix      each voter on its best timeframe for THIS hold, picked on the selection months only
//   decide on H1/H4   live mix, but the poll is only taken at H1 / H4 closes (fewer, later entries)
import { m30, SYMS, SPLIT, START, aligned, LIVE, decisions, runPairs, summary, rollingRuns, okTime, setHold, type Voter, type Decision } from "./book-lib.mts";
import { commissionBps, exitIndex } from "./cand-lib.mts";

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const ids = LIVE.map((v) => v.id);
/** selection-months score of one voter alone at a hold: bps per vote after commission */
function selScore(v: Voter, hold: number) { const r: number[] = [];
  for (const s of SYMS) { const b = m30[s], a = aligned[v.tf][s][v.id];
    for (let i = 1; i < b.t.length - 1; i += 2) { if (b.t[i] < START || b.t[i] >= SPLIT || !a[i] || !okTime(b.t[i] + 1800_000)) continue;
      const e = exitIndex(s, i, hold); r.push(a[i] * (b.c[e] - b.o[i + 1]) / b.o[i + 1] * 1e4 - commissionBps(b.t[i + 1])); } }
  return mean(r); }
const cadence = (min: number) => (s: string, i: number) => ((m30[s].t[i] + 1800_000) / 60_000) % min === 0;
const blank = (dec: Record<string, Decision[]>, keep: (s: string, i: number) => boolean) => Object.fromEntries(SYMS.map((s) => [s, dec[s].map((x, i) => (keep(s, i) ? x : { ...x, d: 0 }))]));

const rows: { hold: string; name: string; total: number; line: string; r12: string; r26: string }[] = [];
for (const days of [2, 3, 4]) {
  const hold = days * 48; setHold(hold);
  const retuned = ids.map((id) => ["M30", "H1", "H4"].map((tf) => ({ id, tf, sc: selScore({ id, tf }, hold) })).reduce((a, b) => (b.sc > a.sc ? b : a)));
  const live = decisions(LIVE);
  const sets: [string, Record<string, Decision[]>][] = [
    ["live mix (now)", live],
    ["all M30", decisions(ids.map((id) => ({ id, tf: "M30" })))],
    ["all H1", decisions(ids.map((id) => ({ id, tf: "H1" })))],
    ["all H4", decisions(ids.map((id) => ({ id, tf: "H4" })))],
    [`re-tuned mix (${["M30", "H1", "H4"].map((tf) => retuned.filter((x) => x.tf === tf).length).join("/")})`, decisions(retuned)],
    ["live mix, decide on H1 closes", blank(live, cadence(60))],
    ["live mix, decide on H4 closes", blank(live, cadence(240))],
  ];
  console.log(`\n== hold ${days} days ==`);
  for (const [name, dec] of sets) { const t = runPairs(dec), line = summary(t);
    const r12 = rollingRuns(dec, 12), r26 = rollingRuns(dec, 26);
    console.log(name.padEnd(34), line); console.log("".padEnd(34), "$10 12d", r12); console.log("".padEnd(34), "$10 26d", r26);
    rows.push({ hold: `${days}d`, name, total: t.reduce((a, x) => a + x.pnl, 0), line, r12, r26 }); }
}
setHold(192);
