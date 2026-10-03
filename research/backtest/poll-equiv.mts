import fs from "node:fs";
import { STRATEGIES, type Bars } from "../../artifacts/api-server/src/lib/poll-strategies.ts";
const B = new URL("./data", import.meta.url).pathname + "";
const raw = JSON.parse(fs.readFileSync(B + "/candles2y.json", "utf8"));
const mk = (rows: number[][]): Bars => ({ t: rows.map((r) => r[0] * 1000), o: rows.map((r) => r[1]), h: rows.map((r) => r[2]), l: rows.map((r) => r[3]), c: rows.map((r) => r[4]) });
const syms = Object.keys(raw);
let mism = 0; const t0 = Date.now(); let liveMs = 0;
for (const end of [6000, 9000, 12000]) {
  const all: Record<string, Bars> = {}; for (const s of syms) all[s] = mk(raw[s].M30.filter((r: number[]) => r[0] % 1800 === 0).slice(0, end));
  for (const s of syms.slice(0, 3)) {
    const full = all[s];
    const win: Bars = { t: full.t.slice(-4200), o: full.o.slice(-4200), h: full.h.slice(-4200), l: full.l.slice(-4200), c: full.c.slice(-4200) };
    const closes = (bb: Bars) => { const idx = new Map(bb.t.map((t, i) => [t, i])); const o: Record<string, number[]> = {}; for (const q of syms) { const a = new Array(bb.t.length).fill(NaN); all[q].t.forEach((t, j) => { const i = idx.get(t); if (i != null) a[i] = all[q].c[j]; }); o[q] = a; } return o; };
    const xf = { symbol: s, closes: closes(full) }, xw = { symbol: s, closes: closes(win) };
    for (const st of STRATEGIES) {
      const a = st.compute(full, xf).at(-1);
      const t1 = Date.now(); const b = st.compute(win, xw, win.t.length - 1).at(-1); liveMs += Date.now() - t1;
      if (a !== b) { mism++; console.log("mismatch", end, s, st.id, a, b); }
    }
  }
}
console.log("mismatches", mism, "live ms per pair (avg)", (liveMs / 9).toFixed(0));
