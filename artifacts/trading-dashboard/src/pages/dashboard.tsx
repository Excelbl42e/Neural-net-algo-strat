import { Link } from "wouter";
import { Activity, ArrowUpRight, CandlestickChart, Crosshair, HeartPulse, Radio, ShieldAlert, Workflow } from "lucide-react";
import {
  useGetWorkerStatus, getGetWorkerStatusQueryKey,
  useGetCandleFeederStatus, getGetCandleFeederStatusQueryKey,
  useListStrategies, useListSignals, useListBrokerConnections,
} from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { SystemStatus } from "@/components/layout/app-layout";

/** ok / degraded / down / idle -> dot colour + label colour. */
const HEALTH_STYLE: Record<string, { dot: string; text: string }> = {
  ok: { dot: "bg-emerald-400", text: "text-emerald-300" },
  degraded: { dot: "bg-amber-400", text: "text-amber-300" },
  down: { dot: "bg-red-500", text: "text-red-300" },
  idle: { dot: "bg-muted-foreground/50", text: "text-muted-foreground" },
};

/** signal_judge -> Signal judge, ai -> AI */
const NAME_OVERRIDES: Record<string, string> = { ai: "AI (unused)" };
const humanize = (name: string) => {
  if (NAME_OVERRIDES[name]) return NAME_OVERRIDES[name]!;
  const spaced = name.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

export default function Dashboard() {
  const worker = useGetWorkerStatus({ query: { queryKey: getGetWorkerStatusQueryKey(), refetchInterval: 10000 } });
  const feeder = useGetCandleFeederStatus({ query: { queryKey: getGetCandleFeederStatusQueryKey(), refetchInterval: 10000 } });
  const strategies = useListStrategies();
  const signals = useListSignals();
  const brokers = useListBrokerConnections();
  // Same endpoint the layout already polls for the mode banner — it carries a
  // per-component health list that was being fetched and then discarded, which
  // left "is the system actually ready?" answerable only from DevTools.
  const system = useQuery<SystemStatus>({
    queryKey: ["system-status"],
    queryFn: async () => { const r = await fetch("/api/system/status", { cache: "no-store" }); if (!r.ok) throw new Error(String(r.status)); return r.json(); },
    refetchInterval: 15000,
  });
  const loading = [worker, feeder, strategies, signals, brokers].some(q => q.isLoading);
  const failed = [worker, feeder, strategies, signals, brokers].some(q => q.isError);
  const activeStrategies = strategies.data?.filter(s => s.active).length;
  const activeSignals = signals.data?.filter(s => s.status === "active").length;
  const connectedBrokers = brokers.data?.filter(b => b.status === "connected" && b.enabled).length;

  return <div className="space-y-7 pb-10 max-w-[1500px]">
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-5">
      <div>
        <div className="text-[10px] tracking-[.24em] uppercase text-primary font-mono-numbers mb-2">Operations / Overview</div>
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Trading system status</h1>
        <p className="text-sm text-muted-foreground mt-2">Observed API state, not an execution guarantee. Signals and orders are separate records.</p>
      </div>
      <Link href="/signals" data-testid="link-dashboard-signals" className="text-xs text-primary border border-primary/30 rounded px-3 py-2 hover:bg-primary/10 flex gap-2 items-center">Inspect signals <ArrowUpRight className="w-3.5 h-3.5" /></Link>
    </header>
    {loading ? <div className="grid gap-3 md:grid-cols-3"><Skeleton className="h-40" /><Skeleton className="h-40" /><Skeleton className="h-40" /></div> :
      failed ? <div className="border border-amber-500/30 rounded-lg p-6 text-sm text-amber-200">Some operational data is unavailable. Do not infer system readiness from partial status. <button className="underline ml-2" onClick={() => { worker.refetch(); feeder.refetch(); strategies.refetch(); signals.refetch(); brokers.refetch(); }}>Retry</button></div> :
      <>
        <section className="grid gap-3 md:grid-cols-[1.1fr_1fr_1fr]">
          <StatusPanel icon={<Crosshair className="w-5 h-5" />} label="Strategy library" value={`${activeStrategies ?? 0} active`} detail="Hardcoded ICT + quant/TA strategies, seeded on boot" href="/strategy" />
          <StatusPanel icon={<Activity className="w-5 h-5" />} label="Signal worker" value={worker.data?.running ? "Running" : "Not running"} detail={`${worker.data?.signalsGeneratedTotal ?? 0} generated (worker counter) · ${activeSignals ?? 0} active records`} href="/analysis" />
          <StatusPanel icon={<Radio className="w-5 h-5" />} label="Deriv connectivity" value={`${connectedBrokers ?? 0} broker connections`} detail={`Candle feeder: ${feeder.data?.connected ? "connected" : "disconnected"} · ${feeder.data?.symbols.length ?? 0} subscribed symbols`} href="/brokers" />
        </section>
        <section className="rounded-xl border border-border bg-card p-5 md:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-primary font-mono-numbers text-[11px] tracking-widest uppercase">
              <HeartPulse className="w-4 h-4" /> System health
            </div>
            {system.data && (
              <span
                className={cn(
                  "text-[11px] font-mono-numbers uppercase tracking-wider px-2 py-0.5 rounded border",
                  system.data.status === "ok" ? "border-emerald-500/40 text-emerald-300"
                    : system.data.status === "degraded" ? "border-amber-500/40 text-amber-300"
                    : "border-red-500/40 text-red-300",
                )}
                data-testid="badge-system-status"
              >
                {system.data.status === "ok" ? "All systems go" : system.data.status}
              </span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground mt-2">
            Live component check, refreshed every 15s. Before funding or switching to live, the ones that matter are
            <span className="text-foreground"> signal judge</span>,<span className="text-foreground"> candle feed</span> and
            <span className="text-foreground"> news calendar</span> — a stalled feed or an unreachable calendar stops trades
            entirely.
          </p>
          {system.isLoading ? <Skeleton className="h-28 mt-4" /> : system.data ? (
            <div className="mt-4 grid gap-x-6 gap-y-2 md:grid-cols-2">
              {system.data.components.map((c) => {
                const style = HEALTH_STYLE[c.status] ?? HEALTH_STYLE.idle!;
                return (
                  <div key={c.name} className="flex items-start gap-2.5 border-t border-border/60 pt-2 min-w-0" data-testid={`health-${c.name}`}>
                    <span className={cn("w-2 h-2 rounded-full mt-1.5 shrink-0", style.dot)} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-xs font-medium">{humanize(c.name)}</span>
                        <span className={cn("text-[10px] font-mono-numbers uppercase tracking-wider shrink-0", style.text)}>{c.status}</span>
                      </div>
                      <div className="text-[11px] text-muted-foreground leading-snug break-words">{c.reason}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="mt-4 text-xs text-amber-300">Could not read system status — treat readiness as unknown.</div>
          )}
        </section>

        <section className="grid gap-3 lg:grid-cols-[1.35fr_1fr]">
          <div className="rounded-xl border border-violet-500/25 bg-violet-500/[.04] p-5 md:p-7">
            <div className="flex items-center gap-2 text-violet-300 font-mono-numbers text-[11px] tracking-widest uppercase"><Workflow className="w-4 h-4" /> What happens next</div>
            <div className="mt-5 space-y-0">
              {[
                ["01", "Strategy library", "The hardcoded ICT + quant/TA strategy list feeds the signal prompt directly — no upload or processing step.", "/strategy"],
                ["02", "Analyze", "The worker generates signal records from available market data and the strategy library.", "/analysis"],
                ["03", "Review", "A generated signal is not proof that an order was sent or filled. Verify trades and broker state independently.", "/signals"],
              ].map(([n, title, body, href]) => <Link key={n} href={href} className="group flex gap-5 border-t border-border/70 py-4" data-testid={`link-stage-${n}`}>
                <span className="font-mono-numbers text-primary text-xs">{n}</span>
                <span className="flex-1"><strong className="block text-sm">{title}</strong><span className="text-xs text-muted-foreground leading-relaxed">{body}</span></span>
                <ArrowUpRight className="w-4 h-4 text-muted-foreground group-hover:text-primary shrink-0" />
              </Link>)}
            </div>
          </div>
          <div className="rounded-xl border border-primary/20 bg-primary/[.035] p-5 md:p-7 flex flex-col">
            <div className="flex gap-2 items-center text-primary text-[11px] font-mono-numbers uppercase tracking-widest"><ShieldAlert className="w-4 h-4" /> Execution boundary</div>
            <h2 className="text-xl font-semibold mt-5">No order controls here.</h2>
            <p className="text-sm leading-relaxed text-muted-foreground mt-2">The dashboard does not expose a safe manual dispatch endpoint. “Executed” on a signal is a record status, not independent broker fill confirmation. Review the trade ledger and your Deriv account before making financial decisions.</p>
            <div className="mt-auto pt-7 flex flex-wrap gap-2">
              <Link href="/trades" className="border border-primary/30 rounded px-3 py-2 text-xs text-primary hover:bg-primary/10" data-testid="link-dashboard-trades">Open trade ledger</Link>
              <Link href="/chart" className="border border-border rounded px-3 py-2 text-xs text-muted-foreground hover:text-foreground flex gap-2 items-center" data-testid="link-dashboard-chart"><CandlestickChart className="w-3.5 h-3.5" /> Price chart</Link>
            </div>
          </div>
        </section>
        {(worker.data?.lastError || feeder.data?.lastError) && <div className="border border-red-500/30 bg-red-500/5 rounded-lg p-4 text-xs text-red-300 font-mono-numbers">Latest errors: {[worker.data?.lastError, feeder.data?.lastError].filter(Boolean).join(" · ")}</div>}
      </>
    }
  </div>;
}

function StatusPanel({ icon, label, value, detail, href }: { icon: React.ReactNode; label: string; value: string; detail: string; href: string }) {
  return <Link href={href} className="group min-w-0 border border-border rounded-xl bg-card p-5 hover:border-primary/40 transition-colors" data-testid={`link-status-${href.slice(1)}`}>
    <div className="flex justify-between text-primary">{icon}<ArrowUpRight className="w-4 h-4 opacity-50 group-hover:opacity-100" /></div>
    <div className="mt-7 text-[10px] text-muted-foreground uppercase tracking-widest font-mono-numbers">{label}</div>
    <div className="mt-1 text-lg font-semibold">{value}</div>
    <div className="text-[11px] text-muted-foreground mt-1">{detail}</div>
  </Link>;
}