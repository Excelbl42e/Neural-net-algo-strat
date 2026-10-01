import { getSyntheticSymbol } from "./synthetic-catalog.js";
import { inspectDerivAccount, syncDerivPatAccount, toFiniteNumber } from "./deriv-account.js";
import { commissionUsdFromQuote } from "./execution-risk.js";
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
  /**
   * The exact multiplier stop-loss / take-profit, in USD, as approved by
   * planEntry against the live price. When present these are sent verbatim;
   * entry/stop/target prices are then only used for logging. Without them the
   * bracket is derived from the prices (the self-test path).
   */
  stopLossUsd?: number | null;
  takeProfitUsd?: number | null;
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
  session: DerivSession, symbol: string, currency: string, stakeAmount: number,
): Promise<{ d: BinaryDuration; note: string }> {
  const preferred: BinaryDuration = { value: defaultBinaryDurationDays(), unit: "d" };
  const fallback: BinaryDuration = { value: VERIFIED_BINARY_FALLBACK_DAYS, unit: "d" };
  // Nothing to gain from probing a duration that is not shorter than the fallback.
  if (preferred.value >= fallback.value) return { d: preferred, note: `${preferred.value}d (not shorter than the verified fallback; sent as-is)` };

  // Keyed by symbol only: Deriv's allowed durations are a property of the
  // instrument, not of the stake, so one probe answers for every stake size.
  const key = `${symbol}:${preferred.value}${preferred.unit}`;
  const hit = binaryDurationCache.get(key);
  if (hit && Date.now() - hit.at < BINARY_DURATION_CACHE_MS) return { d: hit.d, note: `${hit.d.value}${hit.d.unit} (cached probe result)` };

  try {
    const res = await session.request<{ proposal?: { id?: string }; error?: { message?: string } }>(
      {
        // Probe with the stake we are actually about to send. A hardcoded
        // amount risks Deriv refusing the proposal over the *stake* and this
        // reading it as a refusal of the duration, silently costing us the
        // shorter contract for no reason.
        proposal: 1, amount: stakeAmount, basis: "stake", contract_type: "CALL",
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
    const approved = params.stopLossUsd != null || params.takeProfitUsd != null;
    const limit = approved
      ? {
          ...(params.stopLossUsd != null ? { stop_loss: params.stopLossUsd } : {}),
          ...(params.takeProfitUsd != null ? { take_profit: params.takeProfitUsd } : {}),
        }
      : computeLimitOrder(params, multiplier);
    if (limit && Object.keys(limit).length > 0) parameters.limit_order = limit;
  } else {
    // An explicit override (the self-test) is obeyed verbatim; otherwise probe.
    let d: BinaryDuration;
    if (params.binaryDuration) { d = params.binaryDuration; }
    else { const r = await resolveBinaryDuration(session, symbol, currency, params.stakeAmount); d = r.d; durationNote = r.note; }
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

export interface ContractQuote {
  /**
   * Trading cost as a percentage of position size: stake x multiplier for a
   * multiplier, the stake itself for a binary. Position size is the unit FX
   * costs are normally quoted in, and it does not move with leverage the way a
   * percentage of the stake does.
   */
  costPct: number;
  /**
   * What costPct was measured from. "commission" is Deriv's own figure.
   * "ask_price" means Deriv reported no commission, and on a stake-basis quote
   * the ask always equals the stake, so costPct is then 0 and says nothing
   * beyond "the quote succeeded".
   */
  costSource: "commission" | "ask_price";
  /** Commission in dollars, read conservatively; see commissionUsdFromQuote. */
  commissionUsd: number | null;
  /** Deriv's `commission` field exactly as sent, before any reading of its unit. */
  commissionRaw: number | null;
  /** Deriv's current spot for the underlying, when it reports one. */
  spot: number | null;
  /** Deriv's own limits on the multiplier stop-loss / take-profit amount, when reported. */
  limits: { stopLossMin: number | null; stopLossMax: number | null; takeProfitMin: number | null; takeProfitMax: number | null };
}

/**
 * Live quote for exactly the contract about to be sent, at the real stake and
 * direction. Never opens a position.
 *
 * This replaces getIndicativeCostPct, which computed |ask_price - stake| / stake.
 * On a stake-basis proposal Deriv's ask_price always equals the stake — the
 * self-test shows "ask_price 1" for $1 and "ask_price 0.5" for $0.50 — so that
 * figure was 0% every time, and the configured cost ceiling never refused
 * anything except a failed quote. The real cost of a multiplier is its
 * commission, which Deriv reports separately; it is used whenever present.
 *
 * The same response is also where Deriv states its minimum and maximum
 * stop-loss / take-profit amounts. The dispatcher used a $0.50 floor carried
 * over from the original import that nothing had verified; reading Deriv's own
 * numbers replaces a guess with the broker's answer whenever it gives one.
 */
export async function getContractQuote(
  token: string,
  environment: "demo" | "real",
  symbol: string,
  opts: { stakeAmount: number; binary: boolean; direction: "buy" | "sell"; currency?: string },
): Promise<ContractQuote | { error: string }> {
  const meta = getSyntheticSymbol(symbol);
  const multiplier = meta?.multiplier ?? 100;
  const amount = Number.isFinite(opts.stakeAmount) && opts.stakeAmount > 0 ? opts.stakeAmount : 1;
  const buy = opts.direction === "buy";
  let session: DerivSession | null = null;
  try {
    session = await openDerivSession(token, environment);
    // Quote in the account's own currency, as the order will be placed.
    const currency = opts.currency ?? session.account.currency ?? "USD";
    const req: Record<string, unknown> = opts.binary
      ? {
          proposal: 1, amount, basis: "stake", contract_type: buy ? "CALL" : "PUT", currency,
          underlying_symbol: symbol,
          duration: defaultBinaryDurationDays(), duration_unit: "d",
        }
      : {
          proposal: 1, amount, basis: "stake", contract_type: buy ? "MULTUP" : "MULTDOWN", currency,
          underlying_symbol: symbol, multiplier,
        };
    type Range = { min?: number | string; max?: number | string } | undefined;
    const res = await session.request<{
      proposal?: {
        ask_price?: number | string;
        commission?: number | string;
        spot?: number | string;
        validation_params?: { stop_loss?: Range; take_profit?: Range };
      };
      error?: { message?: string; code?: string };
    }>(req, { timeoutMs: 8_000 });
    if (res.error) return { error: `Deriv refused the price quote: ${res.error.message ?? res.error.code ?? "no reason given"}` };
    if (!res.proposal) return { error: "Deriv's price quote came back empty" };
    const askPrice = toFiniteNumber(res.proposal.ask_price);
    if (askPrice === null) return { error: "Deriv's price quote had no usable ask price" };

    const positionSize = opts.binary ? amount : amount * multiplier;
    const commissionRaw = toFiniteNumber(res.proposal.commission);
    const commissionUsd = commissionUsdFromQuote(commissionRaw, opts.binary ? 0 : positionSize);
    const costSource: ContractQuote["costSource"] = commissionUsd != null ? "commission" : "ask_price";
    const costUsd = commissionUsd != null ? commissionUsd : Math.abs(askPrice - amount);
    const vp = res.proposal.validation_params;
    return {
      costPct: (costUsd / positionSize) * 100,
      costSource,
      commissionUsd,
      commissionRaw,
      spot: toFiniteNumber(res.proposal.spot),
      limits: {
        stopLossMin: toFiniteNumber(vp?.stop_loss?.min),
        stopLossMax: toFiniteNumber(vp?.stop_loss?.max),
        takeProfitMin: toFiniteNumber(vp?.take_profit?.min),
        takeProfitMax: toFiniteNumber(vp?.take_profit?.max),
      },
    };
  } catch (err) {
    return { error: `Could not get a price quote from Deriv: ${err instanceof Error ? err.message.replace(/otp=[^&\s]+/g, "otp=[redacted]") : "unknown error"}` };
  } finally {
    session?.close();
  }
}

/**
 * Diagnostic-only check that Deriv accepts the multiplier (MULTUP/MULTDOWN)
 * parameter shape used by real forex signal dispatch — a quote-only
 * `proposal`, never a `buy`, so it can never open a position or leave
 * anything to close. Used by the demo self-test to catch a wrong field name
 * on the multiplier path before any order is sent.
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
 * The multipliers Deriv offers on each pair for this account, from
 * contracts_for (MULTUP entries' multiplier_range). The dispatcher sends one
 * fixed multiplier per pair; a pair that does not offer it can never trade.
 * null for a pair means Deriv gave no answer for it.
 */
export async function getMultiplierRanges(
  token: string, environment: "demo" | "real", symbols: string[],
): Promise<Map<string, number[] | null>> {
  const out = new Map<string, number[] | null>();
  let session: DerivSession | null = null;
  try {
    session = await openDerivSession(token, environment);
    for (const symbol of symbols) {
      try {
        const res = await session.request<{
          contracts_for?: { available?: Array<Record<string, unknown>> };
          error?: unknown;
        }>({ contracts_for: symbol }, { timeoutMs: 10_000 });
        const entry = (res.contracts_for?.available ?? []).find((c) => c.contract_type === "MULTUP");
        const range = Array.isArray(entry?.multiplier_range)
          ? (entry!.multiplier_range as unknown[]).map((v) => toFiniteNumber(v)).filter((v): v is number => v != null)
          : null;
        out.set(symbol, res.error ? null : range);
      } catch {
        out.set(symbol, null);
      }
    }
  } catch {
    for (const symbol of symbols) if (!out.has(symbol)) out.set(symbol, null);
  } finally {
    session?.close();
  }
  return out;
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
    }>(
      // Deriv's contracts_for schema allows only contracts_for, passthrough and
      // req_id; the currency this used to send made every request fail.
      { contracts_for: symbol }, { timeoutMs: 10_000 },
    );
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
 * Evidence label: the request/response shape ({sell: contract_id, price},
 * response.sell.{sold_for, contract_id, ...}) matches Deriv's current
 * documented Sell Contract endpoint. The demo self-test now exercises this
 * for real — it buys a $1 multiplier and sells it straight back — so run
 * that before trusting this with funded money. Until a self-test has passed
 * on this account, treat it as reviewed but unproven: the buy path in this
 * same file once had a wrong field name that only a live order exposed.
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
        // The current API names the pair underlying_symbol; there is no
        // `symbol`. Reading the old name left every open contract without a
        // pair, so the reconciler could never match an unconfirmed buy to it.
        contractId: Number(c.contract_id), symbol: c.underlying_symbol ?? c.symbol ?? null,
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
      // The schema allows a null contract_id; Number(null) would read as contract 0.
      if (t.contract_id == null) continue;
      const sym = typeof t.underlying_symbol === "string" ? t.underlying_symbol
        : typeof t.shortcode === "string" ? (t.shortcode.split("_")[1] ?? null) : null;
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
        // Closed for good: sold back (by us, or by Deriv at a stop-loss /
        // take-profit / stop-out), or settled at expiry as won or lost.
        const sold = poc.is_sold === 1 || poc.is_sold === true
          || poc.status === "sold" || poc.status === "won" || poc.status === "lost" || poc.status === "cancelled";
        result.set(id, {
          contractId: id, symbol: poc.underlying_symbol ?? poc.underlying ?? null,
          buyPrice: poc.buy_price != null ? Number(poc.buy_price) : null,
          purchaseTime: poc.purchase_time != null ? Number(poc.purchase_time) : null,
          isSold: sold,
          profit: poc.profit != null ? Number(poc.profit) : null,
          sellPrice: poc.sell_price != null ? Number(poc.sell_price) : null,
          // The schema has exit_spot, not sell_spot: the price the contract closed at.
          sellSpot: toFiniteNumber(poc.exit_spot ?? poc.sell_spot),
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
