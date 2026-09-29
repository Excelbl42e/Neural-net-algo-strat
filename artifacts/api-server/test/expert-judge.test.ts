import { test } from "node:test";
import assert from "node:assert/strict";
import { runExpertJudge, computeConfluence, conceptKey, type OHLC } from "../src/lib/quant-filters.ts";

const k = (o: number, h: number, l: number, c: number): OHLC => ({ open: o, high: h, low: l, close: c });

/** Deterministic (seeded LCG) noisy trend, the same scale production actually
 * fetches (h1Long: 250 candles, m30Long: 150) — most of computeConfluence's
 * indicators (EMA200 stack, ADX, Ichimoku) need far more history than the
 * hand-built 20-candle setups above provide, so this is the only way to
 * exercise them meaningfully without a live broker connection. */
function noisyTrend(n: number, start: number, drift: number, noise: number, seed: number): OHLC[] {
  let price = start, s = seed;
  const rand = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const out: OHLC[] = [];
  for (let i = 0; i < n; i++) {
    const move = drift + (rand() - 0.5) * noise;
    const open = price, close = price + move;
    const high = Math.max(open, close) + rand() * noise * 0.3;
    const low = Math.min(open, close) - rand() * noise * 0.3;
    out.push({ open, high, low, close, t: Date.UTC(2026, 0, 1) + i * 3_600_000 });
    price = close;
  }
  return out;
}

// H1 bias series: two ascending fractal swing highs (1.1050 then 1.1080) and
// two ascending fractal swing lows (1.0900 then 1.0905) => bullish bias.
// Only .high/.low/.close matter to runExpertJudge; .open is filler.
const h1Bull: OHLC[] = [
  k(1.1000, 1.1000, 1.0990, 1.0995), k(1.1005, 1.1020, 1.1005, 1.1015), k(1.1015, 1.1050, 1.1030, 1.1045),
  k(1.1045, 1.1040, 1.1015, 1.1015), k(1.1015, 1.1010, 1.0995, 1.0995), k(1.0995, 1.0995, 1.0970, 1.0975),
  k(1.0975, 1.0975, 1.0945, 1.0950), k(1.0950, 1.0950, 1.0900, 1.0905), k(1.0905, 1.0965, 1.0920, 1.0940),
  k(1.0940, 1.0980, 1.0940, 1.0960), k(1.0960, 1.1000, 1.0960, 1.0980), k(1.0980, 1.1030, 1.0990, 1.1010),
  k(1.1010, 1.1080, 1.1020, 1.1060), k(1.1060, 1.1060, 1.1010, 1.1030), k(1.1030, 1.1030, 1.0990, 1.1000),
  k(1.1000, 1.0995, 1.0950, 1.0960), k(1.0960, 1.0960, 1.0920, 1.0935), k(1.0935, 1.0940, 1.0905, 1.0910),
  k(1.0910, 1.0960, 1.0925, 1.0940), k(1.0940, 1.0990, 1.0945, 1.0960),
];

// H4: too short to produce two swings each side => biasFromSwings returns
// null, i.e. "no H4 opinion" rather than disagreement.
const h4Flat: OHLC[] = [k(1.10, 1.10, 1.09, 1.095), k(1.095, 1.10, 1.09, 1.095), k(1.095, 1.10, 1.09, 1.095)];

// M30 setup, empirically verified (see the diagnosis in this change's commit
// message) to produce: a swing low at idx7 (1.0900) that gets swept at idx13
// (wick to 1.0890, close back to 1.0905); a displacement candle at idx15
// that, with idx14/idx16, leaves a bullish FVG [1.0955, 1.0990]; idx16's
// close (1.1010) breaks back above the pre-sweep structure; a later swing
// high at idx19 (1.1180) stands as the real opposing-liquidity target,
// clearing the 2:1 reward:risk floor (actual RR ~2.73).
const m30Setup: OHLC[] = [
  k(1.0930, 1.0930, 1.0920, 1.0925), k(1.0925, 1.0940, 1.0925, 1.0935), k(1.0935, 1.0950, 1.0935, 1.0945),
  k(1.0945, 1.0940, 1.0920, 1.0930), k(1.0930, 1.0930, 1.0905, 1.0915),
  k(1.0915, 1.0925, 1.0920, 1.0922), k(1.0922, 1.0915, 1.0910, 1.0912), k(1.0912, 1.0905, 1.0900, 1.0902),
  k(1.0902, 1.0920, 1.0915, 1.0917), k(1.0917, 1.0935, 1.0925, 1.0930),
  k(1.0920, 1.0940, 1.0915, 1.0925), k(1.0925, 1.0935, 1.0910, 1.0920), k(1.0920, 1.0930, 1.0905, 1.0915),
  k(1.0915, 1.0918, 1.0890, 1.0905), // idx13: sweep of idx7's low (1.0900)
  k(1.0910, 1.0955, 1.0905, 1.0950), // idx14
  k(1.0950, 1.1010, 1.0945, 1.1000), // idx15: displacement
  k(1.1000, 1.1020, 1.0990, 1.1010), // idx16: FVG completes, closes above prior structure
  k(1.1010, 1.1070, 1.1000, 1.1030), // idx17
  k(1.1030, 1.1100, 1.1020, 1.1080), // idx18
  k(1.1080, 1.1180, 1.1060, 1.1150), // idx19: later swing high (the real target)
  k(1.1150, 1.1140, 1.1100, 1.1120), // idx20
  k(1.1120, 1.1130, 1.1080, 1.1100), // idx21: last close stays well above the FVG
];

// No sweep anywhere in this series, so no signal should ever be produced.
const m30Flat: OHLC[] = new Array(20).fill(0)
  .map((_, i) => k(1.10 + i * 0.0001, 1.1005 + i * 0.0001, 1.0995 + i * 0.0001, 1.10 + i * 0.0001));

test("runExpertJudge: finds a valid buy setup (sweep -> structure break -> FVG)", () => {
  const result = runExpertJudge(h1Bull, m30Setup, h4Flat, 0.5, new Set());
  assert.ok(result, "expected a signal, got null");
  assert.equal(result!.direction, "buy");
  assert.ok(result!.stopLevel! < result!.entryLow!, "stop must be below entry for a buy");
  assert.ok(result!.target1Level! > result!.entryLow!, "target must be above entry for a buy");
  const risk = result!.entryLow! - result!.stopLevel!;
  const reward = result!.target1Level! - result!.entryLow!;
  assert.ok(reward / risk >= 2, `reward:risk should clear the 2:1 floor, got ${reward / risk}`);
  assert.ok(result!.confidence >= 0.6 && result!.confidence <= 0.95);
  assert.ok(result!.conceptsDetected.includes("Liquidity Sweep"));
  assert.equal(result!.levels.length, 2);
});

test("runExpertJudge: no sweep in the data => null, not a fabricated signal", () => {
  const result = runExpertJudge(h1Bull, m30Flat, h4Flat, 0.5, new Set());
  assert.equal(result, null);
});

test("runExpertJudge: no clear H1 bias => null", () => {
  const result = runExpertJudge(h4Flat, m30Setup, h4Flat, 0.5, new Set());
  assert.equal(result, null);
});

test("runExpertJudge: confidence floor rejects a real setup below minConfidence", () => {
  const result = runExpertJudge(h1Bull, m30Setup, h4Flat, 0.99, new Set());
  assert.equal(result, null);
});

test("runExpertJudge: self-learning suppression of a fired concept kills the signal", () => {
  const suppressed = new Set([conceptKey("Liquidity Sweep")]);
  const result = runExpertJudge(h1Bull, m30Setup, h4Flat, 0.5, suppressed);
  assert.equal(result, null);
});

test("computeConfluence: realistic-length uptrend produces mostly-buy votes, no crash", () => {
  const h1 = noisyTrend(250, 1.1000, 0.00015, 0.0010, 7);
  const m30 = noisyTrend(150, 1.1000, 0.00010, 0.0008, 13);
  const votes = computeConfluence(h1, m30);
  assert.equal(votes.length, 14, "every voter should always appear, even when its direction is null");
  const withOpinion = votes.filter((v) => v.direction != null);
  assert.ok(withOpinion.length >= 5, `expected several voters to have enough history to fire on 250/150 candles, got ${withOpinion.length}`);
  const buys = withOpinion.filter((v) => v.direction === "buy").length;
  assert.ok(buys > withOpinion.length / 2, `expected a majority-buy vote on a clear uptrend, got ${buys}/${withOpinion.length}`);
});

test("computeConfluence: flat/choppy data never throws and mostly abstains", () => {
  const flat = noisyTrend(250, 1.1000, 0, 0.0003, 99);
  const votes = computeConfluence(flat, flat.slice(0, 150));
  assert.equal(votes.length, 14);
  assert.ok(votes.every((v) => v.direction === "buy" || v.direction === "sell" || v.direction === null));
});
