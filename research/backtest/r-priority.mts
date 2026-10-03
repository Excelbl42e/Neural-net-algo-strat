// With a cap on open positions, which of several simultaneous votes gets the slot? (The live bot takes
// them in its scan order, majors first.) 8-week $10 runs from every weekday 07:00 UTC.
import { LIVE, decisions } from "./book-lib.mts";
import { m30, START, END, LIVE_RULES, account, type Rules, type Acct } from "./r-lib.mts";

const dec = decisions(LIVE);
const dow = (s: string, i: number) => new Date(m30[s].t[i] + 1800_000).getUTCDay();
const MT: Rules = { ...LIVE_RULES, entry: (s, i) => dow(s, i) <= 2 };
const W = 56 * 86_400_000; const starts: number[] = []; for (let d = START; d + W <= END; d += 86_400_000) { const w = new Date(d).getUTCDay(); if (w >= 1 && w <= 5) starts.push(d + 7 * 3600_000); }
const ends = (R: Rules, A: Acct) => starts.map((s) => account(dec, R, s, s + W, A)).sort((a, b) => a - b);
const line = (e: number[]) => { const k = e.length; return `median $${e[k >> 1].toFixed(2)} geo x${Math.exp(e.reduce((a, x) => a + Math.log(Math.max(x, 0.01) / 10), 0) / k).toFixed(2)} up ${Math.round(100 * e.filter((x) => x > 10).length / k)}% <$5 ${Math.round(100 * e.filter((x) => x < 5).length / k)}% $20+ ${Math.round(100 * e.filter((x) => x >= 20).length / k)}%`; };
const legs = (s: string) => [s.slice(3, 6), s.slice(6, 9)];
type C = { s: string; i: number; x: { d: number; share: number } };
const ORDERS: [string, ((c: C[], o: { s: string; d: number }[]) => C[]) | undefined][] = [
  ["scan order (live)", undefined],
  ["reverse scan order", (c) => [...c].reverse()],
  ["highest vote share first", (c) => [...c].sort((a, b) => b.x.share - a.x.share)],
  ["least currency overlap first", (c, o) => { const use: Record<string, number> = {}; for (const p of o) { const [a, b] = legs(p.s); use[a] = (use[a] ?? 0) + 1; use[b] = (use[b] ?? 0) + 1; }
    return [...c].sort((p, q) => legs(p.s).reduce((z, k) => z + (use[k] ?? 0), 0) - legs(q.s).reduce((z, k) => z + (use[k] ?? 0), 0)); }],
];
for (const [rn, R] of [["all days", LIVE_RULES], ["Mon-Tue", MT]] as const) for (const mo of [3, 4, 6]) {
  for (const [on, f] of ORDERS) console.log(`${rn.padEnd(9)} max ${mo} ${on.padEnd(30)} ${line(ends(R, { maxOpen: mo, order: f as any }))}`);
  // random order, 6 seeds pooled
  const pool: number[] = []; for (let seed = 1; seed <= 6; seed++) { let r = seed * 7919; const rnd = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648);
    pool.push(...ends(R, { maxOpen: mo, order: (c) => c.map((x) => [rnd(), x] as const).sort((a, b) => a[0] - b[0]).map((z) => z[1]) })); }
  console.log(`${rn.padEnd(9)} max ${mo} ${"random order (6 seeds pooled)".padEnd(30)} ${line(pool.sort((a, b) => a - b))}`);
}
