import { getSyntheticSymbol } from "./synthetic-catalog.js";
import { inspectDerivAccount, syncDerivPatAccount, toFiniteNumber } from "./deriv-account.js";
import { DerivRequestTimeout, openDerivSession, type DerivSession } from "./deriv-session.js";

export type BinaryDuration = { value: number; unit: "t" | "s" | "m" | "h" | "d" };

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
  /** Override binary duration, skipping the probe. Default: the shortest duration Deriv accepts, preferring DERIV_BINARY_DURATION_DAYS (1) day. */
  binaryDuration?: BinaryDuration;
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

/**
 * The only binary duration ever confirmed live on Deriv for forex (a 5-minute
 * attempt came back `TradingDurationNotAllowed`). Nothing shorter is assumed
 * to work — it is *probed* per symbol below, and this is what we fall back to
 * so the binary path can never go dead.
 */
export const VERIFIED_BINARY_FALLBACK_DAYS = 3;

/**
 * Preferred binary duration. 1 day by default so a binary settles inside the
 * intended 4h–1day holding window instead of running for most of a week;
 * `resolveBinaryDuration()` falls back to VERIFIED_BINARY_FALLBACK_DAYS when
 * Deriv refuses it for a symbol.
 */
export function defaultBinaryDurationDays(): number {
  const raw = Number(process.env.DERIV_BINARY_DURATION_DAYS ?? "1");
  return Number.isFinite(raw) && raw >= 1 && raw <= 4 ? Math.floor(raw) : 1;
}

/** Cache of the probe result, so the extra round-trip is paid once per symbol, not once per trade. */
const binaryDurationCache = new Map<string, { d: BinaryDuration; at: number }>();
const BINARY_DURATION_CACHE_MS = 6 * 60 * 60 * 1000;

/** Exported for tests / diagnostics: forget what was probed so the next trade re-asks Deriv. */
export function clearBinaryDurationCache(): void { binaryDurationCache.clear(); }

/**
 * Decide which binary duration to actually send.
 *
 * Asks Deriv for a quote-only `proposal` at the preferred (shorter) duration
 * first. A proposal never creates a contract, so this is safe to run before
 * the buy: if Deriv refuses the shorter duration, or the probe itself fails,
 * we send the live-verified fallback instead and the trade still goes out.
 */
async function resolveBinaryDuration(
  session: DerivSession, symbol: string, currency: string,
): Promise<{ d: BinaryDuration; note: string }> {
  const preferred: BinaryDuration = { value: defaultBinaryDurationDays(), unit: "d" };
  const fallback: BinaryDuration = { value: VERIFIED_BINARY_FALLBACK_DAYS, unit: "d" };
  // Nothing to gain from probing a duration that is not shorter than the fallback.
  if (preferred.value >= fallback.value) return { d: preferred, note: `${preferred.value}d (not shorter than the verified fallback; sent as-is)` };

  const key = `${symbol}:${preferred.value}${preferred.unit}`;
  const hit = binaryDurationCache.get(key);
  if (hit && Date.now() - hit.at < BINARY_DURATION_CACHE_MS) return { d: hit.d, note: `${hit.d.value}${hit.d.unit} (cached probe result)` };

  try {
    const res = await session.request<{ proposal?: { id?: string }; error?: { message?: string } }>(
      {
        proposal: 1, amount: 0.5, basis: "stake", contract_type: "CALL",
        currency, underlying_symbol: symbol, duration: preferred.value, duration_unit: preferred.unit,
      },
      { timeoutMs: 8_000 },
    );
    const accepted = !res.error && Boolean(res.proposal?.id);
    const chosen = accepted ? preferred : fallback;
    // Only a completed request is a real answer worth caching; a thrown probe is not.
    binaryDurationCache.set(key, { d: chosen, at: Date.now() });
    return {
      d: chosen,
      note: accepted
        ? `${preferred.value}d accepted by Deriv`
        : `${preferred.value}d refused (${res.error?.message ?? "proposal returned no id"}); using verified ${fallback.value}d`,
    };
  } catch (err) {
    return { d: fallback, note: `duration probe failed (${err instanceof Error ? err.message : "unknown"}); using verified ${fallback.value}d` };
  }
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
  const multiplier = meta?.multiplier ?? 100;
  const currency = params.currency ?? "USD";
  // Verified live against Deriv, twice: the field is not named `symbol` at
  // all anymore in this API — confirmed via Deriv's own current docs, the
  // proposal/buy schema renamed it to `underlying_symbol`. Neither a nested
  // nor a top-level `symbol` was accepted ("Properties not allowed: symbol"
  // both times); this is the actual fix, not just a placement change.
  let parameters: Record<string, unknown>;
  let duration: string | null = null;
  /** Why this binary duration was chosen — surfaced so a 3d fallback is never silent. */
  let durationNote: string | null = null;
  if (useMultiplier) {
    parameters = {
      contract_type: params.direction === "buy" ? "MULTUP" : "MULTDOWN",
      underlying_symbol: symbol, amount: params.stakeAmount, basis: "stake", currency, multiplier,
    };
    const limit = computeLimitOrder(params, multiplier);
    if (limit) parameters.limit_order = limit;
  } else {
    // An explicit override (the self-test) is obeyed verbatim; otherwise probe.
    let d: BinaryDuration;
    if (params.binaryDuration) { d = params.binaryDuration; }
    else { const r = await resolveBinaryDuration(session, symbol, currency); d = r.d; durationNote = r.note; }
    duration = `${d.value}${d.unit}`;
    parameters = {
      contract_type: params.direction === "buy" ? "CALL" : "PUT",
      underlying_symbol: symbol, duration: d.value, duration_unit: d.unit,
      amount: params.stakeAmount, basis: "stake", currency,
    };
  }
  const contractType = useMultiplier ? "multiplier" : "binary";

  try {
    // From here on the request may have reached Deriv: never treat failure as retryable.
    const res = await session.request<{
      error?: { message?: string; code?: string; details?: unknown };
      buy?: { contract_id?: number; buy_price?: number | string };
    }>(
      { buy: "1", price: params.stakeAmount, parameters, passthrough: { signal_id: params.signalId ?? null } },
      { signalId: params.signalId ?? null, timeoutMs: 20_000 },
    );
    if (res.error) {
      consecutiveBrokerErrors = 0;
      // Deriv's `details` often names the exact invalid field/reason that the
      // top-level message alone doesn't; surface it instead of discarding it,
      // it's also always visible in the redacted raw frame in Diagnostics.
      const details = res.error.details !== undefined ? ` — details: ${JSON.stringify(res.error.details)}` : "";
      return { ok: false, message: `${res.error.message ?? "Deriv rejected the buy request"}${details}` };
    }
    if (!res.buy?.contract_id) return { ok: false, ambiguous: true, message: "Buy response missing contract_id" };
    consecutiveBrokerErrors = 0;
    const buyPrice = toFiniteNumber(res.buy.buy_price) ?? undefined;
    return {
      ok: true, contractId: res.buy.contract_id, buyPrice, contractType, duration,
      message: `Contract ${res.buy.contract_id} opened at ${buyPrice}${durationNote ? ` — duration ${durationNote}` : ""}`,
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
  /** "multiplier" | "binary" | null (unknown — e.g. Deriv omitted contract_type). */
  contractType: "multiplier" | "binary" | null;
}

/** Deriv's raw contract_type (MULTUP/MULTDOWN/CALL/PUT/...) -> our two buckets. */
function classifyContractType(raw: unknown): "multiplier" | "binary" | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  return raw.toUpperCase().startsWith("MULT") ? "multiplier" : "binary";
}

/**
 * Indicative live trading cost as a percentage of stake, read from a real
 * Deriv `proposal` quote for a $1 MULTUP (basis=stake, so ask_price should
 * equal amount modulo the spread/commission Deriv actually prices in). Used
 * by the forex readiness dispatch gate to refuse trading when the market is
 * too expensive right now. Returns null (never throws) if the quote can't be
 * read; forex-readiness.ts treats null as "refuse rather than trade blind".
 *
 * Evidence label: code review only — the proposal shape (`ask_price`,
 * `amount`, `basis: "stake"`) matches Deriv's documented multiplier proposal
 * response, but this has not been run against a live Deriv connection.
 */
export async function getIndicativeCostPct(token: string, environment: "demo" | "real", symbol: string): Promise<number | null> {
  const meta = getSyntheticSymbol(symbol);
  const multiplier = meta?.multiplier ?? 100;
  let session: DerivSession | null = null;
  try {
    session = await openDerivSession(token, environment);
    const res = await session.request<{ proposal?: { ask_price?: number | string }; error?: { message?: string } }>(
      { proposal: 1, amount: 1, basis: "stake", contract_type: "MULTUP", currency: "USD", underlying_symbol: symbol, multiplier },
      { timeoutMs: 8_000 },
    );
    if (res.error) return null;
    const askPrice = toFiniteNumber(res.proposal?.ask_price);
    if (askPrice === null) return null;
    return Math.abs(askPrice - 1) * 100;
  } catch {
    return null;
  } finally {
    session?.close();
  }
}

/**
 * Diagnostic-only check that Deriv accepts the multiplier (MULTUP/MULTDOWN)
 * parameter shape used by real forex signal dispatch — a quote-only
 * `proposal`, never a `buy`, so it can never open a position or leave
 * anything to close. Used by the demo self-test to catch a wrong field name
 * on the multiplier path the same way the binary path's buy already caught
 * one, without the risk of an orphaned open position (this codebase has no
 * "sell to close" capability at all — a multiplier position can only close
 * via its own stop-loss/take-profit).
 */
export async function checkMultiplierProposal(token: string, environment: "demo" | "real", symbol: string): Promise<{ ok: boolean; message: string }> {
  const meta = getSyntheticSymbol(symbol);
  const multiplier = meta?.multiplier ?? 100;
  let session: DerivSession | null = null;
  try {
    session = await openDerivSession(token, environment);
    const res = await session.request<{ proposal?: { ask_price?: number | string; id?: string }; error?: { message?: string; details?: unknown } }>(
      { proposal: 1, amount: 1, basis: "stake", contract_type: "MULTUP", currency: "USD", underlying_symbol: symbol, multiplier },
      { timeoutMs: 8_000 },
    );
    if (res.error) {
      const details = res.error.details !== undefined ? ` — details: ${JSON.stringify(res.error.details)}` : "";
      return { ok: false, message: `${res.error.message ?? "Deriv rejected the multiplier proposal"}${details}` };
    }
    if (!res.proposal?.id) return { ok: false, message: "Multiplier proposal response missing id" };
    return { ok: true, message: `Multiplier proposal accepted (ask_price ${res.proposal.ask_price})` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Multiplier proposal check failed" };
  } finally {
    session?.close();
  }
}

/**
 * Ask Deriv itself for the shortest CALL/PUT duration it actually offers on
 * this symbol, instead of guessing. Discovered the hard way: a hardcoded
 * "5 minutes" self-test guess was rejected live with
 * TradingDurationNotAllowed — forex binaries evidently need a longer
 * minimum than the synthetic/volatility indices this app used to trade,
 * and no public doc page we could reach from this sandbox states the exact
 * number. contracts_for is Deriv's own authoritative source for it.
 *
 * Evidence label: code review only for the exact response field names
 * (min_contract_duration inside contracts_for.available) — not verified
 * against a live response from this sandbox. Parses defensively and
 * returns null on anything unexpected rather than guessing further;
 * callers must have a non-buy fallback for that case.
 */
export async function queryBinaryMinDuration(
  token: string, environment: "demo" | "real", symbol: string,
): Promise<{ value: number; unit: "t" | "s" | "m" | "h" | "d" } | null> {
  let session: DerivSession | null = null;
  try {
    session = await openDerivSession(token, environment);
    const res = await session.request<{
      contracts_for?: { available?: Array<Record<string, unknown>> };
      error?: unknown;
    }>({ contracts_for: symbol, currency: "USD" }, { timeoutMs: 10_000 });
    if (res.error) return null;
    const available = res.contracts_for?.available ?? [];
    const callEntry = available.find((c) => c.contract_type === "CALL" || c.contract_type === "CALLE");
    if (!callEntry) return null;
    const raw = callEntry.min_contract_duration ?? callEntry.min_duration;
    if (typeof raw !== "string") return null;
    const m = raw.trim().match(/^(\d+)([tsmhd])$/i);
    if (!m) return null;
    const value = Number(m[1]);
    const unit = m[2]!.toLowerCase() as "t" | "s" | "m" | "h" | "d";
    if (!Number.isFinite(value) || value <= 0) return null;
    return { value, unit };
  } catch {
    return null;
  } finally {
    session?.close();
  }
}

/** Rough upper bound past which a self-test shouldn't try to synchronously wait for settlement. */
export function binaryDurationMs(d: { value: number; unit: "t" | "s" | "m" | "h" | "d" }): number {
  const perUnit: Record<string, number> = { t: 2_000, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return d.value * (perUnit[d.unit] ?? 60_000);
}

/**
 * Diagnostic-only check that Deriv accepts the binary (CALL/PUT) parameter
 * shape at whatever duration the caller supplies — a quote-only `proposal`,
 * never a `buy`. Used as a fallback when the minimum tradeable duration
 * either can't be discovered or is too long to wait for real settlement in
 * a self-test.
 */
export async function checkBinaryProposal(
  token: string, environment: "demo" | "real", symbol: string, d: { value: number; unit: "t" | "s" | "m" | "h" | "d" },
): Promise<{ ok: boolean; message: string }> {
  let session: DerivSession | null = null;
  try {
    session = await openDerivSession(token, environment);
    const res = await session.request<{ proposal?: { ask_price?: number | string; id?: string }; error?: { message?: string; details?: unknown } }>(
      { proposal: 1, amount: 0.5, basis: "stake", contract_type: "CALL", currency: "USD", underlying_symbol: symbol, duration: d.value, duration_unit: d.unit },
      { timeoutMs: 8_000 },
    );
    if (res.error) {
      const details = res.error.details !== undefined ? ` — details: ${JSON.stringify(res.error.details)}` : "";
      return { ok: false, message: `${res.error.message ?? "Deriv rejected the binary proposal"}${details}` };
    }
    if (!res.proposal?.id) return { ok: false, message: "Binary proposal response missing id" };
    return { ok: true, message: `Binary proposal accepted at ${d.value}${d.unit} (ask_price ${res.proposal.ask_price})` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Binary proposal check failed" };
  } finally {
    session?.close();
  }
}

export interface DerivSellResult {
  ok: boolean;
  soldFor?: number;
  contractId?: number;
  message?: string;
  /** The sell request may have reached Deriv but the outcome could not be confirmed. Never retry blindly; re-check via fetchContractStatuses instead. */
  ambiguous?: boolean;
}

/**
 * Closes an open contract now, at whatever price Deriv currently offers
 * (price: 0 = accept any price — there is no meaningful minimum to protect
 * for a forced exit; the caller already decided this position must close).
 *
 * Evidence label: code review only. The request/response shape
 * ({sell: contract_id, price}, response.sell.{sold_for, contract_id, ...})
 * matches Deriv's current documented Sell Contract endpoint, but — like
 * every other write path in this file before today — has not been run
 * against a live Deriv connection. Given the buy path had a wrong field
 * name that only live testing caught, treat a first real use of this as
 * a genuine test, not a proven capability.
 */
export async function sellDerivTrade(token: string, environment: "demo" | "real", contractId: number): Promise<DerivSellResult> {
  let session: DerivSession | null = null;
  try {
    session = await openDerivSession(token, environment);
    const res = await session.request<{
      error?: { message?: string; code?: string; details?: unknown };
      sell?: { sold_for?: number | string; contract_id?: number };
    }>(
      { sell: contractId, price: 0 },
      { timeoutMs: 20_000 },
    );
    if (res.error) {
      const details = res.error.details !== undefined ? ` — details: ${JSON.stringify(res.error.details)}` : "";
      return { ok: false, message: `${res.error.message ?? "Deriv rejected the sell request"}${details}` };
    }
    if (!res.sell?.contract_id) return { ok: false, ambiguous: true, message: "Sell response missing contract_id" };
    const soldFor = toFiniteNumber(res.sell.sold_for) ?? undefined;
    return { ok: true, contractId: res.sell.contract_id, soldFor, message: `Contract ${res.sell.contract_id} sold for ${soldFor}` };
  } catch (err) {
    if (err instanceof DerivRequestTimeout || (err instanceof Error && /closed/i.test(err.message))) {
      return { ok: false, ambiguous: true, message: "Deriv connection dropped or timed out after sell submission; outcome is ambiguous" };
    }
    return { ok: false, ambiguous: true, message: err instanceof Error ? err.message : "Unknown error after sell submission" };
  } finally {
    session?.close();
  }
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
        contractType: classifyContractType(c.contract_type),
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
        contractType: classifyContractType(t.contract_type),
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
          contractType: classifyContractType(poc.contract_type),
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
