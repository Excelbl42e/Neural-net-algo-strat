import { test } from "node:test";
import assert from "node:assert/strict";
import { STRATEGIES, type Bars, type Vote } from "../src/lib/poll-strategies.ts";
import { tallyPoll, runPoll, pollLevels, pollBars, POLL_QUORUM, POLL_MIN_BARS, POLL_TIMEFRAME, POLL_STOP_FRACTION, type PollInput } from "../src/lib/poll-engine.ts";

import { portfolioGate, historyPageEnds } from "../src/lib/scan-rules.ts";
import { planEntry } from "../src/lib/execution-risk.ts";

/** Deterministic random walk with trends and quiet spells, on the real M30 grid (weekdays only). */
function walk(n: number, seed: number, start = 1.1): Bars {
  let s = seed >>> 0 || 1;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const b: Bars = { t: [], o: [], h: [], l: [], c: [] };
  let t = Date.parse("2026-01-05T00:00:00Z"), p = start;
  while (b.t.length < n) {
    const day = new Date(t).getUTCDay();
    if (day !== 0 && day !== 6) {
      const drift = Math.sin(b.t.length / 300) * 0.00004;
      const o = p, c = p * (1 + drift + (rnd() - 0.5) * 0.0016);
      b.t.push(t); b.o.push(o); b.c.push(c);
      b.h.push(Math.max(o, c) * (1 + rnd() * 0.0006)); b.l.push(Math.min(o, c) * (1 - rnd() * 0.0006));
      p = c;
    }
    t += 1_800_000;
  }
  return b;
}

test("the poll has exactly 60 strategies: 40 quantitative and 20 technical, all distinct", () => {
  assert.equal(STRATEGIES.length, 60);
  assert.equal(STRATEGIES.filter((s) => s.family === "quant").length, 40);
  assert.equal(STRATEGIES.filter((s) => s.family === "ta").length, 20);
  assert.equal(new Set(STRATEGIES.map((s) => s.id)).size, 60);
  assert.equal(new Set(STRATEGIES.map((s) => s.name)).size, 60);
  // Trade reviews split the agreeing list on ", ": a comma inside a name would break the credit.
  for (const s of STRATEGIES) assert.ok(!s.name.includes(","), `${s.name} contains a comma`);
});

test("agreement rule: majority by default, a configurable share, a quorum, and never a tie", () => {
  const votes = (buy: number, sell: number, abstain: number): Vote[] => [
    ...Array<Vote>(buy).fill(1), ...Array<Vote>(sell).fill(-1), ...Array<Vote>(abstain).fill(0),
  ];
  assert.equal(tallyPoll(votes(28, 12, 20), 0.7).direction, "buy");          // 70% exactly
  assert.equal(tallyPoll(votes(27, 13, 20), 0.7).direction, null);           // 67.5%
  assert.equal(tallyPoll(votes(9, 31, 20), 0.7).direction, "sell");          // 77.5% sell
  assert.equal(tallyPoll(votes(29, 0, 31), 0.7).direction, null, "29 opinions is under the quorum of 30");
  assert.equal(tallyPoll(votes(POLL_QUORUM, 0, 60 - POLL_QUORUM), 0.7).direction, "buy");
  assert.match(tallyPoll(votes(27, 13, 20), 0.7).reason, /27 buy \/ 13 sell \/ 20 abstain: 68% buy, 70% needed/);
  // Simple majority (the tested default): one vote more is enough, a tie never trades.
  assert.equal(tallyPoll(votes(16, 15, 29), 0.5).direction, "buy");
  assert.equal(tallyPoll(votes(15, 16, 29), 0.5).direction, "sell");
  assert.equal(tallyPoll(votes(15, 15, 30), 0.5).direction, null);
});

test("an unreadable or nonsensical agreement setting can never mean 'trade anything'", () => {
  const split: Vote[] = [...Array<Vote>(20).fill(1), ...Array<Vote>(20).fill(-1)];
  assert.equal(tallyPoll(split, Number.NaN).direction, null);
  assert.equal(tallyPoll(split, 0.1).direction, null, "below 50% is clamped up to a majority");
});

test("every vote uses only closed candles: appending future bars never changes a past vote", () => {
  const all = walk(2200, 7);
  const cut = 1900;
  const past: Bars = { t: all.t.slice(0, cut), o: all.o.slice(0, cut), h: all.h.slice(0, cut), l: all.l.slice(0, cut), c: all.c.slice(0, cut) };
  for (const s of STRATEGIES) {
    const a = s.compute(past), b = s.compute(all);
    for (let i = cut - 50; i < cut; i++) assert.equal(a[i], b[i], `${s.id} vote at bar ${i} changed when later bars were added`);
  }
});

test("the live scan (newest bar only) votes exactly as the full backtest computation does", () => {
  const b = walk(2000, 11), last = b.c.length - 1;
  const other = walk(2000, 23, 1.3);
  const x = { symbol: "frxEURUSD", closes: { frxEURUSD: b.c, frxGBPUSD: other.c, frxEURGBP: b.c.map((c, i) => c / other.c[i]!) } };
  for (const s of STRATEGIES) assert.equal(s.compute(b, x, last)[last], s.compute(b, x)[last], `${s.id} differs when computed from the last bar only`);
});

/** The same series on every timeframe: enough for the poll's mechanics, not a market. */
function inputOf(m30: Bars, h1: Bars, h4: Bars): PollInput {
  return { symbol: "frxEURUSD", bars: { M30: m30, H1: h1, H4: h4 }, closes: { M30: { frxEURUSD: m30.c }, H1: { frxEURUSD: h1.c }, H4: { frxEURUSD: h4.c } } };
}

test("every strategy has a tested timeframe, and the poll runs end to end on all three", () => {
  for (const s of STRATEGIES) assert.ok(["M30", "H1", "H4"].includes(POLL_TIMEFRAME[s.id]!), `${s.id} has no timeframe`);
  assert.equal(Object.keys(POLL_TIMEFRAME).length, 60);
  const r = runPoll(inputOf(walk(2000, 5), walk(1500, 6), walk(1600, 7)), 0.5);
  assert.equal(r.ballots.length, 60);
  assert.ok(r.ballots.every((b) => b.timeframe === POLL_TIMEFRAME[b.id]));
  assert.equal(r.buy + r.sell + r.abstain, 60);
});

test("history pages join up: no hole between the first request and the older pages", () => {
  const now = 1_790_000_000, g = 3600;
  const ends = historyPageEnds(now, g, 3);
  assert.deepEqual(ends, [now - 500 * g, now - 1500 * g]);
  // The first request covers (now-500g, now]; page k covers (end-1000g, end]: each starts where the next ends.
  assert.equal(ends[1], ends[0]! - 1000 * g);
});

test("strategies survive flat and degenerate series without throwing or voting on nothing", () => {
  const flat: Bars = { t: [], o: [], h: [], l: [], c: [] };
  for (let i = 0; i < 1500; i++) { flat.t.push(i * 1_800_000); flat.o.push(1); flat.h.push(1); flat.l.push(1); flat.c.push(1); }
  const empty: Bars = { t: [], o: [], h: [], l: [], c: [] };
  for (const s of STRATEGIES) {
    assert.doesNotThrow(() => s.compute(empty), s.id);
    assert.doesNotThrow(() => s.compute(flat), s.id);
  }
  const poll = runPoll(inputOf(flat, flat, flat), 0.5);
  assert.equal(poll.direction, null, "a market that does not move gives no trade");
});

test("runPoll refuses without enough history instead of voting on a partial window", () => {
  const ok = walk(2000, 3);
  const r = runPoll(inputOf(ok, ok, walk(POLL_MIN_BARS.H4 - 1, 4)), 0.5);
  assert.equal(r.direction, null);
  assert.match(r.reason, /Not enough H4 history/);
});

test("poll levels pass the order path: reward:risk holds after Deriv's commission anywhere in the band", () => {
  for (const [dir, price, atr] of [["buy", 1.1, 0.0008], ["sell", 1.1, 0.0008], ["buy", 160.5, 0.12], ["sell", 0.65, 0.0006]] as const) {
    const lv = pollLevels(dir, price, atr, 1.5);
    assert.ok(Math.abs(Math.abs(price - lv.stop) - POLL_STOP_FRACTION * price) < 1e-9);
    for (const fill of [lv.entryLow, price, lv.entryHigh]) {
      // $1 x100 at the measured $0.02 commission: the real call the dispatcher makes.
      const plan = planEntry({
        direction: dir, price: fill, entryLow: lv.entryLow, entryHigh: lv.entryHigh, stop: lv.stop, target: lv.target, minRiskReward: 1.5,
        bracket: { stake: 10, multiplier: 100, minStopUsd: 0.1, minTakeProfitUsd: 0.1, maxStopFraction: 0.8, commissionUsd: 0.2 },
      });
      assert.equal(plan.action, "enter", `${dir} ${price} filled at ${fill}: ${"reason" in plan ? plan.reason : ""}`);
    }
  }
});

test("stored candles: off-grid partial candles are dropped, strings become numbers", () => {
  const rows = [
    { t: new Date("2026-09-10T11:20:58Z"), o: "1.1", h: "1.2", l: "1.0", c: "1.15" },
    { t: new Date("2026-09-10T11:30:00Z"), o: "1.15", h: "1.16", l: "1.14", c: "1.155" },
  ];
  const b = pollBars(rows);
  assert.equal(pollBars(rows, "H4").t.length, 0, "11:30 is not on the 4-hour grid");
  assert.deepEqual(b.t, [Date.parse("2026-09-10T11:30:00Z")]);
  assert.equal(b.c[0], 1.155);
});

test("portfolio cap: only the class ceiling — no currency-exposure cap (positions fill until the reserve)", () => {
  const open = [{ symbol: "frxEURUSD", direction: "buy" as const }, { symbol: "frxGBPUSD", direction: "buy" as const }];
  assert.equal(portfolioGate(open, { symbol: "frxAUDUSD", direction: "buy" }, 14).ok, true); // a third short-USD is allowed now
  assert.equal(portfolioGate(open, { symbol: "frxUSDJPY", direction: "buy" }, 2).ok, false); // class ceiling still applies
});
