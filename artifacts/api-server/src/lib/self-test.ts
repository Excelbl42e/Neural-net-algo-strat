/**
 * Demo self-test. Refuses unless Deriv itself reports the account as virtual.
 * Checks both order paths real signals can take: a quote-only multiplier
 * proposal (never opens a position — this codebase cannot close one early),
 * then the binary path used by small-account signals — a real buy walked
 * pending -> confirmed -> closed if Deriv's own reported minimum duration is
 * short enough to wait out here, otherwise a quote-only proposal check at
 * the same duration production code actually uses. Nothing else calls this
 * path. A passed run is what unlocks auto_live.
 */
import { brokerConnectionsTable } from "@workspace/db";
import { decryptSecret } from "./crypto.js";
import {
  fetchContractStatuses, placeDerivTrade, checkMultiplierProposal,
  queryBinaryMinDuration, checkBinaryProposal, binaryDurationMs, defaultBinaryDurationDays,
} from "./deriv.js";
import { inspectDerivAccount } from "./deriv-account.js";
import { setSecret } from "./secrets.js";

/** Past this, don't try to synchronously wait for a real binary contract to settle inside the self-test. */
const MAX_SYNCHRONOUS_WAIT_MS = 20 * 60_000;

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

    // Quote-only check (never opens a position) that Deriv accepts the
    // multiplier parameter shape real forex signals actually use — the
    // binary buy below only proves the binary path, and this codebase has
    // no way to close a multiplier position early, so this is a proposal
    // check, not a buy.
    const multiplierCheck = await checkMultiplierProposal(token, "demo", "frxEURUSD");
    mark(multiplierCheck.ok ? "multiplier_path_ok" : "multiplier_path_failed", multiplierCheck.message);
    if (!multiplierCheck.ok) {
      return await finish(false, `Multiplier order path rejected by Deriv (this is what real signals will use): ${multiplierCheck.message}`);
    }

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
      return await finish(true, `Passed: multiplier and binary order paths both accepted by Deriv (binary checked by quote only, at ${useDuration.value}${useDuration.unit} — too long to buy-and-wait in a self-test)`);
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
