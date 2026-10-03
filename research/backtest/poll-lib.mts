import fs from "node:fs";
import { atrSeries, STRATEGIES, type Bars } from "../../artifacts/api-server/src/lib/poll-strategies.ts";
export const B = new URL("./data", import.meta.url).pathname + "";
const raw: Record<string, Record<string, number[][]>> = JSON.parse(fs.readFileSync(B + "/candles2y.json", "utf8"));
export const bars: Record<string, Bars> = {};
for (const [s, tf] of Object.entries(raw)) {
  const rows = tf.M30.filter((r) => r[0] % 1800 === 0);
  bars[s] = { t: rows.map((r) => r[0] * 1000), o: rows.map((r) => r[1]), h: rows.map((r) => r[2]), l: rows.map((r) => r[3]), c: rows.map((r) => r[4]) };
}
export const votes: Record<string, Record<string, number[]>> = JSON.parse(fs.readFileSync(B + "/votes.json", "utf8"));
export const SYMS = Object.keys(bars);
export const atr: Record<string, number[]> = Object.fromEntries(SYMS.map((s) => [s, atrSeries(bars[s], 14)]));
export const SPLIT = Date.parse("2026-07-01T00:00:00Z");
export const WARM = Date.parse("2025-11-10T00:00:00Z");

/** Deriv commission per $1 stake at x100, measured: $0.02 in London/NY hours, $0.06 otherwise. */
export const commissionAt = (ms: number) => { if (process.env.GROSS) return 0; const h = new Date(ms).getUTCHours(); return h >= 7 && h < 20 ? 0.02 : 0.06; };
/** Scan allowed at the close of bar i? Deriv forex hours + Friday rules (no new trades from 16:00 UTC Friday). */
export function canOpen(ms: number, sessionOnly: boolean) {
  const d = new Date(ms), day = d.getUTCDay(), h = d.getUTCHours();
  if (day === 0 || day === 6) return false;
  if (day === 5 && h >= 16) return false;
  if (sessionOnly && (h < 7 || h >= 20)) return false;
  return true;
}
export interface Bracket { stopAtr: number; rr: number; holdBars: number; stake: number; mult: number }
export interface Fill { sym: string; dir: 1 | -1; at: number; exitAt: number; pnl: number; risk: number; outcome: string }
/** Opens at the next bar's open after signal bar i (the live scan buys right after the close). Same-bar stop+target = stop. */
export function simTrade(sym: string, i: number, dir: 1 | -1, br: Bracket): Fill | null {
  const b = bars[sym], n = b.c.length, a = atr[sym][i];
  if (i + 1 >= n || !Number.isFinite(a)) return null;
  if (b.t[i + 1] - b.t[i] > 30 * 60_000) return null; // next bar is after a gap: the scan would not have had a live price
  const entry = b.o[i + 1], usd = br.stake * br.mult / entry;
  let stopUsd = Math.max(br.stopAtr * a * usd, 0.10);           // Deriv minimum stop loss $0.10
  if (stopUsd > 0.8 * br.stake) return null;                      // never risk over 80% of the stake
  const tpUsd = Math.max(stopUsd * br.rr, 0.10);
  const comm = commissionAt(b.t[i + 1]) * br.stake * br.mult / 100;
  const sp = entry - dir * stopUsd / usd, tp = entry + dir * tpUsd / usd;
  for (let j = i + 1; j < n; j++) {
    const fridayFlat = new Date(b.t[j]).getUTCDay() === 5 && new Date(b.t[j]).getUTCHours() * 60 + new Date(b.t[j]).getUTCMinutes() >= 20 * 60 + 30;
    if (j > i + 1 && b.t[j] - b.t[j - 1] > 30 * 60_000) { // gap open (weekend/outage)
      const o = b.o[j];
      if (dir * (o - sp) <= 0) return { sym, dir, at: b.t[i + 1], exitAt: b.t[j], pnl: Math.max(-br.stake, dir * (o - entry) * usd - comm), risk: stopUsd + comm, outcome: "gap" };
    }
    const hitS = dir === 1 ? b.l[j] <= sp : b.h[j] >= sp, hitT = dir === 1 ? b.h[j] >= tp : b.l[j] <= tp;
    if (hitS) return { sym, dir, at: b.t[i + 1], exitAt: b.t[j] + 1800_000, pnl: -stopUsd - comm, risk: stopUsd + comm, outcome: "stop" };
    if (hitT) return { sym, dir, at: b.t[i + 1], exitAt: b.t[j] + 1800_000, pnl: tpUsd - comm, risk: stopUsd + comm, outcome: "target" };
    if (j - i >= br.holdBars || fridayFlat) return { sym, dir, at: b.t[i + 1], exitAt: b.t[j] + 1800_000, pnl: dir * (b.c[j] - entry) * usd - comm, risk: stopUsd + comm, outcome: fridayFlat ? "friday" : "timeout" };
  }
  return null;
}
export const STRAT_IDS = STRATEGIES.map((s) => s.id);
export const FAMILY = Object.fromEntries(STRATEGIES.map((s) => [s.id, s.family]));
