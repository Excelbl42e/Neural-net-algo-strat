/**
 * Deriv candle feeder.
 *
 * Connects to Deriv's unauthenticated Options public WebSocket,
 * subscribes to live ticks for the configured symbols, builds OHLCV candles
 * for several timeframes in memory, and persists each closed candle into the
 * `candles` table. Also exposes a `getRecentCandles` helper used by the
 * REST `/candles` endpoint.
 *
 * The public market-data channel requires neither an app ID nor an API token.
 * Account-scoped operations require a separate authenticated connection.
 */
import WebSocket from "ws";
import { sql, and, eq, desc, lt, notInArray, inArray, type SQL } from "drizzle-orm";
import { db, candlesTable, type Candle } from "@workspace/db";
import { logger } from "./logger.js";
import { isSyntheticCode, getSyntheticSymbol, DEFAULT_FEED_SYMBOLS as CATALOG_DEFAULT_SYMBOLS } from "./synthetic-catalog.js";

// Deriv is case-sensitive on live `ticks` subscriptions: forex/crypto codes
// MUST be sent in their canonical mixed case (e.g. `frxEURUSD`, `cryBTCUSD`),
// while synthetics are uppercase (`R_75`). Look up the canonical form in the
// catalog; fall back to the original string for unknown codes.
const normalizeSymbol = (s: string): string => {
  const known = getSyntheticSymbol(s);
  return known?.code ?? s;
};

/**
 * Timeframes this feeder builds and stores.
 *
 * M1 was built and persisted here but read by nothing: the chart offers M5 and
 * up, and the judge uses H4/H1/M30. At 1,440 bars a day per symbol it was
 * roughly three quarters of all candle writes and re-fetched 500 rows per
 * symbol on every reconnect, for data no code path has ever queried. Removed.
 */
const TIMEFRAMES: Record<string, number> = {
  M5: 5 * 60,
  M15: 15 * 60,
  M30: 30 * 60,
  H1: 60 * 60,
  H4: 4 * 60 * 60,
  D1: 24 * 60 * 60,
};

/**
 * How long each timeframe is kept.
 *
 * Nothing pruned this table, so it grew forever — about 13,000 rows a day
 * across the catalogue even without M1 — until the database filled and every
 * write started failing, which would read as the bot mysteriously dying weeks
 * later. Each window is comfortably more than anything that reads it needs:
 * the judge's deepest look-back is 250 H1 bars (~10 days) and 150 M30 bars
 * (~3 days); the rest is chart history.
 */
const CANDLE_RETENTION_DAYS: Record<string, number> = {
  M5: 7, M15: 14, M30: 30, H1: 90, H4: 180, D1: 730,
};
const CANDLE_PRUNE_EVERY_MS = 60 * 60 * 1000;
/** Gap between history requests. ~6 per second stays well inside Deriv's limits. */
const HISTORY_REQUEST_SPACING_MS = 150;
/** Rows removed per DELETE, so a prune never holds long locks against the live feed. */
const PRUNE_BATCH_SIZE = 5_000;
/** Ceiling on batches per pass; anything left is taken by the next hourly run. */
const PRUNE_MAX_BATCHES = 200;
/** Long enough after boot that housekeeping never competes with the feed coming up. */
const PRUNE_STARTUP_DELAY_MS = 90_000;

// Public endpoint verified with a 101 upgrade and real ticks/candles.
// Do not reuse it for account authorization or trading.
const DERIV_PUBLIC_WS_URL = "wss://api.derivws.com/trading/v1/options/ws/public";

interface BucketKey { symbol: string; tf: string; bucket: number }
interface OHLC { open: number; high: number; low: number; close: number; ticks: number }

class CandleFeeder {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private subscribedSymbols = new Set<string>();
  private pruneTimer: NodeJS.Timeout | null = null;
  /** Symbols Deriv refused, with its reason. Reported separately: one bad symbol is not a broken feed. */
  private rejectedSymbols = new Map<string, string>();
  private buckets = new Map<string, OHLC>();
  private lastTick = new Map<string, { price: number; at: number }>();
  private lastError: string | null = null;
  private lastErrorAt: string | null = null;
  private connectedAt: Date | null = null;
  private bucketsFlushed = 0;
  private feedState: "stopped" | "connecting" | "connected" | "reconnecting" | "error" = "stopped";

  start(symbols: string[]): void {
    for (const s of symbols) {
      const code = normalizeSymbol(s);
      if (isSyntheticCode(code)) this.subscribedSymbols.add(code);
    }
    // Trim shortly after boot as well as hourly, so an already-bloated table is
    // brought back inside its window without waiting an hour — but not *during*
    // startup, where a large delete would compete with the feed coming up.
    setTimeout(() => { void this.pruneOldCandles(); }, PRUNE_STARTUP_DELAY_MS).unref?.();
    this.pruneTimer ??= setInterval(() => { void this.pruneOldCandles(); }, CANDLE_PRUNE_EVERY_MS);
    this.pruneTimer.unref?.();
    // Always connect — the user can lazy-subscribe symbols later via ensureSubscribed().
    this.connect();
  }

  /**
   * Subscribe to a symbol on demand. Used by the /candles REST endpoint when
   * the user opens a chart for a symbol the feeder isn't streaming yet.
   */
  rejectionReason(symbol: string): string | null {
    return this.rejectedSymbols.get(normalizeSymbol(symbol)) ?? null;
  }

  ensureSubscribed(symbol: string): void {
    const code = normalizeSymbol(symbol);
    if (!isSyntheticCode(code)) return;
    // Deriv already refused this one; re-asking just re-raises the same error.
    if (this.rejectedSymbols.has(code)) return;
    if (this.subscribedSymbols.has(code)) return;
    this.subscribedSymbols.add(code);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ ticks: code, subscribe: 1 }));
      logger.info({ symbol: code }, "Candle feeder: lazy-subscribed");
    }
  }

  status() {
    const latestTickAt = Math.max(0, ...Array.from(this.lastTick.values(), (tick) => tick.at));
    const tickAgeMs = latestTickAt > 0 ? Math.max(0, Date.now() - latestTickAt) : null;
    const noTickDuration = this.connectedAt ? Date.now() - this.connectedAt.getTime() : 0;
    const feedFailure = this.feedState !== "connected"
      ? (this.lastError ?? `feed ${this.feedState}`)
      : tickAgeMs != null && tickAgeMs > 5 * 60 * 1000
        ? "no tick received for more than five minutes"
        : tickAgeMs == null && noTickDuration > 5 * 60 * 1000
          ? "no tick received within five minutes of connection"
        : null;
    return {
      connected: this.ws?.readyState === WebSocket.OPEN,
      state: this.feedState,
      feedFailure,
      latestTickAt: latestTickAt > 0 ? new Date(latestTickAt).toISOString() : null,
      tickAgeMs,
      connectedAt: this.connectedAt?.toISOString() ?? null,
      symbols: Array.from(this.subscribedSymbols),
      rejectedSymbols: Array.from(this.rejectedSymbols, ([symbol, reason]) => ({ symbol, reason })),
      bucketsFlushed: this.bucketsFlushed,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  /**
   * Requests candle history for every subscribed symbol, paced so the burst
   * cannot trip Deriv's rate limiter. Aborts quietly if the socket closes
   * partway through: the next connect starts it again.
   */
  private async backfillHistory(): Promise<void> {
    const socket = this.ws;
    for (const symbol of Array.from(this.subscribedSymbols)) {
      for (const granularity of Object.values(TIMEFRAMES)) {
        if (this.ws !== socket || socket?.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({
          ticks_history: symbol,
          granularity,
          count: 500,
          end: "latest",
          style: "candles",
          req_id: granularity,
        }));
        await new Promise((r) => setTimeout(r, HISTORY_REQUEST_SPACING_MS));
      }
    }
  }

  private connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    try {
      this.feedState = this.reconnectAttempts > 0 ? "reconnecting" : "connecting";
      logger.info({ symbols: Array.from(this.subscribedSymbols) }, "Candle feeder: connecting to Deriv");
      const ws = new WebSocket(DERIV_PUBLIC_WS_URL);
      this.ws = ws;
      let rejectedUpgrade = false;

      ws.on("open", () => {
        this.connectedAt = new Date();
        this.reconnectAttempts = 0;
        this.lastError = null;
        this.lastErrorAt = null;
        this.feedState = "connected";
        // Live tick subscriptions go out immediately — they are what the signal
        // worker waits on, and there is one per symbol.
        for (const s of this.subscribedSymbols) {
          this.ws?.send(JSON.stringify({ ticks: s, subscribe: 1 }));
        }
        // History is a much larger burst: one request per symbol per timeframe.
        // Across the full forex catalogue that is well over a hundred frames,
        // and firing them in a tight loop invites a rate limit that would cost
        // us the whole backfill. Ticks are unaffected either way, so pace it.
        void this.backfillHistory();
        logger.info(
          { symbols: this.subscribedSymbols.size },
          "Candle feeder: connected, subscribed to ticks, backfilling history"
        );
      });

      ws.on("message", (data) => this.handleMessage(data.toString()));

      ws.on("unexpected-response", (_request, response) => {
        rejectedUpgrade = true;
        this.lastError = `Deriv public WebSocket upgrade rejected: HTTP ${response.statusCode ?? "unknown"}`;
        this.lastErrorAt = new Date().toISOString();
        this.feedState = "error";
        // Only status and a diagnostic request ID: never log URLs, response
        // bodies or headers that might contain account credentials.
        logger.warn(
          { statusCode: response.statusCode, cfRay: response.headers["cf-ray"], at: this.lastErrorAt },
          "Candle feeder: upgrade rejected",
        );
        response.resume();
        this.scheduleReconnect();
        ws.terminate();
      });

      ws.on("error", (err) => {
        if (rejectedUpgrade) return;
        this.lastError = err.message;
        this.lastErrorAt = new Date().toISOString();
        this.feedState = "error";
        logger.warn({ err: err.message }, "Candle feeder: WebSocket error");
        this.scheduleReconnect();
        try { ws.close(); } catch { /* reconnect timer handles recovery */ }
      });

      ws.on("close", () => {
        this.connectedAt = null;
        this.feedState = "reconnecting";
        this.scheduleReconnect();
      });
    } catch (err: unknown) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.lastErrorAt = new Date().toISOString();
      this.feedState = "error";
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectAttempts++;
    const baseDelay = Math.min(60_000, 1000 * Math.pow(2, Math.min(this.reconnectAttempts, 6)));
    const delay = Math.min(60_000, Math.round(baseDelay * (0.8 + Math.random() * 0.4)));
    logger.info({ delayMs: delay, attempt: this.reconnectAttempts }, "Candle feeder: reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private handleMessage(raw: string): void {
    let msg: {
      tick?: { symbol: string; quote: number; epoch: number };
      candles?: { open: number; high: number; low: number; close: number; epoch: number }[];
      history?: { symbol: string };
      echo_req?: { ticks?: string; ticks_history?: string; granularity?: number };
      error?: { message: string; code?: string };
      msg_type?: string;
    };
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.error) {
      // Deriv echoes the failing request back, which is the only way to learn
      // WHICH symbol it rejected. Without this the status read "Invalid symbol"
      // with no symbol named — unactionable, and indistinguishable from the
      // whole feed being broken when in fact the other 27 were streaming fine.
      const symbol = msg.echo_req?.ticks ?? msg.echo_req?.ticks_history;
      if (symbol) {
        const code = normalizeSymbol(symbol);
        // Deriv will reject it identically on every reconnect, so stop asking.
        // Re-subscribing forever would keep the feed noisy and keep re-raising
        // an error the operator cannot do anything about.
        this.subscribedSymbols.delete(code);
        this.rejectedSymbols.set(code, msg.error.message);
        logger.warn({ symbol: code, err: msg.error.message }, "Candle feeder: Deriv rejected a symbol; dropped from the subscription set");
        return;
      }
      this.lastError = msg.error.message;
      this.lastErrorAt = new Date().toISOString();
      logger.warn({ err: msg.error.message }, "Candle feeder: Deriv error");
      return;
    }

    // Handle historical candles response
    if (msg.msg_type === "candles" && Array.isArray(msg.candles) && msg.echo_req?.ticks_history) {
      const symbol = normalizeSymbol(msg.echo_req.ticks_history);
      const granularity = msg.echo_req.granularity ?? 300;
      // Derived from TIMEFRAMES so a tier can never be added or removed in one
      // place and silently mislabelled here.
      const tf = Object.entries(TIMEFRAMES).find(([, secs]) => secs === granularity)?.[0] ?? "M5";
      // Deriv's history includes the real, possibly in-progress current candle.
      // Rehydrate only that exact bucket after reconnect/restart; never fill a
      // gap or synthesize OHLC from the last tick.
      const nowSeconds = Math.floor(Date.now() / 1000);
      const currentBucket = Math.floor(nowSeconds / granularity) * granularity;
      const currentCandle = msg.candles.find((c) => c.epoch === currentBucket);
      if (currentCandle) {
        const key = `${symbol}|${tf}|${currentBucket}`;
        const existing = this.buckets.get(key);
        this.buckets.set(key, {
          open: existing ? existing.open : currentCandle.open,
          high: Math.max(existing?.high ?? currentCandle.high, currentCandle.high),
          low: Math.min(existing?.low ?? currentCandle.low, currentCandle.low),
          close: existing?.close ?? currentCandle.close,
          ticks: existing?.ticks ?? 0,
        });
      }

      // Persist historical candles in one go (fire-and-forget).
      // Deriv's ticks_history candle response carries no volume field at all
      // — leave it null (unknown) rather than a false "0", which would read
      // as "confirmed zero trading activity" to any future consumer. Only
      // the live-built M1 candles below have a real value (actual tick count).
      const inserts = msg.candles.map((c) => ({
        symbol,
        timeframe: tf,
        openTime: new Date(c.epoch * 1000),
        open: String(c.open),
        high: String(c.high),
        low: String(c.low),
        close: String(c.close),
      }));
      if (inserts.length > 0) {
        db.insert(candlesTable)
          .values(inserts)
          .onConflictDoNothing()
          .then(() => {
            logger.info(
              { symbol, tf, count: inserts.length },
              "Candle feeder: historical candles loaded"
            );
          })
          .catch((err) =>
            logger.warn({ err: String(err), symbol, tf }, "Candle feeder: history persist failed")
          );
      }
      return;
    }

    if (!msg.tick) return;
    // A tick proves the feed is alive. Without this, a transient error stayed
    // pinned in the status forever and the Chart page kept showing it while
    // prices were streaming in perfectly well behind it.
    if (this.lastError) { this.lastError = null; this.lastErrorAt = null; }
    const { symbol, quote, epoch } = msg.tick;
    const localSymbol = normalizeSymbol(symbol);
    const tickAt = epoch * 1000;
    const previousTick = this.lastTick.get(localSymbol);
    // Ignore out-of-order delivery instead of reopening an already completed
    // candle bucket with an old tick after reconnect.
    if (previousTick && tickAt < previousTick.at) return;
    this.lastTick.set(localSymbol, { price: quote, at: tickAt });
    this.recordTick(localSymbol, quote, epoch);
  }

  private recordTick(symbol: string, price: number, epochSeconds: number): void {
    for (const [tf, secs] of Object.entries(TIMEFRAMES)) {
      const bucketStart = Math.floor(epochSeconds / secs) * secs;
      const key = `${symbol}|${tf}|${bucketStart}`;
      const existing = this.buckets.get(key);
      if (!existing) {
        // New bucket — flush any older buckets for this (symbol, tf)
        this.flushOlderBuckets(symbol, tf, bucketStart);
        this.buckets.set(key, { open: price, high: price, low: price, close: price, ticks: 1 });
      } else {
        existing.high = Math.max(existing.high, price);
        existing.low = Math.min(existing.low, price);
        existing.close = price;
        existing.ticks += 1;
      }
    }
  }

  private flushOlderBuckets(symbol: string, tf: string, currentBucketStart: number): void {
    const secs = TIMEFRAMES[tf];
    if (!secs) return;
    for (const [key, ohlc] of Array.from(this.buckets.entries())) {
      const [sym, frame, startStr] = key.split("|");
      if (sym !== symbol || frame !== tf) continue;
      const start = parseInt(startStr, 10);
      if (start >= currentBucketStart) continue;
      // Only delete the in-memory bucket AFTER a successful DB write.
      // On failure we keep the bucket so a future tick (or flushAll) can
      // retry it; this avoids silent data loss on transient DB errors.
      this.persistCandle(symbol, tf, start, ohlc)
        .then(() => this.buckets.delete(key))
        .catch((err) =>
          logger.warn({ err: String(err), symbol, tf, openTime: start }, "Candle persist failed; will retry")
        );
    }
  }

  /**
   * Drops candles older than their timeframe's retention window, one timeframe
   * at a time so a single large delete cannot lock the table for long. Purely
   * best-effort: a failure here must never interrupt the feed.
   */
  private async pruneOldCandles(): Promise<void> {
    /**
     * Delete in bounded batches. A single unbounded DELETE on a table this
     * feed fills continuously holds row locks for its whole duration and
     * builds one enormous transaction; batching keeps each lock short so
     * inserts are never blocked behind housekeeping.
     */
    const deleteBatched = async (label: string, matching: SQL | undefined): Promise<number> => {
      let removed = 0;
      for (let pass = 0; pass < PRUNE_MAX_BATCHES; pass++) {
        const doomed = await db.select({ id: candlesTable.id }).from(candlesTable).where(matching).limit(PRUNE_BATCH_SIZE);
        if (doomed.length === 0) break;
        await db.delete(candlesTable).where(inArray(candlesTable.id, doomed.map((r) => r.id)));
        removed += doomed.length;
        if (doomed.length < PRUNE_BATCH_SIZE) break;
      }
      if (removed > 0) logger.info({ scope: label, removed }, "Candle prune removed rows past retention");
      return removed;
    };

    for (const [tf, days] of Object.entries(CANDLE_RETENTION_DAYS)) {
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      try {
        await deleteBatched(tf, and(eq(candlesTable.timeframe, tf), lt(candlesTable.openTime, cutoff)));
      } catch (err) {
        logger.warn({ err: String(err), timeframe: tf }, "Candle prune failed; will retry next cycle");
      }
    }
    // Anything the feeder no longer builds (M1 from earlier versions) is dead
    // weight that no retention window above would ever reach.
    try {
      await deleteBatched("retired-timeframes", notInArray(candlesTable.timeframe, Object.keys(TIMEFRAMES)));
    } catch (err) {
      logger.warn({ err: String(err) }, "Retired-timeframe candle prune failed");
    }
  }

  private async persistCandle(symbol: string, tf: string, openTimeSecs: number, ohlc: OHLC): Promise<void> {
    const openTime = new Date(openTimeSecs * 1000);
    await db
      .insert(candlesTable)
      .values({
        symbol,
        timeframe: tf,
        openTime,
        open: String(ohlc.open),
        high: String(ohlc.high),
        low: String(ohlc.low),
        close: String(ohlc.close),
        volume: String(ohlc.ticks),
      })
      .onConflictDoUpdate({
        target: [candlesTable.symbol, candlesTable.timeframe, candlesTable.openTime],
        set: {
          high: sql`GREATEST(${candlesTable.high}, ${String(ohlc.high)})`,
          low: sql`LEAST(${candlesTable.low}, ${String(ohlc.low)})`,
          close: String(ohlc.close),
          volume: String(ohlc.ticks),
        },
      });
    this.bucketsFlushed += 1;
  }

  /**
   * Force-flush any open buckets older than the current epoch — used by
   * the REST endpoint to make sure the most recent candle is queryable
   * even if the next tick has not arrived yet.
   */
  async flushAll(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    for (const [key, ohlc] of Array.from(this.buckets.entries())) {
      const [symbol, tf, startStr] = key.split("|");
      const start = parseInt(startStr, 10);
      const secs = TIMEFRAMES[tf] ?? 60;
      // Keep the in-progress bucket; only flush completed ones.
      if (start + secs <= now) {
        try {
          await this.persistCandle(symbol, tf, start, ohlc);
          this.buckets.delete(key);
        } catch (err) {
          logger.warn({ err: String(err), symbol, tf, openTime: start }, "flushAll: persist failed; bucket retained for retry");
        }
      }
    }
  }

  /** Get the latest in-memory tick for a symbol (used by the chart's live overlay). */
  getLastTick(symbol: string): { price: number; at: number } | null {
    return this.lastTick.get(normalizeSymbol(symbol)) ?? null;
  }
}

const feeder = new CandleFeeder();

export function startCandleFeeder(symbols: string[] = CATALOG_DEFAULT_SYMBOLS): void {
  feeder.start(symbols);
}

export function ensureSymbolSubscribed(symbol: string): void {
  feeder.ensureSubscribed(symbol);
}

export function getCandleFeederStatus() {
  return feeder.status();
}

/**
 * Deriv's reason for refusing a symbol, or null if it is fine. The worker uses
 * this so a refused pair is reported as refused rather than as a feed outage,
 * and is not re-analysed every scan for data that will never arrive.
 */
export function symbolRejectionReason(symbol: string): string | null {
  return feeder.rejectionReason(symbol);
}

export function getLastTick(symbol: string) {
  return feeder.getLastTick(symbol);
}

export async function getRecentCandles(symbol: string, timeframe: string, limit = 200): Promise<Candle[]> {
  await feeder.flushAll().catch(() => undefined);
  // Use canonical casing — synthetics are uppercase, forex/crypto mixed case.
  const canonical = normalizeSymbol(symbol);
  const rows = await db
    .select()
    .from(candlesTable)
    .where(and(eq(candlesTable.symbol, canonical), eq(candlesTable.timeframe, timeframe.toUpperCase())))
    .orderBy(desc(candlesTable.openTime))
    .limit(limit);
  return rows.reverse();
}

export const SUPPORTED_TIMEFRAMES = Object.keys(TIMEFRAMES);
export const FEEDER_SYMBOLS = CATALOG_DEFAULT_SYMBOLS;

export async function flushCandles(): Promise<void> {
  await feeder.flushAll().catch(() => undefined);
}
