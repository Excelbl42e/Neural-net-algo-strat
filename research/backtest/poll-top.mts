import { bars, votes, SYMS, SPLIT, WARM, canOpen, simTrade } from "./poll-lib.mts";
// Order = train-period gross R ranking (selection period only).
const rank = ["ewma_vol_momentum","markov_candle_type","monte_carlo_bootstrap","markov_updown","volatility_breakout","sharpe_trend","monte_carlo_block","markov_3state","markov_2nd_order","logistic_lags","heikin_ashi","aroon","roc_momentum","bayes_updown","trix","keltner_breakout","hurst_momentum","haar_wavelet_trend","adx_dmi","permutation_trend"];
for (const k of [5, 10, 20]) for (const sa of [5, 8]) for (const agree of [0.7, 0.8]) for (const minPart of [Math.ceil(k * 0.3), Math.ceil(k * 0.5)]) {
  const ids = rank.slice(0, k), acc = { tr: [] as number[], te: [] as number[] };
  for (const s of SYMS) {
    const b = bars[s], vs = ids.map((id) => votes[s][id]); let last = 0;
    for (let i = 1; i < b.c.length - 1; i++) {
      let up = 0, dn = 0; for (const v of vs) { if (v[i] > 0) up++; else if (v[i] < 0) dn++; }
      const p = up + dn, d = p >= minPart && up / p >= agree ? 1 : p >= minPart && dn / p >= agree ? -1 : 0;
      const isNew = d !== 0 && d !== last; last = d;
      if (!isNew || b.t[i] < WARM || !canOpen(b.t[i] + 1800_000, true)) continue;
      const f = simTrade(s, i, d as 1 | -1, { stopAtr: sa, rr: 1.5, holdBars: 48, stake: 1, mult: 100 }); if (!f) continue;
      (b.t[i] < SPLIT ? acc.tr : acc.te).push(f.pnl / f.risk);
    }
  }
  const m = (a: number[]) => +(a.reduce((x, y) => x + y, 0) / (a.length || 1)).toFixed(3);
  console.log(`top${k} sl${sa} agree${agree} part${minPart}`.padEnd(28), "train n", acc.tr.length, m(acc.tr), "| test n", acc.te.length, m(acc.te));
}
