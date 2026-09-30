/**
 * Demo self-test. Refuses unless Deriv itself reports the account as virtual.
 *
 * Covers both order paths a real signal can take:
 *
 *  - Multiplier (what a funded account trades): a genuine round trip — quote,
 *    buy at Deriv's $1 minimum with a stop-loss and take-profit attached,
 *    confirm the contract opened, then sell it straight back. The demo balance
 *    moves by the spread, which is the visible proof that an order really went
 *    out. This is also the only place the sell path runs before real money
 *    depends on it.
 *  - Binary (the small-account fallback): a forex binary runs for days, far too
 *    long to buy and wait out here, so this stays a quote-only proposal at the
 *    exact duration production code uses.
 *
 * A passed run is what unlocks auto_live, so it is deliberately the strongest
 * check that can be made without leaving a position open.
 */
import { brokerConnectionsTable } from "@workspace/db";
import { decryptSecret } from "./crypto.js";
import {
  fetchContractStatuses, placeDerivTrade, checkMultiplierProposal, sellDerivTrade,
  queryBinaryMinDuration, checkBinaryProposal, binaryDurationMs, defaultBinaryDurationDays,
} from "./deriv.js";
import { inspectDerivAccount } from "./deriv-account.js";
import { setSecret } from "./secrets.js";

/** Past this, don't try to synchronously wait for a real binary contract to settle inside the self-test. */
const MAX_SYNCHRONOUS_WAIT_MS = 20 * 60_000;
/** Deriv's multiplier minimum. The round trip costs the spread on it, on a demo account. */
const MULTIPLIER_TEST_STAKE = 1;

type Conn = typeof brokerConnectionsTable.$inferSelect;
let busy = false;

export interface SelfTestResult {
  ok: boolean;
  passed: boolean;
  message: string;
  contractId?: number;
  steps: Array<{ step: string; atMs: number; detail?: string }>;
}

export async function runDemoSelfTest(conn: Conn): Promise<SelfTestResult> {
  const steps: SelfTestResult["steps"] = [];
  const t0 = Date.now();
  const mark = (step: string, detail?: string) => steps.push({ step, atMs: Date.now() - t0, detail });
  const finish = async (passed: boolean, message: string, contractId?: number): Promise<SelfTestResult> => {
    const result: SelfTestResult = { ok: passed, passed, message, contractId, steps };
    await setSecret("selftest:last", JSON.stringify({ passed, at: new Date().toISOString(), contractId: contractId ?? null, message, steps }));
    return result;
  };
  if (busy) return { ok: false, passed: false, message: "A self-test is already running", steps };
  busy = true;
  try {
    if (conn.environment !== "demo") return { ok: false, passed: false, message: "Refused: self-test only runs on a connection marked demo", steps };
    const token = await decryptSecret(conn.credential);
    mark("authorize", "asking Deriv which account type this token belongs to");
    const { account } = await inspectDerivAccount(token, "demo");
    if (account.account_type !== "demo") return { ok: false, passed: false, message: "Refused: Deriv did not report this account as virtual (is_virtual)", steps };
    mark("virtual_confirmed", `account ${account.account_id} is a demo account`);

    // A real multiplier round trip: buy, confirm, sell back.
    //
    // This used to be a quote-only proposal, on the grounds that the codebase
    // "has no way to close a multiplier position early". That has not been
    // true for some time — sellDerivTrade exists and both the contract
    // monitor and the manual-close route call it. Meanwhile a proposal proves
    // only that Deriv accepts the parameter *shape*; the buy path once had a
    // wrong field name that no amount of review caught and only a live order
    // exposed, and the sell path has never run against Deriv at all. Leaving
    // it that way meant the first real use of sell would be the contract
    // monitor closing a funded position — the worst possible place to find a
    // bug. Doing it here costs a cent of spread on a demo account.
    //
    // It is also what makes the auto_live gate mean something: "a passed demo
    // self-test" should imply an order actually went out and came back.
    const multiplierCheck = await checkMultiplierProposal(token, "demo", "frxEURUSD");
    mark(multiplierCheck.ok ? "multiplier_quote_ok" : "multiplier_path_failed", multiplierCheck.message);
    if (!multiplierCheck.ok) {
      return await finish(false, `Multiplier order path rejected by Deriv (this is what real signals will use): ${multiplierCheck.message}`);
    }

    // A reference price lets the order carry a real stop-loss/take-profit, so
    // the limit_order attachment is exercised too rather than only the bare buy.
    const { getLastTick } = await import("./candle-feeder.js");
    const tick = getLastTick("frxEURUSD");
    const ref = tick?.price ?? null;
    const levels = ref != null
      ? { entryPrice: ref, stopPrice: ref * 0.999, targetPrice: ref * 1.002 }
      : {};
    mark("multiplier_buy_sent", `frxEURUSD MULTUP, stake $${MULTIPLIER_TEST_STAKE.toFixed(2)}${ref != null ? `, stop/target around ${ref.toFixed(5)}` : ", no reference tick so no stop/target attached"}`);

    const mBuy = await placeDerivTrade({
      token, environment: "demo", symbol: "frxEURUSD", direction: "buy",
      stakeAmount: MULTIPLIER_TEST_STAKE, currency: account.currency, ...levels,
    });
    if (!mBuy.ok || !mBuy.contractId) {
      return await finish(false, `Multiplier buy did not confirm: ${mBuy.message ?? "unknown"}${mBuy.ambiguous ? " (ambiguous — check Diagnostics frames before retrying)" : ""}`);
    }
    mark("multiplier_open", `contract ${mBuy.contractId} opened at ${mBuy.buyPrice}`);

    // Close it straight away. This is the first time the sell path runs
    // against Deriv anywhere, which is the point of doing it on demo.
    const sold = await sellDerivTrade(token, "demo", mBuy.contractId);
    if (!sold.ok) {
      mark("multiplier_close_failed", sold.message ?? "sell rejected");
      return await finish(
        false,
        `Bought multiplier ${mBuy.contractId} but could NOT close it: ${sold.message ?? "sell rejected"}. ` +
        `A demo position is open — the contract monitor will force-close it at the configured hold time, ` +
        `or close it yourself from the Trades page. Do not fund until the sell path works.`,
        mBuy.contractId,
      );
    }
    const roundTripPnl = sold.soldFor != null ? Number((sold.soldFor - MULTIPLIER_TEST_STAKE).toFixed(2)) : null;
    mark("multiplier_closed", `sold for ${sold.soldFor}${roundTripPnl != null ? ` (round trip ${roundTripPnl >= 0 ? "+" : ""}${roundTripPnl})` : ""}`);

    // Test the actual instrument class the bot trades (forex, via binary
    // CALL/PUT — the small-account fallback real signals use when their
    // computed stake is below the multiplier minimum) rather than a
    // leftover synthetic-index symbol from before this app became
    // forex-only.
    //
    // A hardcoded "5 minutes" guess was live-rejected: Deriv's
    // TradingDurationNotAllowed — forex binaries need a longer minimum
    // than synthetic/volatility indices, and no reachable doc states the
    // exact number. Ask Deriv itself via contracts_for instead of guessing
    // again. If that can't be read, or the discovered minimum is too long
    // to wait out synchronously here, fall back to a quote-only proposal
    // check at the same duration real production code already uses
    // (defaultBinaryDurationDays) — still proves the field shape is
    // accepted, without a multi-day wait or a fourth blind guess.
    const minDuration = await queryBinaryMinDuration(token, "demo", "frxEURUSD");
    const useDuration = minDuration ?? { value: defaultBinaryDurationDays(), unit: "d" as const };
    const canWaitForSettlement = minDuration != null && binaryDurationMs(minDuration) <= MAX_SYNCHRONOUS_WAIT_MS;

    if (!canWaitForSettlement) {
      mark("duration_discovery", minDuration
        ? `Deriv's minimum (${useDuration.value}${useDuration.unit}) is too long to wait out here; checking via proposal instead`
        : "Could not read Deriv's minimum duration via contracts_for; checking via proposal at the production default instead");
      const proposalCheck = await checkBinaryProposal(token, "demo", "frxEURUSD", useDuration);
      mark(proposalCheck.ok ? "binary_path_ok" : "binary_path_failed", proposalCheck.message);
      if (!proposalCheck.ok) {
        return await finish(false, `Binary order path rejected by Deriv (this is what small-account signals will use): ${proposalCheck.message}`);
      }
      return await finish(
        true,
        `Passed: a real multiplier was bought and sold back on the demo account` +
        // Sign kept explicit: the spread makes this a small loss, and printing
        // it as "$0.02" read as neither a loss nor a gain.
        `${roundTripPnl != null ? ` (round trip ${roundTripPnl >= 0 ? "+" : "-"}$${Math.abs(roundTripPnl).toFixed(2)})` : ""}` +
        `, and the binary path was accepted at ${useDuration.value}${useDuration.unit} by quote ` +
        `(a forex binary runs for days, too long to buy and wait out here).`,
        mBuy.contractId,
      );
    }

    mark("pending", `buy request sent: frxEURUSD CALL, ${useDuration.value}${useDuration.unit} (Deriv's own reported minimum), stake 0.50`);
    const buy = await placeDerivTrade({
      token, environment: "demo", symbol: "frxEURUSD", direction: "buy", stakeAmount: 0.50,
      currency: account.currency, forceBinary: true, binaryDuration: useDuration,
    });
    if (!buy.ok || !buy.contractId) {
      return await finish(false, `Buy did not confirm: ${buy.message ?? "unknown"}${buy.ambiguous ? " (ambiguous; check Diagnostics frames)" : ""}`);
    }
    mark("confirmed", `contract ${buy.contractId} bought at ${buy.buyPrice}`);

    // Wait proportional to the actual contract duration plus a buffer for
    // settlement lag and polling overhead, rather than a value hardcoded
    // for a specific duration guess.
    const waitMs = binaryDurationMs(useDuration) + 120_000;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3_000));
      const m = await fetchContractStatuses(token, "demo", [buy.contractId]);
      const info = m.get(buy.contractId);
      if (info?.isSold) {
        mark("closed", `profit ${info.profit}, sell_price ${info.sellPrice}`);
        return await finish(true, `Passed: order confirmed and settled in ${((Date.now() - t0) / 1000).toFixed(1)}s`, buy.contractId);
      }
    }
    return await finish(false, `Order confirmed but did not settle within ${Math.round(waitMs / 1000)}s`, buy.contractId);
  } catch (err) {
    return await finish(false, err instanceof Error ? err.message.replace(/otp=[^&\s]+/g, "otp=[redacted]") : "self-test error");
  } finally {
    busy = false;
  }
}
