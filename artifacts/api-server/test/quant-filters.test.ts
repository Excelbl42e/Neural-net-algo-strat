import { test } from "node:test";
import assert from "node:assert/strict";
import {
  atrSeries, atrPercentile, efficiencyRatio, findFvgs, findSweeps, swingPoints, findDisplacements,
  premiumDiscount, geometryGate, preTradeGate, verifyClaims, portfolioGate, currencyLegs, DEFAULT_THRESHOLDS as T, type OHLC,
} from "../src/lib/quant-filters.ts";
import { calculateCappedStake } from "../src/lib/execution-risk.ts";

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
