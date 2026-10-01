/**
 * Forex-specific readiness gates: weekend/market-hours closure, killzone
 * session filtering, and high-impact news blackout. Pure, deterministic,
 * unit-tested functions — no I/O here (the news calendar fetch lives in
 * news-calendar.ts and is injected as data).
 *
 * These gates exist because the strategy poll, which only sees candles, has
 * no notion of a market that closes or that reacts violently to a scheduled
 * release; forex has both, so it is refused unless these pass.
 */
import { getSyntheticSymbol } from "./synthetic-catalog.js";
import type { NewsEvent } from "./news-calendar.js";

export type Session = "asian" | "london" | "newyork";

/** UTC hour windows. London/NY overlap (12:00-16:00 UTC) is the highest-liquidity window. */
const SESSION_WINDOWS: Record<Session, { startHour: number; endHour: number }> = {
  asian: { startHour: 0, endHour: 9 },
  london: { startHour: 7, endHour: 16 },
  newyork: { startHour: 12, endHour: 21 },
};

const ALL_SESSIONS: Session[] = ["asian", "london", "newyork"];

/**
 * Deriv's own forex hours, from its `trading_times` endpoint (checked
 * 2026-10-01 for every Friday from October 2026 to April 2027, i.e. across
 * both sides of the clock change, and for all 14 traded pairs): open
 * Monday-Friday from 00:00 UTC, "Closes early (at 20:55)" on Fridays, closed
 * Saturday and Sunday.
 *
 * This used to reopen the market at Sunday 21:00 UTC and close it at Friday
 * 21:00 — the interbank week, not Deriv's. Deriv does not trade forex on
 * Sunday evening at all, and stops five minutes before 21:00 on Friday.
 */
export const DERIV_FX_FRIDAY_CLOSE_UTC_MIN = 20 * 60 + 55;

export function isForexWeekendClosed(now: Date): boolean {
  const day = now.getUTCDay(); // 0=Sun .. 6=Sat
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (day === 6 || day === 0) return true; // Saturday and Sunday
  if (day === 5 && minute >= DERIV_FX_FRIDAY_CLOSE_UTC_MIN) return true; // Friday after Deriv's close
  return false;
}

/**
 * No new positions late on a Friday. A trade opened in the last hours before
 * Deriv's 20:55 UTC close may not reach its stop or target before the market
 * shuts, and then sits through the weekend: Monday can open far from Friday's
 * close, straight past the stop, and a multiplier then loses up to its whole
 * stake. From 16:00 UTC the bot neither looks for new setups nor enters
 * pending ones.
 */
export const FRIDAY_NO_NEW_TRADES_UTC_MIN = 16 * 60;

export function isFridayNewTradeCutoff(now: Date): boolean {
  if (now.getUTCDay() !== 5) return false;
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  return minute >= FRIDAY_NO_NEW_TRADES_UTC_MIN;
}

/**
 * Anything still open this close to Deriv's Friday close is bought back, so
 * no position is carried over the weekend gap. Deriv only buys a contract
 * back while its market is open, which is why this starts 25 minutes before
 * 20:55 rather than at the close itself: the contract monitor retries every
 * 30 seconds until it succeeds.
 */
export const FRIDAY_FLATTEN_UTC_MIN = 20 * 60 + 30;

export function isFridayFlattenWindow(now: Date): boolean {
  if (now.getUTCDay() !== 5) return false;
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  return minute >= FRIDAY_FLATTEN_UTC_MIN && minute < DERIV_FX_FRIDAY_CLOSE_UTC_MIN;
}

export function activeSessions(now: Date): Session[] {
  const hour = now.getUTCHours();
  return ALL_SESSIONS.filter((s) => {
    const w = SESSION_WINDOWS[s];
    return hour >= w.startHour && hour < w.endHour;
  });
}

/**
 * `killzones` is the botConfig free-text field, e.g. "london,newyork".
 * Empty/unset means no session restriction (any open-market hour is fine).
 */
export function parseKillzones(killzones: string | null | undefined): Session[] {
  if (!killzones || !killzones.trim()) return [];
  const known = new Set(ALL_SESSIONS);
  return killzones
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is Session => known.has(s as Session));
}

export function sessionAllowed(now: Date, killzones: string | null | undefined): boolean {
  const configured = parseKillzones(killzones);
  if (configured.length === 0) return true;
  const active = activeSessions(now);
  return active.some((s) => configured.includes(s));
}

/** Deriv forex code -> [base, quote] currency legs, e.g. "frxEURUSD" -> ["EUR","USD"]. */
export function symbolCurrencyPair(symbol: string): string[] {
  const meta = getSyntheticSymbol(symbol);
  const code = (meta?.code ?? symbol).toUpperCase();
  const body = code.startsWith("FRX") ? code.slice(3) : code;
  if (body.length !== 6) return [];
  return [body.slice(0, 3), body.slice(3)];
}

export interface NewsBlackoutResult {
  blocked: boolean;
  reason?: string;
}

/**
 * Blocks trading a pair around any HIGH-impact event for either of its two
 * currency legs. `events` is null when the calendar could not be fetched and
 * there is no usable cache — that fails CLOSED (blocked) by design.
 */
export function newsBlackoutActive(
  symbol: string,
  now: Date,
  events: NewsEvent[] | null,
  minutesBefore: number,
  minutesAfter: number,
): NewsBlackoutResult {
  if (events === null) {
    return { blocked: true, reason: "News calendar unavailable; forex trading fails closed until it can be fetched" };
  }
  const legs = symbolCurrencyPair(symbol);
  if (legs.length === 0) return { blocked: false };
  const nowMs = now.getTime();
  for (const ev of events) {
    if (ev.impact !== "High") continue;
    if (!legs.includes(ev.country)) continue;
    const evMs = ev.date.getTime();
    const windowStart = evMs - minutesBefore * 60_000;
    const windowEnd = evMs + minutesAfter * 60_000;
    if (nowMs >= windowStart && nowMs <= windowEnd) {
      return { blocked: true, reason: `High-impact ${ev.country} event "${ev.title}" at ${ev.date.toISOString()}` };
    }
  }
  return { blocked: false };
}

export interface ForexPreScanInput {
  symbol: string;
  now: Date;
  killzones: string | null | undefined;
  newsEvents: NewsEvent[] | null;
  newsBlackoutBeforeMin: number;
  newsBlackoutAfterMin: number;
}

export interface ForexGateResult {
  ok: boolean;
  reason?: string;
}

/** Gate applied before any GPT call: hours + session + news. No cost data needed yet. */
export function forexPreScanGate(input: ForexPreScanInput): ForexGateResult {
  if (isForexWeekendClosed(input.now)) {
    return { ok: false, reason: "Forex market is closed for the weekend (Deriv: Friday 20:55 to Monday 00:00 UTC)" };
  }
  if (isFridayNewTradeCutoff(input.now)) {
    return { ok: false, reason: "No new trades after 16:00 UTC on Friday, so nothing is left open over the weekend" };
  }
  if (!sessionAllowed(input.now, input.killzones)) {
    return { ok: false, reason: `Outside configured killzone session(s): ${input.killzones}` };
  }
  const blackout = newsBlackoutActive(
    input.symbol, input.now, input.newsEvents, input.newsBlackoutBeforeMin, input.newsBlackoutAfterMin,
  );
  if (blackout.blocked) {
    return { ok: false, reason: blackout.reason ?? "News blackout active" };
  }
  return { ok: true };
}

/**
 * Live trading-cost gate, applied immediately before the order goes out.
 *
 * Separate from the pre-scan gate because it needs a network quote, and that
 * quote is only meaningful once the stake and contract type are decided — the
 * dispatcher used to run this early against a fixed $1 multiplier quote, which
 * measured an instrument a sub-$1 account would never trade.
 *
 * `costPct` is null when the quote could not be read at all, which refuses the
 * trade: placing an order without knowing its cost is trading blind.
 */
export function tradingCostGate(costPct: number | null, maxCostPct: number): ForexGateResult {
  if (costPct === null) {
    return { ok: false, reason: "Could not read a live indicative price/cost from Deriv; refusing to trade blind" };
  }
  if (!Number.isFinite(maxCostPct) || maxCostPct < 0) {
    return { ok: false, reason: "Maximum trading-cost setting is missing or invalid; refusing execution" };
  }
  if (costPct > maxCostPct) {
    return { ok: false, reason: `Trading cost ${costPct.toFixed(3)}% of position size exceeds the configured max ${maxCostPct}%` };
  }
  return { ok: true };
}
