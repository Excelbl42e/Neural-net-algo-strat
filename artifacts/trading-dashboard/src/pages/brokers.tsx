import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  useListBrokerConnections,
  useCreateBrokerConnection,
  useDeleteBrokerConnection,
  useSyncBrokerConnection,
  useUpdateBrokerConnection,
  getListBrokerConnectionsQueryKey,
  getListAccountsQueryKey,
  getGetAccountsSummaryQueryKey,
} from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage, FormDescription } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, RefreshCw, Trash2, Plug, AlertCircle, CheckCircle2, ExternalLink } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const formSchema = z.object({
  label: z.string().min(1, "Label required"),
  environment: z.enum(["real", "demo"]).default("real"),
  derivToken: z.string().min(5, "Deriv API token required"),
});
type FormValues = z.infer<typeof formSchema>;

export default function BrokersPage() {
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [selfTest, setSelfTest] = useState<{ running: boolean; result?: { passed: boolean; message: string; steps: Array<{ step: string; atMs: number; detail?: string }> } }>({ running: false });
  const runSelfTest = async (id: number) => {
    setSelfTest({ running: true });
    try {
      const r = await fetch(`/api/brokers/connections/${id}/self-test`, { method: "POST" });
      const body = await r.json();
      setSelfTest({ running: false, result: { passed: Boolean(body.passed), message: body.message ?? body.error ?? "No response", steps: body.steps ?? [] } });
    } catch (e) {
      setSelfTest({ running: false, result: { passed: false, message: e instanceof Error ? e.message : "Request failed", steps: [] } });
    }
  };
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: connections, isLoading } = useListBrokerConnections();
  const create = useCreateBrokerConnection();
  const del = useDeleteBrokerConnection();
  const sync = useSyncBrokerConnection();
  const update = useUpdateBrokerConnection();

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { label: "", environment: "real", derivToken: "" },
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getListBrokerConnectionsQueryKey() });
    qc.invalidateQueries({ queryKey: getListAccountsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetAccountsSummaryQueryKey() });
  };

  const onSubmit = (v: FormValues) => {
    create.mutate(
      { data: { broker: "deriv", label: v.label, environment: v.environment, credential: v.derivToken.trim() } },
      {
        onSuccess: () => {
          invalidate();
          form.reset();
          setOpen(false);
          toast({ title: "Connection added", description: "Click Sync to pull live balance." });
        },
        onError: (err) => {
          if ("status" in err && (err.status === 401 ||
            (err.status === 503 && err.message.includes("BOT_API_KEY")))) return;
          toast({ variant: "destructive", title: "Failed to add", description: err.message });
        },
      }
    );
  };

  const handleSync = (id: number) => {
    sync.mutate(
      { id },
      {
        onSuccess: (r) => {
          invalidate();
          toast({
            title: r.ok ? "Synced" : "Sync failed",
            description: r.message ?? `${r.balance ?? 0} ${r.currency ?? ""}`,
            variant: r.ok ? "default" : "destructive",
          });
        },
        onError: (err) => toast({ variant: "destructive", title: "Sync failed", description: err.message }),
      }
    );
  };

  const handleDelete = (id: number) => {
    setConfirmDeleteId(null);
    del.mutate({ id }, { onSuccess: () => { invalidate(); toast({ title: "Removed" }); } });
  };

  const handleToggle = (id: number, enabled: boolean) => {
    update.mutate({ id, data: { enabled } }, { onSuccess: invalidate });
  };

  if (isLoading) return <Skeleton className="w-full h-96 rounded-xl" />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between border-b border-border pb-4">
        <div>
          <h1 className="text-2xl font-bold uppercase tracking-wider">Broker Connections</h1>
          <p className="text-xs text-muted-foreground font-mono-numbers mt-1 uppercase tracking-wider">
            Deriv connections, balance sync, demo self-test and raw Deriv frames
          </p>
        </div>
        <Button size="sm" onClick={() => setOpen(true)} data-testid="button-add-connection">
          <Plus className="w-4 h-4 mr-1" /> Add Connection
        </Button>
      </div>

      <InstructionCard />

      <Card className="border-border">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className="font-mono-numbers uppercase text-xs tracking-wider">Label</TableHead>
              <TableHead className="font-mono-numbers uppercase text-xs tracking-wider">Broker</TableHead>
              <TableHead className="font-mono-numbers uppercase text-xs tracking-wider">Env</TableHead>
              <TableHead className="font-mono-numbers uppercase text-xs tracking-wider">Status</TableHead>
              <TableHead className="font-mono-numbers uppercase text-xs tracking-wider">Last Sync</TableHead>
              <TableHead className="font-mono-numbers uppercase text-xs tracking-wider text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {connections?.map((c) => (
              <TableRow key={c.id} className="border-border hover:bg-muted/20" data-testid={`row-conn-${c.id}`}>
                <TableCell className="font-medium">
                  <div>{c.label}</div>
                  {c.lastError && (
                    <div className="text-[10px] text-destructive font-mono-numbers mt-1 flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" /> {c.lastError}
                    </div>
                  )}
                </TableCell>
                <TableCell className="uppercase text-xs font-mono-numbers">Deriv</TableCell>
                <TableCell>
                  <Badge variant="outline" className={`uppercase text-[10px] ${c.environment === "real" ? "border-primary text-primary" : "border-amber-400 text-amber-400"}`}>
                    {c.environment}
                  </Badge>
                </TableCell>
                <TableCell>
                  <StatusBadge status={c.status} enabled={c.enabled} />
                </TableCell>
                <TableCell className="text-xs font-mono-numbers text-muted-foreground">
                  {c.lastSyncAt ? new Date(c.lastSyncAt).toLocaleString() : "Never"}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-2">
                    <Select value={c.enabled ? "on" : "off"} onValueChange={(v) => handleToggle(c.id, v === "on")}>
                      <SelectTrigger className="h-7 w-[80px] text-[10px]" data-testid={`select-enabled-${c.id}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="on" className="text-xs uppercase font-mono-numbers">Enabled</SelectItem>
                        <SelectItem value="off" className="text-xs uppercase font-mono-numbers">Disabled</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleSync(c.id)}
                      disabled={sync.isPending}
                      data-testid={`button-sync-${c.id}`}
                    >
                      <RefreshCw className={`w-3 h-3 mr-1 ${sync.isPending ? "animate-spin" : ""}`} />
                      Sync
                    </Button>
                    {c.environment === "demo" && (
                      <Button size="sm" variant="outline" disabled={selfTest.running} onClick={() => void runSelfTest(c.id)} data-testid={`button-selftest-${c.id}`}>
                        {selfTest.running ? "Testing…" : "Demo self-test"}
                      </Button>
                    )}
                    {confirmDeleteId === c.id ? (
                      <div className="flex items-center gap-1">
                        <Button size="sm" variant="destructive" className="text-xs" onClick={() => handleDelete(c.id)} data-testid={`button-confirm-delete-${c.id}`}>
                          Remove (account stays)
                        </Button>
                        <Button size="sm" variant="ghost" className="text-xs text-muted-foreground" onClick={() => setConfirmDeleteId(null)} aria-label="Keep this connection">✕</Button>
                      </div>
                    ) : (
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => setConfirmDeleteId(c.id)}
                        className="h-7 w-7 text-destructive"
                        aria-label="Remove this broker connection"
                        data-testid={`button-delete-${c.id}`}
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {(!connections || connections.length === 0) && (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-12 text-muted-foreground">
                  <Plug className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  No broker connections yet. Click "Add Connection" to link your Deriv account.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      {selfTest.result && (
        <Card className={`p-4 border ${selfTest.result.passed ? "border-green-500" : "border-destructive"}`} data-testid="card-selftest-result">
          <p className="text-sm font-semibold">{selfTest.result.passed ? "Self-test passed" : "Self-test did not pass"}: <span className="font-normal">{selfTest.result.message}</span></p>
          <ol className="mt-2 text-xs font-mono-numbers space-y-1">
            {selfTest.result.steps.map((st, i) => <li key={i}>{(st.atMs / 1000).toFixed(1)}s · {st.step}{st.detail ? ` · ${st.detail}` : ""}</li>)}
          </ol>
        </Card>
      )}

      <DiagnosticsPanel />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="uppercase tracking-wider">Add Deriv Connection</DialogTitle>
            <DialogDescription>
              Your token is sent to the server, stored AES-256-GCM encrypted (protects against table exports and casual reads, not a full database compromise) and never returned to the browser.
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField control={form.control} name="label" render={({ field }) => (
                <FormItem>
                  <FormLabel>Label</FormLabel>
                  <FormControl><Input placeholder="My Deriv Real" {...field} data-testid="input-label" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              <FormField control={form.control} name="environment" render={({ field }) => (
                <FormItem>
                  <FormLabel>Environment</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl><SelectTrigger data-testid="select-env"><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="real">Real (live money)</SelectItem>
                      <SelectItem value="demo">Demo</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />

              <FormField control={form.control} name="derivToken" render={({ field }) => (
                <FormItem>
                  <FormLabel>Deriv API Token</FormLabel>
                  <FormControl>
                    <Input type="password" placeholder="a1B2c3D4e5F6g7H8" {...field} data-testid="input-deriv-token" />
                  </FormControl>
                  <FormDescription className="text-[11px]">
                     Use a Deriv Personal Access Token with the trade scope. The server also needs your registered DERIV_APP_ID. Only one active Options account in the selected environment can be synced until account selection is added.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )} />

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={create.isPending} data-testid="button-submit-conn">
                  {create.isPending ? "Adding..." : "Add Connection"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatusBadge({ status, enabled }: { status: string; enabled: boolean }) {
  if (!enabled) return <Badge variant="outline" className="uppercase text-[10px] text-muted-foreground">Disabled</Badge>;
  const map: Record<string, { cls: string; icon: React.ReactNode }> = {
    connected: { cls: "border-green-500 text-green-500", icon: <CheckCircle2 className="w-3 h-3" /> },
    connecting: { cls: "border-amber-400 text-amber-400 animate-pulse", icon: <RefreshCw className="w-3 h-3 animate-spin" /> },
    disconnected: { cls: "border-muted-foreground text-muted-foreground", icon: <Plug className="w-3 h-3" /> },
    error: { cls: "border-destructive text-destructive", icon: <AlertCircle className="w-3 h-3" /> },
  };
  const { cls, icon } = map[status] ?? map.disconnected;
  return (
    <Badge variant="outline" className={`uppercase text-[10px] gap-1 ${cls}`}>
      {icon}
      {status}
    </Badge>
  );
}

function InstructionCard() {
  return (
    <Card className="border-border bg-card/50 max-w-xl">
      <CardContent className="p-4 space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="font-bold uppercase tracking-wider text-sm">Deriv</h3>
          <Badge variant="outline" className="uppercase text-[10px] border-green-500 text-green-500">
            Free API · Cloud
          </Badge>
        </div>
        <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside font-mono-numbers">
          <li>Log in at app.deriv.com</li>
          <li>Configure your registered Deriv App ID on the server</li>
          <li>Create a Personal Access Token with trade scope</li>
          <li>Paste the token here; the balance syncs automatically within a minute</li>
        </ol>
        <a href="https://app.deriv.com/account/api-token" target="_blank" rel="noreferrer" className="text-xs text-primary inline-flex items-center gap-1 hover:underline">
          Open Deriv API Token page <ExternalLink className="w-3 h-3" />
        </a>
      </CardContent>
    </Card>
  );
}


interface FrameRow { id: number; receivedAt: string; direction: string; kind: string; signalId: number | null; contractId: string | null; payload: string; ok: boolean | null }
interface Rejection { at: string; symbol: string; stage: string; reason: string }

function DiagnosticsPanel() {
  const frames = useQuery<FrameRow[]>({ queryKey: ["deriv-frames"], refetchInterval: 20000, queryFn: async () => (await fetch("/api/system/frames?limit=40")).json() });
  const rejections = useQuery<Rejection[]>({ queryKey: ["quant-rejections"], refetchInterval: 30000, queryFn: async () => (await fetch("/api/system/rejections")).json() });
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="p-4 min-w-0">
        <h2 className="text-sm font-bold uppercase tracking-wider mb-2">Diagnostics: raw Deriv frames (UTC, tokens redacted)</h2>
        <div className="max-h-72 overflow-auto text-[11px] font-mono-numbers space-y-1">
          {(frames.data ?? []).length === 0 && <p className="text-muted-foreground">No frames captured yet.</p>}
          {(frames.data ?? []).map((f) => (
            <details key={f.id} className="border-b border-border/50 pb-1">
              <summary className="cursor-pointer break-all">{new Date(f.receivedAt).toISOString()} {f.direction === "in" ? "←" : "→"} {f.kind}{f.ok === false ? " ERROR" : ""}{f.signalId ? ` sig#${f.signalId}` : ""}</summary>
              <pre className="whitespace-pre-wrap break-all text-muted-foreground">{f.payload}</pre>
            </details>
          ))}
        </div>
      </Card>
      <Card className="p-4 min-w-0">
        <h2 className="text-sm font-bold uppercase tracking-wider mb-2">Filter rejections (what blocked what)</h2>
        <div className="max-h-72 overflow-auto text-[11px] font-mono-numbers space-y-1">
          {(rejections.data ?? []).length === 0 && <p className="text-muted-foreground">No rejections logged yet.</p>}
          {(rejections.data ?? []).map((r, i) => (
            <p key={i} className="break-words">{new Date(r.at).toLocaleString()} · {r.symbol} · {r.stage} · {r.reason}</p>
          ))}
        </div>
      </Card>
    </div>
  );
}
