import { useMemo, useState } from "react";
import { useListStrategies } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronDown, ChevronRight, Layers3 } from "lucide-react";
import { cn } from "@/lib/utils";

export default function StrategyPage() {
  const { data: strategies, isLoading, isError } = useListStrategies();
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const ict = useMemo(() => (strategies ?? []).filter((s) => s.type === "ict").sort((a, b) => a.name.localeCompare(b.name)), [strategies]);
  const quant = useMemo(() => (strategies ?? []).filter((s) => s.type === "quant").sort((a, b) => a.name.localeCompare(b.name)), [strategies]);
  const other = useMemo(() => (strategies ?? []).filter((s) => s.type !== "ict" && s.type !== "quant"), [strategies]);

  return (
    <div className="max-w-5xl space-y-6 pb-8">
      <header className="border-b border-border pb-5">
        <div className="text-primary text-[10px] uppercase tracking-[.24em] font-mono-numbers mb-2">Strategy Library</div>
        <h1 className="text-2xl font-bold">Hardcoded ICT + quant/TA strategies</h1>
        <p className="text-sm text-muted-foreground mt-2 max-w-2xl">
          Curated once in code, not scanned from uploaded books. Every concept below is individually gated by real closed-trade
          performance — a concept with a poor historical win rate is automatically suppressed from future signals until its
          sample-adjusted score recovers. While no AI budget is configured, the signal worker runs a deterministic expert-system
          judge instead of GPT, which only ever fires on 4 of these entries (Liquidity Sweep, MSS, FVG, 2022 Entry Model) — the
          rest stay listed and scored, ready for when GPT is reconnected.
        </p>
      </header>

      {isLoading ? (
        <Skeleton className="h-60 w-full" />
      ) : isError || !strategies || strategies.length === 0 ? (
        <div className="border border-dashed border-border rounded-xl p-8 text-center">
          <Layers3 className="w-6 h-6 text-violet-400 mb-4 mx-auto" />
          <h2 className="font-semibold">No strategies loaded</h2>
          <p className="text-sm text-muted-foreground mt-1">
            The library seeds itself automatically on server boot. If this persists, the server hasn't finished starting up.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          <StrategyGroup
            label="ICT / Smart Money Concepts"
            badgeClass="text-violet-300 border-violet-400/30 bg-violet-400/5"
            items={ict}
            expandedId={expandedId}
            setExpandedId={setExpandedId}
          />
          <StrategyGroup
            label="Technical Analysis / Quant"
            badgeClass="text-primary border-primary/30 bg-primary/5"
            items={quant}
            expandedId={expandedId}
            setExpandedId={setExpandedId}
          />
          {other.length > 0 && (
            <StrategyGroup
              label="Other"
              badgeClass="text-muted-foreground border-border bg-muted/20"
              items={other}
              expandedId={expandedId}
              setExpandedId={setExpandedId}
            />
          )}
        </div>
      )}
    </div>
  );
}

interface StrategyRow {
  id: number;
  name: string;
  description: string;
  explanation?: string | null;
  active: boolean;
  tradeCount?: number;
  winRate?: number | null;
}

function StrategyGroup({
  label, badgeClass, items, expandedId, setExpandedId,
}: {
  label: string;
  badgeClass: string;
  items: StrategyRow[];
  expandedId: number | null;
  setExpandedId: (id: number | null) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <h2 className="font-semibold">{label}</h2>
        <Badge variant="outline" className={cn("text-[10px] font-mono-numbers", badgeClass)}>{items.length}</Badge>
      </div>
      <Card className="border-border overflow-hidden">
        <CardContent className="p-0 divide-y divide-border">
          {items.map((s) => {
            const expanded = expandedId === s.id;
            return (
              <div key={s.id}>
                <button
                  type="button"
                  onClick={() => setExpandedId(expanded ? null : s.id)}
                  className="w-full flex items-start gap-3 p-4 text-left hover:bg-muted/20 transition-colors"
                  data-testid={`row-strategy-${s.id}`}
                >
                  {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{s.name}</span>
                      {!s.active && <Badge variant="outline" className="text-[9px] text-muted-foreground border-border">Inactive</Badge>}
                      {!!s.tradeCount && s.tradeCount > 0 && (
                        <span className="text-[10px] text-muted-foreground font-mono-numbers">
                          {s.tradeCount} trade{s.tradeCount === 1 ? "" : "s"}
                          {s.winRate != null && ` · ${(s.winRate * 100).toFixed(0)}% win rate`}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">{s.description}</p>
                  </div>
                </button>
                {expanded && s.explanation && (
                  <div className="px-4 pb-4 pl-11">
                    <p className="text-xs leading-relaxed text-foreground/90 bg-muted/20 border border-border rounded p-3">{s.explanation}</p>
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </section>
  );
}
