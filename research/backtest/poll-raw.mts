// Every poll signal on its own (no account), gross and net R, to see if the vote carries information.
import { bars, votes, SYMS, SPLIT, WARM, canOpen, simTrade, STRAT_IDS, FAMILY } from "./poll-lib.mts";
const sets: Record<string, string[]> = {
  all60: STRAT_IDS.filter((x) => x !== "range_position_reversion"),
  quant: STRAT_IDS.filter((x) => FAMILY[x] === "quant"),
  ta: STRAT_IDS.filter((x) => FAMILY[x] === "ta"),
};
for (const [nm, ids] of Object.entries(sets)) for (const minPart of [10, 20, 30]) for (const agree of [0.7, 0.8]) {
  const acc = { tr: [] as number[], te: [] as number[] };
  for (const s of SYMS) {
    const b = bars[s], vs = ids.map((id) => votes[s][id]); let last = 0;
    for (let i = 1; i < b.c.length - 1; i++) {
      let up = 0, dn = 0; for (const v of vs) { if (v[i] > 0) up++; else if (v[i] < 0) dn++; }
      const p = up + dn, d = p >= minPart && up / p >= agree ? 1 : p >= minPart && dn / p >= agree ? -1 : 0;
      const isNew = d !== 0 && d !== last; last = d;
      if (!isNew || b.t[i] < WARM || !canOpen(b.t[i] + 1800_000, true)) continue;
      const f = simTrade(s, i, d as 1 | -1, { stopAtr: +(process.env.SA ?? 5), rr: 1.5, holdBars: 48, stake: 1, mult: 100 }); if (!f) continue;
      (b.t[i] < SPLIT ? acc.tr : acc.te).push(f.pnl / f.risk);
    }
  }
  const m = (a: number[]) => +(a.reduce((x, y) => x + y, 0) / (a.length || 1)).toFixed(3);
  console.log(nm.padEnd(6), "part", minPart, "agree", agree, "| train n", acc.tr.length, "R/trade", m(acc.tr), "| test n", acc.te.length, "R/trade", m(acc.te));
}
