import { Router, type IRouter } from "express";
import { getRecentCandles, getCandleFeederStatus, getLastTick, SUPPORTED_TIMEFRAMES, ensureSymbolSubscribed } from "../lib/candle-feeder.js";
import { SYNTHETIC_CATALOG, isSyntheticCode, getSyntheticSymbol } from "../lib/synthetic-catalog.js";

const router: IRouter = Router();

// Only forex is traded and analyzed; the chart/dashboard catalog matches that
// scope rather than listing instruments the bot will never scan.
const FOREX_ONLY_CATALOG = SYNTHETIC_CATALOG.filter((s) => s.group === "Forex");

// Literal-path routes MUST come before any param routes
router.get("/symbols", (_req, res): void => {
  res.json(FOREX_ONLY_CATALOG);
});

router.get("/candles/feeder-status", (_req, res): void => {
  res.json(getCandleFeederStatus());
});

router.get("/candles", async (req, res): Promise<void> => {
  const rawSymbol = String(req.query["symbol"] ?? "");
  // Normalize to the catalog's canonical case (e.g. frxEURUSD, R_75) so DB
  // queries match the form used by the candle feeder.
  const symbol = getSyntheticSymbol(rawSymbol)?.code ?? rawSymbol;
  const timeframe = String(req.query["timeframe"] ?? "M5").toUpperCase();
  const limitRaw = parseInt(String(req.query["limit"] ?? "200"), 10);
  const limit = Math.min(1000, Math.max(1, isNaN(limitRaw) ? 200 : limitRaw));

  if (!symbol) {
    res.status(400).json({ error: "symbol query param is required" });
    return;
  }
  if (!isSyntheticCode(symbol)) {
    res.status(400).json({ error: `Unknown instrument: ${rawSymbol}` });
    return;
  }
  if (!SUPPORTED_TIMEFRAMES.includes(timeframe)) {
    res.status(400).json({ error: `timeframe must be one of ${SUPPORTED_TIMEFRAMES.join(", ")}` });
    return;
  }

  // Ensure the feeder is streaming this symbol (lazy-subscribe on first view)
  ensureSymbolSubscribed(symbol);

  // getRecentCandles upper-cases internally for synthetics; pass the canonical
  // form, then refetch with the original casing if forex/crypto.
  const rows = await getRecentCandles(symbol, timeframe, limit);
  const candles = rows.map((c) => ({
    time: Math.floor(c.openTime.getTime() / 1000),
    open: parseFloat(c.open),
    high: parseFloat(c.high),
    low: parseFloat(c.low),
    close: parseFloat(c.close),
    volume: c.volume != null ? parseFloat(c.volume) : null,
  }));

  res.json({ symbol, timeframe, candles, lastTick: getLastTick(symbol) });
});

export default router;
