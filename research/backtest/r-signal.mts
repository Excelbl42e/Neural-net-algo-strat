// Signal-side changes on top of the early-week cutoff:
//  A. entry hours on the allowed days (the live bot opens 07:00-21:00 UTC, Fri until 16:00)
//  B. meta-labeling filter (book-meta.mts), walk-forward: refit each month on trades closed before it
//  C. walk-forward pair filter: skip pairs whose trades over the previous 3 months lost money
import { LIVE, decisions, okTime } from "./book-lib.mts";
import { m30, SYMS, START, END, LIVE_RULES, runPairs, sumLine, account, type Rules } from "./r-lib.mts";
import { features, fit } from "./book-meta.mts";

const dec = decisions(LIVE);
const dow = (s: string, i: number) => new Date(m30[s].t[i] + 1800_000).getUTCDay();
const early = (last: number) => (s: string, i: number) => dow(s, i) <= last;
const show = (n: string, R: Rules) => console.log(n.padEnd(46), sumLine(runPairs(dec, R)));
const hours = (from: number, to: number) => (ms: number) => { const d = new Date(ms), day = d.getUTCDay(), h = d.getUTCHours(); return day >= 1 && day <= 5 && h >= from && h < to && !(day === 5 && h >= 16); };

console.log("== A. entry hours ==");
show("live (all days, 07-21)", LIVE_RULES);
for (const last of [1, 2]) for (const [f, t] of [[0, 24], [3, 21], [7, 21], [7, 17], [10, 21]] as const)
  show(`Mon-${last === 1 ? "Mon" : "Tue"}, ${String(f).padStart(2, "0")}-${t} UTC`, { ...LIVE_RULES, entry: early(last), ok: hours(f, t) });

console.log("\n== B. meta-labeling, walk-forward monthly (trained on all live trades closed before each month) ==");
const all = runPairs(dec, LIVE_RULES);
const X = new Map<string, number[]>(); const key = (s: string, i: number) => `${s}|${i}`;
const feat = (s: string, i: number) => { const k = key(s, i); if (!X.has(k)) X.set(k, features(s, i, dec[s][i], all as any)); return X.get(k)!; };
const mon = (t: number) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
const models = new Map<number, (x: number[]) => number>();
for (let m = mon(START); m < END; m = Date.UTC(new Date(m).getUTCFullYear(), new Date(m).getUTCMonth() + 1, 1)) {
  const tr = all.filter((x) => x.t1 <= m); if (tr.length < 150) continue;
  models.set(m, fit(tr.map((x) => feat(x.s, x.i)), tr.map((x) => (x.pnl > 0 ? 1 : 0)), tr.map((x) => Math.abs(x.pnl)))); }
const firstModel = Math.min(...models.keys());
console.log(`model in use from ${new Date(firstModel).toISOString().slice(0, 7)}; trades before that are taken unfiltered`);
const meta = (th: number) => (s: string, i: number) => { const f = models.get(mon(m30[s].t[i] + 1800_000)); return !f || f(feat(s, i)) >= th; };
for (const [n, e] of [["all days", null], ["Mon-Tue", early(2)], ["Mon only", early(1)]] as const) {
  show(`${n}, no filter`, { ...LIVE_RULES, entry: e ?? undefined });
  for (const th of [0.5, 0.55]) show(`${n} + meta >= ${th}`, { ...LIVE_RULES, entry: (s, i, x) => (!e || e(s, i)) && meta(th)(s, i) }); }

console.log("\n== C. walk-forward pair filter (skip a pair if its live trades closed in the previous 90 days lost money) ==");
const pairOk = (s: string, i: number) => { const t = m30[s].t[i]; const past = all.filter((x) => x.s === s && x.t1 <= t && x.t1 > t - 90 * 86_400_000); return past.length < 10 || past.reduce((a, x) => a + x.pnl, 0) >= 0; };
show("all days + pair filter", { ...LIVE_RULES, entry: pairOk });
show("Mon-Tue + pair filter", { ...LIVE_RULES, entry: (s, i) => early(2)(s, i) && pairOk(s, i) });

console.log("\n== $10, 8-week runs from every weekday 07:00 UTC, max 4 open and every vote ==");
const W = 56 * 86_400_000; const starts: number[] = []; for (let d = START; d + W <= END; d += 86_400_000) { const w = new Date(d).getUTCDay(); if (w >= 1 && w <= 5) starts.push(d + 7 * 3600_000); }
const acc = (n: string, R: Rules, maxOpen?: number) => { const e = starts.map((s) => account(dec, R, s, s + W, { maxOpen })).sort((a, b) => a - b), k = e.length;
  console.log(`${n.padEnd(34)} ${maxOpen ? `max ${maxOpen}` : "every"} | median $${e[k >> 1].toFixed(2)} geo x${Math.exp(e.reduce((a, x) => a + Math.log(Math.max(x, 0.01) / 10), 0) / k).toFixed(2)} up ${Math.round(100 * e.filter((x) => x > 10).length / k)}% <$5 ${Math.round(100 * e.filter((x) => x < 5).length / k)}% $20+ ${Math.round(100 * e.filter((x) => x >= 20).length / k)}%`); };
for (const mo of [undefined, 4]) {
  acc("live", LIVE_RULES, mo); acc("Mon-Tue", { ...LIVE_RULES, entry: early(2) }, mo);
  acc("Mon-Tue + meta 0.5", { ...LIVE_RULES, entry: (s, i) => early(2)(s, i) && meta(0.5)(s, i) }, mo);
  acc("all days + meta 0.5", { ...LIVE_RULES, entry: meta(0.5) }, mo); }
