import { type ReactNode } from "react";
import { Sidebar } from "./sidebar";
import { useQuery } from "@tanstack/react-query";
import { useGetDashboardOverview, useListAccounts, useListTrades, getGetDashboardOverviewQueryKey } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";

export interface SystemStatus {
  status: string;
  bot: { enabled: boolean; mode: string; reason: string };
  executionLock: { locked: boolean; reason: string | null };
  hosting: { deploymentTarget: string; alwaysOn: boolean };
  components: Array<{ name: string; status: string; reason: string }>;
}

export function AppLayout({ children }: { children: ReactNode }) {
  const { data: sys } = useQuery<SystemStatus>({
    queryKey: ["system-status"],
    queryFn: async () => { const r = await fetch("/api/system/status", { cache: "no-store" }); if (!r.ok) throw new Error(String(r.status)); return r.json(); },
    refetchInterval: 15000,
  });
  const { data: overview } = useGetDashboardOverview({ query: { queryKey: getGetDashboardOverviewQueryKey(), refetchInterval: 15000 } });
  const { data: accounts } = useListAccounts();
  const { data: recentTrades } = useListTrades({ limit: 1 });
  const pnlPositive = (overview?.dailyPnl ?? 0) >= 0;
  const hasAccounts = (overview?.accountCount ?? 0) > 0 || (accounts?.length ?? 0) > 0;
  const accountsChecked = (overview?.accountCount ?? 0) > 0 || accounts !== undefined;
  const hasTradeEvidence = !!overview?.lastTradeAt || (overview?.openTrades ?? 0) > 0 || (recentTrades?.length ?? 0) > 0;
  const tradesChecked = !!overview && (!!overview.lastTradeAt || overview.openTrades > 0 || recentTrades !== undefined);
  const tradeMetric = (value: string) => !overview || !tradesChecked ? "—" : hasTradeEvidence ? value : "No trades";

  // Determine trading mode banner: any ACTIVE live/prop account = LIVE warning,
  // otherwise any ACTIVE demo account = DEMO confirmation.
  const activeAccounts = (accounts ?? []).filter((a) => a.status === "active");
  const hasLive = activeAccounts.some((a) => a.accountType === "live" || a.accountType === "prop");
  const hasDemo = activeAccounts.some((a) => a.accountType === "demo");
  const mode: "live" | "demo" | null = hasLive ? "live" : hasDemo ? "demo" : null;

  return (
    <div className="flex flex-col md:flex-row min-h-[100dvh] w-full bg-background text-foreground selection:bg-primary/30">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        {sys && (
          <div
            className={cn(
              "px-4 py-1.5 text-xs font-mono-numbers border-b flex flex-wrap items-center gap-x-4 gap-y-1",
              sys.bot.mode === "auto_live" && sys.bot.enabled ? "bg-red-950 border-red-700 text-red-100"
                : sys.bot.enabled && sys.bot.mode !== "off" ? "bg-emerald-950 border-emerald-700 text-emerald-100"
                : "bg-muted border-border text-muted-foreground",
            )}
            data-testid="banner-bot-mode"
          >
            <span className="font-bold uppercase">Mode: {sys.bot.mode}</span>
            <span>{sys.bot.reason}</span>
            {sys.executionLock.locked && <span className="text-amber-300">Orders paused: {sys.executionLock.reason}</span>}
          </div>
        )}
        {sys && !sys.hosting.alwaysOn && sys.hosting.deploymentTarget === "deployment" && (
          <div role="alert" className="bg-amber-950 border-b border-amber-600 px-4 py-2 text-sm text-amber-100" data-testid="banner-not-always-on">
            Bot is not running 24/7 in this deployment. Use a Reserved VM deployment; autoscale sleeps and open positions go unmonitored.
          </div>
        )}
        {/* Trading mode banner — pinned above the status bar */}
        {mode === "live" && (
          <div className="h-7 bg-red-600 text-white flex items-center justify-center gap-3 text-xs font-bold uppercase tracking-wider shrink-0 border-b border-red-800">
            <span className="inline-block w-2 h-2 rounded-full bg-white animate-pulse" />
            Live account configured · Real money may be at risk
            <span className="font-mono-numbers font-normal opacity-80">
              {activeAccounts
                .filter((a) => a.accountType === "live" || a.accountType === "prop")
                .map((a) => `${a.name} (${a.accountType.toUpperCase()})`)
                .join(" · ")}
            </span>
          </div>
        )}
        {mode === "demo" && (
          <div className="h-7 bg-emerald-600 text-white flex items-center justify-center gap-3 text-xs font-bold uppercase tracking-wider shrink-0 border-b border-emerald-800">
            <span className="inline-block w-2 h-2 rounded-full bg-white" />
            Demo account configured
            <span className="font-mono-numbers font-normal opacity-80">
              {activeAccounts
                .filter((a) => a.accountType === "demo")
                .map((a) => a.name)
                .join(" · ")}
            </span>
          </div>
        )}

        {/* Top status bar */}
        <header className="min-h-12 border-b border-border bg-card flex items-center justify-between gap-5 px-4 md:px-6 shrink-0">
          <div className="flex items-center gap-5 text-xs font-mono-numbers text-muted-foreground overflow-x-auto">
            <StatusPill
              label="BOT"
              value={overview?.botStatus?.toUpperCase() || "UNKNOWN"}
              valueClass={overview?.botStatus === "running" ? "text-primary" : "text-yellow-400"}
            />
            <StatusPill label="OPEN TRADES" value={overview ? String(overview.openTrades) : "—"} />
            <StatusPill label="ACTIVE SIGNAL RECORDS" value={overview ? String(overview.activeSignals) : "—"} />
            <StatusPill
              label="WIN RATE"
              value={tradeMetric(overview?.winRate != null ? `${(overview.winRate * 100).toFixed(1)}%` : "—")}
            />
            <StatusPill
              label="DAILY P&L"
              value={tradeMetric(overview?.dailyPnl != null
                ? `${pnlPositive ? "+" : ""}$${overview.dailyPnl.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                : "—")}
              valueClass={hasTradeEvidence ? pnlPositive ? "text-green-400" : "text-red-400" : undefined}
            />
            <StatusPill
              label="DRAWDOWN"
              value={tradeMetric(overview?.maxDrawdown != null ? `${(overview.maxDrawdown * 100).toFixed(2)}%` : "—")}
              valueClass={hasTradeEvidence ? "text-orange-400" : undefined}
            />
          </div>
          <div className="flex flex-col items-end font-mono-numbers shrink-0">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Total Equity</span>
            <span className="text-sm font-bold text-primary">
              {!overview || !accountsChecked ? "—" : hasAccounts ? `$${overview.totalEquity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "No account"}
            </span>
          </div>
        </header>

        {/* Scrollable page content */}
        <main className="flex-1 overflow-y-auto overflow-x-hidden bg-background">
          <div className="p-4 md:p-6 min-h-full">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

function StatusPill({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <span className="text-muted-foreground/60">{label}:</span>
      <span className={cn("text-foreground font-medium", valueClass)}>{value}</span>
    </div>
  );
}
