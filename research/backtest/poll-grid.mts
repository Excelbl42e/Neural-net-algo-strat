import { runPoll, summary } from "./poll-bt.mts";
import { STRAT_IDS, FAMILY, SPLIT, WARM } from "./poll-lib.mts";
const all = STRAT_IDS;
const rows: any[] = [];
for (const minPart of [10, 20, 30])
 for (const stopAtr of [2, 3, 5, 8])
  for (const rr of [1, 1.5, 2])
   for (const session of [true, false]) {
    const cfg = { name: `part${minPart} sl${stopAtr} rr${rr} ${session ? "sess" : "all"}`, ids: all, agree: 0.7, minPart, br: { stopAtr, rr, holdBars: 48, stake: 1, mult: 100 }, session, maxOpen: 3, dailyLoss: 0.2 };
    const tr = summary(runPoll(cfg, WARM, SPLIT)), te = summary(runPoll(cfg, SPLIT, Infinity));
    rows.push({ name: cfg.name, tr, te });
   }
rows.sort((a, b) => b.tr.R - a.tr.R);
for (const r of rows) console.log(r.name.padEnd(26), "TRAIN n", String(r.tr.n).padStart(4), "win", String(r.tr.win).padStart(5), "net$", String(r.tr.net).padStart(6), "R", String(r.tr.R).padStart(6), "dd", r.tr.dd, " | TEST n", r.te.n, "net$", r.te.net, "R", r.te.R, "dd", r.te.dd);
