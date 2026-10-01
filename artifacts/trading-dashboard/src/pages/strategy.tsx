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

  // Retired rows (the old ICT concepts) stay in the table for their trade
  // history but are inactive, so only the 60 voters are listed.
  const quant = useMemo(() => (strategies ?? []).filter((s) => s.active && s.type === "quant").sort((a, b) => a.name.localeCompare(b.name)), [strategies]);
  const ta = useMemo(() => (strategies ?? []).filter((s) => s.active && s.type === "ta").sort((a, b) => a.name.localeCompare(b.name)), [strategies]);

  return (
    <div className="max-w-5xl space-y-6 pb-8">
      <header className="border-b border-border pb-5">
        <div className="text-primary text-[10px] uppercase tracking-[.24em] font-mono-numbers mb-2">Strategy Library</div>
        <h1 className="text-2xl font-bold">The strategy poll: {quant.length} quantitative + {ta.length} technical</h1>
        <p className="text-sm text-muted-foreground mt-2 max-w-2xl">
          Every strategy below is code. After each 30-minute close it votes buy, sell or abstain on every pair, each on its
          own timeframe (30-minute, 1-hour or 4-hour — open one to see which), using only candles that have closed.
          Majority rules: when more strategies say buy than sell (or the reverse) and at least 30 of the 60 have an
          opinion, the bot trades that direction at market — stop 0.6% from entry, target 1.5 times the stop after
          commission, held up to four days and always closed before Deriv's Friday close. No language model, no API cost.
          The same code runs in the backtest, so what was tested is exactly what trades.
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
            label="Quantitative"
            badgeClass="text-violet-300 border-violet-400/30 bg-violet-400/5"
            items={quant}
            expandedId={expandedId}
            setExpandedId={setExpandedId}
          />
          <StrategyGroup
            label="Technical analysis"
            badgeClass="text-primary border-primary/30 bg-primary/5"
            items={ta}
            expandedId={expandedId}
            setExpandedId={setExpandedId}
          />
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
