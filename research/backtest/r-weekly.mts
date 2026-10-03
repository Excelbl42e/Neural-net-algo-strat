// The owner's way of running it: put $10 in on Monday, take the result out by Friday, start again at $10.
// Every Monday 07:00 UTC -> Friday 21:00 UTC (after the 20:30 close, so nothing is open), start $10 each week.
import { LIVE, decisions } from "./book-lib.mts";
import { m30, START, END, SPLIT, LIVE_RULES, account, type Rules } from "./r-lib.mts";
import { cotFade } from "./r-extra.mts";

const dec = decisions(LIVE);
const dow = (s: string, i: number) => new Date(m30[s].t[i] + 1800_000).getUTCDay();
const WKR: Rules = { ...LIVE_RULES, hold: 300, entry: (s, i) => dow(s, i) <= 2 };
const VETO: Rules = { ...WKR, entry: (s, i, x) => dow(s, i) <= 2 && cotFade(s, m30[s].t[i] + 1800_000) !== -x.d };
const D = 86_400_000; const mons: number[] = []; for (let d = START; d + 5 * D <= END; d += D) if (new Date(d).getUTCDay() === 1) mons.push(d + 7 * 3600_000);
for (const [n, R, A] of [["live now (every vote, 4-day hold)", LIVE_RULES, {}], ["weekly cycle (Mon-Tue, to Friday, max 4)", WKR, { maxOpen: 4 }], ["weekly cycle + COT veto", VETO, { maxOpen: 4 }]] as const) {
  const r = mons.map((s) => ({ s, e: account(dec, R as Rules, s, s + 4 * D + 14 * 3600_000, A) })), e = r.map((x) => x.e).sort((a, b) => a - b), k = e.length;
  const profit = r.reduce((a, x) => a + x.e - 10, 0);
  console.log(`\n${n}\n  ${k} weeks from $10: average Friday $${(profit / k + 10).toFixed(2)} | median $${e[k >> 1].toFixed(2)} | up ${Math.round(100 * e.filter((x) => x > 10.005).length / k)}% | flat ${Math.round(100 * e.filter((x) => Math.abs(x - 10) <= 0.005).length / k)}% | $12+ ${Math.round(100 * e.filter((x) => x >= 12).length / k)}% | under $8 ${Math.round(100 * e.filter((x) => x < 8).length / k)}% | worst $${e[0].toFixed(2)} | best $${e[k - 1].toFixed(2)}`);
  console.log(`  taking out the profit / topping up the loss every Friday: ${profit >= 0 ? "+" : ""}$${profit.toFixed(2)} over the ${k} weeks (sel weeks $${r.filter((x) => x.s < SPLIT).reduce((a, x) => a + x.e - 10, 0).toFixed(2)}, Jul-Sep weeks $${r.filter((x) => x.s >= SPLIT).reduce((a, x) => a + x.e - 10, 0).toFixed(2)})`);
  console.log("  week by week:", r.map((x) => `${new Date(x.s).toISOString().slice(5, 10)} ${(x.e - 10 >= 0 ? "+" : "") + (x.e - 10).toFixed(2)}`).join(", "));
}
