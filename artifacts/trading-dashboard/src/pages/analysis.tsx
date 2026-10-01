import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useRunAnalysis, useGetWorkerStatus, getGetWorkerStatusQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader2, ScanSearch, AlertCircle, CheckCircle2, Crosshair, Plug } from "lucide-react";
import { cn } from "@/lib/utils";

const TIMEFRAMES = ["M5", "M15", "M30", "H1", "H4", "D1"];

interface Rejection {
  at: string;
  symbol: string;
  stage: "poll" | "pre_gpt" | "no_tick" | "expert_judge" | "post_gpt" | "portfolio" | "sizing" | "entry" | "execution" | "forex_readiness";
  reason: string;
  metrics?: Record<string, unknown>;
}

/**
 * Plain-language name for each pipeline stage. `pre_gpt`, `expert_judge` and
 * `post_gpt` are the retired ICT pipeline, kept so stored entries still render.
 */
const STAGE_LABEL: Record<Rejection["stage"], string> = {
  poll: "Strategy poll",
  no_tick: "No price tick",
  pre_gpt: "Quant pre-filter (retired)",
  expert_judge: "ICT judge (retired)",
  post_gpt: "Geometry check (retired)",
  portfolio: "Portfolio caps",
  sizing: "Risk sizing",
  entry: "Entry timing",
  forex_readiness: "Market readiness",
  execution: "Execution",
};

const STATUS_META: Record<string, { color: string; icon: React.ReactNode; title: string }> = {
  no_data: {
    color: "border-amber-400 text-amber-400",
    icon: <Loader2 className="w-4 h-4 animate-spin" />,
    title: "Strategy library not seeded yet",
  },
  brain_warming: {
    color: "border-amber-400 text-amber-400",
    icon: <Plug className="w-4 h-4" />,
    title: "No connected broker",
  },
  ready: {
    color: "border-green-500 text-green-500",
    icon: <CheckCircle2 className="w-4 h-4" />,
    title: "Analysis ready",
  },
};

export default function AnalysisPage() {
  const [symbol, setSymbol] = useState("");
  const [timeframe, setTimeframe] = useState("H1");
  const run = useRunAnalysis();
  const { data: workerStatus } = useGetWorkerStatus({ query: { refetchInterval: 10000, queryKey: getGetWorkerStatusQueryKey() } });
  // The scan loop runs every 30 minutes. The endpoint to run one on demand
  // existed but nothing called it, so waiting out the interval was the only
  // way to see the effect of a config change.
  const runScan = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/brain/generate-signals", { method: "POST" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<{ started: boolean; message: string }>;
    },
    onSuccess: () => {
      // Give the tick a moment to record its refusals, then show them.
      setTimeout(() => { void rejections.refetch(); }, 4000);
    },
  });
  const ws = (workerStatus ?? {}) as { scheduled?: boolean; stalled?: boolean; nextRunAt?: string | null };
  const nextRun = ws.nextRunAt ? new Date(ws.nextRunAt) : null;
  const minsToNext = nextRun ? Math.max(0, Math.round((nextRun.getTime() - Date.now()) / 60000)) : null;
  // Every refusal is already recorded server-side; until now the only way to
  // read it was to request the endpoint by hand, which left "why has it not
  // traded?" — the question that actually matters — unanswerable from the app.
  const rejections = useQuery<Rejection[]>({
    queryKey: ["system-rejections"],
    queryFn: async () => {
      const r = await fetch("/api/system/rejections", { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    },
    refetchInterval: 15000,
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!symbol.trim()) return;
    run.mutate({ data: { symbol: symbol.trim(), timeframe } });
  };

  const r = run.data;
  const meta = r ? STATUS_META[r.status] : null;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between border-b border-border pb-4">
        <div>
          <h1 className="text-2xl font-bold uppercase tracking-wider">On-Demand Analysis</h1>
          <p className="text-xs text-muted-foreground font-mono-numbers mt-1 uppercase tracking-wider">
            Check the analysis endpoint for a symbol; this does not place an order
          </p>
        </div>
      </div>

      {/* Worker Status Bar */}
      {workerStatus && (
        <div className="border border-violet-500/20 bg-violet-500/5 rounded-lg p-3 flex items-center gap-4 text-[11px] font-mono-numbers">
          {/* Between ticks the worker is idle by design, which is not the same
              as stopped. "IDLE" for 29 of every 30 minutes read like a fault. */}
          <div className={cn("flex items-center gap-1.5", ws.stalled ? "text-amber-300" : ws.scheduled ? "text-violet-300" : "text-muted-foreground")}>
            <span className={cn("w-2 h-2 rounded-full", workerStatus.running ? "bg-violet-400 animate-pulse" : ws.stalled ? "bg-amber-400" : ws.scheduled ? "bg-violet-400" : "bg-muted-foreground/40")} />
            <span className="uppercase tracking-wider font-bold">
              {workerStatus.running ? "SCANNING NOW" : ws.stalled ? "SCAN OVERDUE" : ws.scheduled ? "SCHEDULED" : "STOPPED"}
            </span>
          </div>
          {ws.scheduled && !workerStatus.running && minsToNext != null && (
            <>
              <span className="text-muted-foreground/60">|</span>
              <span className="text-muted-foreground">Next scan in <span className="text-foreground">~{minsToNext} min</span></span>
            </>
          )}
          <span className="text-muted-foreground/60">|</span>
          <span className="text-muted-foreground">Signals generated (worker counter, not dispatched): <span className="text-foreground">{workerStatus.signalsGeneratedTotal}</span></span>
          <span className="text-muted-foreground/60">|</span>
          <span className="text-muted-foreground">Interval: <span className="text-foreground">{Math.round((workerStatus.intervalMs ?? 300000) / 60000)}min</span></span>
          {workerStatus.lastRunAt && (
            <>
              <span className="text-muted-foreground/60">|</span>
              <span className="text-muted-foreground">Last run: <span className="text-foreground">{new Date(workerStatus.lastRunAt).toLocaleTimeString()}</span></span>
            </>
          )}
          {workerStatus.lastError && (
            <span className="text-red-400 ml-auto truncate max-w-[200px]">Error: {workerStatus.lastError}</span>
          )}
        </div>
      )}

      {/* Why nothing traded: the recorded refusal reasons, newest first. */}
      <Card className="border-border" data-testid="card-rejections">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="uppercase tracking-wider text-sm flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-primary" /> Why no trade was placed
            </CardTitle>
            <div className="flex items-center gap-2">
              {runScan.data && (
                <span className="text-[11px] text-muted-foreground" data-testid="text-scan-result">{runScan.data.message}</span>
              )}
              {runScan.isError && <span className="text-[11px] text-amber-300">Could not start a scan.</span>}
              <Button size="sm" variant="outline" disabled={runScan.isPending} onClick={() => runScan.mutate()} data-testid="button-run-scan">
                {runScan.isPending ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Scanning…</> : "Run scan now"}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-[11px] text-muted-foreground mb-3">
            Each scan records the exact gate that dropped a symbol, and approved signals report here while they wait for
            price to retrace into their entry zone. The same refusal for the same pair is recorded once per 10 minutes, so
            a rescan with nothing new adds nothing new. The last 200 are kept.
          </p>
          {rejections.isLoading ? (
            <div className="text-xs text-muted-foreground">Loading…</div>
          ) : rejections.isError ? (
            <div className="text-xs text-amber-300">Could not read the refusal log — treat "no trades" as unexplained.</div>
          ) : (rejections.data ?? []).length === 0 ? (
            <div className="text-xs text-muted-foreground" data-testid="text-no-rejections">
              Nothing recorded yet. If the worker has run and no signal was produced, no symbol reached a gate that
              refuses — check the Overview health panel first.
            </div>
          ) : (
            <div className="space-y-1.5 max-h-80 overflow-y-auto">
              {(rejections.data ?? []).slice(0, 40).map((r, i) => (
                <div key={`${r.at}-${i}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-t border-border/60 pt-1.5 text-[11px]" data-testid={`rejection-${i}`}>
                  <span className="font-mono-numbers text-muted-foreground shrink-0">{new Date(r.at).toLocaleTimeString()}</span>
                  <span className="font-mono-numbers text-foreground shrink-0">{r.symbol}</span>
                  <span className="text-primary shrink-0">{STAGE_LABEL[r.stage] ?? r.stage}</span>
                  <span className="text-muted-foreground break-words min-w-0 flex-1">{r.reason}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-border">
        <CardHeader className="pb-3">
          <CardTitle className="uppercase tracking-wider text-sm flex items-center gap-2">
            <ScanSearch className="w-4 h-4 text-primary" /> Check status
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="grid grid-cols-1 md:grid-cols-[1fr,140px,160px] gap-3 items-end">
            <div className="space-y-1">
              <label className="text-xs uppercase font-mono-numbers tracking-wider text-muted-foreground">Symbol</label>
              <Input
                placeholder="EURUSD, XAUUSD, BTCUSD..."
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                data-testid="input-symbol"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs uppercase font-mono-numbers tracking-wider text-muted-foreground">Timeframe</label>
              <Select value={timeframe} onValueChange={setTimeframe}>
                <SelectTrigger data-testid="select-timeframe"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TIMEFRAMES.map(tf => <SelectItem key={tf} value={tf}>{tf}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={!symbol.trim() || run.isPending} data-testid="button-run-analysis">
              {run.isPending ? <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Analyzing...</> : <>Analyze</>}
            </Button>
          </form>
        </CardContent>
      </Card>

      {run.isError && (
        <Card className="border-destructive/50">
          <CardContent className="p-4 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
            <div className="text-sm">Request failed: {(run.error as Error).message}</div>
          </CardContent>
        </Card>
      )}

      {r && meta && (
        <Card className={`border ${meta.color.replace("text-", "border-")}`} data-testid="card-analysis-result">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                {meta.icon}
                {meta.title}
              </CardTitle>
              <Badge variant="outline" className={`uppercase text-[10px] gap-1 ${meta.color}`}>
                {r.symbol} · {r.timeframe}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm leading-relaxed">{r.message}</p>

            <div className="grid grid-cols-2 gap-3 pt-2 border-t border-border">
              <Stat icon={<Crosshair className="w-3 h-3" />} label="Active Strategies" value={r.activeStrategies ?? 0} />
              <Stat icon={<Plug className="w-3 h-3" />} label="Connected Brokers" value={r.connectedBrokers ?? 0} />
            </div>

            {r.status === "no_data" && (
              <div className="text-[11px] text-muted-foreground font-mono-numbers p-3 bg-muted/30 rounded border border-border">
                The hardcoded strategy library seeds itself automatically on server boot. If this persists, the server hasn't finished starting up.
              </div>
            )}
            {r.status === "brain_warming" && (
              <NextStep label="Open Brokers" href="/brokers" hint="Connect and enable a Deriv account so the signal worker has somewhere to trade." />
            )}
            {r.status === "ready" && (
              <div className="text-[11px] text-muted-foreground font-mono-numbers p-3 bg-muted/30 rounded border border-border">
                This confirms readiness only. The signal worker scans on its own interval — see the worker status bar above.
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {!r && !run.isPending && (
        <Card className="border-border bg-card/50">
          <CardContent className="p-6 text-center text-muted-foreground">
            <ScanSearch className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">Enter a symbol to check the current analysis endpoint status.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] text-muted-foreground uppercase font-mono-numbers tracking-wider flex items-center gap-1">
        {icon} {label}
      </div>
      <div className="text-lg font-bold font-mono-numbers">{value}</div>
    </div>
  );
}

function NextStep({ label, href, hint }: { label: string; href: string; hint: string }) {
  return (
    <a href={href} className="block p-3 bg-primary/5 border border-primary/20 rounded hover:bg-primary/10 transition-colors">
      <div className="text-sm font-bold text-primary">→ {label}</div>
      <div className="text-[11px] text-muted-foreground mt-0.5">{hint}</div>
    </a>
  );
}
