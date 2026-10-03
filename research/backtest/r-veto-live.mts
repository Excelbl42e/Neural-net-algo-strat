// COT veto on the owner's settings (every weekday, every vote until one stake left, 4-day hold).
import { LIVE, decisions } from "./book-lib.mts";
import { m30, START, END, SPLIT, LIVE_RULES, runPairs, sumLine, account, type Rules } from "./r-lib.mts";
import { cotFade } from "./r-extra.mts";
const dec = decisions(LIVE), D = 86_400_000;
const VETO: Rules = { ...LIVE_RULES, entry: (s, i, x) => cotFade(s, m30[s].t[i] + 1800_000) !== -x.d };
const mons: number[] = []; for (let d = START; d + 5 * D <= END; d += D) if (new Date(d).getUTCDay() === 1) mons.push(d + 7 * 3600_000);
const st: number[] = []; for (let d = START; d + 84 * D <= END; d += D) { const w = new Date(d).getUTCDay(); if (w >= 1 && w <= 5) st.push(d + 7 * 3600_000); }
for (const [n, R] of [["current settings", LIVE_RULES], ["current settings + COT veto", VETO]] as const) {
  console.log(n.padEnd(30), sumLine(runPairs(dec, R)));
  const w = mons.map((s) => ({ s, e: account(dec, R, s, s + 4 * D + 14 * 3600_000) })), e = w.map((x) => x.e).sort((a, b) => a - b), k = e.length;
  console.log(`  $10 Mon->Fri, 46 weeks: avg $${(e.reduce((a, b) => a + b, 0) / k).toFixed(2)} median $${e[k >> 1].toFixed(2)} up ${Math.round(100 * e.filter((x) => x > 10).length / k)}% under $8 ${Math.round(100 * e.filter((x) => x < 8).length / k)}% worst $${e[0].toFixed(2)} | withdrawn +$${w.reduce((a, x) => a + x.e - 10, 0).toFixed(2)} (Nov-Jun $${w.filter((x) => x.s < SPLIT).reduce((a, x) => a + x.e - 10, 0).toFixed(2)}, Jul-Sep $${w.filter((x) => x.s >= SPLIT).reduce((a, x) => a + x.e - 10, 0).toFixed(2)})`);
  const r = st.map((s) => account(dec, R, s, s + 84 * D)).sort((a, b) => a - b); console.log(`  12 weeks from $10: median $${r[r.length >> 1].toFixed(2)} under $5 ${Math.round(100 * r.filter((x) => x < 5).length / r.length)}%`);
}
