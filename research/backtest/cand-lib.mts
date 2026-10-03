import fs from "node:fs";
const B = new URL("./data", import.meta.url).pathname + "";
const raw: Record<string, Record<string, number[][]>> = JSON.parse(fs.readFileSync(B + "/candles2y.json", "utf8"));
export const SPLIT = Date.parse("2026-07-01T00:00:00Z");
export const START = Date.parse("2025-11-10T00:00:00Z");
export type M = { t: number[]; o: number[]; h: number[]; l: number[]; c: number[] };
export const m30: Record<string, M> = {};
for (const [s, tf] of Object.entries(raw)) { const r = tf.M30.filter((x) => x[0] % 1800 === 0); m30[s] = { t: r.map((x) => x[0] * 1000), o: r.map((x) => x[1]), h: r.map((x) => x[2]), l: r.map((x) => x[3]), c: r.map((x) => x[4]) }; }
export const SYMS = Object.keys(m30);
const TFMS: Record<string, number> = { M30: 1800_000, H1: 3600_000, H4: 14_400_000 };
/** votes[tf][sym][strategyId] aligned to the M30 decision timeline (vote of the last closed tf bar at each M30 close). */
export const aligned: Record<string, Record<string, Record<string, Int8Array>>> = {};
export function loadTF(tf: string, file = `${B}/votes-${tf}.json`) {
  const v: Record<string, Record<string, number[]>> = JSON.parse(fs.readFileSync(file, "utf8"));
  aligned[tf] ??= {};
  for (const s of SYMS) {
    const vt: number[] = tf === "M30" ? m30[s].t : v[s].t; const L = TFMS[tf];
    const map = new Int32Array(m30[s].t.length).fill(-1); let j = -1;
    for (let i = 0; i < m30[s].t.length; i++) { const close = m30[s].t[i] + 1800_000; while (j + 1 < vt.length && vt[j + 1] + L <= close) j++; map[i] = j; }
    aligned[tf][s] ??= {};
    for (const [id, arr] of Object.entries(v[s])) { if (id === "t") continue; const a = new Int8Array(map.length); for (let i = 0; i < map.length; i++) a[i] = map[i] >= 0 ? arr[map[i]] : 0; aligned[tf][s][id] = a; }
  }
}
export const commissionBps = (ms: number) => { const h = new Date(ms).getUTCHours(); return h >= 7 && h < 20 ? 2 : 6; };
export function canOpen(closeMs: number) { const d = new Date(closeMs), day = d.getUTCDay(), h = d.getUTCHours(); return day >= 1 && day <= 5 && h >= 7 && h < 21 && !(day === 5 && h >= 16); }
/** Exit bar index for an entry after bar i held `hb` M30 bars, cut at Friday 20:30 UTC. */
export function exitIndex(s: string, i: number, hb: number) {
  const t = m30[s].t; let e = Math.min(i + hb, t.length - 1);
  for (let k = i + 1; k <= e; k++) { const d = new Date(t[k]); if (d.getUTCDay() === 5 && d.getUTCHours() * 60 + d.getUTCMinutes() >= 20 * 60) { e = k; break; } if (t[k] - t[k - 1] > 6 * 3600_000) { e = k - 1; break; } }
  return e;
}
