import { bars, votes, SYMS, SPLIT, WARM, canOpen, STRAT_IDS, FAMILY } from "./poll-lib.mts";
const ids = STRAT_IDS.filter((x) => x !== "range_position_reversion");
const H = [2, 4, 8, 16, 32, 48];
for (const [agree, minPart, onlyNew] of [[0.7, 20, true], [0.8, 20, true], [0.7, 20, false], [0.8, 20, false], [0.9, 20, false]] as const) {
  const acc: Record<string, number[][]> = { tr: H.map(() => []), te: H.map(() => []) };
  for (const s of SYMS) {
    const b = bars[s], vs = ids.map((id) => votes[s][id]); let last = 0;
    for (let i = 1; i < b.c.length - 49; i++) {
      let up = 0, dn = 0; for (const v of vs) { if (v[i] > 0) up++; else if (v[i] < 0) dn++; }
      const p = up + dn, d = p >= minPart && up / p >= agree ? 1 : p >= minPart && dn / p >= agree ? -1 : 0;
      const isNew = d !== 0 && d !== last; last = d;
      if (!d || (onlyNew && !isNew) || b.t[i] < WARM || !canOpen(b.t[i] + 1800_000, true)) continue;
      const e = b.o[i + 1];
      H.forEach((h, k) => acc[b.t[i] < SPLIT ? "tr" : "te"][k].push(d * (b.c[i + h] - e) / e * 1e4));
    }
  }
  const m = (a: number[]) => (a.reduce((x, y) => x + y, 0) / (a.length || 1)).toFixed(2);
  console.log(`agree ${agree} ${onlyNew ? "new" : "every bar"}`.padEnd(22), "n", acc.tr[0].length, "/", acc.te[0].length, "| bps after", H.map((h, k) => `${h / 2}h: ${m(acc.tr[k])}/${m(acc.te[k])}`).join("  "));
}
