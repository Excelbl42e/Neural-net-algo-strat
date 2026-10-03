import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCotSeries, cotFadeSignal, cotVetoes, mondayOf, type CotRow } from "../src/lib/cot-positioning.ts";

const WEEK = 7 * 86_400_000;
/** 160 weekly reports (Tuesdays) per currency; `last` sets the newest EUR net. */
function rows(lastEur: number): CotRow[] {
  const out: CotRow[] = []; const firstTue = Date.UTC(2023, 7, 1); // a Tuesday
  for (let k = 0; k < 160; k++) {
    const d = new Date(firstTue + k * WEEK).toISOString().slice(0, 10);
    const eur = k === 159 ? lastEur : Math.sin(k / 5) * 0.1; // EUR net swings between -10% and +10% of open interest
    for (const [code, net] of [["099741", eur], ["096742", 0], ["097741", 0], ["232741", 0], ["090741", 0], ["092741", 0]] as const)
      out.push({ reportDate: `${d}T00:00:00.000`, code, long: 1000 + net * 10_000, short: 1000, openInterest: 10_000 });
  }
  return out;
}
const newestMonday = mondayOf(Date.UTC(2023, 7, 1) + 159 * WEEK) + WEEK;

test("a report is used from the Monday after its Tuesday, not before", () => {
  const s = buildCotSeries(rows(0.5));
  assert.equal(cotFadeSignal("frxEURUSD", s, new Date(newestMonday - 1)).week !== new Date(newestMonday).toISOString().slice(0, 10), true);
  assert.equal(cotFadeSignal("frxEURUSD", s, new Date(newestMonday + 7 * 3600_000)).week, new Date(newestMonday).toISOString().slice(0, 10));
});

test("speculators at a 3-year extreme long -> sell signal; extreme short -> buy; middle -> none", () => {
  const monday = new Date(newestMonday + 7 * 3600_000);
  const hi = cotFadeSignal("frxEURUSD", buildCotSeries(rows(0.5)), monday);
  assert.equal(hi.signal, -1); assert.ok(hi.percentile! > 0.9);
  assert.equal(cotFadeSignal("frxEURUSD", buildCotSeries(rows(-0.5)), monday).signal, 1);
  assert.equal(cotFadeSignal("frxEURUSD", buildCotSeries(rows(0)), monday).signal, 0);
  // USD is the quote: for USD-based pairs the sign flips with the base/quote order
  assert.equal(cotFadeSignal("frxUSDCHF", buildCotSeries(rows(0.5)), monday).signal, 0); // EUR not in the pair
});

test("the veto skips only a trade that goes with the crowd at an extreme", () => {
  const sell = { signal: -1 as const, percentile: 0.97, week: "2026-10-05" };
  assert.equal(cotVetoes("buy", sell), true);   // crowd extremely long, bot wants to buy: skip
  assert.equal(cotVetoes("sell", sell), false); // bot sells against the crowd: trade
  assert.equal(cotVetoes("buy", { signal: 0, percentile: 0.5, week: "2026-10-05" }), false);
});

test("too little history gives no signal (fails open)", () => {
  const short = rows(0.5).slice(-6 * 50);
  assert.equal(cotFadeSignal("frxEURUSD", buildCotSeries(short), new Date(newestMonday + 3600_000)).signal, 0);
});
