// Do some of the 60 voters hurt under the weekly cycle? Blocked cross-validation: the year is cut into 6
// time blocks; for each block, voters are scored on the trades of the OTHER blocks (minus a 1-week purge
// either side) and the worst ones are dropped; the pruned poll is then traded on the held-out block only.
// Score of a voter = sum over training trades of (its vote agrees with the trade ? +pnl : its vote opposes ? -pnl : 0).
import { LIVE, decisions, aligned } from "./book-lib.mts";
import { m30, START, END, LIVE_RULES, runPairs, type Rules } from "./r-lib.mts";

const dow = (s: string, i: number) => new Date(m30[s].t[i] + 1800_000).getUTCDay();
const WK: Rules = { ...LIVE_RULES, hold: 300, entry: (s, i) => dow(s, i) <= 2 };
const base = runPairs(decisions(LIVE), WK);
const K = 6, span = (END - START) / K, W = 7 * 86_400_000;
const total = { live: 0, d5: 0, d10: 0, d20: 0, neg: 0 }; const kept: number[] = [];
for (let f = 0; f < K; f++) {
  const a = START + f * span, b = a + span;
  const train = base.filter((x) => x.t1 < a - W || x.t0 > b + W);
  const score = LIVE.map((v) => train.reduce((z, x) => z + aligned[v.tf][x.s][v.id][x.i] * x.d * x.pnl, 0));
  const order = LIVE.map((_, k) => k).sort((p, q) => score[p] - score[q]);
  const inFold = (t: { t0: number }) => t.t0 >= a && t.t0 < b;
  const res = (vs: typeof LIVE) => runPairs(decisions(vs), WK).filter(inFold).reduce((z, x) => z + x.pnl, 0);
  const live = base.filter(inFold).reduce((z, x) => z + x.pnl, 0);
  const drop = (n: number) => LIVE.filter((_, k) => !order.slice(0, n).includes(k));
  const neg = LIVE.filter((_, k) => score[k] >= 0); kept.push(neg.length);
  const r = { live, d5: res(drop(5)), d10: res(drop(10)), d20: res(drop(20)), neg: res(neg) };
  for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += r[k];
  console.log(`block ${f + 1} (${new Date(a).toISOString().slice(0, 10)}): live $${r.live.toFixed(2)} | drop worst 5 $${r.d5.toFixed(2)} | 10 $${r.d10.toFixed(2)} | 20 $${r.d20.toFixed(2)} | drop all negative (${60 - neg.length}) $${r.neg.toFixed(2)}`);
}
console.log(`held-out total: live $${total.live.toFixed(2)} | drop 5 $${total.d5.toFixed(2)} | drop 10 $${total.d10.toFixed(2)} | drop 20 $${total.d20.toFixed(2)} | drop negative $${total.neg.toFixed(2)}`);
