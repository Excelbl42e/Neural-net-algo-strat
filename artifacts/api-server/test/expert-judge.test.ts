import { test } from "node:test";
import assert from "node:assert/strict";
import { runExpertJudge, conceptKey, type OHLC } from "../src/lib/quant-filters.ts";

const k = (o: number, h: number, l: number, c: number): OHLC => ({ open: o, high: h, low: l, close: c });

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
