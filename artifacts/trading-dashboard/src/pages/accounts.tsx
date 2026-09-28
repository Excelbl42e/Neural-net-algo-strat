import { useState } from "react";
import {
  useListAccounts,
  useGetAccountsSummary,
  useUpdateAccount,
  useCreateAccount,
  useDeleteAccount,
  getListAccountsQueryKey,
  getGetAccountsSummaryQueryKey,
  getGetDashboardOverviewQueryKey,
} from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, Trash2 } from "lucide-react";

const accountFormSchema = z.object({
  name: z.string().min(1, "Name required"),
  broker: z.string().min(1, "Broker required"),
  currency: z.string().min(1, "Currency required").default("USD"),
  accountType: z.enum(["live", "demo", "prop"]),
  balance: z.coerce.number().min(0).default(0),
  equity: z.coerce.number().min(0).default(0),
  margin: z.coerce.number().min(0).default(0),
  marginLevel: z.coerce.number().optional(),
  status: z.enum(["active", "inactive", "suspended"]).default("active"),
  notes: z.string().optional(),
});

type AccountForm = z.infer<typeof accountFormSchema>;

export default function AccountsPage() {
  const [open, setOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const { data: accounts, isLoading: accountsLoading } = useListAccounts();
  const { data: summary, isLoading: summaryLoading } = useGetAccountsSummary();
  const updateAccount = useUpdateAccount();
  const createAccount = useCreateAccount();
  const deleteAccount = useDeleteAccount();
  const queryClient = useQueryClient();

  const form = useForm<AccountForm>({
    resolver: zodResolver(accountFormSchema),
    defaultValues: {
      name: "",
      broker: "",
      currency: "USD",
      accountType: "live",
      balance: 0,
      equity: 0,
      margin: 0,
      status: "active",
      notes: "",
    },
  });

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetAccountsSummaryQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetDashboardOverviewQueryKey() });
  };

  const onSubmit = (values: AccountForm) => {
    createAccount.mutate(
      { data: { ...values, marginLevel: values.marginLevel ?? undefined } },
      {
        onSuccess: () => {
          invalidateAll();
          form.reset();
          setOpen(false);
        },
      }
    );
  };

  const handleStatusChange = (id: number, status: string) => {
    updateAccount.mutate(
      { id, data: { status: status as "active" | "inactive" | "suspended" } },
      { onSuccess: invalidateAll }
    );
  };

  const handleDelete = (id: number) => {
    setDeleteError(null);
    deleteAccount.mutate(
      { id },
      {
        onSuccess: () => {
          setConfirmDeleteId(null);
          invalidateAll();
        },
        onError: (err: any) => {
          const msg = err?.response?.data?.error ?? err?.message ?? "Failed to delete account";
          setDeleteError(msg);
        },
      }
    );
  };

  if (accountsLoading || summaryLoading) {
    return <Skeleton className="w-full h-96 rounded-xl" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between border-b border-border pb-4">
        <h1 className="text-2xl font-bold uppercase tracking-wider">Trading Accounts</h1>
        <Button size="sm" onClick={() => setOpen(true)} data-testid="button-new-account">
          <Plus className="w-4 h-4 mr-1" /> New Account
        </Button>
      </div>

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <SummaryCard title="Total Equity" value={`$${Number(summary.totalEquity).toLocaleString(undefined, { minimumFractionDigits: 2 })}`} valueClassName="text-primary" />
          <SummaryCard title="Total Balance" value={`$${Number(summary.totalBalance).toLocaleString(undefined, { minimumFractionDigits: 2 })}`} />
          <SummaryCard title="Margin Used" value={`$${Number(summary.totalMargin).toLocaleString(undefined, { minimumFractionDigits: 2 })}`} />
          <SummaryCard title="Active Accounts" value={`${summary.activeAccounts} / ${summary.accountCount}`} />
        </div>
      )}

      {deleteError && (
        <div className="text-sm text-destructive bg-destructive/10 border border-destructive/30 px-4 py-2 rounded-md font-mono-numbers">
          {deleteError}
          <button className="ml-3 underline text-xs" onClick={() => setDeleteError(null)}>Dismiss</button>
        </div>
      )}

      <Card className="border-border">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className="font-mono-numbers uppercase text-xs tracking-wider">Account</TableHead>
              <TableHead className="font-mono-numbers uppercase text-xs tracking-wider">Broker</TableHead>
              <TableHead className="font-mono-numbers uppercase text-xs tracking-wider">Type</TableHead>
              <TableHead className="font-mono-numbers uppercase text-xs tracking-wider text-right">Balance</TableHead>
              <TableHead className="font-mono-numbers uppercase text-xs tracking-wider text-right">Equity</TableHead>
              <TableHead className="font-mono-numbers uppercase text-xs tracking-wider text-right">Margin Lvl</TableHead>
              <TableHead className="font-mono-numbers uppercase text-xs tracking-wider text-center">Status</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts?.map((acc) => (
              <TableRow key={acc.id} className="border-border hover:bg-muted/20" data-testid={`row-account-${acc.id}`}>
                <TableCell className="font-medium">
                  <div>{acc.name}</div>
                  <div className="text-[10px] text-muted-foreground font-mono-numbers uppercase">{acc.currency}</div>
                </TableCell>
                <TableCell>{acc.broker}</TableCell>
                <TableCell>
                  <Badge variant="outline" className={`uppercase text-[10px] ${acc.accountType === "live" ? "border-primary text-primary" : acc.accountType === "prop" ? "border-violet-400 text-violet-400" : ""}`}>
                    {acc.accountType}
                  </Badge>
                </TableCell>
                <TableCell className="text-right font-mono-numbers">${Number(acc.balance).toLocaleString(undefined, { minimumFractionDigits: 2 })}</TableCell>
                <TableCell className="text-right font-mono-numbers text-primary font-medium">${Number(acc.equity).toLocaleString(undefined, { minimumFractionDigits: 2 })}</TableCell>
                <TableCell className="text-right font-mono-numbers">
                  {acc.marginLevel != null ? `${Number(acc.marginLevel).toFixed(2)}%` : "---"}
                </TableCell>
                <TableCell className="text-center">
                  <Select value={acc.status} onValueChange={(v) => handleStatusChange(acc.id, v)}>
                    <SelectTrigger className="h-8 text-xs border-border bg-background w-[120px] mx-auto" data-testid={`select-status-${acc.id}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active" className="text-xs uppercase font-mono-numbers text-green-500">Active</SelectItem>
                      <SelectItem value="inactive" className="text-xs uppercase font-mono-numbers text-muted-foreground">Inactive</SelectItem>
                      <SelectItem value="suspended" className="text-xs uppercase font-mono-numbers text-destructive">Suspended</SelectItem>
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell className="text-center">
                  {confirmDeleteId === acc.id ? (
                    <div className="flex items-center gap-1 justify-center">
                      <button
                        onClick={() => handleDelete(acc.id)}
                        className="text-[10px] bg-destructive text-destructive-foreground px-1.5 py-0.5 rounded font-mono-numbers uppercase"
                        data-testid={`button-confirm-delete-account-${acc.id}`}
                      >
                        Confirm
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
                      onClick={() => { setDeleteError(null); setConfirmDeleteId(acc.id); }}
                      className="text-muted-foreground hover:text-destructive transition-colors p-1 rounded"
                      title="Delete account"
                      data-testid={`button-delete-account-${acc.id}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {accounts?.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-12 text-muted-foreground">
                  No accounts yet. Click "New Account" to add one.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      {/* New Account Dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="uppercase tracking-wider">New Broker Account</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="name" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Account Name</FormLabel>
                    <FormControl><Input placeholder="Primary Live" {...field} data-testid="input-account-name" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="broker" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Broker</FormLabel>
                    <FormControl><Input placeholder="IC Markets" {...field} data-testid="input-broker" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="accountType" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Account Type</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-account-type"><SelectValue /></SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="live">Live</SelectItem>
                        <SelectItem value="demo">Demo</SelectItem>
                        <SelectItem value="prop">Prop</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="currency" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Currency</FormLabel>
                    <FormControl><Input placeholder="USD" {...field} data-testid="input-currency" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>

              <div className="grid grid-cols-3 gap-4">
                <FormField control={form.control} name="balance" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Balance</FormLabel>
                    <FormControl><Input type="number" step="0.01" {...field} data-testid="input-balance" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="equity" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Equity</FormLabel>
                    <FormControl><Input type="number" step="0.01" {...field} data-testid="input-equity" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="margin" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Margin</FormLabel>
                    <FormControl><Input type="number" step="0.01" {...field} data-testid="input-margin" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>

              <FormField control={form.control} name="marginLevel" render={({ field }) => (
                <FormItem>
                  <FormLabel>Margin Level % <span className="text-muted-foreground font-normal">(optional)</span></FormLabel>
                  <FormControl><Input type="number" step="0.01" placeholder="e.g. 283.00" {...field} data-testid="input-margin-level" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              <FormField control={form.control} name="notes" render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes <span className="text-muted-foreground font-normal">(optional)</span></FormLabel>
                  <FormControl><Input placeholder="e.g. Main live trading account" {...field} data-testid="input-notes" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createAccount.isPending} data-testid="button-submit-account">
                  {createAccount.isPending ? "Adding..." : "Add Account"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SummaryCard({ title, value, valueClassName }: { title: string; value: string; valueClassName?: string }) {
  return (
    <Card className="border-border bg-card/50">
      <CardContent className="p-4 flex flex-col gap-1">
        <span className="text-xs text-muted-foreground uppercase font-mono-numbers tracking-widest">{title}</span>
        <span className={`text-2xl font-mono-numbers font-bold ${valueClassName || ""}`}>{value}</span>
      </CardContent>
    </Card>
  );
}
