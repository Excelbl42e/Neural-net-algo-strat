import { strict as assert } from "node:assert";
import test from "node:test";
import {
  applyMultiplierFloor, describeStakePlan, effectiveRiskPcts, maxFundablePositions,
  riskBandFor, typicalLoss, worstCaseLoss, RISK_BANDS, MULTIPLIER_MIN_STAKE,
} from "../src/lib/execution-risk.ts";

const plan = (equity: number, riskPct = 20, dailyLossPct = 20, maxPositions = 3) =>
  describeStakePlan({ equity, riskPerTradePct: riskPct, maxConcurrentPositions: maxPositions, maxDailyLossPct: dailyLossPct });

test("no band boundary pushes the stake back under the $1.00 multiplier floor", () => {
  // The whole point of where the bands are cut: stepping risk down at the
  // boundary must not drop the account onto the stop-less binary path.
  for (const rule of RISK_BANDS) {
    if (rule.from === 0) continue;
    const stake = rule.from * rule.riskPct / 100;
    assert.ok(stake >= MULTIPLIER_MIN_STAKE, `band ${rule.band} at $${rule.from} gives $${stake.toFixed(2)}, under the floor`);
  }
});

test("the band ladder tightens as the balance grows and never loosens", () => {
  let lastRisk = Infinity, lastDaily = Infinity;
  for (const rule of RISK_BANDS) {
    assert.ok(rule.riskPct <= lastRisk, `${rule.band} risk went up`);
    assert.ok(rule.dailyLossPct <= lastDaily, `${rule.band} daily loss went up`);
    lastRisk = rule.riskPct; lastDaily = rule.dailyLossPct;
  }
});

test("the band can only tighten a configured setting, never widen it", () => {
  // A deliberately cautious operator is not talked up to the band ceiling.
  const cautious = effectiveRiskPcts(5, 1, 2);
  assert.equal(cautious.riskPct, 1);
  assert.equal(cautious.dailyLossPct, 2);
  assert.equal(cautious.riskCappedByBand, false);

  // But 20% saved at $5 does not survive to $500.
  const grown = effectiveRiskPcts(500, 20, 20);
  assert.equal(grown.band, "steady");
  assert.equal(grown.riskPct, 2);
  assert.equal(grown.dailyLossPct, 6);
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

test("a $0.99 stake is lifted to $1.00 because the binary it would become risks more", () => {
  const r = applyMultiplierFloor({ stake: 0.99, equity: 4.99 });
  assert.equal(r.lifted, true);
  assert.equal(r.stake, 1);
  // The justification has to hold numerically, not just in prose.
  assert.ok(worstCaseLoss(1, "multiplier") < worstCaseLoss(0.99, "binary"));
});

test("the lift is refused when the balance cannot carry the floor", () => {
  // $0.80 worst case on a $3 balance is 26.7%, past the 20% limit.
  const r = applyMultiplierFloor({ stake: 0.6, equity: 3 });
  assert.equal(r.lifted, false);
  assert.equal(r.stake, 0.6);
  assert.match(r.reason, /too small/);
});

test("an already-multiplier stake is left exactly alone", () => {
  const r = applyMultiplierFloor({ stake: 4, equity: 20 });
  assert.equal(r.lifted, false);
  assert.equal(r.stake, 4);
});

test("a losing trade at the $1.00 floor costs its 1-ATR stop, not a guessed $0.50 floor", () => {
  // 1 ATR (~0.1% of price) on $1 x 100 is ~$0.10. The old model clamped this to
  // an unverified $0.50 Deriv minimum, which the dispatcher no longer assumes.
  assert.equal(typicalLoss(1, "multiplier"), 0.1);
  assert.equal(typicalLoss(40, "multiplier"), 4);
  assert.equal(typicalLoss(0.99, "binary"), 0.99);     // a binary always costs everything
  // Never over the 80% stop cap, however wide the modelled stop.
  assert.equal(typicalLoss(1, "multiplier", 100, 0.02), 0.8);
});

test("$5.00 funds one $1.00 multiplier trade, and the day's budget stops there", () => {
  const p = plan(5);
  assert.equal(p.stake, 1);
  assert.equal(p.contract, "multiplier");
  assert.equal(p.band, "floor");
  assert.equal(p.fundable, 1);
  assert.equal(p.limitedBy, "daily_loss_budget");
  assert.equal(p.worstCaseLoss, 0.8);
});

test("$4.99 no longer falls onto the binary path — the regression that motivated the floor", () => {
  const p = plan(4.99);
  assert.equal(p.contract, "multiplier");
  assert.equal(p.stake, 1);
  assert.equal(p.lifted, true);
  // 20% of $4.99 is $0.99; without the lift this row was a full-stake binary.
  assert.ok(p.worstCaseLoss! < 0.99);
});

test("below the floor's reach the account trades binaries, and says so", () => {
  const p = plan(3);
  assert.equal(p.contract, "binary");
  assert.equal(p.lifted, false);
  // A binary's worst case is the whole stake, and the row must not pretend otherwise.
  assert.equal(p.worstCaseLoss, p.stake);
});

test("the stake ladder keeps worst case shrinking as a share of equity", () => {
  // The property that actually prevents blowing up: bigger balance, smaller bite.
  const shares = [5, 20, 100, 500, 2000].map((e) => plan(e).worstCasePctOfEquity!);
  for (let i = 1; i < shares.length; i++) {
    assert.ok(shares[i]! <= shares[i - 1]!, `share rose from ${shares[i - 1]} to ${shares[i]}`);
  }
  assert.ok(shares.at(-1)! <= 1, `a mature account should risk <=1% per trade, got ${shares.at(-1)}`);
});

test("the preview walks the same path as the dispatcher, lift included", () => {
  // describeStakePlan must not restate the arithmetic — it must call the sizer.
  const fit = maxFundablePositions({ equity: 4.99, riskPerTradePct: 20, maxConcurrentPositions: 3, maxDailyLossPct: 20 });
  assert.deepEqual(fit.stakes, [plan(4.99).stake]);
  assert.deepEqual(fit.lifted, [true]);
});

test("an account under the Deriv minimum is reported as blocked, not as a zero stake", () => {
  const p = plan(0.2);
  assert.equal(p.stake, null);
  assert.equal(p.fundable, 0);
  assert.match(p.blocked!, /minimum stake/);
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

test("the asset-class cap is honoured, because every forex pair is one class", async () => {
  const { maxFundablePositions } = await import("../src/lib/execution-risk.ts");
  // This bot trades forex only, so maxPerAssetClass is a second and lower
  // ceiling than maxConcurrentPositions at their defaults. Reporting "3 of 3"
  // promised a third position the portfolio gate always refuses.
  const capped = maxFundablePositions({
    equity: 1000, riskPerTradePct: 1, maxConcurrentPositions: 3, maxDailyLossPct: 4, maxPerAssetClass: 2,
  });
  assert.equal(capped.configured, 2, "the lower of the two caps is what is promised");
  assert.equal(capped.fundable, 2);
  assert.equal(capped.limitedBy, "asset_class_cap");

  // A wider asset-class cap hands the ceiling back to maxConcurrentPositions.
  const uncapped = maxFundablePositions({
    equity: 1000, riskPerTradePct: 1, maxConcurrentPositions: 3, maxDailyLossPct: 4, maxPerAssetClass: 9,
  });
  assert.equal(uncapped.configured, 3);
  assert.equal(uncapped.limitedBy, "configured");
});
