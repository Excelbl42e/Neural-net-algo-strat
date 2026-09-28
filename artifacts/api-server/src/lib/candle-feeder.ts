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
import { sql, and, eq, desc } from "drizzle-orm";
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

const TIMEFRAMES: Record<string, number> = {
  M1: 60,
  M5: 5 * 60,
  M15: 15 * 60,
  M30: 30 * 60,
  H1: 60 * 60,
  H4: 4 * 60 * 60,
  D1: 24 * 60 * 60,
};

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
    // Always connect — the user can lazy-subscribe symbols later via ensureSubscribed().
    this.connect();
  }

  /**
   * Subscribe to a symbol on demand. Used by the /candles REST endpoint when
   * the user opens a chart for a symbol the feeder isn't streaming yet.
   */
  ensureSubscribed(symbol: string): void {
    const code = normalizeSymbol(symbol);
    if (!isSyntheticCode(code)) return;
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
      bucketsFlushed: this.bucketsFlushed,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      reconnectAttempts: this.reconnectAttempts,
    };
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
        for (const s of this.subscribedSymbols) {
          // Subscribe to live ticks
          this.ws?.send(JSON.stringify({ ticks: s, subscribe: 1 }));
          // Fetch 500 historical candles for each timeframe immediately
          for (const granularity of [60, 300, 900, 1800, 3600, 14400, 86400]) {
            this.ws?.send(JSON.stringify({
              ticks_history: s,
              granularity,
              count: 500,
              end: "latest",
              style: "candles",
              req_id: granularity,
            }));
          }
        }
        logger.info(
          { symbols: Array.from(this.subscribedSymbols) },
          "Candle feeder: connected, fetching history"
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
      echo_req?: { ticks_history?: string; granularity?: number };
      error?: { message: string };
      msg_type?: string;
    };
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.error) {
      this.lastError = msg.error.message;
      this.lastErrorAt = new Date().toISOString();
      logger.warn({ err: msg.error.message }, "Candle feeder: Deriv error");
      return;
    }

    // Handle historical candles response
    if (msg.msg_type === "candles" && Array.isArray(msg.candles) && msg.echo_req?.ticks_history) {
      const symbol = normalizeSymbol(msg.echo_req.ticks_history);
      const granularity = msg.echo_req.granularity ?? 300;
      const tf = ({
        60: "M1", 300: "M5", 900: "M15", 1800: "M30", 3600: "H1", 14400: "H4", 86400: "D1",
      } as Record<number, string>)[granularity] ?? "M5";
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

      // Persist historical candles in one go (fire-and-forget)
      const inserts = msg.candles.map((c) => ({
        symbol,
        timeframe: tf,
        openTime: new Date(c.epoch * 1000),
        open: String(c.open),
        high: String(c.high),
        low: String(c.low),
        close: String(c.close),
        volume: "0",
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
