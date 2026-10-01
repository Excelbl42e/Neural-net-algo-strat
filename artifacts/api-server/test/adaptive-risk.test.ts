import { strict as assert } from "node:assert";
import test from "node:test";
import {
  describeStakePlan, effectiveRiskPcts, pollStake,
  riskBandFor, typicalLoss, worstCaseLoss, RISK_BANDS, MULTIPLIER_MIN_STAKE,
} from "../src/lib/execution-risk.ts";

const plan = (equity: number, riskPct = 5, maxPositions = 14, perClass = 14) =>
  describeStakePlan({ equity, riskPerTradePct: riskPct, maxConcurrentPositions: maxPositions, maxPerAssetClass: perClass });

test("no band boundary pushes the stake back under the $1.00 multiplier minimum", () => {
  for (const rule of RISK_BANDS) {
    if (rule.from === 0) continue;
    const stake = rule.from * rule.riskPct / 100;
    assert.ok(stake >= MULTIPLIER_MIN_STAKE, `band ${rule.band} at $${rule.from} gives $${stake.toFixed(2)}, under the minimum`);
  }
});

test("the band ladder tightens as the balance grows and never loosens", () => {
  let lastRisk = Infinity;
  for (const rule of RISK_BANDS) { assert.ok(rule.riskPct <= lastRisk, `${rule.band} risk went up`); lastRisk = rule.riskPct; }
});

test("the band can only tighten a configured setting, never widen it", () => {
  const cautious = effectiveRiskPcts(5, 1);
  assert.equal(cautious.riskPct, 1);
  assert.equal(cautious.riskCappedByBand, false);
  const grown = effectiveRiskPcts(500, 20);
  assert.equal(grown.band, "steady");
  assert.equal(grown.riskPct, 2);
  assert.equal(grown.riskCappedByBand, true);
});

test("riskBandFor lands on the right band at each boundary", () => {
  assert.equal(riskBandFor(5).band, "floor");
  assert.equal(riskBandFor(11.99).band, "floor");
  assert.equal(riskBandFor(12).band, "build");
  assert.equal(riskBandFor(49.99).band, "build");
  assert.equal(riskBandFor(50).band, "grow");
  assert.equal(riskBandFor(200).band, "steady");
  assert.equal(riskBandFor(1000).band, "mature");
  assert.equal(riskBandFor(1_000_000).band, "mature");
});

test("the stake is sized so a stopped-out trade loses the risk percentage, never under $1.00", () => {
  // $1.00 at x100 loses ~$0.62 at the 0.6% stop. 5% of $20 = $1.00 of loss -> $1.61 stake.
  assert.deepEqual(pollStake({ equity: 20, freeBalance: 20, riskPerTradePct: 5 }), { ok: true, stake: 1.61, band: "build", riskPct: 5, riskCappedByBand: false });
  assert.equal((pollStake({ equity: 100, freeBalance: 100, riskPerTradePct: 5 }) as { stake: number }).stake, 8.06);
  // Small balances are held at Deriv's $1.00 minimum rather than refused...
  assert.equal((pollStake({ equity: 10, freeBalance: 10, riskPerTradePct: 5 }) as { stake: number }).stake, 1);
  assert.equal((pollStake({ equity: 10, freeBalance: 2, riskPerTradePct: 5 }) as { stake: number }).stake, 1);
  // ...and positions keep opening until one stake is left. Money held by open trades is not free.
  assert.equal(pollStake({ equity: 10, freeBalance: 1.99, riskPerTradePct: 5 }).ok, false);
  assert.equal(pollStake({ equity: 1, freeBalance: 1, riskPerTradePct: 5 }).ok, false);
  assert.equal(pollStake({ equity: 20, freeBalance: 3, riskPerTradePct: 5 }).ok, false);   // $1.61 stake needs $3.22 free
});

test("the ladder caps the risk lower as the balance grows", () => {
  const big = pollStake({ equity: 2000, freeBalance: 2000, riskPerTradePct: 5 }) as { stake: number; riskPct: number };
  assert.equal(big.riskPct, 1);
  assert.equal(big.stake, 32.25);
});

test("a losing trade costs its 0.6% stop; never over the 80% cap", () => {
  assert.equal(typicalLoss(1), 0.6);
  assert.equal(typicalLoss(40), 24);
  assert.equal(typicalLoss(1, 100, 0.02), 0.8);
  assert.equal(worstCaseLoss(1), 0.8);
});

test("$10: $1.00 per trade, up to 9 open — every vote until one stake is left", () => {
  const p = plan(10);
  assert.equal(p.stake, 1);
  assert.equal(p.fundable, 9);
  assert.equal(p.limitedBy, "equity");
  assert.equal(p.worstCaseLoss, 0.8);
  assert.equal(plan(10, 5, 3, 2).fundable, 2, "a lower ceiling set by the operator still applies");
});

test("under two stakes is blocked with the reason", () => {
  const p = plan(1.5);
  assert.equal(p.stake, null);
  assert.equal(p.fundable, 0);
  assert.match(p.blocked!, /reserve/);
});

test("the stake ladder keeps worst case shrinking as a share of equity", () => {
  const shares = [5, 20, 100, 500, 2000].map((e) => plan(e).worstCasePctOfEquity!);
  for (let i = 1; i < shares.length; i++) assert.ok(shares[i]! <= shares[i - 1]!, `share rose from ${shares[i - 1]} to ${shares[i]}`);
  assert.ok(shares.at(-1)! <= 1.5, `a mature account's worst case (a gap to the 80% cap) should stay near 1%, got ${shares.at(-1)}`);
});

// ── Settlement accounting ────────────────────────────────────────────────────

test("a missing or corrupt stake yields unknown P&L, never a fabricated number", async () => {
  const { parseStake, settlementPnl } = await import("../src/lib/execution-risk.ts");
  // The old code did parseFloat(lotSize ?? "10"): on a $1.00 trade that turned
  // a $0.50 profit into an $8.50 loss, and fed that to the daily-loss guard.
  assert.equal(settlementPnl(1.5, null), null);
  assert.equal(settlementPnl(1.5, "not-a-number"), null);
  assert.equal(settlementPnl(1.5, "0"), null);
  // And an unparseable stake must not produce NaN bound for a numeric column.
  assert.equal(parseStake("abc"), null);
  assert.equal(parseStake("-1"), null);
  assert.equal(parseStake(undefined), null);
});

test("settlement P&L is proceeds minus stake, to the cent", async () => {
  const { settlementPnl } = await import("../src/lib/execution-risk.ts");
  assert.equal(settlementPnl(1.5, "1"), 0.5);      // a winning $1.00 multiplier
  assert.equal(settlementPnl(0.5, "1"), -0.5);     // its stop being hit
  assert.equal(settlementPnl(0, "0.99"), -0.99);   // a binary expiring worthless
  assert.equal(settlementPnl(2, "1.005"), 1);      // rounds, never drifts
});

test("the asset-class cap is honoured, because every forex pair is one class", () => {
  // This bot trades forex only, so maxPerAssetClass is a second and lower
  // ceiling than maxConcurrentPositions at their defaults.
  const capped = describeStakePlan({ equity: 1000, riskPerTradePct: 1, maxConcurrentPositions: 3, maxPerAssetClass: 2 });
  assert.equal(capped.fundable, 2, "the lower of the two caps is what is promised");
  const uncapped = describeStakePlan({ equity: 1000, riskPerTradePct: 1, maxConcurrentPositions: 3, maxPerAssetClass: 9 });
  assert.equal(uncapped.fundable, 3);
});
