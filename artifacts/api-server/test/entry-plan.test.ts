import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planEntry, entryZoneState, parseDerivLimitRejection, setupInvalidation, DEFAULT_MIN_LIMIT_ORDER_USD, KNOWN_ACCEPTED_LIMIT_ORDER_USD,
  type EntryPlanInput,
} from "../src/lib/execution-risk.ts";

// A buy setup shaped like the judge's own fixture: FVG 1.0955–1.0990, stop
// beyond the sweep at 1.08965, liquidity target at 1.11800.
const BUY = { direction: "buy" as const, entryLow: 1.0955, entryHigh: 1.0990, stop: 1.08965, target: 1.1180, minRiskReward: 2 };
const BRACKET = { stake: 1, multiplier: 100, minStopUsd: 0.5, minTakeProfitUsd: 0.5, maxStopFraction: 0.8 };

test("regression: a signal firing above its zone waits instead of chasing", () => {
  // The judge's fixture fires with price at 1.10750 — above the FVG, before the
  // retrace. The old dispatcher sent a market order here with a bracket measured
  // from the FVG midpoint: stop ~100 pips above structure, right on the FVG,
  // target ~100 pips past the pool; approved RR 2.73, executed RR 0.59.
  const plan = planEntry({ ...BUY, price: 1.1075, bracket: BRACKET });
  assert.equal(plan.action, "wait");
  assert.match((plan as { reason: string }).reason, /retrace into the entry zone/);
});

test("inside the zone, the bracket is measured from the live price to the structural levels", () => {
  // Deep in the zone, with a stop wide enough that Deriv's $0.50 minimum does not bind.
  const plan = planEntry({ ...BUY, price: 1.0960, bracket: BRACKET });
  assert.equal(plan.action, "enter");
  if (plan.action !== "enter") return;
  assert.equal(plan.stopWidened, false);
  // The executed levels are the structural ones, to within one cent of rounding
  // (a cent is ~1.1 pips at $1 x 100) — and the rounding only ever widens the
  // stop and pulls the target in, never the other way.
  const oneCentOfPrice = 0.01 / ((1 * 100) / 1.0960);
  assert.ok(plan.stopPrice <= BUY.stop && BUY.stop - plan.stopPrice < oneCentOfPrice, `stop ${plan.stopPrice} vs structure ${BUY.stop}`);
  assert.ok(plan.targetPrice <= BUY.target && BUY.target - plan.targetPrice < oneCentOfPrice, `target ${plan.targetPrice} vs pool ${BUY.target}`);
  assert.ok(plan.rr >= 2);
  // $1 x 100 / 1.0960 per unit of price: a 63.5-pip stop is ~$0.58, a 220-pip target ~$2.00.
  assert.equal(plan.stopLossUsd, 0.58);
  assert.equal(plan.takeProfitUsd, 2.0);
});

test("a setup that is over is cancelled, in both directions", () => {
  assert.equal(planEntry({ ...BUY, price: 1.0890 }).action, "cancel", "through the stop");
  assert.equal(planEntry({ ...BUY, price: 1.1180 }).action, "cancel", "at the target");
  assert.equal(planEntry({ ...BUY, price: 1.1250 }).action, "cancel", "past the target");
});

test("at the top of the zone reward:risk can be short of the floor; a deeper fill qualifies", () => {
  // RR from the zone's top edge is (1.1180-1.0990)/(1.0990-1.08965) = 2.03 — just enough.
  // Raise the floor so the top edge fails but the midpoint passes.
  const floor = { ...BUY, minRiskReward: 2.5 };
  const top = planEntry({ ...floor, price: 1.0989 });
  assert.equal(top.action, "wait");
  assert.match((top as { reason: string }).reason, /deeper fill/);
  assert.equal(planEntry({ ...floor, price: 1.0960 }).action, "enter");
});

test("Deriv's minimum stop widens the stop, and reward:risk is judged after it", () => {
  // A tight structure: 10-pip stop, 30-pip target (RR 3 on the chart). On a $1
  // stake at x100 the 10-pip stop is ~$0.09, under a $0.50 minimum. Widened to
  // $0.50 while the target stays ~$0.27, the trade that would actually execute
  // is RR 0.55 — so it must not be sent as though it were RR 3.
  const tight = { direction: "buy" as const, entryLow: 1.1000, entryHigh: 1.1005, stop: 1.0990, target: 1.1030, minRiskReward: 2 };
  // Isolate the stop minimum: Deriv's take-profit minimum set low enough not to bind.
  const plan = planEntry({ ...tight, price: 1.1000, bracket: { ...BRACKET, minTakeProfitUsd: 0.05 } });
  assert.equal(plan.action, "wait");
  assert.match((plan as { reason: string }).reason, /minimum stop widens the stop/);
  // With both of Deriv's minimums at $0.50 it is the take-profit minimum that speaks first.
  const both = planEntry({ ...tight, price: 1.1000, bracket: BRACKET });
  assert.match((both as { reason: string }).reason, /minimum take-profit/);

  // Where Deriv's real minimum is lower, the same structure is tradeable as drawn.
  const lowMin = planEntry({ ...tight, price: 1.1000, bracket: { ...BRACKET, minStopUsd: 0.05, minTakeProfitUsd: 0.05 } });
  assert.equal(lowMin.action, "enter");
});

test("a Deriv minimum stop above the stop cap refuses outright", () => {
  const plan = planEntry({ ...BUY, price: 1.0960, bracket: { ...BRACKET, minStopUsd: 0.9 } });
  assert.equal(plan.action, "refuse");
});

test("a binary enters on the zone and reward:risk alone, with no bracket", () => {
  const plan = planEntry({ ...BUY, price: 1.0960 });
  assert.equal(plan.action, "enter");
  if (plan.action !== "enter") return;
  assert.equal(plan.stopLossUsd, null);
  assert.equal(plan.takeProfitUsd, null);
});

test("sells mirror buys", () => {
  const SELL = { direction: "sell" as const, entryLow: 1.1010, entryHigh: 1.1045, stop: 1.11035, target: 1.0820, minRiskReward: 2 };
  assert.equal(planEntry({ ...SELL, price: 1.0925, bracket: BRACKET }).action, "wait", "below the zone: not retraced yet");
  assert.equal(planEntry({ ...SELL, price: 1.1110, bracket: BRACKET }).action, "cancel", "through the stop");
  assert.equal(planEntry({ ...SELL, price: 1.0815, bracket: BRACKET }).action, "cancel", "past the target");
  const plan = planEntry({ ...SELL, price: 1.1040, bracket: BRACKET });
  assert.equal(plan.action, "enter");
  if (plan.action === "enter") {
    assert.ok(plan.stopPrice >= SELL.stop - 0.00002, "a sell's stop is never tighter than structure");
    assert.ok(plan.targetPrice >= SELL.target - 0.00002, "a sell's target is never past the pool");
  }
});

test("inconsistent stored levels are refused, not traded", () => {
  assert.equal(planEntry({ ...BUY, stop: 1.1000, price: 1.0960 }).action, "refuse");
  assert.equal(planEntry({ ...BUY, price: Number.NaN }).action, "refuse");
});

test("property: an entered plan never executes a trade worse than the one approved", () => {
  // Thousands of random setups and prices. Whatever planEntry lets through must
  // honour the approval: reward:risk at or above the floor as executed, stop
  // never tighter than structure, target never beyond the pool, stop within
  // the cap. These are exactly the properties the old dispatcher violated.
  let s = 42;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  let entered = 0;
  for (let i = 0; i < 20000; i++) {
    const buy = rnd() < 0.5;
    const mid = 0.8 + rnd() * 150;              // covers JPY pairs too
    const pip = mid > 20 ? 0.01 : 0.0001;
    const zone = (2 + rnd() * 30) * pip;
    const stopGap = (3 + rnd() * 80) * pip;
    const targetGap = (5 + rnd() * 300) * pip;
    const lo = mid - zone / 2, hi = mid + zone / 2;
    const stop = buy ? lo - stopGap : hi + stopGap;
    const target = buy ? hi + targetGap : lo - targetGap;
    const price = buy ? stop + (target - stop) * rnd() : target + (stop - target) * rnd();
    const minRiskReward = 1 + rnd() * 2;
    const bracket = {
      stake: 1 + rnd() * 50, multiplier: [100, 200, 300, 500][Math.floor(rnd() * 4)]!,
      minStopUsd: rnd() * 1.5, minTakeProfitUsd: rnd() * 1.5, maxStopFraction: 0.8,
      commissionUsd: rnd() < 0.3 ? 0 : rnd() * 0.2,
    };
    const input: EntryPlanInput = { direction: buy ? "buy" : "sell", price, entryLow: lo, entryHigh: hi, stop, target, minRiskReward, bracket };
    const plan = planEntry(input);
    if (plan.action !== "enter") continue;
    entered++;
    const tol = 1e-9 * mid;
    assert.ok(plan.rr >= minRiskReward - 1e-9, `rr ${plan.rr} < ${minRiskReward}`);
    assert.ok(plan.stopLossUsd! <= bracket.maxStopFraction * bracket.stake + 1e-9, "stop beyond the cap");
    assert.ok(plan.stopLossUsd! >= bracket.minStopUsd - 1e-9, "stop under Deriv's minimum");
    assert.ok(plan.takeProfitUsd! >= bracket.minTakeProfitUsd - 1e-9, "target under Deriv's minimum");
    if (buy) {
      assert.ok(price <= hi + tol, "entered a buy above its zone");
      assert.ok(plan.stopPrice <= stop + (stop * 1e-6), "buy stop tighter than structure");
      assert.ok(plan.targetPrice <= target + tol, "buy target beyond the pool");
    } else {
      assert.ok(price >= lo - tol, "entered a sell below its zone");
      assert.ok(plan.stopPrice >= stop - (stop * 1e-6), "sell stop tighter than structure");
      assert.ok(plan.targetPrice >= target - tol, "sell target beyond the pool");
    }
  }
  assert.ok(entered > 500, `the property should be exercised on plenty of entries (got ${entered})`);
});

test("entryZoneState agrees with planEntry on where price is", () => {
  assert.equal(entryZoneState("buy", 1.1075, BUY.entryLow, BUY.entryHigh, BUY.stop, BUY.target), "wait");
  assert.equal(entryZoneState("buy", 1.0960, BUY.entryLow, BUY.entryHigh, BUY.stop, BUY.target), "in_zone");
  assert.equal(entryZoneState("buy", 1.0890, BUY.entryLow, BUY.entryHigh, BUY.stop, BUY.target), "over");
  assert.equal(entryZoneState("buy", 1.1190, BUY.entryLow, BUY.entryHigh, BUY.stop, BUY.target), "over");
  assert.equal(entryZoneState("buy", Number.NaN, BUY.entryLow, BUY.entryHigh, BUY.stop, BUY.target), "wait");
});

test("the commission is inside the bracket: the stop still fires at structure, the target at the pool", () => {
  // Deriv books its commission as a loss at open. A stop-loss amount equal to
  // the price move alone would fire before price reached the structural stop.
  const c = 0.05;
  const plan = planEntry({ ...BUY, price: 1.0960, bracket: { ...BRACKET, commissionUsd: c } });
  const bare = planEntry({ ...BUY, price: 1.0960, bracket: BRACKET });
  assert.equal(plan.action, "enter");
  assert.equal(bare.action, "enter");
  if (plan.action !== "enter" || bare.action !== "enter") return;
  assert.equal(plan.stopLossUsd, 0.63, "stop amount = move to structure + commission");
  assert.equal(plan.takeProfitUsd, 1.95, "take-profit amount = move to the pool - commission");
  // The price levels Deriv acts on are unchanged: at structure and at the pool.
  const oneCentOfPrice = 0.01 / ((1 * 100) / 1.0960);
  assert.ok(plan.stopPrice <= BUY.stop && BUY.stop - plan.stopPrice < oneCentOfPrice);
  assert.ok(plan.targetPrice <= BUY.target && BUY.target - plan.targetPrice < oneCentOfPrice);
  // Reward:risk is what is actually won or lost, so it is lower than without cost.
  assert.ok(plan.rr < bare.rr);
  assert.ok(Math.abs(plan.rr - 1.95 / 0.63) < 1e-9);
});

test("a commission that eats the edge makes the setup wait", () => {
  // 20-pip stop, 45-pip target (RR 2.25 on the chart) on $1 x 100. A $0.04
  // commission turns $0.18 / $0.41 into $0.22 / $0.37: RR 1.68 as executed.
  const setup = { direction: "buy" as const, entryLow: 1.1000, entryHigh: 1.1005, stop: 1.0980, target: 1.1045, minRiskReward: 2 };
  const low = { ...BRACKET, minStopUsd: 0.1, minTakeProfitUsd: 0.1 };
  assert.equal(planEntry({ ...setup, price: 1.1000, bracket: low }).action, "enter");
  const costly = planEntry({ ...setup, price: 1.1000, bracket: { ...low, commissionUsd: 0.04 } });
  assert.equal(costly.action, "wait");
});

test("at the assumed minimum a $1 stake can trade an ordinary M30 structure", () => {
  // Why the assumed minimum is $0.10, not $0.50. A 20-pip stop with a 50-pip
  // target on EURUSD is an ordinary setup. At $0.50 the stop has to be widened
  // to ~55 pips, which kills reward:risk; at $0.10 it trades as drawn.
  const setup = { direction: "buy" as const, entryLow: 1.1000, entryHigh: 1.1005, stop: 1.0980, target: 1.1050, minRiskReward: 2 };
  const at = (min: number) => planEntry({ ...setup, price: 1.1000, bracket: { ...BRACKET, minStopUsd: min, minTakeProfitUsd: min, commissionUsd: 0.01 } });
  assert.equal(at(KNOWN_ACCEPTED_LIMIT_ORDER_USD).action, "wait");
  const plan = at(DEFAULT_MIN_LIMIT_ORDER_USD);
  assert.equal(plan.action, "enter");
  if (plan.action === "enter") assert.equal(plan.stopWidened, false);
});

test("Deriv's refusal of a bracket is read into a raised minimum", () => {
  assert.deepEqual(parseDerivLimitRejection("Please enter a stop loss amount that's higher than 0.50."), { stopLossMin: 0.5 });
  assert.deepEqual(parseDerivLimitRejection("Please enter a take profit amount that's higher than 0.20."), { takeProfitMin: 0.2 });
  assert.deepEqual(parseDerivLimitRejection("Minimum stop_loss is 0.35 — details: {\"field\":\"stop_loss\"}"), { stopLossMin: 0.35 });
  // About a limit, but no figure: answered with an amount Deriv has accepted before.
  assert.deepEqual(parseDerivLimitRejection("Invalid stop loss."), { stopLossMin: KNOWN_ACCEPTED_LIMIT_ORDER_USD });
  assert.deepEqual(parseDerivLimitRejection("limit_order is invalid"), { stopLossMin: 0.5, takeProfitMin: 0.5 });
  // Ceilings and unrelated refusals are not minimums.
  assert.equal(parseDerivLimitRejection("Stop loss cannot be more than stake."), null);
  assert.equal(parseDerivLimitRejection("Please enter a stop loss amount that's lower than 1.00."), null);
  assert.equal(parseDerivLimitRejection("Trading is not offered for this asset."), null);
  assert.equal(parseDerivLimitRejection("Your account balance (0.20 USD) is insufficient to buy this contract (1.00 USD)."), null);
  assert.equal(parseDerivLimitRejection(undefined), null);
  // An absurd figure is not learned as a minimum that would block everything.
  assert.deepEqual(parseDerivLimitRejection("stop loss must be higher than 5000"), { stopLossMin: KNOWN_ACCEPTED_LIMIT_ORDER_USD });
});

test("a setup whose stop was traded through is over, even if price is back in the zone", () => {
  // The case the live-price check missed: the stop taken at 03:00 while a gate
  // held the dispatch, price back in the zone by the London open.
  const nowInZone = 1.0960;
  assert.equal(planEntry({ ...BUY, price: nowInZone }).action, "enter", "the live price alone says enter");
  const over = setupInvalidation("buy", BUY.stop, BUY.target, 1.0890, 1.1010);
  assert.match(over ?? "", /through the stop/);
  // Touching the stop exactly counts; a low above it does not.
  assert.ok(setupInvalidation("buy", BUY.stop, BUY.target, BUY.stop, 1.1010));
  assert.equal(setupInvalidation("buy", BUY.stop, BUY.target, BUY.stop + 0.00001, 1.1010), null);
});

test("a setup whose target was reached before entry is over", () => {
  assert.match(setupInvalidation("buy", BUY.stop, BUY.target, 1.0950, 1.1181) ?? "", /happened without us/);
  // Sells mirror.
  const SELL = { stop: 1.11035, target: 1.0820 };
  assert.match(setupInvalidation("sell", SELL.stop, SELL.target, 1.1000, 1.1105) ?? "", /through the stop/);
  assert.match(setupInvalidation("sell", SELL.stop, SELL.target, 1.0815, 1.1000) ?? "", /happened without us/);
  assert.equal(setupInvalidation("sell", SELL.stop, SELL.target, 1.0900, 1.1100), null);
  // No history yet: nothing to judge.
  assert.equal(setupInvalidation("buy", BUY.stop, BUY.target, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY), null);
});
