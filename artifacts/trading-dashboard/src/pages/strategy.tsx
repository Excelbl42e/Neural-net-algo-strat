import { useMemo } from "react";
import { useGetMegaStrategy, useSynthesizeStrategy, getGetMegaStrategyQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RefreshCw, Layers3 } from "lucide-react";

type Concept = { name?: string; hitCount?: number; weight?: number; evidence?: string };
type Rule = { id?: string; title?: string; trigger?: string; entry?: string };
function decodeList<T>(raw?: string | null): T[] {
  try { const data: unknown = JSON.parse(raw ?? "[]"); return Array.isArray(data) ? data as T[] : []; } catch { return []; }
}

export default function StrategyPage() {
  const { data: strategy, isLoading, isError, refetch } = useGetMegaStrategy({ query: { queryKey: getGetMegaStrategyQueryKey(), retry: false } });
  const synthesize = useSynthesizeStrategy();
  const qc = useQueryClient();
  const { toast } = useToast();
  const concepts = useMemo(() => decodeList<Concept>(strategy?.concepts), [strategy?.concepts]);
  const rules = useMemo(() => decodeList<Rule>(strategy?.rules), [strategy?.rules]);
  return <div className="max-w-5xl space-y-6 pb-8">
    <header className="border-b border-border pb-5 flex flex-wrap gap-4 justify-between items-end">
      <div><div className="text-primary text-[10px] uppercase tracking-[.24em] font-mono-numbers mb-2">Knowledge / Concept scan</div><h1 className="text-2xl font-bold">Extracted strategy record</h1><p className="text-sm text-muted-foreground mt-2 max-w-xl">Stored concept hits and rule templates from source scanning. These are not model weights, backtest results, or evidence of a learned trading policy.</p></div>
      <Button disabled={synthesize.isPending} onClick={() => synthesize.mutate(undefined, { onSuccess: () => { qc.invalidateQueries({ queryKey: getGetMegaStrategyQueryKey() }); toast({ title: "Concept scan saved" }); }, onError: () => toast({ title: "Scan failed", variant: "destructive" }) })} data-testid="button-scan-sources"><RefreshCw className="w-4 h-4 mr-2" />{synthesize.isPending ? "Scanning…" : "Scan ready sources"}</Button>
    </header>
    {isLoading ? <Skeleton className="h-60 w-full" /> : !strategy ? <div className="border border-dashed border-border rounded-xl p-8"><Layers3 className="w-6 h-6 text-violet-400 mb-4" /><h2 className="font-semibold">{isError ? "No extracted strategy available" : "No scan record yet"}</h2><p className="text-sm text-muted-foreground mt-1">Add and process sources in Education, then scan them here. This does not retrain a model.</p><Button variant="outline" size="sm" className="mt-4" onClick={() => refetch()}>Retry lookup</Button></div> :
      <>
        <section className="rounded-xl border border-violet-500/25 bg-violet-500/[.04] p-5"><div className="text-[10px] uppercase tracking-widest text-violet-300 font-mono-numbers">Stored record</div><h2 className="text-xl font-semibold mt-2">{strategy.name}</h2><p className="text-sm text-muted-foreground mt-2">{strategy.summary || strategy.description}</p><div className="flex gap-5 flex-wrap font-mono-numbers text-xs text-muted-foreground mt-5"><span>{strategy.sourcesUsed ?? "—"} sources</span><span>{strategy.wordsAnalyzed ?? "—"} words</span><span>{strategy.synthesizedAt ? new Date(strategy.synthesizedAt).toLocaleString() : "No timestamp"}</span></div></section>
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-xl border border-border bg-card p-5"><h3 className="font-semibold mb-4">Concept hits <span className="text-muted-foreground font-normal">({concepts.length})</span></h3>{concepts.length ? concepts.map((c, i) => <div key={i} className="border-t border-border py-3 flex justify-between gap-4 text-sm"><span><strong>{c.name ?? "Unnamed"}</strong><span className="block text-xs text-muted-foreground mt-1">{c.evidence || "No excerpt provided"}</span></span><span className="text-primary font-mono-numbers whitespace-nowrap text-xs">{c.hitCount ?? "—"} hits</span></div>) : <p className="text-sm text-muted-foreground">No concept hits in this record.</p>}</section>
          <section className="rounded-xl border border-border bg-card p-5"><h3 className="font-semibold mb-4">Rule templates <span className="text-muted-foreground font-normal">({rules.length})</span></h3>{rules.length ? rules.map((r, i) => <div key={i} className="border-t border-border py-3 text-sm"><strong>{r.title || r.id || "Untitled"}</strong>{r.trigger && <p className="text-xs text-muted-foreground mt-1">{r.trigger}</p>}</div>) : <p className="text-sm text-muted-foreground">No rule templates in this record.</p>}</section>
        </div>
      </>
    }
  </div>;
}