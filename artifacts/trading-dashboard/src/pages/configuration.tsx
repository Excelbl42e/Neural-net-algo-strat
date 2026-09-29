import {
  useGetBotConfig,
  useUpdateBotConfig,
  useGetAccountsSummary,
  getGetBotConfigQueryKey,
} from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage, FormDescription } from "@/components/ui/form";
import { Badge } from "@/components/ui/badge";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { AlertCircle, Save, ShieldCheck, Layers, TrendingUp } from "lucide-react";

const formSchema = z.object({
  enabled: z.boolean(),
  autotradeMode: z.enum(["off", "auto_demo", "auto_live"]),
  riskPerTradePct: z.coerce.number().min(0).max(100),
  maxConcurrentPositions: z.coerce.number().int().min(1).max(10),
  smallAccountMaxRiskPct: z.coerce.number().min(0).max(100),
  minRiskReward: z.coerce.number().min(0).max(20),
  atrPercentileMin: z.coerce.number().min(0).max(100),
  atrPercentileMax: z.coerce.number().min(0).max(100),
  efficiencyRatioMin: z.coerce.number().min(0).max(1),
  minStopAtr: z.coerce.number().min(0).max(20),
  maxPerAssetClass: z.coerce.number().int().min(1).max(100),
  newsBlackoutBeforeMin: z.coerce.number().int().min(0).max(1440),
  newsBlackoutAfterMin: z.coerce.number().int().min(0).max(1440),
  maxSpreadCostPct: z.coerce.number().min(0).max(100),
  maxPositionHoldHours: z.coerce.number().int().min(1).max(8760),
  maxDailyLossPct: z.coerce.number().min(0).max(100),
  minConfidence: z.coerce.number().min(0).max(1),
  allowedInstruments: z.string(),
  killzones: z.string(),
  notes: z.string().optional(),
});
type FormValues = z.infer<typeof formSchema>;

interface StakeRow {
  equity: number; ok: boolean; stake?: number; riskPct?: number; contract?: string; reason?: string;
  fundablePositions?: number; configuredPositions?: number;
  positionsLimitedBy?: "configured" | "daily_loss_budget" | "risk_sizing" | "equity";
}
export default function ConfigurationPage() {
  const { data: config, isLoading } = useGetBotConfig();
  const { data: summary } = useGetAccountsSummary();
  const update = useUpdateBotConfig();
  const qc = useQueryClient();
  const { toast } = useToast();
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      enabled: false,
      autotradeMode: "off",
      riskPerTradePct: 1,
      maxConcurrentPositions: 3,
      smallAccountMaxRiskPct: 10,
      minRiskReward: 2,
      atrPercentileMin: 15,
      atrPercentileMax: 90,
      efficiencyRatioMin: 0.15,
      minStopAtr: 1,
      maxPerAssetClass: 2,
      newsBlackoutBeforeMin: 30,
      newsBlackoutAfterMin: 30,
      maxSpreadCostPct: 0.5,
      maxPositionHoldHours: 36,
      maxDailyLossPct: 5,
      minConfidence: 0.7,
      allowedInstruments: "",
      killzones: "",
      notes: "",
    },
  });

  useEffect(() => {
    if (config) {
      form.reset({
        enabled: config.enabled,
        autotradeMode: config.autotradeMode,
        riskPerTradePct: Number(config.riskPerTradePct),
        maxConcurrentPositions: config.maxConcurrentPositions,
        smallAccountMaxRiskPct: Number(config.smallAccountMaxRiskPct ?? 10),
        minRiskReward: Number(config.minRiskReward ?? 2),
        atrPercentileMin: Number(config.atrPercentileMin ?? 15),
        atrPercentileMax: Number(config.atrPercentileMax ?? 90),
        efficiencyRatioMin: Number(config.efficiencyRatioMin ?? 0.15),
        minStopAtr: Number(config.minStopAtr ?? 1),
        maxPerAssetClass: config.maxPerAssetClass ?? 2,
        newsBlackoutBeforeMin: config.newsBlackoutBeforeMin ?? 30,
        newsBlackoutAfterMin: config.newsBlackoutAfterMin ?? 30,
        maxSpreadCostPct: Number(config.maxSpreadCostPct ?? 0.5),
        maxPositionHoldHours: config.maxPositionHoldHours ?? 36,
        maxDailyLossPct: Number(config.maxDailyLossPct),
        minConfidence: Number(config.minConfidence),
        allowedInstruments: config.allowedInstruments,
        killzones: config.killzones,
        notes: config.notes ?? "",
      });
    }
  }, [config, form]);

  const onSubmit = (v: FormValues) => {
    update.mutate(
      { data: { ...v, notes: v.notes || undefined } },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getGetBotConfigQueryKey() });
          toast({ title: "Configuration saved" });
        },
        onError: (err) => toast({ variant: "destructive", title: "Save failed", description: err.message }),
      }
    );
  };

  const equity = summary?.totalEquity ?? 0;
  const stakeQuery = useQuery<StakeRow[]>({
    queryKey: ["stake-preview", equity, config?.updatedAt],
    queryFn: async () => {
      const list = [equity > 0 ? equity : null, 5, 20, 50, 200].filter((n): n is number => n != null);
      const r = await fetch(`/api/config/stake-preview?equity=${list.join(",")}`, { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    },
  });

  if (isLoading) return <Skeleton className="w-full h-96 rounded-xl" />;

  const enabled = form.watch("enabled");
  const mode = form.watch("autotradeMode");
  const riskPerTradePctValue = form.watch("riskPerTradePct");
  const maxDailyLossPctValue = form.watch("maxDailyLossPct");
  // First preview row is the synced balance when there is one (see the query's
  // equity list below), so it reflects this account rather than a sample rung.
  const yourRow = equity > 0 ? stakeQuery.data?.[0] : undefined;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between border-b border-border pb-4">
        <div>
          <h1 className="text-2xl font-bold uppercase tracking-wider">Configuration</h1>
          <p className="text-xs text-muted-foreground font-mono-numbers mt-1 uppercase tracking-wider">
            Risk · Autotrade · Instruments
          </p>
        </div>
        <Badge variant="outline" className={`uppercase text-[10px] gap-1 ${enabled ? "border-green-500 text-green-500" : "border-muted-foreground text-muted-foreground"}`}>
          <ShieldCheck className="w-3 h-3" />
          Config {enabled ? "ENABLED" : "DISABLED"}
        </Badge>
      </div>

      {/* Stake preview: computed by the server with the same function the worker uses */}
      <Card className="border-primary/30 bg-primary/5">
        <CardHeader className="pb-3">
          <CardTitle className="uppercase tracking-wider text-sm flex items-center gap-2">
            <Layers className="w-4 h-4 text-primary" />
            Stake per trade (saved settings)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {equity > 0 ? `Your synced equity is $${equity.toFixed(2)}.` : "No synced account balance yet."} Rows below use the same sizing code as the trading worker and your saved risk settings.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono-numbers">
              <thead><tr className="text-left text-muted-foreground uppercase tracking-wider"><th className="py-1 pr-4">Equity</th><th className="pr-4">Stake</th><th className="pr-4">% of equity</th><th className="pr-4">Trades at once</th><th>Result</th></tr></thead>
              <tbody>
                {(stakeQuery.data ?? []).map((r, i) => (
                  <tr key={`${r.equity}-${i}`} className="border-t border-border">
                    <td className="py-1 pr-4">${r.equity.toFixed(2)}{i === 0 && equity > 0 ? " (yours)" : ""}</td>
                    <td className="pr-4">{r.ok ? `$${r.stake!.toFixed(2)}` : "skip"}</td>
                    <td className="pr-4">{r.ok ? `${r.riskPct}%` : "-"}</td>
                    <td className={`pr-4 ${r.fundablePositions != null && r.configuredPositions != null && r.fundablePositions < r.configuredPositions ? "text-amber-400" : ""}`}>
                      {r.fundablePositions != null && r.configuredPositions != null
                        ? `${r.fundablePositions} of ${r.configuredPositions}`
                        : "-"}
                    </td>
                    <td className={r.ok ? "" : "text-amber-400"}>{r.ok ? r.contract : r.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-start gap-2 rounded-lg border border-border p-3 text-[11px] text-muted-foreground">
            <TrendingUp className="w-3.5 h-3.5 mt-0.5 shrink-0 text-primary" />
            <span>Multiplier max loss equals the stake, so stake is the true risk. Not a quote; the daily-loss budget can lower it further at order time. When the stake falls below Deriv's $1 multiplier minimum, the trade is placed as a binary option instead — with a fixed 3-day expiry, separate from the strategy's usual 4-hour to 1-day target hold, and not affected by the "Force-close after" setting below (that only applies to multipliers).</span>
          </div>
          {yourRow?.ok && yourRow.stake != null && yourRow.stake >= 1 && yourRow.stake < 1.2 && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-[11px] text-amber-400" data-testid="warn-multiplier-boundary">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>
                You are sitting right on Deriv's $1.00 multiplier boundary — your stake is
                ${yourRow.stake.toFixed(2)}. The moment your balance dips below
                ${(1 / (Number(riskPerTradePctValue) / 100)).toFixed(2)}, the stake falls under $1.00 and every trade
                becomes a 3-day binary instead: no stop-loss, no take-profit, the full stake at risk until expiry, and
                the force-close setting will not apply. One losing trade is enough to cross it. Winning trades push you
                back over.
              </span>
            </div>
          )}
          {yourRow?.ok && yourRow.stake != null && yourRow.stake < 1 && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-[11px] text-amber-400" data-testid="warn-binary-mode">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>
                Your ${yourRow.stake.toFixed(2)} stake is below Deriv's $1.00 multiplier minimum, so trades are being
                placed as 3-day binaries — no stop-loss, no take-profit, full stake at risk until expiry. A balance of
                ${(1 / (Number(riskPerTradePctValue) / 100)).toFixed(2)} or more at your current risk setting returns
                you to multiplier contracts.
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <Card className="border-border">
            <CardHeader className="pb-3">
              <CardTitle className="uppercase tracking-wider text-sm">Master switches</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <FormField control={form.control} name="enabled" render={({ field }) => (
                <FormItem className="flex items-center justify-between rounded-lg border border-border p-3">
                  <div>
                    <FormLabel className="text-base">Enable bot configuration</FormLabel>
                    <FormDescription className="text-[11px]">Master switch for the whole scan loop: turned off, the worker skips every tick entirely — no analysis, no signals, no orders. Turned on, it scans and records signals, but orders still only go out when Autotrade mode is not Off. It does not confirm broker connectivity, account readiness, or a successful order.</FormDescription>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} className="data-[state=checked]:bg-primary" data-testid="switch-enabled" />
                  </FormControl>
                </FormItem>
              )} />

              <FormField control={form.control} name="autotradeMode" render={({ field }) => (
                <FormItem>
                  <FormLabel>Autotrade mode</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger data-testid="select-autotrade-mode"><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="off">Off: signals only, no orders</SelectItem>
                      <SelectItem value="auto_demo">Auto on Deriv DEMO account</SelectItem>
                      <SelectItem value="auto_live">Auto on REAL account (needs passed demo self-test)</SelectItem>
                    </SelectContent>
                  </Select>
                  {mode === "auto_live" && (
                    <FormDescription className="text-[11px] text-red-400 flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" /> Real money. The server refuses this until a real connection is synced and the demo self-test on the Brokers page has passed.
                    </FormDescription>
                  )}
                  <FormMessage />
                </FormItem>
              )} />
            </CardContent>
          </Card>

          <Card className="border-border">
            <CardHeader className="pb-3">
              <CardTitle className="uppercase tracking-wider text-sm">Risk limits</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField control={form.control} name="maxConcurrentPositions" render={({ field }) => (
                <FormItem>
                  <FormLabel>Max positions (hard ceiling)</FormLabel>
                  <FormControl><Input type="number" step="1" min="1" max="10" {...field} data-testid="input-max-positions" /></FormControl>
                  <FormDescription className="text-[11px]">
                    An upper bound, not a target. What actually fits is shown per balance in the "Trades at once"
                    column above.
                  </FormDescription>
                  {yourRow?.fundablePositions != null && yourRow.configuredPositions != null
                    && yourRow.fundablePositions < yourRow.configuredPositions && (
                    <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-400">
                      <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      <span>
                        At your current ${equity.toFixed(2)} balance only <strong>{yourRow.fundablePositions}</strong> of
                        these {yourRow.configuredPositions} can actually open
                        {yourRow.positionsLimitedBy === "daily_loss_budget"
                          ? " — the daily-loss budget reserves each open stake, so the first trade uses up the day's allowance."
                          : yourRow.positionsLimitedBy === "risk_sizing"
                            ? " — risk sizing refuses the next one at this balance."
                            : "."}
                        {" "}Raising this number will not change that — and it can make things worse: each trade is
                        also capped at balance ÷ this number, so a higher ceiling shrinks every stake and can push it
                        under Deriv's $1.00 multiplier minimum, turning your trades into 3-day binaries. A larger
                        balance or a wider daily-loss budget is what actually unlocks more positions.
                      </span>
                    </div>
                  )}
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="maxDailyLossPct" render={({ field }) => (
                <FormItem>
                  <FormLabel>Max daily loss (% of equity)</FormLabel>
                  <FormControl><Input type="number" step="0.1" min="0" max="100" {...field} data-testid="input-max-daily-loss" /></FormControl>
                  <FormDescription className="text-[11px]">New orders are refused when today's realized losses plus open-stake reservations exhaust this UTC-day budget.</FormDescription>
                  {Number(maxDailyLossPctValue) < Number(riskPerTradePctValue) && (
                    <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-400">
                      <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      <span>
                        This is lower than "Risk per trade %" ({Number(riskPerTradePctValue)}%) above. This budget is checked after per-trade sizing and can only shrink the stake further — so on a small account it can silently refuse every trade (or force it down to the $1 multiplier floor or below) even though risk-per-trade alone would allow a bigger one. If you need the full {Number(riskPerTradePctValue)}% to go through, raise this to at least {Number(riskPerTradePctValue)}% too.
                      </span>
                    </div>
                  )}
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="minConfidence" render={({ field }) => (
                <FormItem>
                  <FormLabel>Minimum signal confidence (0–1)</FormLabel>
                  <FormControl><Input type="number" step="0.01" min="0" max="1" {...field} data-testid="input-min-confidence" /></FormControl>
                  <FormDescription className="text-[11px]">
                    Signals below this are dropped before reaching execution. This is evidence strength, not a win
                    probability. A setup starts at 0.35 for clearing the structural trigger on its own, earns up to
                    +0.40 from how much of the strategy library agrees with it, and up to +0.25 from the five
                    structural confirmations — so 0.35 is a bare setup nothing else supports, ~0.70 means the
                    evidence clearly leans this way, and 0.98 is the ceiling. 0.70 is the default.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="riskPerTradePct" render={({ field }) => (
                <FormItem>
                  <FormLabel>Risk per trade % (hard ceiling)</FormLabel>
                  <FormControl><Input type="number" step="0.1" min="0" max="100" {...field} data-testid="input-risk-per-trade" /></FormControl>
                  <FormDescription className="text-[11px]">The computed stake cannot exceed this share of verified USD equity; trades below the broker minimum are refused.</FormDescription>
                  {Number(riskPerTradePctValue) >= 10 && (
                    <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-400">
                      <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      <span>
                        At {Number(riskPerTradePctValue)}%, a single losing multiplier trade (max loss = stake) can cost roughly {Number(riskPerTradePctValue)}% of your equity in one shot
                        {equity > 0 ? ` — about $${(equity * Number(riskPerTradePctValue) / 100).toFixed(2)} on your current $${equity.toFixed(2)} balance` : ""}.
                        This is well above the 1% fixed-fractional default. It's a deliberate way to clear Deriv's $1 multiplier minimum on a very small account, not a setting to leave in place once equity grows — lower it back toward 1-2% as your balance increases.
                      </span>
                    </div>
                  )}
                  <FormMessage />
                </FormItem>
              )} />
            </CardContent>
          </Card>

          <Card className="border-border">
            <CardHeader className="pb-3">
              <CardTitle className="uppercase tracking-wider text-sm">Quant filters and small-account rule</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {([
                ["smallAccountMaxRiskPct", "Small account: max % of equity for a minimum-stake trade", "0.1"],
                ["minRiskReward", "Minimum reward:risk", "0.1"],
                ["atrPercentileMin", "Skip if H1 ATR percentile below", "1"],
                ["atrPercentileMax", "Skip if H1 ATR percentile above", "1"],
                ["efficiencyRatioMin", "Efficiency ratio floor (0 chop, 1 trend)", "0.01"],
                ["minStopAtr", "Minimum stop distance (ATRs)", "0.1"],
                ["maxPerAssetClass", "Max open positions per asset class", "1"],
                ["newsBlackoutBeforeMin", "News blackout: minutes before a high-impact release", "1"],
                ["newsBlackoutAfterMin", "News blackout: minutes after a high-impact release", "1"],
                ["maxSpreadCostPct", "Max indicative trading cost (% of stake)", "0.01"],
                ["maxPositionHoldHours", "Force-close a multiplier position after this many hours if neither SL nor TP has hit", "1"],
              ] as const).map(([name, label, step]) => (
                <FormField key={name} control={form.control} name={name} render={({ field }) => (
                  <FormItem>
                    <FormLabel>{label}</FormLabel>
                    <FormControl><Input type="number" step={step} {...field} data-testid={`input-${name}`} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              ))}
            </CardContent>
          </Card>

          <Card className="border-border">
            <CardHeader className="pb-3">
              <CardTitle className="uppercase tracking-wider text-sm">Scope</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <FormField control={form.control} name="allowedInstruments" render={({ field }) => (
                <FormItem>
                  <FormLabel>Allowed instruments</FormLabel>
                  <FormControl><Input placeholder="frxEURUSD,frxGBPUSD,frxUSDJPY" {...field} data-testid="input-instruments" /></FormControl>
                  <FormDescription className="text-[11px]">Forex only. Blank scans all forex majors (EURUSD, GBPUSD, USDJPY, AUDUSD, USDCAD, GBPJPY); synthetics, crypto and commodities are not traded or analyzed. Enter comma-separated forex symbols to narrow the scan.</FormDescription>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="killzones" render={({ field }) => (
                <FormItem>
                  <FormLabel>Killzone sessions</FormLabel>
                  <FormControl><Input placeholder="london,newyork" {...field} data-testid="input-killzones" /></FormControl>
                  <FormDescription className="text-[11px]">Comma-separated: asian, london, newyork. Blank allows any open-market hour. Signals are only generated while one of the listed sessions is active (UTC).</FormDescription>
                  <FormMessage />
                </FormItem>
              )} />
            </CardContent>
          </Card>

          <Card className="border-border">
            <CardHeader className="pb-3">
              <CardTitle className="uppercase tracking-wider text-sm">Notes</CardTitle>
            </CardHeader>
            <CardContent>
              <FormField control={form.control} name="notes" render={({ field }) => (
                <FormItem>
                  <FormControl><Textarea rows={3} placeholder="Free-form notes for yourself" {...field} data-testid="textarea-notes" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </CardContent>
          </Card>

          <div className="flex items-center justify-between pt-2">
            <span className="text-[11px] text-muted-foreground font-mono-numbers">
              Last saved: {config?.updatedAt ? new Date(config.updatedAt).toLocaleString() : "never"}
            </span>
            <Button type="submit" disabled={update.isPending} data-testid="button-save-config">
              <Save className="w-4 h-4 mr-1" /> {update.isPending ? "Saving..." : "Save Configuration"}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
