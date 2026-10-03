import { useState } from "react";
import {
  useListSignals,
  useUpdateSignal,
  useCreateSignal,
  useDeleteSignal,
  getListSignalsQueryKey,
  useListBrokerConnections,
  getListBrokerConnectionsQueryKey,
  type Signal,
} from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { Plus, Trash2 } from "lucide-react";

const signalFormSchema = z.object({
  symbol: z.string().min(1, "Symbol required").trim(),
  direction: z.enum(["buy", "sell"]),
  confidence: z.coerce.number().min(0).max(1).default(0.75),
  strategy: z.string().min(1, "Strategy required"),
  concepts: z.string().optional(),
  entryZone: z.string().min(1, "Entry zone required"),
  targetZone: z.string().optional(),
  stopZone: z.string().optional(),
});

type SignalForm = z.infer<typeof signalFormSchema>;

export default function Signals() {
  const [open, setOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const { data: signals, isLoading, isError, refetch } = useListSignals(undefined, { query: { queryKey: getListSignalsQueryKey(), refetchInterval: 10000 } });
  const brokers = useListBrokerConnections({ query: { queryKey: getListBrokerConnectionsQueryKey(), refetchInterval: 10000 } });
  const updateSignal = useUpdateSignal();
  const createSignal = useCreateSignal();
  const deleteSignal = useDeleteSignal();
  const queryClient = useQueryClient();

  const form = useForm<SignalForm>({
    resolver: zodResolver(signalFormSchema),
    defaultValues: {
      symbol: "",
      direction: "buy",
      confidence: 0.75,
      strategy: "",
      concepts: "",
      entryZone: "",
      targetZone: "",
      stopZone: "",
    },
  });

  const confidence = form.watch("confidence");

  const onSubmit = (values: SignalForm) => {
    createSignal.mutate(
      { data: values },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListSignalsQueryKey() });
          form.reset();
          setOpen(false);
        },
      }
    );
  };

  const handleDelete = (id: number) => {
    deleteSignal.mutate(
      { id },
      { onSuccess: () => queryClient.invalidateQueries({ queryKey: getListSignalsQueryKey() }) }
    );
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-48" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-64 rounded-xl" />)}
        </div>
      </div>
    );
  }
  if (isError) return <div className="border border-amber-500/30 rounded-lg p-6 text-sm">Signal records unavailable. <Button variant="outline" size="sm" className="ml-3" onClick={() => refetch()}>Retry</Button></div>;

  const activeSignals = signals?.filter(s => s.status === "active") || [];
  const pastSignals = signals?.filter(s => s.status !== "active") || [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between border-b border-border pb-4">
        <div>
          <h1 className="text-2xl font-bold uppercase tracking-wider">Signal Records</h1>
          <p className="text-xs text-muted-foreground mt-1 font-mono-numbers">
            {activeSignals.length} ACTIVE RECORDS / {signals?.length || 0} TOTAL · EXECUTION LIFECYCLE SHOWN PER SIGNAL
          </p>
        </div>
        <Button size="sm" onClick={() => setOpen(true)} data-testid="button-new-signal">
          <Plus className="w-4 h-4 mr-1" /> Log Manual Signal
        </Button>
      </div>

      <div className="rounded-lg border border-border bg-card/50 px-4 py-3 flex flex-wrap justify-between gap-2 text-xs">
        <div><strong className="text-foreground">Broker connectivity (separate check)</strong><p className="text-muted-foreground mt-1">Connection state does not prove any signal was sent or any order was accepted.</p></div>
        <span className={cn("font-mono-numbers", brokers.isError ? "text-amber-300" : brokers.data?.some(b => b.enabled && b.status === "connected") ? "text-green-400" : "text-muted-foreground")} data-testid="status-signal-broker-connectivity">
          {brokers.isLoading ? "Checking…" : brokers.isError ? "Unavailable" : `${brokers.data?.filter(b => b.enabled && b.status === "connected").length ?? 0} connected / ${brokers.data?.length ?? 0} saved`}
        </span>
      </div>

      {activeSignals.length === 0 && pastSignals.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground space-y-2">
          <p className="text-sm">No signals yet.</p>
          <p className="text-xs">Manually logged and worker-generated signals appear here. Execution state is reported separately when available.</p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {activeSignals.map(signal => (
          <SignalCard
            key={signal.id}
            signal={signal}
            onUpdate={(status) =>
              updateSignal.mutate(
                { id: signal.id, data: { status } },
                { onSuccess: () => queryClient.invalidateQueries({ queryKey: getListSignalsQueryKey() }) }
              )
            }
            onDelete={() => handleDelete(signal.id)}
          />
        ))}
      </div>

      {pastSignals.length > 0 && (
        <>
          <div className="flex items-center justify-between mt-10">
            <h2 className="text-xl font-bold uppercase tracking-wider">Signal History</h2>
            {confirmClear ? (
              <div className="flex items-center gap-1">
                <Button size="sm" variant="destructive" className="text-xs" data-testid="button-confirm-clear-history"
                  onClick={() => { pastSignals.forEach(s => handleDelete(s.id)); setConfirmClear(false); }}>
                  Delete all {pastSignals.length} past signals
                </Button>
                <Button size="sm" variant="ghost" className="text-xs text-muted-foreground" onClick={() => setConfirmClear(false)} aria-label="Keep signal history">✕</Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="destructive"
                className="text-xs opacity-70 hover:opacity-100"
                data-testid="button-clear-history"
                onClick={() => setConfirmClear(true)}
              >
                <Trash2 className="w-3 h-3 mr-1" /> Clear History
              </Button>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {pastSignals.map(signal => (
              <SignalCard
                key={signal.id}
                signal={signal}
                readOnly
                onDelete={() => handleDelete(signal.id)}
              />
            ))}
          </div>
        </>
      )}

      {/* New Signal Dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="uppercase tracking-wider">New Trade Signal</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="symbol" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Symbol</FormLabel>
                    <FormControl><Input placeholder="EURUSD" {...field} data-testid="input-signal-symbol" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="direction" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Direction</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-signal-direction"><SelectValue /></SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="buy">Buy</SelectItem>
                        <SelectItem value="sell">Sell</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>

              <FormField control={form.control} name="confidence" render={({ field }) => (
                <FormItem>
                  <FormLabel>Confidence — <span className="text-primary font-mono-numbers">{Math.round(confidence * 100)}%</span></FormLabel>
                  <FormControl>
                    <Slider
                      min={0} max={1} step={0.01}
                      value={[field.value]}
                      onValueChange={([v]) => field.onChange(v)}
                      data-testid="slider-confidence"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              <FormField control={form.control} name="strategy" render={({ field }) => (
                <FormItem>
                  <FormLabel>Strategy</FormLabel>
                  <FormControl><Input placeholder="London Kill Zone OB" {...field} data-testid="input-signal-strategy" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              <FormField control={form.control} name="concepts" render={({ field }) => (
                <FormItem>
                  <FormLabel>Concepts <span className="text-muted-foreground font-normal">(comma-separated)</span></FormLabel>
                  <FormControl><Input placeholder="H4 OB, M15 CHoCH, London KZ" {...field} data-testid="input-signal-concepts" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              <div className="grid grid-cols-3 gap-4">
                <FormField control={form.control} name="entryZone" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Entry Zone</FormLabel>
                    <FormControl><Input placeholder="1.0831–1.0845" {...field} data-testid="input-entry-zone" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="targetZone" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Target <span className="text-muted-foreground font-normal">(opt)</span></FormLabel>
                    <FormControl><Input placeholder="1.0892–1.0908" {...field} data-testid="input-target-zone" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="stopZone" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Stop <span className="text-muted-foreground font-normal">(opt)</span></FormLabel>
                    <FormControl><Input placeholder="1.0815–1.0820" {...field} data-testid="input-stop-zone" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createSignal.isPending} data-testid="button-submit-signal">
                  {createSignal.isPending ? "Adding..." : "Add Signal"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SignalCard({ signal, onUpdate, onDelete, readOnly = false }: {
  signal: Signal;
  onUpdate?: (status: "active" | "executed" | "expired" | "cancelled") => void;
  onDelete?: () => void;
  readOnly?: boolean;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isBuy = signal.direction === "buy";
  const confidencePercent = Math.round(Number(signal.confidence) * 100);
  const lifecycle = executionPresentation(signal.executionStatus);

  return (
    <Card className="border-border overflow-hidden flex flex-col bg-card/50" data-testid={`card-signal-${signal.id}`}>
      <CardHeader className="p-4 pb-2 border-b border-border bg-muted/20">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <div className="flex items-center gap-2 min-w-0">
            <Badge variant="outline" className={cn(
              "uppercase font-mono-numbers tracking-widest px-2 py-0.5 rounded-sm border",
              isBuy ? "bg-green-500/10 text-green-500 border-green-500/30" : "bg-red-500/10 text-red-500 border-red-500/30"
            )}>
              {signal.direction}
            </Badge>
            <span className="font-bold text-lg">{signal.symbol}</span>
          </div>
          <div className="flex items-center gap-1">
            <Badge variant="secondary" className="uppercase text-[10px] tracking-wider whitespace-nowrap" title="Signal record status, not broker execution">Record: {signal.status}</Badge>
            {onDelete && !confirmDelete && (
              <button
                onClick={() => setConfirmDelete(true)}
                className="ml-1 text-muted-foreground hover:text-destructive transition-colors p-1 rounded"
                title="Delete signal"
                data-testid={`button-delete-${signal.id}`}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
            {confirmDelete && (
              <div className="flex items-center gap-1 ml-1">
                <button
                  onClick={() => { onDelete?.(); setConfirmDelete(false); }}
                  className="text-[10px] bg-destructive text-destructive-foreground px-1.5 py-0.5 rounded font-mono-numbers uppercase"
                >
                  Delete
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="text-[10px] text-muted-foreground hover:text-foreground px-1 py-0.5 rounded uppercase"
                >
                  ✕
                </button>
              </div>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-4 flex flex-col gap-4 flex-1">
        <div className={cn("rounded border p-3 text-xs", lifecycle.style)} data-testid={`status-signal-execution-${signal.id}`}>
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono-numbers uppercase tracking-wider font-bold">Execution: {lifecycle.label}</span>
            <span className="text-[10px] opacity-80">Signal #{signal.id}</span>
          </div>
          <p className="mt-1 opacity-85 leading-relaxed">{lifecycle.description}</p>
          {signal.executionReason && <p className="mt-2 border-t border-current/20 pt-2 break-words" data-testid={`text-execution-reason-${signal.id}`}>Reason: {signal.executionReason}</p>}
          {signal.contractId != null && <p className="mt-1 font-mono-numbers" data-testid={`text-contract-id-${signal.id}`}>Broker contract ID: {signal.contractId}</p>}
        </div>
        <div>
          <div className="flex justify-between text-xs mb-1 font-mono-numbers">
            <span className="text-muted-foreground">CONFIDENCE</span>
            <span className={confidencePercent > 80 ? "text-primary" : "text-foreground"}>{confidencePercent}%</span>
          </div>
          <Progress value={confidencePercent} className="h-1 bg-muted" />
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs font-mono-numbers">
          <div className="flex flex-col bg-muted/20 p-2 border border-border rounded">
            <span className="text-[10px] text-muted-foreground uppercase mb-1">Entry Zone</span>
            <span className="text-foreground">{signal.entryZone}</span>
          </div>
          <div className="flex flex-col bg-muted/20 p-2 border border-border rounded">
            <span className="text-[10px] text-muted-foreground uppercase mb-1">Target Zone</span>
            <span className="text-green-500">{signal.targetZone || "---"}</span>
          </div>
          <div className="flex flex-col bg-muted/20 p-2 border border-border rounded col-span-2">
            <span className="text-[10px] text-muted-foreground uppercase mb-1">Stop Loss Zone</span>
            <span className="text-red-500">{signal.stopZone || "---"}</span>
          </div>
        </div>

        <div className="space-y-1">
          <div className="text-[10px] text-muted-foreground uppercase">Strategy / Concepts</div>
          <div className="text-xs font-medium">{signal.strategy}</div>
          {signal.concepts && (
            <div className="flex flex-wrap gap-1 mt-1">
              {signal.concepts.split(",").map((c: string, i: number) => (
                <span key={i} className="text-[9px] bg-secondary text-secondary-foreground px-1.5 py-0.5 rounded border border-border uppercase tracking-wider">
                  {c.trim()}
                </span>
              ))}
            </div>
          )}
        </div>

        {!readOnly && onUpdate && (
          <div className="mt-auto pt-3 grid grid-cols-2 gap-2">
            <Button size="sm" variant="outline" className="text-xs" onClick={() => onUpdate("expired")} data-testid={`button-expire-${signal.id}`}>
              Mark Expired
            </Button>
            <Button size="sm" variant="outline" className="text-xs" onClick={() => onUpdate("cancelled")} data-testid={`button-cancel-${signal.id}`}>
              Cancel Record
            </Button>
          </div>
        )}

        <div className="text-[9px] text-muted-foreground font-mono-numbers text-right">
          {format(new Date(signal.createdAt), "MM/dd HH:mm:ss")}
        </div>
      </CardContent>
    </Card>
  );
}

function executionPresentation(status: Signal["executionStatus"] | null | undefined) {
  switch (status) {
    case "generated": return { label: "Generated", description: "Signal recorded. No broker dispatch confirmed.", style: "border-border bg-muted/20 text-muted-foreground" };
    case "awaiting_broker": return { label: "Awaiting broker", description: "Dispatch is in flight; broker acceptance is not confirmed.", style: "border-amber-500/30 bg-amber-500/5 text-amber-200" };
    case "executed": return { label: "Executed", description: "Broker acceptance reported for this signal; this does not establish current position or settlement.", style: "border-green-500/30 bg-green-500/5 text-green-300" };
    case "rejected": return { label: "Not placed", description: "Execution stopped before a buy, or the broker explicitly rejected it. See the recorded reason.", style: "border-red-500/30 bg-red-500/5 text-red-300" };
    case "ambiguous": return { label: "Ambiguous", description: "Dispatch outcome is uncertain. Reconcile with the broker before acting.", style: "border-orange-500/40 bg-orange-500/5 text-orange-200" };
    default: return { label: "Not reported", description: "This record has no execution lifecycle field. Do not infer dispatch or a fill from its record status.", style: "border-border bg-muted/20 text-muted-foreground" };
  }
}
