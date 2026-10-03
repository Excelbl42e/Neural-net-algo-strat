/**
 * CFTC Commitments of Traders (COT) positioning, for the COT veto.
 *
 * Every Friday the CFTC publishes, as of the Tuesday before, how speculators
 * ("non-commercial" traders) are positioned in each currency future. A pair's
 * positioning is the base currency's net (long - short, as a share of open
 * interest) minus the quote currency's; USD counts as 0. When that figure is
 * above the 90th or below the 10th percentile of its last 156 weekly values,
 * the crowd is at an extreme and the signal is to fade it: sell above the
 * 90th, buy below the 10th. Over 2014-2026 that earned +7.6 bps a week per
 * pair after commission and was positive in every era (research/backtest/r-cot.mts).
 *
 * The veto skips a poll trade that would go WITH the crowd at such an extreme
 * (r-cot2.mts / r-combo.mts). A report is used from the Monday after its
 * Tuesday, exactly as backtested. Fails open: without fresh COT data the veto
 * does nothing and every vote trades as before.
 */
import { logger } from "./logger.js";

/** Legacy futures-only report on the CFTC's public reporting API (no key needed). */
const COT_URL = process.env.COT_URL?.trim() || "https://publicreporting.cftc.gov/resource/6dca-aqww.json";
/** CFTC contract codes of the currency futures (all quoted against USD). */
export const COT_CODES: Record<string, string> = {
  "099741": "EUR", "096742": "GBP", "097741": "JPY", "232741": "AUD", "090741": "CAD", "092741": "CHF",
};
const WEEK_MS = 7 * 86_400_000;
const HISTORY_WEEKS = 156;
const MIN_HISTORY = 125;
const CACHE_TTL_MS = 6 * 3600_000;
/** Older than this (two missed weekly reports) the data is not used and the veto stands down. */
const STALE_MAX_MS = 16 * 86_400_000;
const FETCH_TIMEOUT_MS = 20_000;

export interface CotRow { reportDate: string; code: string; long: number; short: number; openInterest: number }
/** Net positioning per currency, keyed by the Monday (UTC ms) from which each report is used. */
export type CotSeries = Record<string, Map<number, number>>;

/** Monday 00:00 UTC of the week containing `ms`. */
export function mondayOf(ms: number): number {
  const d = new Date(ms);
  const back = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back);
}

export function buildCotSeries(rows: CotRow[]): CotSeries {
  const out: CotSeries = {};
  for (const r of rows) {
    const ccy = COT_CODES[r.code];
    const tue = Date.parse(`${r.reportDate.slice(0, 10)}T00:00:00Z`);
    if (!ccy || !Number.isFinite(tue) || !(r.openInterest > 0) || !Number.isFinite(r.long) || !Number.isFinite(r.short)) continue;
    (out[ccy] ??= new Map()).set(mondayOf(tue) + WEEK_MS, (r.long - r.short) / r.openInterest);
  }
  return out;
}

export interface CotSignal {
  /** +1 buy, -1 sell, 0 no extreme (or not enough history). */
  signal: -1 | 0 | 1;
  /** Where this week's positioning sits among the last 156 weeks (0-1), or null. */
  percentile: number | null;
  /** The Monday (ISO date) the report in use applies from, or null. */
  week: string | null;
}

/** The fade-the-extreme signal for a pair like "frxEURUSD" at `now`. Pure. */
export function cotFadeSignal(symbol: string, series: CotSeries, now: Date): CotSignal {
  const pair = symbol.replace(/^frx/, "");
  const base = pair.slice(0, 3), quote = pair.slice(3, 6);
  const net = (ccy: string, w: number) => (ccy === "USD" ? 0 : series[ccy]?.get(w));
  const diff = (w: number) => { const a = net(base, w), b = net(quote, w); return a == null || b == null ? null : a - b; };
  const w = mondayOf(now.getTime());
  const x = diff(w);
  if (x == null) return { signal: 0, percentile: null, week: null };
  const hist: number[] = [];
  for (let k = 1; k <= HISTORY_WEEKS; k++) { const v = diff(w - k * WEEK_MS); if (v != null) hist.push(v); }
  const week = new Date(w).toISOString().slice(0, 10);
  if (hist.length < MIN_HISTORY) return { signal: 0, percentile: null, week };
  // mid-rank, so a value equal to its whole history sits at the middle, not at an extreme
  const p = (hist.filter((v) => v < x).length + 0.5 * hist.filter((v) => v === x).length) / hist.length;
  return { signal: p > 0.9 ? -1 : p < 0.1 ? 1 : 0, percentile: p, week };
}

/** True when the COT veto should skip this trade: it goes with the crowd at a positioning extreme. */
export function cotVetoes(direction: "buy" | "sell", sig: CotSignal): boolean {
  return sig.signal !== 0 && sig.signal === (direction === "buy" ? -1 : 1);
}

let cache: { series: CotSeries; fetchedAt: number; latestReport: string } | null = null;
let lastError: string | null = null;
let inFlight: Promise<CotSeries | null> | null = null;

async function fetchNow(): Promise<CotSeries | null> {
  try {
    const since = new Date(Date.now() - (HISTORY_WEEKS + 12) * WEEK_MS).toISOString().slice(0, 10);
    const codes = Object.keys(COT_CODES).map((c) => `'${c}'`).join(",");
    const qs = new URLSearchParams({
      $select: "report_date_as_yyyy_mm_dd,cftc_contract_market_code,noncomm_positions_long_all,noncomm_positions_short_all,open_interest_all",
      $where: `cftc_contract_market_code in(${codes}) AND report_date_as_yyyy_mm_dd >= '${since}'`,
      $limit: "5000",
    });
    const res = await fetch(`${COT_URL}?${qs}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`CFTC COT feed returned HTTP ${res.status}`);
    const raw: unknown = await res.json();
    if (!Array.isArray(raw)) throw new Error("CFTC COT response was not an array");
    const rows: CotRow[] = raw.map((r: Record<string, unknown>) => ({
      reportDate: String(r.report_date_as_yyyy_mm_dd ?? ""), code: String(r.cftc_contract_market_code ?? ""),
      long: Number(r.noncomm_positions_long_all), short: Number(r.noncomm_positions_short_all), openInterest: Number(r.open_interest_all),
    }));
    const series = buildCotSeries(rows);
    if (Object.keys(series).length < Object.keys(COT_CODES).length) throw new Error("CFTC COT response is missing currencies");
    const latestReport = rows.map((r) => r.reportDate.slice(0, 10)).sort().at(-1) ?? "";
    cache = { series, fetchedAt: Date.now(), latestReport };
    lastError = null;
    return series;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    logger.warn({ msg: lastError }, "COT positioning fetch failed; the COT veto stands down until it recovers");
    return cache && Date.now() - cache.fetchedAt <= STALE_MAX_MS ? cache.series : null;
  }
}

/** Cached COT series, refreshed every 6 hours; null when no usable data (veto stands down). Never throws. */
export async function getCotSeries(): Promise<CotSeries | null> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.series;
  if (inFlight) return inFlight;
  inFlight = fetchNow().finally(() => { inFlight = null; });
  return inFlight;
}

export function getCotStatus() {
  return {
    latestReport: cache?.latestReport ?? null,
    fetchedAt: cache ? new Date(cache.fetchedAt).toISOString() : null,
    lastError,
  };
}
