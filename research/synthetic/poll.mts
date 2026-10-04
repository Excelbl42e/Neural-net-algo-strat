// The live 60-strategy poll (same voters, same timeframe per voter, simple majority, quorum 30) on Deriv
// synthetic indices, traded as multipliers with each index's own Deriv terms:
//   multiplier = the smallest Deriv offers; commission = Deriv's live quote ($ per $10 stake at that
//   multiplier, fetched 2026-10-04); stop = 80% of the stake (the bot's cap), target 1.5x the stop.
// Synthetics trade 24/7, so there is no Friday close. Holds tried: 4h, 12h, 24h, 4 days.
// Selection = Oct 2025 - Jun 2026, test = Jul - Oct 2026. Control: the same entries with a random side.
import fs from "node:fs";
import { tallyPoll, POLL_TIMEFRAME, POLL_QUORUM } from "../../artifacts/api-server/src/lib/poll-engine.ts";

const B = new URL("./data", import.meta.url).pathname;
const SPLIT = Date.parse("2026-07-01T00:00:00Z"), START = Date.parse("2025-11-10T00:00:00Z");
// smallest multiplier and commission in $ for a $10 stake at it (Deriv proposal, 2026-10-04)
const TERMS: Record<string, [number, number]> = {
  R_10: [400, 0.15], R_25: [160, 0.14], R_50: [80, 0.16], R_75: [50, 0.15], R_100: [40, 0.15],
  "1HZ10V": [400, 0.15], "1HZ75V": [50, 0.15], "1HZ100V": [40, 0.15],
  BOOM500: [100, 0.09], BOOM1000: [100, 0.09], CRASH500: [100, 0.09], CRASH1000: [100, 0.06],
  JD25: [50, 0.05], JD75: [15, 0.04], stpRNG: [750, 0.11],
};
const raw = JSON.parse(fs.readFileSync(B + "/candles.json", "utf8"));
type M = { t: number[]; o: number[]; h: number[]; l: number[]; c: number[] };
const m30: Record<string, M> = {};
for (const [s, tf] of Object.entries<any>(raw)) { const r = tf.M30; m30[s] = { t: r.map((x: number[]) => x[0] * 1000), o: r.map((x: number[]) => x[1]), h: r.map((x: number[]) => x[2]), l: r.map((x: number[]) => x[3]), c: r.map((x: number[]) => x[4]) }; }
const SYMS = Object.keys(m30);
const TFMS: Record<string, number> = { M30: 1800_000, H1: 3600_000, H4: 14_400_000 };
const aligned: Record<string, Record<string, Record<string, Int8Array>>> = {};
for (const tf of ["M30", "H1", "H4"]) { const v = JSON.parse(fs.readFileSync(`${B}/votes-${tf}.json`, "utf8")); aligned[tf] = {};
  for (const s of SYMS) { const vt: number[] = v[s].t, L = TFMS[tf], map = new Int32Array(m30[s].t.length).fill(-1); let j = -1;
    for (let i = 0; i < m30[s].t.length; i++) { const close = m30[s].t[i] + 1800_000; while (j + 1 < vt.length && vt[j + 1] + L <= close) j++; map[i] = j; }
    aligned[tf][s] = {}; for (const [id, arr] of Object.entries<number[]>(v[s])) { if (id === "t") continue; const a = new Int8Array(map.length); for (let i = 0; i < map.length; i++) a[i] = map[i] >= 0 ? arr[map[i]] : 0; aligned[tf][s][id] = a; } } }
const LIVE = Object.entries(POLL_TIMEFRAME).map(([id, tf]) => ({ id, tf }));
const dec: Record<string, Int8Array> = {};
let decided = 0, bars = 0;
for (const s of SYMS) { const vs = LIVE.map((v) => aligned[v.tf][s][v.id]), n = m30[s].t.length, d = new Int8Array(n);
  for (let i = 0; i < n; i++) { const r = tallyPoll(vs.map((v) => v[i] as any), 0.5, POLL_QUORUM); d[i] = r.direction === "buy" ? 1 : r.direction === "sell" ? -1 : 0; if (m30[s].t[i] >= START) { bars++; if (d[i]) decided++; } } dec[s] = d; }
console.log(`poll decided on ${(100 * decided / bars).toFixed(0)}% of bars (forex: 19%)`);

function sim(s: string, i: number, d: number, hold: number) {
  const b = m30[s], [mult, c10] = TERMS[s], comm = c10 / 10, e0 = b.o[i + 1], stop = 0.8 / mult, tpd = 1.5 * stop + comm / mult * 2.5;
  const sp = e0 * (1 - d * stop), tp = e0 * (1 + d * tpd);
  for (let j = i + 1; j < b.t.length; j++) { let px: number | null = null;
    if (d * (b.o[j] - sp) <= 0 && j > i + 1) px = b.o[j];             // opened through the stop (spike)
    else if (d > 0 ? b.l[j] <= sp : b.h[j] >= sp) px = sp;
    else if (d > 0 ? b.h[j] >= tp : b.l[j] <= tp) px = tp;
    else if (j - (i + 1) >= hold) px = b.c[j];
    if (px != null) return { j, pnl: Math.max(-1, mult * d * (px - e0) / e0 - comm) }; }
  return null;
}
let rng = 99; const rnd = () => ((rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648);
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
function run(s: string, hold: number, side: "poll" | "random") { const b = m30[s], out: { t: number; pnl: number }[] = []; let busy = -1;
  for (let i = 0; i + 1 < b.t.length; i++) { if (b.t[i] < START || i <= busy || !dec[s][i]) continue;
    const d = side === "poll" ? dec[s][i] : rnd() < 0.5 ? 1 : -1; const r = sim(s, i, d, hold); if (!r) break; out.push({ t: b.t[i], pnl: r.pnl }); busy = r.j; } return out; }

console.log("\n== direction value of the poll: side x move over the next N hours, bps of price, before costs (0 = coin flip) ==");
for (const s of SYMS) { const b = m30[s]; const row = [2, 8, 48].map((h) => { const sel: number[] = [], te: number[] = [];
    for (let i = 0; i + h < b.t.length; i += 2) if (b.t[i] >= START && dec[s][i]) (b.t[i] < SPLIT ? sel : te).push(dec[s][i] * (b.c[i + h] - b.o[i + 1]) / b.o[i + 1] * 1e4);
    return `${h / 2}h ${mean(sel).toFixed(1).padStart(6)}/${mean(te).toFixed(1).padStart(6)}`; });
  console.log(s.padEnd(10), row.join(" | ")); }

console.log("\n== trades, one position per index: $ per $1 stake after commission, sel / test (n), win% — poll vs random side ==");
const HOLDS: [string, number][] = [["4h", 8], ["12h", 24], ["24h", 48], ["4d", 192]];
const tot: Record<string, { p: number[]; r: number[] }> = {};
for (const s of SYMS) { const cells = HOLDS.map(([hn, h]) => { const p = run(s, h, "poll"), r = run(s, h, "random");
    (tot[hn] ??= { p: [], r: [] }).p.push(...p.map((x) => x.pnl)); tot[hn].r.push(...r.map((x) => x.pnl));
    const ps = p.filter((x) => x.t < SPLIT).map((x) => x.pnl), pt = p.filter((x) => x.t >= SPLIT).map((x) => x.pnl);
    return `${hn} ${mean(ps).toFixed(3).padStart(6)}/${mean(pt).toFixed(3).padStart(6)} (${p.length}) ${Math.round(100 * p.filter((x) => x.pnl > 0).length / (p.length || 1))}% rnd ${mean(r.map((x) => x.pnl)).toFixed(3)}`; });
  console.log(`${s.padEnd(10)} x${String(TERMS[s][0]).padEnd(4)} stop ${(80 / TERMS[s][0]).toFixed(2)}% |`, cells.join(" | ")); }
console.log("\nall indices pooled:", Object.entries(tot).map(([h, v]) => `${h}: poll ${mean(v.p).toFixed(4)} (${v.p.length} trades) vs random ${mean(v.r).toFixed(4)}`).join(" | "));
// forex reference: the same live rules earned +$0.017 per $1 stake (1,041 trades), +$0.036 in the test months
