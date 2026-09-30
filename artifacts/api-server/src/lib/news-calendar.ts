/**
 * Free, no-key economic calendar feed (ForexFactory's public "this week" JSON,
 * widely used by retail trading tools; no authentication or app registration).
 * Cached with a hard staleness limit: if the feed is unreachable and the cache
 * is too old to trust, callers get `null` and forex trading fails closed
 * (see forex-readiness.ts) rather than trading on stale or absent news data.
 */
import { logger } from "./logger.js";

export interface NewsEvent {
  title: string;
  /** Currency code the event applies to, e.g. "USD", "EUR", "GBP". */
  country: string;
  date: Date;
  impact: "High" | "Medium" | "Low" | string;
}

/**
 * The whole forex path fails closed when this feed can't be reached, so a
 * single unreachable host means zero trades until it recovers. The default is
 * the usual ForexFactory mirror; NEWS_CALENDAR_URL allows pointing at another
 * mirror (or a local cache) without a code change if that host ever goes dark
 * or a deployment's network policy blocks it.
 */
const CALENDAR_URL = process.env.NEWS_CALENDAR_URL?.trim() || "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 30 * 60_000;
/** Beyond this age a cached calendar is no longer trusted even as a fallback. */
const STALE_MAX_MS = 2 * CACHE_TTL_MS;

let cache: { events: NewsEvent[]; fetchedAt: number } | null = null;
let lastError: string | null = null;
let lastErrorAt: string | null = null;
let inFlight: Promise<NewsEvent[] | null> | null = null;

interface RawEvent {
  title?: unknown;
  country?: unknown;
  date?: unknown;
  impact?: unknown;
}

/** A trailing `Z` or a `+hh:mm` / `-hh:mm` offset — i.e. the string says which zone it means. */
const HAS_TIMEZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Parse one calendar timestamp without depending on the host's timezone.
 *
 * `new Date("2026-09-30T08:30:00")` — an ISO string with no offset — is
 * interpreted in *local* time by the JavaScript spec. Every other date in this
 * server is UTC, and this container happens to resolve to UTC, so it read
 * correctly by luck. On a host with TZ set to anything else, every blackout
 * window would silently shift by that offset and the bot would trade straight
 * through a high-impact release believing it was clear. A timestamp that names
 * its zone is honoured; one that does not is read as UTC explicitly, so the
 * result is the same on every machine.
 */
export function parseEventDate(raw: string): { date: Date; assumedUtc: boolean } | null {
  const text = raw.trim();
  if (!text) return null;
  const hasZone = HAS_TIMEZONE.test(text);
  // A space separator instead of "T" is not ISO and is parsed inconsistently.
  const normalised = hasZone ? text : `${text.replace(" ", "T")}Z`;
  const date = new Date(normalised);
  if (Number.isNaN(date.getTime())) return null;
  return { date, assumedUtc: !hasZone };
}

function parseCalendar(raw: unknown): NewsEvent[] {
  if (!Array.isArray(raw)) throw new Error("Calendar response was not an array");
  const events: NewsEvent[] = [];
  let assumedUtcCount = 0;
  for (const item of raw as RawEvent[]) {
    if (typeof item.title !== "string" || typeof item.country !== "string" || typeof item.date !== "string") continue;
    const parsed = parseEventDate(item.date);
    if (!parsed) continue;
    if (parsed.assumedUtc) assumedUtcCount++;
    const impact = typeof item.impact === "string" ? item.impact : "Low";
    events.push({ title: item.title, country: item.country.toUpperCase(), date: parsed.date, impact });
  }
  if (assumedUtcCount > 0) {
    logger.warn(
      { assumedUtcCount, total: events.length },
      "News calendar: some events carried no timezone and were read as UTC; blackout windows for those are only right if the feed publishes in UTC",
    );
  }
  return events;
}

async function fetchNow(): Promise<NewsEvent[] | null> {
  try {
    const res = await fetch(CALENDAR_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Calendar feed returned HTTP ${res.status}`);
    const raw: unknown = await res.json();
    const events = parseCalendar(raw);
    cache = { events, fetchedAt: Date.now() };
    lastError = null;
    lastErrorAt = null;
    return events;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    lastErrorAt = new Date().toISOString();
    logger.warn({ msg: lastError }, "News calendar fetch failed");
    if (cache && Date.now() - cache.fetchedAt <= STALE_MAX_MS) {
      return cache.events;
    }
    return null;
  }
}

/**
 * Returns cached events if fresh, otherwise fetches. Never throws: returns
 * null when there is no trustworthy data, which callers must treat as
 * "block forex trading" rather than "no news today".
 */
export async function getNewsEvents(): Promise<NewsEvent[] | null> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.events;
  if (inFlight) return inFlight;
  inFlight = fetchNow().finally(() => { inFlight = null; });
  return inFlight;
}

export function getNewsCalendarStatus() {
  const ageMs = cache ? Date.now() - cache.fetchedAt : null;
  return {
    cachedEvents: cache?.events.length ?? 0,
    fetchedAt: cache ? new Date(cache.fetchedAt).toISOString() : null,
    staleMs: ageMs,
    trusted: cache !== null && (ageMs ?? Infinity) <= STALE_MAX_MS,
    lastError,
    lastErrorAt,
  };
}
