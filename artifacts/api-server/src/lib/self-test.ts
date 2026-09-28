/**
 * Demo self-test. Refuses unless Deriv itself reports the account as virtual, places ONE
 * minimum-stake demo order, and walks it pending -> confirmed -> closed with timings.
 * Nothing else calls this path. A passed run is what unlocks auto_live.
 */
import { brokerConnectionsTable } from "@workspace/db";
import { decryptSecret } from "./crypto.js";
import { fetchContractStatuses, placeDerivTrade } from "./deriv.js";
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

    mark("pending", "buy request sent: R_100 CALL, 5 ticks, stake 0.35");
    const buy = await placeDerivTrade({
      token, environment: "demo", symbol: "R_100", direction: "buy", stakeAmount: 0.35,
      currency: account.currency, forceBinary: true, binaryDuration: { value: 5, unit: "t" },
    });
    if (!buy.ok || !buy.contractId) {
      return await finish(false, `Buy did not confirm: ${buy.message ?? "unknown"}${buy.ambiguous ? " (ambiguous; check Diagnostics frames)" : ""}`);
    }
    mark("confirmed", `contract ${buy.contractId} bought at ${buy.buyPrice}`);

    const deadline = Date.now() + 120_000;
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
