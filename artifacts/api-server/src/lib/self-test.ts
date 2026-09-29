/**
 * Demo self-test. Refuses unless Deriv itself reports the account as virtual.
 * Checks both order paths real signals can take: a quote-only multiplier
 * proposal (never opens a position — this codebase cannot close one early),
 * then places ONE minimum-stake binary demo order and walks it pending ->
 * confirmed -> closed with timings. Nothing else calls this path. A passed
 * run is what unlocks auto_live.
 */
import { brokerConnectionsTable } from "@workspace/db";
import { decryptSecret } from "./crypto.js";
import { fetchContractStatuses, placeDerivTrade, checkMultiplierProposal } from "./deriv.js";
import { inspectDerivAccount } from "./deriv-account.js";
import { setSecret } from "./secrets.js";

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

    // Test the actual instrument class the bot trades (forex, via a binary
    // CALL for a fast, self-settling round trip) rather than a leftover
    // synthetic-index symbol from before this app became forex-only.
    //
    // stakeAmount: 0.50 — live-verified. A real self-test run against this
    // exact binary CALL request returned InvalidtoBuy/InvalidMinStake:
    // "Please enter a stake amount that's at least 0.50." DERIV_MIN_STAKE
    // (0.35, execution-risk.ts) is the MULTIPLIER minimum, not binary's —
    // this path never affects live forex signals (they only ever place
    // multiplier contracts; forceBinary is set only here), so the fix is
    // scoped to this diagnostic, not to real trade sizing.
    mark("pending", "buy request sent: frxEURUSD CALL, 5 minutes, stake 0.50");
    const buy = await placeDerivTrade({
      token, environment: "demo", symbol: "frxEURUSD", direction: "buy", stakeAmount: 0.50,
      currency: account.currency, forceBinary: true, binaryDuration: { value: 5, unit: "m" },
    });
    if (!buy.ok || !buy.contractId) {
      return await finish(false, `Buy did not confirm: ${buy.message ?? "unknown"}${buy.ambiguous ? " (ambiguous; check Diagnostics frames)" : ""}`);
    }
    mark("confirmed", `contract ${buy.contractId} bought at ${buy.buyPrice}`);

    // 5-minute contract + settlement lag + polling overhead: give it a
    // generous window rather than the tick-contract-sized 120s this used
    // to have when it tested a synthetic instead of forex.
    const deadline = Date.now() + 420_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3_000));
      const m = await fetchContractStatuses(token, "demo", [buy.contractId]);
      const info = m.get(buy.contractId);
      if (info?.isSold) {
        mark("closed", `profit ${info.profit}, sell_price ${info.sellPrice}`);
        return await finish(true, `Passed: order confirmed and settled in ${((Date.now() - t0) / 1000).toFixed(1)}s`, buy.contractId);
      }
    }
    return await finish(false, "Order confirmed but did not settle within 120s", buy.contractId);
  } catch (err) {
    return await finish(false, err instanceof Error ? err.message.replace(/otp=[^&\s]+/g, "otp=[redacted]") : "self-test error");
  } finally {
    busy = false;
  }
}
