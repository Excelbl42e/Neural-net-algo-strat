/**
 * Scan timing and portfolio caps: the rules around the strategy poll that are
 * about when to look and how much to hold at once, not about direction.
 */

export interface GateResult { ok: boolean; reason?: string; metrics: Record<string, number | string | null> }

export function assetClass(symbol: string, group?: string): string {
  if (group) return group;
  if (symbol.startsWith("frx")) return "Forex";
  if (symbol.startsWith("cry")) return "Crypto";
  return "Synthetic";
}

/** Signed currency exposure: long EURUSD => +EUR -USD. */
export function currencyLegs(symbol: string, direction: "buy" | "sell"): Record<string, number> {
  const m = symbol.match(/^frx([A-Z]{3})([A-Z]{3})$/);
  if (!m) return {};
  const s = direction === "buy" ? 1 : -1;
  return { [m[1]!]: s, [m[2]!]: -s };
}

/**
 * At most `maxPerAssetClass` open positions per class (forex is one class), and
 * never a third position on the same side of one currency — three USD shorts
 * are one bet on the dollar, not three trades.
 */
export function portfolioGate(
  open: Array<{ symbol: string; direction: "buy" | "sell"; group?: string }>,
  next: { symbol: string; direction: "buy" | "sell"; group?: string },
  maxPerAssetClass: number,
): GateResult {
  const cls = assetClass(next.symbol, next.group);
  const sameClass = open.filter((o) => assetClass(o.symbol, o.group) === cls).length;
  const metrics = { assetClass: cls, sameClass };
  if (sameClass >= maxPerAssetClass) return { ok: false, reason: `Asset class cap: ${sameClass}/${maxPerAssetClass} open in ${cls}`, metrics };
  const legs = currencyLegs(next.symbol, next.direction);
  for (const [ccy, sign] of Object.entries(legs)) {
    const same = open.filter((o) => (currencyLegs(o.symbol, o.direction)[ccy] ?? 0) === sign).length;
    if (same >= 2) return { ok: false, reason: `Currency leg cap: ${same} open positions already ${sign > 0 ? "long" : "short"} ${ccy}`, metrics };
  }
  return { ok: true, metrics };
}

// ── Scan timing ─────────────────────────────────────────────────────────────

const TIMEFRAME_MS: Record<string, number> = {
  M5: 5 * 60_000, M15: 15 * 60_000, M30: 30 * 60_000, H1: 60 * 60_000, H4: 4 * 60 * 60_000, D1: 24 * 60 * 60_000,
};

/**
 * True once a candle's period has ended. The newest stored row can be the
 * candle still forming: Deriv's history includes it, and the feed writes it on
 * every reconnect. Judging "did price close beyond structure?" on a close that
 * has not happened yet reads a live price as a vote.
 */
export function isClosedCandle(openTimeMs: number, timeframe: string, nowMs: number): boolean {
  const len = TIMEFRAME_MS[timeframe];
  if (len == null || !Number.isFinite(openTimeMs)) return true;
  return openTimeMs + len <= nowMs;
}

/**
 * The next scan time: just after the next boundary of the entry timeframe.
 * The poll votes on M30 candles, so nothing new can be seen between two
 * closes. Scanning on a fixed 30 minutes from process start — as before —
 * landed anywhere in that window: in production it ran a minute before each
 * close, so a candle closed at :30 was first seen at :58.
 */
export function nextAlignedScanAt(nowMs: number, intervalMs: number, offsetMs: number): number {
  const boundary = Math.floor(nowMs / intervalMs) * intervalMs;
  const thisSlot = boundary + offsetMs;
  return thisSlot > nowMs ? thisSlot : thisSlot + intervalMs;
}


// ── Candle history paging ───────────────────────────────────────────────────

/** Slots in the first (latest) ticks_history request per timeframe. */
export const FIRST_REQUEST_SLOTS = 500;
/** Slots per older page: Deriv returns at most 1,000 per request. */
export const PAGE_SLOTS = 1000;

/**
 * End times of the older history pages for one timeframe. The first request
 * covers the latest 500 slots; each page ends where the previous one began,
 * so the stored history has no hole (an earlier version left one 500 slots
 * wide between the first request and the first page).
 */
export function historyPageEnds(nowS: number, granularity: number, pages: number): number[] {
  const ends: number[] = [];
  for (let page = 1; page < pages; page++) ends.push(nowS - (FIRST_REQUEST_SLOTS + (page - 1) * PAGE_SLOTS) * granularity);
  return ends;
}
