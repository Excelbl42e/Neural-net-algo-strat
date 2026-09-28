import { Link, useLocation } from "wouter";
import {
  Activity,
  Zap,
  CandlestickChart,
  Crosshair,
  Wallet,
  BarChart3,
  History,
  Terminal,
  Plug,
  ScanSearch,
  Settings,
  BookOpenText,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useHealthCheck } from "@workspace/api-client-react";

export function Sidebar() {
  const [location] = useLocation();
  const { data: health } = useHealthCheck();

  const links = [
    { href: "/", label: "Overview", icon: Activity },
    { href: "/analysis", label: "Analysis", icon: ScanSearch },
    { href: "/signals", label: "Signals", icon: Zap },
    { href: "/chart", label: "Chart", icon: CandlestickChart },
    { href: "/strategy", label: "Strategy", icon: Crosshair },
    { href: "/brokers", label: "Brokers", icon: Plug },
    { href: "/accounts", label: "Accounts", icon: Wallet },
    { href: "/trades", label: "Trades", icon: History },
    { href: "/journal", label: "Trade Journal", icon: BookOpenText },
    { href: "/reports", label: "Reports", icon: BarChart3 },
    { href: "/configuration", label: "Configuration", icon: Settings },
  ];

  return (
    <div className="w-full md:w-60 border-b md:border-b-0 md:border-r border-border bg-card flex flex-col md:min-h-[100dvh] shrink-0">
      {/* Brand */}
      <div className="p-3 md:p-4 border-b border-border">
        <div className="flex items-center gap-2">
          <Terminal className="w-5 h-5 text-primary shrink-0" />
          <span className="font-bold text-base tracking-tight uppercase">NeuralTrade</span>
        </div>
        <div className="mt-2 hidden md:flex flex-col gap-1">
          <StackBadge color="text-fuchsia-400 border-fuchsia-400/30 bg-fuchsia-400/5" label="Node" sublabel="Signal worker / Deriv client" />
          <StackBadge color="text-primary border-primary/30 bg-primary/5" label="React" sublabel="Control panel" />
        </div>
      </div>

      {/* Nav */}
      <div className="flex-1 overflow-x-auto md:overflow-y-auto py-2 md:py-4">
        <nav className="flex md:block gap-1 md:space-y-0.5 px-2 w-max md:w-auto">
          {links.map((link) => {
            const active = location === link.href;
            const Icon = link.icon;
            return (
              <Link
                key={link.href}
                href={link.href}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors whitespace-nowrap",
                  active
                    ? "bg-primary/10 text-primary border border-primary/20"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                )}
              >
                <Icon className={cn("w-4 h-4 shrink-0", active ? "text-primary" : "text-muted-foreground")} />
                {link.label}
              </Link>
            );
          })}
        </nav>
      </div>

      {/* API status */}
      <div className="hidden md:flex p-4 border-t border-border items-center justify-between text-xs font-mono-numbers">
        <div className="flex items-center gap-2">
          <div className={cn(
            "w-2 h-2 rounded-full",
            health?.status === "ok" ? "bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.7)]" : "bg-red-500 animate-pulse"
          )} />
          <span className="text-muted-foreground">API STATUS</span>
        </div>
        <span className={health?.status === "ok" ? "text-green-400" : "text-red-400"}>
          {health?.status === "ok" ? "ONLINE" : health ? "ERR" : "UNKNOWN"}
        </span>
      </div>
    </div>
  );
}

function StackBadge({ color, label, sublabel }: { color: string; label: string; sublabel: string }) {
  return (
    <div className={cn("flex items-center gap-2 px-2 py-1 rounded border text-[10px] font-mono-numbers", color)}>
      <span className="font-bold">{label}</span>
      <span className="text-muted-foreground/60">—</span>
      <span className="text-muted-foreground/80">{sublabel}</span>
    </div>
  );
}
