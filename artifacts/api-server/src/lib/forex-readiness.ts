/**
 * Forex-specific readiness gates: weekend/market-hours closure, killzone
 * session filtering, and high-impact news blackout. Pure, deterministic,
 * unit-tested functions — no I/O here (the news calendar fetch lives in
 * news-calendar.ts and is injected as data).
 *
 * These gates exist because generic ICT structure logic (quant-filters.ts)
 * has no notion of a market that closes or that reacts violently to a
 * scheduled release; forex has both, so it is refused unless these pass.
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
 * Forex/commodities close Fri 21:00 UTC and reopen Sun 21:00 UTC (Deriv's
 * real-market hours track the interbank week). This is a broadly correct
 * approximation, not exchange-holiday-aware.
 */
export function isForexWeekendClosed(now: Date): boolean {
  const day = now.getUTCDay(); // 0=Sun .. 6=Sat
  const hour = now.getUTCHours();
  if (day === 6) return true; // all Saturday
  if (day === 0 && hour < 21) return true; // Sunday before reopen
  if (day === 5 && hour >= 21) return true; // Friday after close
  return false;
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
    return { ok: false, reason: "Forex market is closed for the weekend" };
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

export interface ForexDispatchInput extends ForexPreScanInput {
  /** Effective trading cost as a percentage of stake, from a live indicative quote. Null = could not be read. */
  costPct: number | null;
  maxCostPct: number;
}

/** Gate applied right before order placement: everything in the pre-scan gate plus live cost. */
export function forexDispatchGate(input: ForexDispatchInput): ForexGateResult {
  const preScan = forexPreScanGate(input);
  if (!preScan.ok) return preScan;
  if (input.costPct === null) {
    return { ok: false, reason: "Could not read a live indicative price/cost from Deriv; refusing to trade blind" };
  }
  if (input.costPct > input.maxCostPct) {
    return { ok: false, reason: `Indicative trading cost ${input.costPct.toFixed(3)}% of stake exceeds configured max ${input.maxCostPct}%` };
  }
  return { ok: true };
}
