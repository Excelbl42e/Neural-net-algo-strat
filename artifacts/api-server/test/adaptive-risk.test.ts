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

test("a losing trade at the $1.00 floor costs $0.50, not the modelled 1-ATR stop", () => {
  // Deriv's $0.50 minimum stop_loss binds here: 1 ATR on a $1 stake models to
  // ~$0.10, but the order builder cannot send that. Worth asserting because the
  // difference is 5x and it decides how many losses a $5 account survives.
  assert.equal(typicalLoss(1, "multiplier"), 0.5);
  assert.equal(typicalLoss(40, "multiplier"), 4);      // floor no longer binds
  assert.equal(typicalLoss(0.99, "binary"), 0.99);     // a binary always costs everything
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
