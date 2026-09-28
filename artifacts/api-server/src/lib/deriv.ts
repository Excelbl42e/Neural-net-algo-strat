import { getSyntheticSymbol } from "./synthetic-catalog.js";
import { inspectDerivAccount, syncDerivPatAccount } from "./deriv-account.js";
import { DerivRequestTimeout, openDerivSession, type DerivSession } from "./deriv-session.js";

export interface DerivTradeParams {
  token: string;
  environment: "demo" | "real";
  symbol: string;
  direction: "buy" | "sell";
  stakeAmount: number;
  currency?: string;
  /** Persisted signal id, echoed by Deriv in passthrough so the reconciler can match. */
  signalId?: number;
  /** Approximate entry price (mid of entry zone). Used to size SL/TP. */
  entryPrice?: number | null;
  stopPrice?: number | null;
  targetPrice?: number | null;
  /** Use binary CALL/PUT (stake < $1 makes multipliers ineligible). */
  forceBinary?: boolean;
  /** Override binary duration. Default: DERIV_BINARY_DURATION_DAYS (3) days. */
  binaryDuration?: { value: number; unit: "t" | "s" | "m" | "h" | "d" };
}

export interface DerivTradeResult {
  ok: boolean;
  contractId?: number;
  buyPrice?: number;
  contractType?: string;
  /** Binary duration actually sent, e.g. "3d" (null for multipliers). */
  duration?: string | null;
  message?: string;
  /** The broker may have accepted an order but did not confirm its outcome. */
  ambiguous?: boolean;
  /** Safe to retry only because no buy request was submitted. */
  retryable?: boolean;
}

const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_OPEN_MS = 60_000;
let consecutiveBrokerErrors = 0;
let circuitOpenUntil = 0;

export function defaultBinaryDurationDays(): number {
  const raw = Number(process.env.DERIV_BINARY_DURATION_DAYS ?? "3");
  return Number.isFinite(raw) && raw >= 1 && raw <= 4 ? Math.floor(raw) : 3;
}

/**
 * Place exactly one trade over the OTP-authenticated account channel. Anything
 * that fails BEFORE the buy frame is written is retryable. Anything after the
 * buy frame is written and not answered is ambiguous and is never replayed:
 * the reconciler decides what actually happened.
 */
export async function placeDerivTrade(params: DerivTradeParams): Promise<DerivTradeResult> {
  if (!Number.isFinite(params.stakeAmount) || params.stakeAmount < 0.35) {
    return { ok: false, message: "Stake is below the Deriv minimum or invalid" };
  }
  if (Date.now() < circuitOpenUntil) {
    return { ok: false, retryable: true, message: "Deriv execution circuit breaker is open" };
  }
  let session: DerivSession | null = null;
  try {
    session = await openDerivSession(params.token, params.environment);
  } catch (err) {
    consecutiveBrokerErrors++;
    if (consecutiveBrokerErrors >= CIRCUIT_FAILURE_THRESHOLD) circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
    return { ok: false, retryable: true, message: err instanceof Error ? err.message : "Deriv session failed" };
  }
  if (params.environment === "demo" && !session.isVirtual) {
    session.close();
    return { ok: false, message: "Refusing: Deriv did not confirm this account is virtual" };
  }
  if (params.environment === "real" && session.isVirtual) {
    session.close();
    return { ok: false, message: "Refusing: account is virtual but real environment was requested" };
  }

  const meta = getSyntheticSymbol(params.symbol);
  const symbol = meta?.code ?? params.symbol;
  const useMultiplier = meta?.tradeType === "multiplier" && !params.forceBinary;
  const multiplier = meta?.multiplier ?? 30;
  const currency = params.currency ?? "USD";
  let parameters: Record<string, unknown>;
  let duration: string | null = null;
  if (useMultiplier) {
    parameters = {
      contract_type: params.direction === "buy" ? "MULTUP" : "MULTDOWN",
      symbol, amount: params.stakeAmount, basis: "stake", currency, multiplier,
    };
    const limit = computeLimitOrder(params, multiplier);
    if (limit) parameters.limit_order = limit;
  } else {
    const d = params.binaryDuration ?? { value: defaultBinaryDurationDays(), unit: "d" as const };
    duration = `${d.value}${d.unit}`;
    parameters = {
      contract_type: params.direction === "buy" ? "CALL" : "PUT",
      symbol, duration: d.value, duration_unit: d.unit,
      amount: params.stakeAmount, basis: "stake", currency,
    };
  }
  const contractType = useMultiplier ? "multiplier" : "binary";

  try {
    // From here on the request may have reached Deriv: never treat failure as retryable.
    const res = await session.request<{
      error?: { message?: string; code?: string };
      buy?: { contract_id?: number; buy_price?: number };
    }>(
      { buy: "1", price: params.stakeAmount, parameters, passthrough: { signal_id: params.signalId ?? null } },
      { signalId: params.signalId ?? null, timeoutMs: 20_000 },
    );
    if (res.error) {
      consecutiveBrokerErrors = 0;
      return { ok: false, message: res.error.message ?? "Deriv rejected the buy request" };
    }
    if (!res.buy?.contract_id) return { ok: false, ambiguous: true, message: "Buy response missing contract_id" };
    consecutiveBrokerErrors = 0;
    return {
      ok: true, contractId: res.buy.contract_id, buyPrice: res.buy.buy_price, contractType, duration,
      message: `Contract ${res.buy.contract_id} opened at ${res.buy.buy_price}`,
    };
  } catch (err) {
    if (err instanceof DerivRequestTimeout || (err instanceof Error && /closed/i.test(err.message))) {
      return { ok: false, ambiguous: true, message: "Deriv connection dropped or timed out after buy submission; outcome is ambiguous" };
    }
    return { ok: false, ambiguous: true, message: err instanceof Error ? err.message : "Unknown error after buy submission" };
  } finally {
    session.close();
  }
}

export interface DerivContractInfo {
  contractId: number;
  symbol: string | null;
  buyPrice: number | null;
  purchaseTime: number | null;
  isSold: boolean;
  profit: number | null;
  sellPrice: number | null;
  sellSpot: number | null;
  sellTime: number | null;
}

/** Open portfolio + recent profit table for an account. Used by the reconciler. */
export async function fetchRecentContracts(token: string, environment: "demo" | "real"): Promise<DerivContractInfo[]> {
  const session = await openDerivSession(token, environment);
  try {
    const out: DerivContractInfo[] = [];
    const pf = await session.request<{ portfolio?: { contracts?: Array<Record<string, any>> }; error?: unknown }>({ portfolio: 1 });
    if ((pf as { error?: unknown }).error) throw new Error("Deriv portfolio request rejected");
    for (const c of pf.portfolio?.contracts ?? []) {
      out.push({
        contractId: Number(c.contract_id), symbol: c.symbol ?? null,
        buyPrice: c.buy_price != null ? Number(c.buy_price) : null,
        purchaseTime: c.purchase_time != null ? Number(c.purchase_time) : null,
        isSold: false, profit: null, sellPrice: null, sellSpot: null, sellTime: null,
      });
    }
    const pt = await session.request<{ profit_table?: { transactions?: Array<Record<string, any>> }; error?: unknown }>({
      profit_table: 1, description: 1, limit: 50, sort: "DESC",
    });
    if ((pt as { error?: unknown }).error) throw new Error("Deriv profit_table request rejected");
    for (const t of pt.profit_table?.transactions ?? []) {
      const sym = typeof t.shortcode === "string" ? (t.shortcode.split("_")[1] ?? null) : null;
      const buy = t.buy_price != null ? Number(t.buy_price) : null;
      const sell = t.sell_price != null ? Number(t.sell_price) : null;
      out.push({
        contractId: Number(t.contract_id), symbol: sym, buyPrice: buy,
        purchaseTime: t.purchase_time != null ? Number(t.purchase_time) : null,
        isSold: true, profit: buy != null && sell != null ? Number((sell - buy).toFixed(2)) : null,
        sellPrice: sell, sellSpot: null, sellTime: t.sell_time != null ? Number(t.sell_time) : null,
      });
    }
    return out;
  } finally {
    session.close();
  }
}

/** Query settlement status of specific contracts through one session. */
export async function fetchContractStatuses(
  token: string, environment: "demo" | "real", contractIds: number[],
): Promise<Map<number, DerivContractInfo>> {
  const result = new Map<number, DerivContractInfo>();
  if (contractIds.length === 0) return result;
  const session = await openDerivSession(token, environment);
  try {
    for (const id of contractIds) {
      try {
        const r = await session.request<{ proposal_open_contract?: Record<string, any>; error?: unknown }>(
          { proposal_open_contract: 1, contract_id: id }, { timeoutMs: 15_000 },
        );
        const poc = r.proposal_open_contract;
        if ((r as { error?: unknown }).error || !poc || Number(poc.contract_id) !== id) continue;
        const sold = poc.is_sold === 1 || poc.is_sold === true || poc.status === "sold";
        result.set(id, {
          contractId: id, symbol: poc.underlying ?? null,
          buyPrice: poc.buy_price != null ? Number(poc.buy_price) : null,
          purchaseTime: poc.purchase_time != null ? Number(poc.purchase_time) : null,
          isSold: sold,
          profit: poc.profit != null ? Number(poc.profit) : null,
          sellPrice: poc.sell_price != null ? Number(poc.sell_price) : null,
          sellSpot: poc.sell_spot != null ? Number(poc.sell_spot) : null,
          sellTime: poc.sell_time != null ? Number(poc.sell_time) : null,
        });
      } catch { /* one contract failing is never settlement proof */ }
    }
  } finally {
    session.close();
  }
  return result;
}

/**
 * Compute Deriv limit_order { stop_loss, take_profit } in USD from the signal's
 * price levels. Returns null if we don't have enough info.
 *
 * For multipliers: pnl_usd = stake * multiplier * (price_move / entry_price)
 * So:             usd_at_level = stake * multiplier * |level - entry| / entry
 */
function computeLimitOrder(
  params: DerivTradeParams,
  multiplier: number,
): { stop_loss?: number; take_profit?: number } | null {
  const entry = params.entryPrice;
  if (entry == null || entry <= 0) return null;
  const out: { stop_loss?: number; take_profit?: number } = {};

  if (params.stopPrice != null) {
    const usd = params.stakeAmount * multiplier * Math.abs(params.stopPrice - entry) / entry;
    // Cap at 80% of stake so we exit before Deriv's auto stop-out at 100%.
    const cap = params.stakeAmount * 0.8;
    out.stop_loss = Math.max(0.5, Math.min(cap, Number(usd.toFixed(2))));
  }
  if (params.targetPrice != null) {
    const usd = params.stakeAmount * multiplier * Math.abs(params.targetPrice - entry) / entry;
    out.take_profit = Math.max(0.5, Number(usd.toFixed(2)));
  }
  if (out.stop_loss == null && out.take_profit == null) return null;
  return out;
}

export interface DerivSyncResult {
  ok: boolean;
  status: "connected" | "error";
  isVirtual?: boolean;
  balance?: number;
  equity?: number;
  currency?: string;
  loginid?: string;
  openPositions?: number;
  message?: string;
}

export interface DerivAuthorizationResult {
  ok: boolean;
  isVirtual?: boolean;
  message?: string;
}

/**
 * Confirm one active account of the requested type through Deriv's PAT
 * account listing. Never infer demo status from a user-supplied label.
 */
export async function authorizeDerivAccount(token: string, environment: string): Promise<DerivAuthorizationResult> {
  if (environment !== "demo" && environment !== "real") {
    return { ok: false, message: "Unsupported Deriv account environment" };
  }
  try {
    await inspectDerivAccount(token, environment);
    return { ok: true, isVirtual: environment === "demo" };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Deriv account lookup failed" };
  }
}

export async function syncDerivAccount(token: string, environment: string): Promise<DerivSyncResult> {
  if (environment !== "demo" && environment !== "real") {
    return { ok: false, status: "error", message: "Unsupported Deriv account environment" };
  }
  try {
    return await syncDerivPatAccount(token, environment);
  } catch (error) {
    return { ok: false, status: "error", message: error instanceof Error ? error.message : "Deriv sync failed" };
  }
}
