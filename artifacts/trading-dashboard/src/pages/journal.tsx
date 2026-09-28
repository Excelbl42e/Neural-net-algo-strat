import { useState, type FormEvent } from "react";
import {
  useListTradeReviews,
  useListTradePerformance,
  getListTradeReviewsQueryKey,
  getListTradePerformanceQueryKey,
  type TradeReview,
  type TradePerformance,
} from "@workspace/api-client-react";
import { ArrowLeft, ArrowRight, BookOpenText, ChartNoAxesCombined, FilterX, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 20;

function dateLabel(raw: string | null | undefined) {
  if (!raw) return "Not recorded";
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? "Invalid date" : date.toLocaleString();
}

function money(value: number | null | undefined) {
  if (value == null) return "Not recorded";
  return `${value < 0 ? "−" : value > 0 ? "+" : ""}$${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function percent(value: number | null | undefined) {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

export default function Journal() {
  const [input, setInput] = useState("");
  const [symbol, setSymbol] = useState("");
  const [offset, setOffset] = useState(0);
  const reviewParams = { limit: PAGE_SIZE, offset, ...(symbol ? { symbol } : {}) };
  const reviews = useListTradeReviews(reviewParams, { query: { queryKey: getListTradeReviewsQueryKey(reviewParams) } });
  const performance = useListTradePerformance(undefined, { query: { queryKey: getListTradePerformanceQueryKey() } });
  const reviewRows = reviews.data ?? [];
  const conceptRows = (performance.data ?? []).filter(row => row.dimension === "concept");
  const symbolRows = (performance.data ?? []).filter(row => row.dimension === "symbol");

  const search = (event: FormEvent) => {
    event.preventDefault();
    setOffset(0);
    setSymbol(input.trim());
  };

  return <div className="max-w-[1500px] space-y-8 pb-12">
    <header className="border-b border-border pb-5">
      <div className="flex items-center gap-2 text-primary text-[10px] font-mono-numbers uppercase tracking-[.24em] mb-2"><BookOpenText className="w-4 h-4" /> Research / Closed trades</div>
      <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Trade Journal <span className="text-muted-foreground font-normal">/ Learning Log</span></h1>
      <p className="text-sm text-muted-foreground mt-2 max-w-3xl leading-relaxed">Persisted reviews and performance for closed trades. Classifications reflect recorded evidence, not a retrained model or a prediction of future results.</p>
    </header>

    <section aria-labelledby="reviews-title" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div><div className="text-[10px] text-violet-300 uppercase tracking-widest font-mono-numbers mb-1">01 / Review history</div><h2 id="reviews-title" className="text-xl font-semibold">Closed-trade reviews</h2></div>
        <form onSubmit={search} className="flex gap-2 w-full sm:w-auto">
          <Input value={input} onChange={event => setInput(event.target.value)} placeholder="Filter by symbol" aria-label="Filter reviews by symbol" data-testid="input-journal-symbol" className="min-w-0 sm:w-48" />
          <Button type="submit" variant="outline" data-testid="button-filter-reviews">Filter</Button>
          {symbol && <Button type="button" variant="ghost" size="icon" title="Clear symbol filter" aria-label="Clear symbol filter" data-testid="button-clear-journal-filter" onClick={() => { setInput(""); setSymbol(""); setOffset(0); }}><FilterX className="w-4 h-4" /></Button>}
        </form>
      </div>
      {symbol && <p className="text-xs text-muted-foreground font-mono-numbers">Showing reviews for symbol: <span className="text-foreground">{symbol}</span></p>}
      {reviews.isLoading ? <div className="space-y-3"><Skeleton className="h-48 rounded-xl" /><Skeleton className="h-48 rounded-xl" /></div> :
        reviews.isError ? <StateCard title="Reviews unavailable" description="The review endpoint did not return data. No review history can be inferred from this state." retry={() => reviews.refetch()} /> :
        reviewRows.length === 0 ? <StateCard title={offset > 0 ? "No more reviews on this page" : "No closed-trade reviews yet"} description={symbol ? "No reviews matched this symbol on this page." : "When the server has persisted closed-trade reviews, they will appear here."} /> :
        <div className="space-y-3">{reviewRows.map(review => <ReviewCard key={review.id} review={review} />)}</div>}
      {!reviews.isLoading && !reviews.isError && (offset > 0 || reviewRows.length === PAGE_SIZE) &&
        <div className="flex items-center justify-between border-t border-border pt-3 text-xs font-mono-numbers">
          <Button variant="outline" size="sm" disabled={offset === 0 || reviews.isFetching} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} data-testid="button-journal-previous"><ArrowLeft className="w-3.5 h-3.5 mr-1" /> Previous</Button>
          <span className="text-muted-foreground">Rows {offset + 1}–{offset + reviewRows.length}</span>
          <Button variant="outline" size="sm" disabled={reviewRows.length < PAGE_SIZE || reviews.isFetching} onClick={() => setOffset(offset + PAGE_SIZE)} data-testid="button-journal-next">Next <ArrowRight className="w-3.5 h-3.5 ml-1" /></Button>
        </div>}
    </section>

    <section aria-labelledby="performance-title" className="space-y-4 border-t border-border pt-7">
      <div className="flex items-start gap-3"><ChartNoAxesCombined className="w-5 h-5 text-primary mt-1" /><div><div className="text-[10px] text-primary uppercase tracking-widest font-mono-numbers mb-1">02 / Observed history</div><h2 id="performance-title" className="text-xl font-semibold">Concept & symbol performance</h2><p className="text-xs text-muted-foreground mt-1">Sample-adjusted rates are supplied by the API. Small samples are not evidence of an edge.</p></div></div>
      {performance.isLoading ? <div className="grid gap-4 lg:grid-cols-2"><Skeleton className="h-56 rounded-xl" /><Skeleton className="h-56 rounded-xl" /></div> :
        performance.isError ? <StateCard title="Performance unavailable" description="The performance endpoint did not return data. No metrics are shown." retry={() => performance.refetch()} /> :
        <div className="grid gap-4 lg:grid-cols-2">
          <PerformanceTable title="Claimed concepts" rows={conceptRows} empty="No concept performance recorded." />
          <PerformanceTable title="Symbols" rows={symbolRows} empty="No symbol performance recorded." />
        </div>}
    </section>
  </div>;
}

function ReviewCard({ review }: { review: TradeReview }) {
  const sufficient = review.evidenceStatus === "sufficient";
  return <article className="rounded-xl border border-border bg-card overflow-hidden" data-testid={`card-review-${review.id}`}>
    <div className="p-4 md:p-5 border-b border-border/70 flex flex-wrap items-center justify-between gap-3 bg-muted/10">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-base">{review.symbol}</span>
        <Badge variant="outline" className="uppercase text-[10px] font-mono-numbers">{review.direction}</Badge>
        <Badge variant="outline" className={cn("uppercase text-[10px] font-mono-numbers", review.outcome === "win" ? "border-green-500/40 text-green-400" : review.outcome === "loss" ? "border-red-500/40 text-red-400" : "text-muted-foreground")}>{review.outcome}</Badge>
      </div>
      <div className="text-right"><div className={cn("font-mono-numbers text-sm font-semibold", (review.pnl ?? 0) < 0 ? "text-red-400" : (review.pnl ?? 0) > 0 ? "text-green-400" : "text-foreground")}>{money(review.pnl)}</div><div className="text-[10px] text-muted-foreground font-mono-numbers">Trade #{review.tradeId} · {dateLabel(review.closedAt)}</div></div>
    </div>
    <div className="p-4 md:p-5 grid gap-5 lg:grid-cols-[1.15fr_.85fr]">
      <div>
        <div className="text-[10px] uppercase tracking-widest text-muted-foreground font-mono-numbers">Classification / evidence</div>
        <div className="flex gap-2 items-center flex-wrap mt-2"><strong className="text-sm">{review.classification.replace(/_/g, " ")}</strong><Badge variant="outline" className={cn("text-[10px] uppercase", sufficient ? "text-green-400 border-green-500/30" : "text-amber-300 border-amber-500/30")}>{review.evidenceStatus} evidence</Badge></div>
        <p className="text-xs text-muted-foreground leading-relaxed mt-2">{review.evidenceSummary || "No evidence summary recorded."}</p>
        <p className="text-[10px] text-muted-foreground font-mono-numbers mt-2">{review.candlesExamined} candles examined</p>
        {review.reasoning && <div className="mt-4 border-t border-border pt-3"><div className="text-[10px] uppercase tracking-widest text-muted-foreground font-mono-numbers">Original reasoning</div><p className="text-xs leading-relaxed mt-1 text-foreground/80">{review.reasoning}</p></div>}
      </div>
      <div className="lg:border-l lg:border-border lg:pl-5 space-y-4">
        <div><div className="text-[10px] uppercase tracking-widest text-muted-foreground font-mono-numbers">Claimed concepts</div><div className="flex flex-wrap gap-1.5 mt-2">{review.claimedConcepts.length ? review.claimedConcepts.map((concept, i) => <Badge key={`${concept}-${i}`} variant="secondary" className="text-[10px]">{concept}</Badge>) : <span className="text-xs text-muted-foreground">None recorded</span>}</div></div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs font-mono-numbers">{[["Entry", review.entryPrice], ["Stop", review.stopPrice], ["Target", review.targetPrice], ["Close", review.closePrice]].map(([label, value]) => <div key={label as string}><div className="text-[10px] uppercase text-muted-foreground mb-1">{label}</div><div>{value == null ? "—" : value}</div></div>)}</div>
        <div className="text-[10px] text-muted-foreground">Strategy recorded: <span className="text-foreground">{review.strategy}</span></div>
      </div>
    </div>
  </article>;
}

function PerformanceTable({ title, rows, empty }: { title: string; rows: TradePerformance[]; empty: string }) {
  return <div className="rounded-xl border border-border bg-card overflow-hidden">
    <div className="px-4 py-3 border-b border-border bg-muted/10 flex justify-between"><h3 className="font-semibold text-sm">{title}</h3><span className="text-xs text-muted-foreground font-mono-numbers">{rows.length} records</span></div>
    {rows.length === 0 ? <p className="p-6 text-sm text-muted-foreground">{empty}</p> :
      <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono-numbers border-b border-border"><th className="px-4 py-3 font-normal">{title === "Symbols" ? "Symbol" : "Concept"}</th><th className="px-3 py-3 font-normal text-right">Trades</th><th className="px-3 py-3 font-normal text-right">W / L</th><th className="px-3 py-3 font-normal text-right">Win rate</th><th className="px-3 py-3 font-normal text-right">Adjusted</th><th className="px-4 py-3 font-normal text-right">P&L</th></tr></thead><tbody>{rows.map(row => <tr key={`${row.dimension}-${row.key}`} className="border-b border-border/60 last:border-0" data-testid={`row-performance-${row.dimension}-${row.key}`}><td className="px-4 py-3 font-medium min-w-28">{row.key}</td><td className="px-3 py-3 text-right font-mono-numbers">{row.tradeCount}</td><td className="px-3 py-3 text-right font-mono-numbers">{row.winCount} / {row.lossCount}</td><td className="px-3 py-3 text-right font-mono-numbers">{percent(row.winRate)}</td><td className="px-3 py-3 text-right font-mono-numbers text-primary">{percent(row.sampleAdjustedWinRate)}</td><td className={cn("px-4 py-3 text-right font-mono-numbers", row.totalPnl < 0 ? "text-red-400" : row.totalPnl > 0 ? "text-green-400" : "")}>{money(row.totalPnl)}</td></tr>)}</tbody></table></div>}
  </div>;
}

function StateCard({ title, description, retry }: { title: string; description: string; retry?: () => void }) {
  return <div className="rounded-xl border border-dashed border-border bg-card/40 p-8 text-center"><BookOpenText className="w-7 h-7 text-muted-foreground mx-auto mb-3" /><h3 className="font-semibold text-sm">{title}</h3><p className="text-xs text-muted-foreground mt-1">{description}</p>{retry && <Button variant="outline" size="sm" className="mt-4" onClick={retry}><RefreshCw className="w-3.5 h-3.5 mr-2" />Retry</Button>}</div>;
}