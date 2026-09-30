import { test } from "node:test";
import assert from "node:assert/strict";
import {
  atrSeries, atrPercentile, efficiencyRatio, findFvgs, findSweeps, swingPoints, findDisplacements,
  premiumDiscount, geometryGate, preTradeGate, verifyClaims, portfolioGate, currencyLegs,
  orderBlockPresent, srFlipSignal, DEFAULT_THRESHOLDS as T, type OHLC,
} from "../src/lib/quant-filters.ts";
import { calculateCappedStake, maxFundablePositions } from "../src/lib/execution-risk.ts";

const k = (o: number, h: number, l: number, c: number): OHLC => ({ open: o, high: h, low: l, close: c });

test("ATR of constant 2-wide candles is 2", () => {
  const c = Array.from({ length: 30 }, () => k(10, 11, 9, 10));
  assert.ok(Math.abs(atrSeries(c)[29]! - 2) < 1e-9);
});
test("ER: straight line = 1, zig-zag ~ 0", () => {
  assert.equal(efficiencyRatio([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), 1);
  assert.ok(efficiencyRatio([1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1])! < 0.01);
});
test("FVG detection", () => {
  const f = findFvgs([k(10, 11, 9, 10.5), k(10.5, 14, 10.5, 13.5), k(13.5, 15, 12, 14)]);
  assert.deepEqual(f.map((x) => [x.kind, x.low, x.high]), [["bullish", 11, 12]]);
  const b = findFvgs([k(14, 15, 13, 13.5), k(13.5, 13.5, 9, 9.5), k(9.5, 10, 8, 9)]);
  assert.equal(b[0]!.kind, "bearish");
});
test("sweep: wick above swing high closing back below", () => {
  const c = [k(1,2,1,1.5),k(1.5,3,1.4,2.8),k(2.8,5,2.7,4.8),k(4.8,4.9,3,3.2),k(3.2,3.5,2.5,3),k(3,3.1,2.4,2.6),k(2.6,5.5,2.5,4.5)];
  const s = findSweeps(c);
  assert.ok(s.some((x) => x.side === "buy_side" && x.level === 5 && x.index === 6));
});
test("displacement uses prior ATR", () => {
  const c = Array.from({ length: 20 }, () => k(10, 10.5, 9.5, 10.1));
  c.push(k(10, 14, 9.9, 13.9));
  assert.ok(findDisplacements(c).some((d) => d.index === 20 && d.direction === "up"));
});
test("premium/discount + geometry gate rejects buy in premium and noise stops", () => {
  const c = [k(5,6,4,5),k(5,7,4.5,6),k(6,10,5.5,9),k(9,9.5,7,7.5),k(7.5,8,6,6.5),k(6.5,7,2,3),k(3,4,2.5,3.5),k(3.5,6,3,5.5),k(5.5,7,4,6.5)];
  const pd = premiumDiscount(c, 8.5)!;
  assert.equal(pd.zone, "premium");
  const g = geometryGate({ direction: "buy", entry: 8.5, stop: 7, target: 12 }, 1, pd, T);
  assert.equal(g.ok, false);
  assert.match(g.reason!, /premium/);
  assert.match(geometryGate({ direction: "buy", entry: 5, stop: 4.8, target: 9 }, 1, null, T).reason!, /Noise stop/);
  assert.match(geometryGate({ direction: "sell", entry: 5, stop: 4, target: 8 }, 1, null, T).reason!, /Inconsistent short/);
  assert.match(geometryGate({ direction: "buy", entry: 5, stop: 4, target: 5.5 }, 1, null, T).reason!, /RR/);
  assert.equal(geometryGate({ direction: "buy", entry: 5, stop: 4, target: 8 }, 1, null, T).ok, true);
});
test("preTradeGate: needs history, rejects dead vol", () => {
  assert.equal(preTradeGate([k(1,2,0,1)], T).ok, false);
  const dead: OHLC[] = [];
  for (let i = 0; i < 120; i++) dead.push(i < 100 ? k(10,12,8,10) : k(10,10.1,9.9,10)); // ATR collapses
  const r = preTradeGate(dead, T);
  assert.equal(r.ok, false); assert.match(r.reason!, /Dead volatility/);
});
test("verifyClaims rejects invented FVG", () => {
  const c = Array.from({ length: 10 }, () => k(10, 11, 9, 10));
  const r = verifyClaims([{ kind: "fvg", low: 50, high: 51 }], c, 2);
  assert.equal(r.ok, false);
});
test("portfolio caps: class + shared currency leg", () => {
  const open = [{ symbol: "frxEURUSD", direction: "buy" as const }, { symbol: "frxGBPUSD", direction: "buy" as const }];
  assert.equal(portfolioGate(open, { symbol: "frxAUDUSD", direction: "buy" }, { ...T, maxPerAssetClass: 5 }).ok, false); // 3rd short-USD
  assert.equal(portfolioGate(open, { symbol: "R_75", direction: "buy" }, T).ok, true);
  assert.deepEqual(currencyLegs("frxEURUSD", "sell"), { EUR: -1, USD: 1 });
});
test("stake table for small accounts", () => {
  const rows: string[] = [];
  for (const equity of [5, 20, 50, 200]) {
    const r = calculateCappedStake({ equity, riskPerTradePct: 1, maxConcurrentPositions: 3, openPositions: 0, smallAccountMaxRiskPct: 10 });
    rows.push(`$${equity}: ${r.ok ? "stake $" + r.stake.toFixed(2) : "SKIP - " + r.reason}`);
  }
  console.log(rows.join("\n"));
  assert.equal((calculateCappedStake({ equity: 5, riskPerTradePct: 1, maxConcurrentPositions: 3, openPositions: 0, smallAccountMaxRiskPct: 10 }) as any).stake, 0.35);
  assert.equal(calculateCappedStake({ equity: 5, riskPerTradePct: 1, maxConcurrentPositions: 3, openPositions: 0, smallAccountMaxRiskPct: 5 }).ok, false); // 0.35/5=7% > 5%
  assert.equal((calculateCappedStake({ equity: 200, riskPerTradePct: 1, maxConcurrentPositions: 3, openPositions: 0, smallAccountMaxRiskPct: 10 }) as any).stake, 2);
});

// ── Regression tests for the audit fixes ────────────────────────────────────

test("preTradeGate actually enforces the efficiency-ratio floor (was computed but ignored)", () => {
  // Zig-zag chop: price covers ground repeatedly but nets ~nowhere, so the
  // Kaufman efficiency ratio sits near 0 — exactly what the floor exists to
  // reject, and exactly what used to sail through because the configured
  // efficiencyRatioMin was computed into metrics and then never compared.
  const chop: OHLC[] = [];
  for (let i = 0; i < 120; i++) {
    const base = i % 2 === 0 ? 100 : 101;
    chop.push(k(base, base + 0.5, base - 0.5, base));
  }
  const band = { atrPercentileMin: 0, atrPercentileMax: 100 }; // isolate the ER gate
  const measured = efficiencyRatio(chop.map((c) => c.close), 10)!;
  assert.ok(measured < 0.15, `chop should score below the default floor, got ${measured}`);

  const enforced = preTradeGate(chop, { ...T, ...band, efficiencyRatioMin: 0.15 });
  assert.equal(enforced.ok, false, "chop must be rejected once the floor is actually applied");
  assert.match(String(enforced.reason), /efficiency ratio/i);

  const disabled = preTradeGate(chop, { ...T, ...band, efficiencyRatioMin: 0 });
  assert.equal(disabled.ok, true, "a zero floor should still let the same series through");
});

test("orderBlockPresent needs a real displacement, not any big-ish candle", () => {
  // Flat, displacement-free series: no order block can exist.
  const flat: OHLC[] = [];
  for (let i = 0; i < 60; i++) flat.push(k(100, 100.2, 99.8, 100));
  assert.equal(orderBlockPresent(flat, 0, "buy"), false);

  // Same series plus a down candle followed by a genuine 4-ATR impulse.
  const impulse = [...flat];
  impulse.push(k(100, 100.1, 99.4, 99.5));   // the order block (opposite close)
  impulse.push(k(99.5, 103.5, 99.4, 103.2)); // displacement in the bias direction
  assert.equal(orderBlockPresent(impulse, 55, "buy"), true);
});

test("srFlipSignal does not call a failed retest bullish", () => {
  // Build a swing high at ~101, break above it, then fall back BELOW it.
  const c: OHLC[] = [];
  for (let i = 0; i < 30; i++) c.push(k(100, 100.3, 99.7, 100));
  c.push(k(100, 101.0, 99.9, 100.8)); // swing high forms at 101.0
  for (let i = 0; i < 4; i++) c.push(k(100.8, 100.9, 100.4, 100.6));
  c.push(k(100.6, 102.0, 100.5, 101.8)); // breaks above 101
  for (let i = 0; i < 6; i++) c.push(k(101.8, 101.9, 100.2, 100.5)); // falls back under 101
  const res = srFlipSignal(c);
  assert.notEqual(res, "buy", "price back below a broken high is a failed retest, not support");
});

test("maxFundablePositions reports what really fits, not the configured ceiling", () => {
  // $5 at 20%/20%: the first $1.00 stake consumes the entire daily budget, so
  // the configured 3 is unreachable however it is set.
  const small = maxFundablePositions({
    equity: 5, riskPerTradePct: 20, maxConcurrentPositions: 3, maxDailyLossPct: 20, smallAccountMaxRiskPct: 10,
  });
  assert.equal(small.configured, 3);
  assert.equal(small.fundable, 1, "only one trade fits inside a $1.00 daily budget");
  assert.equal(small.limitedBy, "daily_loss_budget");

  // Raising the ceiling still cannot conjure budget that is not there. It used
  // to be worse than useless: calculateCappedStake also caps each trade at
  // equity/slots, so a higher ceiling shrank every stake, and at $5 that pushed
  // the first trade from $1.00 to $0.62 — under Deriv's $1.00 multiplier
  // minimum, turning it into a stop-less binary purely from raising a number
  // that looks like it should only ever permit more. The multiplier floor now
  // catches that: the stake is lifted back to $1.00 rather than falling through.
  const raised = maxFundablePositions({
    equity: 5, riskPerTradePct: 20, maxConcurrentPositions: 8, maxDailyLossPct: 20, smallAccountMaxRiskPct: 10,
  });
  assert.ok(raised.fundable <= 2, `a higher ceiling cannot conjure budget that is not there, got ${raised.fundable}`);
  assert.equal(raised.stakes[0], 1, "the floor holds the stake on a multiplier despite the equity/slots squeeze");
  assert.equal(raised.lifted[0], true, "and reports that it had to lift it");

  // A wider daily-loss budget no longer unlocks more positions at this balance:
  // the floor band caps the budget at 20%, because a $5 account that is allowed
  // to lose 60% in a day is the thing this ladder exists to prevent.
  const wider = maxFundablePositions({
    equity: 5, riskPerTradePct: 20, maxConcurrentPositions: 3, maxDailyLossPct: 60, smallAccountMaxRiskPct: 10,
  });
  assert.equal(wider.fundable, 1, `the floor band holds the daily budget at 20%, got ${wider.fundable} positions`);

  // Above the floor band a wider budget does buy capacity, as it should.
  const midsize = maxFundablePositions({
    equity: 100, riskPerTradePct: 5, maxConcurrentPositions: 3, maxDailyLossPct: 10, smallAccountMaxRiskPct: 10,
  });
  assert.ok(midsize.fundable > 1, `a $100 account should fund more than one trade, got ${midsize.fundable}`);

  // A funded account reaches its configured ceiling normally.
  const funded = maxFundablePositions({
    equity: 1000, riskPerTradePct: 1, maxConcurrentPositions: 3, maxDailyLossPct: 4, smallAccountMaxRiskPct: 10,
  });
  assert.equal(funded.fundable, 3);
  assert.equal(funded.limitedBy, "configured");
});
