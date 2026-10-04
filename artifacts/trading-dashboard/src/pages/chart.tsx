import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";
import {
  useListCandles,
  useGetCandleFeederStatus,
  useListSignals,
  useListSymbols,
  useListTrades,
  getListCandlesQueryKey,
  getGetCandleFeederStatusQueryKey,
  getListSignalsQueryKey,
  getListSymbolsQueryKey,
  getListTradesQueryKey,
  type Signal,
  type SyntheticSymbol,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup, SelectLabel } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ArrowDown, ArrowUp, Radio, AlertTriangle } from "lucide-react";

const TIMEFRAMES = ["M5", "M15", "M30", "H1", "H4", "D1"] as const;
type Timeframe = (typeof TIMEFRAMES)[number];

interface LevelDrawing {
  kind: "fvg" | "ob" | "sweep" | "level";
  low: number;
  high: number;
  label?: string;
}

/** An open position as the chart draws it: prices as numbers (the API sends numeric columns as text). */
interface OpenTradeLevels { id: number; direction: string; entry: number; stop: number | null; target: number | null; openedAt: number; stake: number }

const toNum = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

function parseLevels(raw: string | null | undefined): LevelDrawing[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export default function ChartPage() {
  const [symbol, setSymbol] = useState<string>("frxEURUSD");
  const [timeframe, setTimeframe] = useState<Timeframe>("H4");

  const { data: symbolCatalog } = useListSymbols({
    query: { queryKey: getListSymbolsQueryKey() },
  });
  const { data: feederStatus, isError: feederError } = useGetCandleFeederStatus({
    query: { queryKey: getGetCandleFeederStatusQueryKey(), refetchInterval: 5000 },
  });
  const candlesParams = { symbol, timeframe, limit: 200 };
  const { data: candleData, isLoading: candlesLoading, isError: candlesError, refetch: retryCandles } = useListCandles(
    candlesParams,
    { query: { queryKey: getListCandlesQueryKey(candlesParams), refetchInterval: 2000 } }
  );
  const signalsParams = { status: "active" as const };
  const { data: allSignals } = useListSignals(
    signalsParams,
    { query: { queryKey: getListSignalsQueryKey(signalsParams), refetchInterval: 5000 } }
  );

  const tradesParams = { status: "open" as const, symbol };
  const { data: openTradesRaw } = useListTrades(
    tradesParams,
    { query: { queryKey: getListTradesQueryKey(tradesParams), refetchInterval: 5000 } }
  );
  // Open positions on this pair, with the stop and target actually sent to Deriv.
  const openTrades = useMemo<OpenTradeLevels[]>(() => (openTradesRaw ?? []).flatMap((t) => {
    const entry = toNum(t.openPrice);
    const openedAt = Date.parse(t.openedAt);
    if (entry == null || !Number.isFinite(openedAt) || t.symbol.toLowerCase() !== symbol.toLowerCase()) return [];
    return [{ id: t.id, direction: t.direction, entry, stop: toNum(t.stopLoss), target: toNum(t.takeProfit), openedAt, stake: toNum(t.lotSize) ?? 0 }];
  }), [openTradesRaw, symbol]);

  const signalsForSymbol = useMemo(
    // Case-insensitive compare so frxEURUSD and FRXEURUSD both match.
    () => (allSignals ?? []).filter((s) => s.symbol.toLowerCase() === symbol.toLowerCase()),
    [allSignals, symbol]
  );

  // Group catalog by `group` field for the dropdown
  const groupedCatalog = useMemo(() => {
    const groups = new Map<string, SyntheticSymbol[]>();
    for (const sym of symbolCatalog ?? []) {
      const list = groups.get(sym.group) ?? [];
      list.push(sym);
      groups.set(sym.group, list);
    }
    return Array.from(groups.entries());
  }, [symbolCatalog]);

  const currentSymbolDisplay = symbolCatalog?.find((s) => s.code === symbol)?.display ?? symbol;
  // Not in the generated client yet; the status route returns whatever the feeder reports.
  const rejected = (feederStatus as { rejectedSymbols?: Array<{ symbol: string; reason: string }> } | undefined)?.rejectedSymbols ?? [];
  const rejectedHere = rejected.find((r) => r.symbol === symbol)?.reason ?? null;
  const rejectedElsewhere = rejected.filter((r) => r.symbol !== symbol);
  // Stored candles plus the one still being built from live ticks, which
  // replaces the last stored candle when they share an open time.
  const liveCandles = useMemo(() => {
    const stored = candleData?.candles ?? [];
    const f = candleData?.forming;
    if (!f) return stored;
    return stored.at(-1)?.time === f.time ? [...stored.slice(0, -1), f] : [...stored, f];
  }, [candleData]);
  const lastTick = candleData?.lastTick ?? null;
  // A tick in the last 2 minutes means the market is streaming right now.
  const tickAgeSec = lastTick ? Math.max(0, Math.round((Date.now() - lastTick.at) / 1000)) : null;
  const isLive = tickAgeSec != null && tickAgeSec <= 120;
  const latestCandle = liveCandles.at(-1);

  return (
    <div className="space-y-4 min-w-0">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{feederStatus?.connected ? "Deriv Candles" : "Stored Candles"}</h1>
          <p className="text-sm text-muted-foreground">
            {feederStatus?.connected ? "Live Deriv ticks: the last candle forms tick by tick and the chart refreshes every 2 seconds; earlier candles are stored history." : "Stored candles only; the feed is disconnected or its state is unavailable, so nothing is live."} Stored signal levels are overlaid. Charting by Lightweight Charts, not a TradingView market-data feed.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <FeederBadge connected={feederStatus?.connected} symbols={feederStatus?.symbols ?? []} unavailable={feederError} />
          <Select value={symbol} onValueChange={(v) => setSymbol(v)}>
            <SelectTrigger className="w-44">
              <SelectValue placeholder="Select symbol">{currentSymbolDisplay}</SelectValue>
            </SelectTrigger>
            <SelectContent className="max-h-80">
              {groupedCatalog.length > 0
                ? groupedCatalog.map(([group, syms]) => (
                    <SelectGroup key={group}>
                      <SelectLabel className="text-xs text-muted-foreground px-2 py-1">{group}</SelectLabel>
                      {syms.map((s) => (
                        <SelectItem key={s.code} value={s.code}>
                          {s.display}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))
                : (
                    <SelectItem value="frxEURUSD">EUR / USD</SelectItem>
                  )
              }
            </SelectContent>
          </Select>
          <div className="flex rounded-md border border-border overflow-x-auto max-w-full">
            {TIMEFRAMES.map((tf) => (
              <Button
                key={tf}
                variant={timeframe === tf ? "default" : "ghost"}
                size="sm"
                className="rounded-none px-3 h-9 text-xs font-mono-numbers"
                onClick={() => setTimeframe(tf)}
              >
                {tf}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {(latestCandle || feederStatus?.lastError || rejectedHere || rejectedElsewhere.length > 0) && (
        <div className="rounded-md border border-border bg-card/50 px-3 py-2 text-xs font-mono-numbers text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
          {isLive && lastTick ? (
            <span data-testid="text-live-price"><span className="text-green-400">● LIVE</span> price <strong className="text-foreground">{lastTick.price}</strong> · tick {new Date(lastTick.at).toLocaleTimeString()} ({tickAgeSec}s ago). The last candle is still forming and moves with every tick.</span>
          ) : latestCandle ? (
            <span data-testid="text-last-price">No live tick{lastTick ? ` since ${new Date(lastTick.at).toLocaleString()}` : ""} — the market is closed or the feed is quiet. Last price <strong className="text-foreground">{lastTick?.price ?? latestCandle.close}</strong>.</span>
          ) : null}
          {/* A symbol Deriv refuses is not a broken feed — say which one and what it means, instead of a bare "Invalid symbol". */}
          {rejectedHere && (
            <span className="text-amber-300" data-testid="text-symbol-rejected">
              Deriv refused {currentSymbolDisplay} ({symbol}): {rejectedHere}. It is not streaming; any candles shown are stored history.
            </span>
          )}
          {!rejectedHere && rejectedElsewhere.length > 0 && (
            <span className="text-muted-foreground" data-testid="text-symbols-rejected-elsewhere">
              {rejectedElsewhere.length} other symbol{rejectedElsewhere.length === 1 ? "" : "s"} refused by Deriv and dropped: {rejectedElsewhere.map((r) => r.symbol).join(", ")}. This symbol is unaffected.
            </span>
          )}
          {feederStatus?.lastError && <span className="text-amber-300" data-testid="text-feeder-error">Feed error: {feederStatus.lastError}</span>}
        </div>
      )}

      {/* Chart */}
      <Card className="overflow-hidden">
        <CardContent className="p-0">
          {candlesLoading ? (
            <Skeleton className="h-[520px] w-full" />
          ) : candlesError ? (
            <div className="min-h-72 p-8 flex items-center justify-center text-sm text-amber-300">Candle data unavailable. <Button className="ml-3" variant="outline" onClick={() => retryCandles()}>Retry</Button></div>
          ) : (candleData?.candles?.length ?? 0) === 0 ? (
            <EmptyChart connected={feederStatus?.connected} symbol={symbol} />
          ) : (
            <ChartCanvas symbol={symbol}
              viewKey={`${symbol}|${timeframe}`}
              livePrice={isLive && lastTick ? lastTick.price : null}
              candles={liveCandles}
              signals={signalsForSymbol}
              trades={openTrades}
            />
          )}
        </CardContent>
      </Card>

      {openTrades.length > 0 && (
        <Card>
          <CardContent className="p-4 space-y-2" data-testid="chart-open-trades">
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Open positions on {currentSymbolDisplay} (drawn on the chart)</div>
            {openTrades.map((t) => (
              <div key={t.id} className="flex flex-wrap gap-x-4 gap-y-1 font-mono-numbers text-xs">
                <span className={t.direction === "buy" ? "text-green-500" : "text-red-500"}>#{t.id} {t.direction.toUpperCase()} ${t.stake.toFixed(2)}</span>
                <span>entry {t.entry}</span>
                <span className="text-red-400">stop {t.stop ?? "---"}</span>
                <span className="text-blue-400">target {t.target ?? "---"}</span>
                <span className="text-muted-foreground">opened {new Date(t.openedAt).toISOString().slice(0, 16).replace("T", " ")} UTC</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Active signals legend */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {signalsForSymbol.length === 0 ? (
          <Card className="md:col-span-2">
            <CardContent className="p-6 text-sm text-muted-foreground">
              No active signal records for {symbol}. Stored numeric levels appear when a signal contains them.
            </CardContent>
          </Card>
        ) : (
          signalsForSymbol.map((s) => <SignalLegendCard key={s.id} signal={s} />)
        )}
      </div>
    </div>
  );
}

function FeederBadge({ connected, symbols, unavailable }: { connected?: boolean; symbols: string[]; unavailable: boolean }) {
  return (
    <Badge variant="outline" className={cn(
      "gap-1.5 font-mono-numbers text-[11px]",
      connected ? "text-green-400 border-green-400/40" : "text-amber-400 border-amber-400/40"
    )}>
      <Radio className={cn("w-3 h-3", connected ? "animate-pulse" : "")} />
      {unavailable || connected == null ? "FEED STATUS UNKNOWN" : connected ? `FEED CONNECTED · ${symbols.length} symbols` : "FEED DISCONNECTED"}
    </Badge>
  );
}

function EmptyChart({ connected, symbol }: { connected?: boolean; symbol: string }) {
  return (
    <div className="h-[520px] flex items-center justify-center text-center px-8">
      <div className="max-w-md space-y-2">
        <AlertTriangle className="w-8 h-8 text-muted-foreground mx-auto" />
        <h3 className="font-semibold">No stored candles for {symbol}</h3>
        <p className="text-sm text-muted-foreground">
          {connected === true
            ? "The feeder reports connected. This symbol may not yet have a completed stored candle."
            : connected === false ? "The candle feeder is disconnected. Check broker/feed status; chart data may not update."
            : "Feeder status is unavailable. Check the connection before interpreting this chart."}
        </p>
      </div>
    </div>
  );
}

interface CandlePoint { time: number; open: number; high: number; low: number; close: number; volume?: number | null }

function ChartCanvas({ candles, signals, trades, symbol, viewKey, livePrice }: {
  candles: CandlePoint[];
  signals: Signal[];
  /** Open positions on this pair: entry, stop and target lines plus an arrow where each opened. */
  trades: OpenTradeLevels[];
  symbol: string;
  /** Changes when the pair or timeframe changes; the view is refitted only then, not on every live refresh. */
  viewKey: string;
  /** Latest live tick, or null when the market is not streaming. */
  livePrice: number | null;
}) {
  const fittedKeyRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<SVGSVGElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  // Chart init
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      width: el.clientWidth,
      height: el.clientHeight,
      layout: {
        background: { color: "transparent" },
        textColor: "#9ca3af",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(75, 85, 99, 0.15)" },
        horzLines: { color: "rgba(75, 85, 99, 0.15)" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: {
        borderColor: "rgba(75, 85, 99, 0.4)",
        scaleMargins: { top: 0.12, bottom: 0.12 },
        autoScale: true,
      },
      timeScale: {
        borderColor: "rgba(75, 85, 99, 0.4)",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 8,
        barSpacing: 10,
        minBarSpacing: 4,
      },
    });
    const series = chart.addSeries(CandlestickSeries, {
      priceLineVisible: false,
      // the dashed "STORED CLOSE" line already labels the last close
      lastValueVisible: false,
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderUpColor: "#22c55e",
      borderDownColor: "#ef4444",
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
    });
    chartRef.current = chart;
    seriesRef.current = series;
    markersRef.current = createSeriesMarkers(series, []);

    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      markersRef.current = null;
      priceLinesRef.current = [];
    };
  }, []);

  // Price precision of the pair: 3 decimals for JPY pairs, 5 for the rest
  useEffect(() => {
    const precision = symbol.endsWith("JPY") ? 3 : 5;
    seriesRef.current?.applyOptions({ priceFormat: { type: "price", precision, minMove: 10 ** -precision } });
  }, [symbol]);

  // Update candle data
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    series.setData(
      candles.map((c) => ({
        time: c.time as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }))
    );
    // Fit all bars into view once per pair/timeframe; live refreshes keep the user's zoom and scroll.
    if (fittedKeyRef.current !== viewKey) {
      chartRef.current?.timeScale().fitContent();
      fittedKeyRef.current = viewKey;
    }
  }, [candles, viewKey]);

  // Render axis-anchored price lines: entry midline + stop + targets (clean labels on the right scale)
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    for (const pl of priceLinesRef.current) series.removePriceLine(pl);
    priceLinesRef.current = [];

    const newLines: IPriceLine[] = [];
    const markers: SeriesMarker<Time>[] = [];

    for (const t of trades) {
      const buy = t.direction === "buy";
      const color = buy ? "#22c55e" : "#ef4444";
      newLines.push(series.createPriceLine({
        price: t.entry, color, lineWidth: 2, lineStyle: 0,
        axisLabelVisible: true, title: `#${t.id} ${buy ? "BUY" : "SELL"}`,
      }));
      if (t.stop != null) {
        newLines.push(series.createPriceLine({
          price: t.stop, color: "#ef4444", lineWidth: 1, lineStyle: 2,
          axisLabelVisible: true, title: `#${t.id} STOP`,
        }));
      }
      if (t.target != null) {
        newLines.push(series.createPriceLine({
          price: t.target, color: "#3b82f6", lineWidth: 1, lineStyle: 2,
          axisLabelVisible: true, title: `#${t.id} TP`,
        }));
      }
      const openedSec = Math.floor(t.openedAt / 1000);
      const bar = candles.findLast?.((c) => c.time <= openedSec);
      if (bar) {
        markers.push({
          time: bar.time as Time,
          position: buy ? "belowBar" : "aboveBar",
          color,
          shape: buy ? "arrowUp" : "arrowDown",
          text: `#${t.id} ${buy ? "BUY" : "SELL"}`,
        });
      }
    }

    for (const s of signals) {
      const dirColor = s.direction === "buy" ? "#22c55e" : "#ef4444";

      const entryMid = s.entryLow != null && s.entryHigh != null
        ? (s.entryLow + s.entryHigh) / 2
        : s.entryLow ?? s.entryHigh ?? null;
      if (entryMid != null) {
        newLines.push(series.createPriceLine({
          price: entryMid, color: dirColor, lineWidth: 2, lineStyle: 0,
          axisLabelVisible: true, title: `${s.direction.toUpperCase()} ENTRY`,
        }));
      }
      if (s.stopLevel != null) {
        newLines.push(series.createPriceLine({
          price: s.stopLevel, color: "#ef4444", lineWidth: 1, lineStyle: 2,
          axisLabelVisible: true, title: "STOP",
        }));
      }
      if (s.target1Level != null) {
        newLines.push(series.createPriceLine({
          price: s.target1Level, color: "#3b82f6", lineWidth: 1, lineStyle: 2,
          axisLabelVisible: true, title: "TP1",
        }));
      }
      if (s.target2Level != null && s.target2Level !== s.target1Level) {
        newLines.push(series.createPriceLine({
          price: s.target2Level, color: "#8b5cf6", lineWidth: 1, lineStyle: 2,
          axisLabelVisible: true, title: "TP2",
        }));
      }

       // Mark only a candle that actually covers or precedes the signal timestamp.
      if (candles.length > 0) {
        const createdSec = Math.floor(new Date(s.createdAt).getTime() / 1000);
        const snap = candles.findLast?.((c) => c.time <= createdSec);
        if (snap) {
          markers.push({
            time: snap.time as Time,
            position: s.direction === "buy" ? "belowBar" : "aboveBar",
            color: dirColor,
            shape: s.direction === "buy" ? "arrowUp" : "arrowDown",
            text: `${s.direction.toUpperCase()} ${(s.confidence * 100).toFixed(0)}%`,
          });
        }
      }
    }

    const last = candles.at(-1);
    if (livePrice != null) {
      newLines.push(series.createPriceLine({
        price: livePrice, color: "#22d3ee", lineWidth: 1, lineStyle: 2,
        axisLabelVisible: true, title: "LIVE",
      }));
    } else if (last) {
      newLines.push(series.createPriceLine({
        price: last.close, color: "#8c9dab", lineWidth: 1, lineStyle: 2,
        axisLabelVisible: true, title: "LAST",
      }));
    }
    priceLinesRef.current = newLines;
    // Markers must be in time order.
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    markersRef.current?.setMarkers(markers);
  }, [signals, trades, candles, livePrice]);

  // SVG overlay: draws human-style trader analysis — filled FVG / OB / Sweep boxes
  // and shaded entry / stop / target zones extending from the signal time forward.
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    const overlay = overlayRef.current;
    const container = containerRef.current;
    if (!chart || !series || !overlay || !container) return;

    const SVG_NS = "http://www.w3.org/2000/svg";
    const make = (name: string, attrs: Record<string, string | number>): SVGElement => {
      const e = document.createElementNS(SVG_NS, name);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
      return e;
    };

    function redraw() {
      if (!chart || !series || !overlay || !container) return;
      const width = container.clientWidth;
       const height = container.clientHeight;
      const tsWidth = chart.timeScale().width();
      overlay.setAttribute("width", String(width));
      overlay.setAttribute("height", String(height));
      overlay.setAttribute("viewBox", `0 0 ${width} ${height}`);
      while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
      if (!signals.length) return;

      const rightX = Math.max(0, tsWidth - 4);

      // Helper: pill-style label tag drawn at (x, y) with text
      const drawTag = (x: number, y: number, text: string, fill: string, textColor = "#0a0a0a") => {
        const tagW = text.length * 6.4 + 14;
        overlay.appendChild(make("rect", {
          x, y: y - 14, width: tagW, height: 14,
          fill, rx: 3, ry: 3,
          stroke: "rgba(0,0,0,0.25)", "stroke-width": 0.5,
        }));
        const lbl = make("text", {
          x: x + 7, y: y - 4,
          fill: textColor, "font-size": 10, "font-weight": 700,
          "font-family": "ui-monospace, SFMono-Regular, Menlo, monospace",
        });
        lbl.textContent = text;
        overlay.appendChild(lbl);
      };

      for (const s of signals) {
        const isBuy = s.direction === "buy";
        const dirColor = isBuy ? "#22c55e" : "#ef4444";
        const dirRGB = isBuy ? "34, 197, 94" : "239, 68, 68";

        // Anchor x = signal creation time → coordinate, snapped to nearest candle
        const createdSec = Math.floor(new Date(s.createdAt).getTime() / 1000);
        const snap = candles.findLast?.((c) => c.time <= createdSec);
        if (!snap) continue;
        let startX: number | null = null;
        startX = chart.timeScale().timeToCoordinate(snap.time as Time);
        if (startX == null) startX = 0;
        startX = Math.max(0, Math.min(startX, rightX - 1));

        // Vertical anchor line at signal time
        overlay.appendChild(make("line", {
          x1: startX, y1: 0, x2: startX, y2: height,
          stroke: `rgba(${dirRGB}, 0.4)`, "stroke-width": 1, "stroke-dasharray": "2 4",
        }));

        // ── ENTRY zone (solid trader-style box, signal time → right) ─────
        if (s.entryLow != null && s.entryHigh != null) {
          const yHi = series.priceToCoordinate(s.entryHigh);
          const yLo = series.priceToCoordinate(s.entryLow);
          if (yHi != null && yLo != null) {
            const top = Math.min(yHi, yLo);
            const h = Math.max(3, Math.abs(yLo - yHi));
            overlay.appendChild(make("rect", {
              x: startX, y: top, width: rightX - startX, height: h,
              fill: `rgba(${dirRGB}, 0.22)`,
              stroke: `rgba(${dirRGB}, 0.85)`, "stroke-width": 1.5,
            }));
            drawTag(startX + 4, top, `${s.direction.toUpperCase()} ENTRY · ${(s.confidence * 100).toFixed(0)}%`, dirColor);
          }
        }

        // STOP zone (red translucent band — risk side)
        if (s.stopLevel != null && s.entryLow != null && s.entryHigh != null) {
          const entrySide = isBuy ? s.entryLow : s.entryHigh;
          const yStop = series.priceToCoordinate(s.stopLevel);
          const yEdge = series.priceToCoordinate(entrySide);
          if (yStop != null && yEdge != null) {
            const top = Math.min(yStop, yEdge);
            const h = Math.max(2, Math.abs(yEdge - yStop));
            overlay.appendChild(make("rect", {
              x: startX, y: top, width: rightX - startX, height: h,
              fill: "rgba(239, 68, 68, 0.10)",
            }));
          }
        }

        // TARGET zone (blue translucent band — reward side)
        if (s.target1Level != null && s.entryLow != null && s.entryHigh != null) {
          const entrySide = isBuy ? s.entryHigh : s.entryLow;
          const yTgt = series.priceToCoordinate(s.target1Level);
          const yEdge = series.priceToCoordinate(entrySide);
          if (yTgt != null && yEdge != null) {
            const top = Math.min(yTgt, yEdge);
            const h = Math.max(2, Math.abs(yEdge - yTgt));
            overlay.appendChild(make("rect", {
              x: startX, y: top, width: rightX - startX, height: h,
              fill: "rgba(59, 130, 246, 0.10)",
            }));
          }
        }

        // ── ICT concept boxes: FVG, OB, Sweep ────────────────────────────
        for (const lvl of parseLevels(s.levels)) {
          const yHi = series.priceToCoordinate(lvl.high);
          const yLo = series.priceToCoordinate(lvl.low);
          if (yHi == null || yLo == null) continue;
          const top = Math.min(yHi, yLo);
          const h = Math.max(3, Math.abs(yLo - yHi));
          const meta = ({
            fvg:   { color: "#f59e0b", rgb: "245, 158, 11", fillA: 0.28, label: "FVG" },
            ob:    { color: "#06b6d4", rgb: "6, 182, 212",  fillA: 0.28, label: "OB"  },
            sweep: { color: "#a855f7", rgb: "168, 85, 247", fillA: 0.20, label: "LIQUIDITY SWEEP" },
            level: { color: "#9ca3af", rgb: "156, 163, 175", fillA: 0.18, label: "LEVEL" },
          } as const)[lvl.kind] ?? { color: "#9ca3af", rgb: "156, 163, 175", fillA: 0.18, label: "LEVEL" };

          overlay.appendChild(make("rect", {
            x: startX, y: top, width: rightX - startX, height: h,
            fill: `rgba(${meta.rgb}, ${meta.fillA})`,
            stroke: `rgba(${meta.rgb}, 0.85)`, "stroke-width": 1.5,
            "stroke-dasharray": lvl.kind === "sweep" ? "4 3" : "0",
          }));
          drawTag(startX + 4, top, (lvl.label ?? meta.label).toUpperCase(), meta.color);
        }
      }
    }

    redraw();
    const ts = chart.timeScale();
    ts.subscribeVisibleTimeRangeChange(redraw);
    ts.subscribeVisibleLogicalRangeChange(redraw);
    const ro = new ResizeObserver(redraw);
    ro.observe(container);
    return () => {
      ts.unsubscribeVisibleTimeRangeChange(redraw);
      ts.unsubscribeVisibleLogicalRangeChange(redraw);
      ro.disconnect();
      while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
    };
  }, [signals, candles]);

  return (
    <div className="relative w-full">
      <div ref={containerRef} className="w-full h-[clamp(300px,55dvh,700px)]" data-testid="chart-canvas" />
      <svg
        ref={overlayRef}
        className="absolute inset-0 pointer-events-none"
        style={{ overflow: "visible" }}
      />
    </div>
  );
}

function SignalLegendCard({ signal }: { signal: Signal }) {
  const dirColor = signal.direction === "buy" ? "text-green-400 border-green-400/40" : "text-red-400 border-red-400/40";
  const Icon = signal.direction === "buy" ? ArrowUp : ArrowDown;
  const conceptList = (signal.concepts ?? "")
    .split(",").map((c) => c.trim()).filter(Boolean);
  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={cn("gap-1 font-mono-numbers", dirColor)}>
            <Icon className="w-3 h-3" />
            {signal.direction.toUpperCase()}
          </Badge>
          <span className="font-semibold text-sm">{signal.symbol}</span>
        </div>
        <Badge variant="outline" className="font-mono-numbers text-[11px]">
          {(signal.confidence * 100).toFixed(0)}% confidence
        </Badge>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        <div className="grid grid-cols-3 gap-2 font-mono-numbers">
          <Stat label="Entry" value={signal.entryZone} color="text-foreground" />
          <Stat label="Stop"  value={signal.stopZone ?? "—"} color="text-red-400" />
          <Stat label="Target" value={signal.targetZone ?? "—"} color="text-blue-400" />
        </div>
        {conceptList.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-1">
            {conceptList.map((c) => (
              <Badge key={c} variant="secondary" className="text-[10px] font-mono-numbers">{c}</Badge>
            ))}
          </div>
        )}
        {signal.reasoning && (
          <p className="text-xs text-muted-foreground italic pt-1 border-t border-border">
            "{signal.reasoning}"
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase text-muted-foreground tracking-wider">{label}</div>
      <div className={cn("text-xs", color)}>{value}</div>
    </div>
  );
}
