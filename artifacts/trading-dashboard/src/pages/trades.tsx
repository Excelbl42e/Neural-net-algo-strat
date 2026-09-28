import { Fragment, useState } from "react";
import { Link } from "wouter";
import {
  useListTrades,
  useListSignals,
  useCreateTrade,
  useDeleteTrade,
  useBulkDeleteTrades,
  useListAccounts,
  getListTradesQueryKey,
  getListSignalsQueryKey,
  getGetDashboardOverviewQueryKey,
} from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { format } from "date-fns";
import { Card } from "@/components/ui/card";
import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";

const tradeFormSchema = z.object({
  accountId: z.coerce.number({ required_error: "Account required" }).min(1, "Account required"),
  symbol: z.string().min(1, "Symbol required").trim(),
  direction: z.enum(["buy", "sell"]),
  openPrice: z.coerce.number().positive("Must be positive"),
  lotSize: z.coerce.number().positive("Must be positive"),
  stopLoss: z.coerce.number().optional(),
  takeProfit: z.coerce.number().optional(),
  status: z.enum(["open", "pending"]).default("open"),
  strategy: z.string().min(1, "Strategy required"),
  reasonChain: z.string().min(1, "Reason chain required"),
  annotations: z.string().optional(),
});

type TradeForm = z.infer<typeof tradeFormSchema>;

export default function TradesPage() {
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [confirmBulk, setConfirmBulk] = useState<"closed" | "all" | null>(null);

  const { data: trades, isLoading } = useListTrades({ limit: 200 });
  const { data: signals, isError: signalsError } = useListSignals(undefined, { query: { queryKey: getListSignalsQueryKey(), refetchInterval: 10000 } });
  const { data: accounts } = useListAccounts();
  const createTrade = useCreateTrade();
  const deleteTrade = useDeleteTrade();
  const bulkDelete = useBulkDeleteTrades();
  const queryClient = useQueryClient();

  const accountMap = new Map((accounts ?? []).map((a) => [a.id, a]));
  const signalMap = new Map((signals ?? []).map((s) => [s.id, s]));

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: getListTradesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetDashboardOverviewQueryKey() });
  };

  const form = useForm<TradeForm>({
    resolver: zodResolver(tradeFormSchema),
    defaultValues: {
      symbol: "",
      direction: "buy",
      openPrice: undefined,
      lotSize: 0.01,
      strategy: "",
      reasonChain: "",
      annotations: "",
      status: "open",
    },
  });

  const onSubmit = (values: TradeForm) => {
    createTrade.mutate(
      {
        data: {
          ...values,
          stopLoss: values.stopLoss ?? undefined,
          takeProfit: values.takeProfit ?? undefined,
          annotations: values.annotations ?? undefined,
        },
      },
      {
        onSuccess: () => {
          invalidateAll();
          form.reset();
          setOpen(false);
        },
      }
    );
  };

  const handleDelete = (id: number) => {
    deleteTrade.mutate({ id }, { onSuccess: () => { setConfirmDeleteId(null); invalidateAll(); } });
  };

  const handleBulkDelete = (scope: "closed" | "all") => {
    bulkDelete.mutate(
      { data: scope === "closed" ? { status: "closed" } : {} },
      { onSuccess: () => { setConfirmBulk(null); invalidateAll(); } }
    );
  };

  const closedCount = (trades ?? []).filter((t) => t.status === "closed").length;

  if (isLoading) {
    return <Skeleton className="w-full h-96 rounded-xl" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between border-b border-border pb-4">
        <div><h1 className="text-2xl font-bold uppercase tracking-wider">Trade Records</h1><p className="text-xs text-muted-foreground mt-1">Stored trade rows, including manual entries; not an independently reconciled Deriv fill history.</p></div>
        <div className="flex items-center gap-2">
          {closedCount > 0 && (
            confirmBulk === "closed" ? (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => handleBulkDelete("closed")}
                  disabled={bulkDelete.isPending}
                  className="text-[10px] bg-destructive text-destructive-foreground px-2 py-1 rounded font-mono-numbers uppercase"
                >
                  {bulkDelete.isPending ? "Clearing..." : `Confirm clear ${closedCount} closed`}
                </button>
                <button onClick={() => setConfirmBulk(null)} className="text-[10px] text-muted-foreground hover:text-foreground px-1 py-1 rounded">✕</button>
              </div>
            ) : (
              <Button size="sm" variant="outline" className="text-muted-foreground border-border" onClick={() => setConfirmBulk("closed")}>
                Clear Closed ({closedCount})
              </Button>
            )
          )}
          {(trades?.length ?? 0) > 0 && (
            confirmBulk === "all" ? (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => handleBulkDelete("all")}
                  disabled={bulkDelete.isPending}
                  className="text-[10px] bg-destructive text-destructive-foreground px-2 py-1 rounded font-mono-numbers uppercase"
                >
                  {bulkDelete.isPending ? "Clearing..." : `Confirm clear all ${trades?.length}`}
                </button>
                <button onClick={() => setConfirmBulk(null)} className="text-[10px] text-muted-foreground hover:text-foreground px-1 py-1 rounded">✕</button>
              </div>
            ) : (
              <Button size="sm" variant="outline" className="text-destructive/70 border-destructive/30 hover:text-destructive hover:border-destructive/60" onClick={() => setConfirmBulk("all")}>
                Clear All
              </Button>
            )
          )}
          <Button size="sm" onClick={() => setOpen(true)} data-testid="button-new-trade">
            <Plus className="w-4 h-4 mr-1" /> Log Trade
          </Button>
        </div>
      </div>

      <Card className="border-border overflow-hidden">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="w-10" />
                <TableHead className="font-mono-numbers uppercase text-[10px] tracking-wider">Time</TableHead>
                <TableHead className="font-mono-numbers uppercase text-[10px] tracking-wider">Account</TableHead>
                <TableHead className="font-mono-numbers uppercase text-[10px] tracking-wider">Symbol</TableHead>
                <TableHead className="font-mono-numbers uppercase text-[10px] tracking-wider">Dir</TableHead>
                <TableHead className="font-mono-numbers uppercase text-[10px] tracking-wider text-right">Size</TableHead>
                <TableHead className="font-mono-numbers uppercase text-[10px] tracking-wider text-right">Open / Cost</TableHead>
                <TableHead className="font-mono-numbers uppercase text-[10px] tracking-wider text-right">Close</TableHead>
                <TableHead className="font-mono-numbers uppercase text-[10px] tracking-wider text-right">P&L</TableHead>
                <TableHead className="font-mono-numbers uppercase text-[10px] tracking-wider text-center">Status</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {trades?.map((trade) => {
                const acct = accountMap.get(trade.accountId);
                const linkedSignal = trade.signalId != null ? signalMap.get(trade.signalId) : undefined;
                return (
                  <Fragment key={trade.id}>
                    <TableRow
                      className="border-border hover:bg-muted/20 cursor-pointer group"
                      onClick={() => setExpandedId(expandedId === trade.id ? null : trade.id)}
                      data-testid={`row-trade-${trade.id}`}
                    >
                      <TableCell className="p-2">
                        {expandedId === trade.id
                          ? <ChevronDown className="w-4 h-4 text-muted-foreground" />
                          : <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />}
                      </TableCell>
                      <TableCell className="font-mono-numbers text-xs whitespace-nowrap text-muted-foreground">
                        {format(new Date(trade.openedAt), "MM/dd HH:mm")}
                      </TableCell>
                      <TableCell className="text-xs">
                        {acct ? (
                          <div>
                            <div className="font-medium text-foreground leading-tight">{acct.name}</div>
                            <div className="text-[10px] text-muted-foreground font-mono-numbers uppercase">{acct.accountType}</div>
                          </div>
                        ) : (
                          <span className="text-muted-foreground/50 text-[10px]">#{trade.accountId}</span>
                        )}
                      </TableCell>
                      <TableCell className="font-bold text-sm">{trade.symbol}{trade.signalId != null && <div className="text-[10px] text-primary font-mono-numbers font-normal">Signal #{trade.signalId}</div>}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`uppercase text-[10px] font-mono-numbers px-1.5 py-0 ${trade.direction === "buy" ? "text-green-500 border-green-500/30" : "text-red-500 border-red-500/30"}`}>
                          {trade.direction}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono-numbers text-xs">{trade.lotSize}</TableCell>
                      <TableCell className="text-right font-mono-numbers text-xs">{trade.openPrice}</TableCell>
                      <TableCell className="text-right font-mono-numbers text-xs text-muted-foreground">{trade.closePrice ?? "---"}</TableCell>
                      <TableCell className="text-right font-mono-numbers text-sm font-medium">
                        {trade.pnl != null ? (
                          <span className={Number(trade.pnl) >= 0 ? "text-green-500" : "text-red-500"}>
                            {Number(trade.pnl) >= 0 ? "+" : ""}{Number(trade.pnl).toFixed(2)}
                          </span>
                        ) : "---"}
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge variant="secondary" className="uppercase text-[9px] tracking-widest">
                          {trade.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-center" onClick={(e) => e.stopPropagation()}>
                        {confirmDeleteId === trade.id ? (
                          <div className="flex items-center gap-1 justify-center">
                            <button
                              onClick={() => handleDelete(trade.id)}
                              disabled={deleteTrade.isPending}
                              className="text-[10px] bg-destructive text-destructive-foreground px-1.5 py-0.5 rounded font-mono-numbers uppercase"
                              data-testid={`button-confirm-delete-trade-${trade.id}`}
                            >
                              Delete
                            </button>
                            <button
                              onClick={() => setConfirmDeleteId(null)}
                              className="text-[10px] text-muted-foreground hover:text-foreground px-1 py-0.5 rounded"
                            >
                              ✕
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setConfirmDeleteId(trade.id)}
                            className="text-muted-foreground hover:text-destructive transition-colors p-1 rounded opacity-0 group-hover:opacity-100"
                            title="Delete trade"
                            data-testid={`button-delete-trade-${trade.id}`}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </TableCell>
                    </TableRow>

                    {expandedId === trade.id && (
                      <TableRow className="border-border bg-muted/5 hover:bg-muted/5">
                        <TableCell colSpan={11} className="p-0">
                          <div className="p-4 pl-12 border-l-2 border-primary/50 m-2 bg-background/50 rounded grid grid-cols-2 gap-8">
                            <div className="space-y-4">
                              <div className="rounded border border-border bg-card/50 p-3" data-testid={`status-trade-signal-${trade.id}`}>
                                <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Signal linkage / broker execution</div>
                                {trade.signalId == null ? (
                                  <p className="text-xs text-muted-foreground">No signal ID linked to this trade record. Its origin cannot be inferred here.</p>
                                ) : (
                                  <div className="space-y-1.5 text-xs">
                                    <div>Linked signal #{trade.signalId}</div>
                                    {signalsError ? <p className="text-amber-300">Signal records unavailable; execution lifecycle cannot be checked.</p> :
                                      !signals ? <p className="text-muted-foreground">Checking linked signal…</p> :
                                      !linkedSignal ? <p className="text-muted-foreground">Linked signal record unavailable. Do not infer its execution state.</p> :
                                      <>
                                        <p>Execution: <span className="font-mono-numbers uppercase text-primary">{linkedSignal.executionStatus || "Not reported"}</span></p>
                                        {linkedSignal.executionStatus === "generated" && <p className="text-muted-foreground">No dispatch confirmed on the signal record.</p>}
                                        {linkedSignal.executionStatus === "awaiting_broker" && <p className="text-amber-300">Broker acceptance is pending.</p>}
                                        {linkedSignal.executionStatus === "ambiguous" && <p className="text-orange-300">Outcome uncertain; reconcile with broker.</p>}
                                        {linkedSignal.executionStatus === "rejected" && <p className="text-red-300">Dispatch rejected.</p>}
                                        {linkedSignal.executionStatus === "executed" && <p className="text-green-300">Broker acceptance reported; not proof of settlement or current position.</p>}
                                        {linkedSignal.executionReason && <p className="break-words">Reason: {linkedSignal.executionReason}</p>}
                                        {linkedSignal.contractId != null && <p className="font-mono-numbers">Broker contract ID: {linkedSignal.contractId}</p>}
                                      </>}
                                    <Link href="/signals" onClick={e => e.stopPropagation()} className="inline-block text-primary underline" data-testid={`link-trade-signal-${trade.id}`}>View signal records</Link>
                                  </div>
                                )}
                                <p className="text-[10px] text-muted-foreground mt-2">Connection status is separate from this signal's execution lifecycle.</p>
                              </div>
                              {acct && (
                                <div>
                                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Account</div>
                                  <div className="text-sm flex items-center gap-2">
                                    <span className="font-medium">{acct.name}</span>
                                    <Badge variant="outline" className={`uppercase text-[9px] px-1.5 py-0 ${acct.accountType === "live" ? "border-primary text-primary" : acct.accountType === "prop" ? "border-violet-400 text-violet-400" : ""}`}>
                                      {acct.accountType}
                                    </Badge>
                                    <span className="text-xs text-muted-foreground font-mono-numbers">{acct.broker}</span>
                                  </div>
                                </div>
                              )}
                              <div>
                                <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Strategy Trigger</div>
                                <div className="text-sm">{trade.strategy}</div>
                              </div>
                              <div>
                                <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Reasoning Chain</div>
                                <div className="text-xs font-mono-numbers whitespace-pre-wrap text-muted-foreground bg-black/40 p-2 rounded border border-border">
                                  {trade.reasonChain}
                                </div>
                              </div>
                            </div>
                            <div className="space-y-4">
                              <div className="grid grid-cols-2 gap-4">
                                <div>
                                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Stop Loss</div>
                                  <div className="text-sm font-mono-numbers text-red-500">{trade.stopLoss ?? "NONE"}</div>
                                </div>
                                <div>
                                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Take Profit</div>
                                  <div className="text-sm font-mono-numbers text-green-500">{trade.takeProfit ?? "NONE"}</div>
                                </div>
                              </div>
                              {trade.annotations && (
                                <div>
                                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Market Annotations</div>
                                  <div className="flex flex-wrap gap-2">
                                    {trade.annotations.split(",").map((ann: string, i: number) => (
                                      <span key={i} className="text-[10px] bg-secondary px-2 py-1 rounded text-secondary-foreground border border-border">
                                        {ann.trim()}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
              {trades?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={11} className="text-center py-12 text-muted-foreground">
                    No trades logged yet. Click "Log Trade" to add one.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      {/* New Trade Dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="uppercase tracking-wider">Log New Trade</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="accountId" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Account</FormLabel>
                    <Select onValueChange={(v) => field.onChange(Number(v))} value={field.value?.toString()}>
                      <FormControl>
                        <SelectTrigger data-testid="select-trade-account"><SelectValue placeholder="Select account" /></SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {accounts?.map(a => (
                          <SelectItem key={a.id} value={String(a.id)}>
                            {a.name}
                            <span className="ml-1.5 text-muted-foreground text-[10px] uppercase">({a.accountType})</span>
                          </SelectItem>
                        ))}
                        {(!accounts || accounts.length === 0) && (
                          <SelectItem value="0" disabled>No accounts — add one first</SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="symbol" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Symbol</FormLabel>
                    <FormControl><Input placeholder="frxEURUSD" {...field} data-testid="input-trade-symbol" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>

              <div className="grid grid-cols-3 gap-4">
                <FormField control={form.control} name="direction" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Direction</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-trade-direction"><SelectValue /></SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="buy">Buy</SelectItem>
                        <SelectItem value="sell">Sell</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="openPrice" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Open Price</FormLabel>
                    <FormControl><Input type="number" step="0.00001" placeholder="1.08310" {...field} data-testid="input-open-price" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="lotSize" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Lot Size</FormLabel>
                    <FormControl><Input type="number" step="0.01" placeholder="0.10" {...field} data-testid="input-lot-size" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>

              <div className="grid grid-cols-3 gap-4">
                <FormField control={form.control} name="stopLoss" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Stop Loss <span className="text-muted-foreground font-normal">(opt)</span></FormLabel>
                    <FormControl><Input type="number" step="0.00001" placeholder="1.08120" {...field} data-testid="input-stop-loss" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="takeProfit" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Take Profit <span className="text-muted-foreground font-normal">(opt)</span></FormLabel>
                    <FormControl><Input type="number" step="0.00001" placeholder="1.08920" {...field} data-testid="input-take-profit" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="status" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Status</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-trade-status"><SelectValue /></SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="open">Open</SelectItem>
                        <SelectItem value="pending">Pending</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>

              <FormField control={form.control} name="strategy" render={({ field }) => (
                <FormItem>
                  <FormLabel>Strategy Trigger</FormLabel>
                  <FormControl><Input placeholder="London Kill Zone OB" {...field} data-testid="input-trade-strategy" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              <FormField control={form.control} name="reasonChain" render={({ field }) => (
                <FormItem>
                  <FormLabel>Reasoning Chain</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="H4 BOS confirmed. Retracement into H4 OB. M15 CHoCH on retest. Entry on close above OB..."
                      rows={4}
                      {...field}
                      data-testid="textarea-reason-chain"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              <FormField control={form.control} name="annotations" render={({ field }) => (
                <FormItem>
                  <FormLabel>Market Annotations <span className="text-muted-foreground font-normal">(comma-separated, optional)</span></FormLabel>
                  <FormControl><Input placeholder="H4 Bullish OB, M15 FVG, Liquidity Pool" {...field} data-testid="input-annotations" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createTrade.isPending} data-testid="button-submit-trade">
                  {createTrade.isPending ? "Logging..." : "Log Trade"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
