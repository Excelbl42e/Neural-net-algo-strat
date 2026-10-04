// How the live poll does when new trades open in the Asian session, with the owner's settings:
// new trades on Monday only, every vote trades until one stake of free balance is left (one per pair,
// up to 14), 5% risk, stop 0.6%, target 1.5x, 96h hold, Friday 20:30 UTC flatten, COT veto on.
// Each window is a "Killzone sessions" choice (forex-readiness.ts): asian 00-09, london 07-16,
// newyork 12-21 UTC; blank = every hour Deriv is open (Mon 00:00 .. Fri 16:00 for new trades).
// Also modelled, as the live scan does it: a poll waits until the H1 and H4 candles that just closed exist.
// After the weekend the first H4 candle closes Monday 04:00, so on Mondays nothing opens before 04:00 UTC.
// Commission is cand-lib's model: 2 bps 07-20 UTC, 6 bps outside (Deriv quotes seen earlier; Asian-hours
// commission was not measured, so the 2 bps case is shown too: +$0.04 per $1 on each 6 bps trade).
import { LIVE, decisions } from "./book-lib.mts";
import { m30, SYMS, START, END, LIVE_RULES, runPairs, account, type Rules, type Tr } from "./r-lib.mts";
import { cotFade } from "./r-extra.mts";

const D = 86_400_000, H = 3600_000;
const dec = decisions(LIVE);
const times: Record<string, Set<number>> = Object.fromEntries(SYMS.map((s) => [s, new Set(m30[s].t)]));
const closeOf = (s: string, i: number) => m30[s].t[i] + 1800_000;
/** The live scan's freshness rule: the H1 and H4 candles that most recently closed must exist. */
const fresh = (s: string, i: number) => [H, 4 * H].every((len) => times[s].has(Math.floor(closeOf(s, i) / len) * len - len));
const veto = (s: string, i: number, d: number) => cotFade(s, closeOf(s, i)) === -d;
const hours = (from: number, to: number) => (ms: number) => { const d = new Date(ms), day = d.getUTCDay(), h = d.getUTCHours(); return day >= 1 && day <= 5 && h >= from && h < to && !(day === 5 && h >= 16); };
const rules = (from: number, to: number, mondayOnly: boolean): Rules => ({
  ...LIVE_RULES, ok: hours(from, to),
  entry: (s, i, x) => fresh(s, i) && !veto(s, i, x.d) && (!mondayOnly || new Date(closeOf(s, i)).getUTCDay() === 1),
});
const comm6 = (t: Tr) => { const h = new Date(t.t0).getUTCHours(); return h < 7 || h >= 20; };
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const f = (x: number, d = 3) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
function perTrade(tr: Tr[]) {
  const p = (part: "sel" | "test") => tr.filter((t) => t.part === part).map((t) => t.pnl);
  const at2 = tr.map((t) => t.pnl + (comm6(t) ? 0.04 : 0));
  return `${String(tr.length).padStart(4)} trades  $ per $1: ${f(mean(tr.map((t) => t.pnl)))} (Nov-Jun ${f(mean(p("sel")))}, Jul-Oct ${f(mean(p("test")))})  win ${Math.round(100 * tr.filter((t) => t.pnl > 0).length / (tr.length || 1))}%  | if 2 bps all day: ${f(mean(at2))}`;
}
const mons: number[] = []; for (let d = START; d + 5 * D <= END; d += D) if (new Date(d).getUTCDay() === 1) mons.push(d);
function weekly(R: Rules) {
  const w = mons.map((s) => account(dec, R, s, s + 4 * D + 21 * H)).sort((a, b) => a - b), n = w.length;
  const tot = w.reduce((a, b) => a + b - 10, 0);
  return `withdrawn over ${n} weeks ${f(tot, 2).replace(/^([+-])/, "$1$")}  avg Friday $${mean(w).toFixed(2)}  median $${w[n >> 1].toFixed(2)}  weeks up ${Math.round(100 * w.filter((x) => x > 10).length / n)}%  worst $${w[0].toFixed(2)} best $${w[n - 1].toFixed(2)}`;
}

const WINDOWS: [string, number, number][] = [
  ["london,newyork  07-21 (deployed)", 7, 21],
  ["asian           00-09", 0, 9],
  ["asian, before London 00-07", 0, 7],
  ["asian,london,newyork 00-21", 0, 21],
  ["blank (every hour)", 0, 24],
];
console.log("== Per trade (one position per pair, no money limit). Every weekday, then Monday only ==");
for (const [n, a, b] of WINDOWS) console.log(n.padEnd(34), "all days ", perTrade(runPairs(dec, rules(a, b, false))));
for (const [n, a, b] of WINDOWS) console.log(n.padEnd(34), "Mon only ", perTrade(runPairs(dec, rules(a, b, true))));
console.log("\n== $10 every Monday 00:00, everything closed or valued Friday 21:00 UTC: Monday-only entries, every vote until one stake is left ==");
for (const [n, a, b] of WINDOWS) console.log(n.padEnd(34), weekly(rules(a, b, true)));
// Monday hour by hour: which hours' votes make or lose money
console.log("\n== Monday entries by UTC hour of the vote (every pair, per $1 stake) ==");
const mon = runPairs(dec, rules(0, 24, true));
for (let h = 0; h < 24; h += 3) { const t = mon.filter((x) => { const k = new Date(x.t0).getUTCHours(); return k >= h && k < h + 3; }); if (t.length) console.log(`  ${String(h).padStart(2, "0")}-${String(h + 3).padStart(2, "0")}`, perTrade(t)); }
