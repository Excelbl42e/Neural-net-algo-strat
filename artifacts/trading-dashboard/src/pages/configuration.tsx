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

const ENTRY_DAYS_LABEL: Record<number, string> = {
  1: "Monday only",
  2: "Monday–Tuesday (weekly cycle)",
  3: "Monday–Wednesday",
  4: "Monday–Thursday",
  5: "Every weekday",
};

const formSchema = z.object({
  enabled: z.boolean(),
  autotradeMode: z.enum(["off", "auto_demo", "auto_live"]),
  riskPerTradePct: z.coerce.number().min(0).max(100),
  maxConcurrentPositions: z.coerce.number().int().min(1).max(100),
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
  lastEntryWeekday: z.coerce.number().int().min(1).max(5),
  cotVeto: z.boolean(),
  maxDailyLossPct: z.coerce.number().min(0).max(100),
  minConfidence: z.coerce.number().min(0).max(1),
  allowedInstruments: z.string(),
  killzones: z.string(),
  notes: z.string().optional(),
});
type FormValues = z.infer<typeof formSchema>;

interface StakeRow {
  equity: number; ok: boolean; stake?: number | null; riskPct?: number; reason?: string;
  band?: "floor" | "build" | "grow" | "steady" | "mature";
  riskCappedByBand?: boolean;
  contract?: "multiplier" | "binary" | null;
  typicalLoss?: number | null; worstCaseLoss?: number | null; worstCasePctOfEquity?: number | null;
  fundablePositions?: number; configuredPositions?: number;
  positionsLimitedBy?: "configured" | "daily_loss_budget" | "risk_sizing" | "equity" | "asset_class_cap";
}

interface RiskBandRow {
  band: string; from: number; to: number | null; riskPct: number; why: string;
  appliedRiskPct: number;
}
interface RiskBandsResponse { configuredRiskPct: number; configuredDailyLossPct: number; bands: RiskBandRow[] }

/**
 * Autotrade labels, kept in one place so the trigger and the menu cannot drift.
 *
 * The trigger text has to be derived from the form value rather than left to
 * Radix. Radix learns an option's label from the `SelectItem` that renders it,
 * and it does not mount the menu until the select is opened — so it only knows
 * the label of whatever was selected at mount. This form mounts with hardcoded
 * defaults ("off") and is only filled from the server afterwards by
 * `form.reset()`, so any saved value other than "off" arrived at a moment when
 * Radix had no label for it and the trigger rendered empty. Passing the label
 * as `SelectValue`'s children makes it a pure function of the form value.
 */
const AUTOTRADE_LABEL: Record<FormValues["autotradeMode"], string> = {
  off: "Off: signals only, no orders",
  auto_demo: "Auto on Deriv DEMO account",
  auto_live: "Auto on REAL account (needs passed demo self-test)",
};

/** Plain-language name for each rung of the ladder. */
const BAND_LABEL: Record<string, string> = {
  floor: "Floor", build: "Build", grow: "Grow", steady: "Steady", mature: "Mature",
};
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
      riskPerTradePct: 5,
      maxConcurrentPositions: 14,
      smallAccountMaxRiskPct: 10,
      minRiskReward: 1.5,
      atrPercentileMin: 15,
      atrPercentileMax: 90,
      efficiencyRatioMin: 0.15,
      minStopAtr: 1,
      maxPerAssetClass: 14,
      newsBlackoutBeforeMin: 30,
      newsBlackoutAfterMin: 30,
      maxSpreadCostPct: 0.5,
      maxPositionHoldHours: 96,
      lastEntryWeekday: 5,
      cotVeto: false,
      maxDailyLossPct: 5,
      minConfidence: 0.5,
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
        minRiskReward: Number(config.minRiskReward ?? 1.5),
        atrPercentileMin: Number(config.atrPercentileMin ?? 15),
        atrPercentileMax: Number(config.atrPercentileMax ?? 90),
        efficiencyRatioMin: Number(config.efficiencyRatioMin ?? 0.15),
        minStopAtr: Number(config.minStopAtr ?? 1),
        maxPerAssetClass: config.maxPerAssetClass ?? 14,
        newsBlackoutBeforeMin: config.newsBlackoutBeforeMin ?? 30,
        newsBlackoutAfterMin: config.newsBlackoutAfterMin ?? 30,
        maxSpreadCostPct: Number(config.maxSpreadCostPct ?? 0.5),
        maxPositionHoldHours: config.maxPositionHoldHours ?? 96,
        lastEntryWeekday: config.lastEntryWeekday ?? 5,
        cotVeto: config.cotVeto ?? false,
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
      // Your balance first, then rungs of the ladder — deduped so a $5 account
      // does not get its own row printed twice.
      const list = [...new Set([equity > 0 ? equity : null, 5, 20, 50, 200].filter((n): n is number => n != null))];
      const r = await fetch(`/api/config/stake-preview?equity=${list.join(",")}`, { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    },
  });

  const bandsQuery = useQuery<RiskBandsResponse>({
    queryKey: ["risk-bands", config?.updatedAt],
    queryFn: async () => {
      const r = await fetch("/api/config/risk-bands", { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    },
  });

  if (isLoading) return <Skeleton className="w-full h-96 rounded-xl" />;

  const enabled = form.watch("enabled");
  const mode = form.watch("autotradeMode");
  const riskPerTradePctValue = form.watch("riskPerTradePct");
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
              <thead><tr className="text-left text-muted-foreground uppercase tracking-wider"><th className="py-1 pr-4">Equity</th><th className="pr-3">Band</th><th className="pr-3">Risk</th><th className="pr-3">Stake</th><th className="pr-3">Contract</th><th className="pr-3">Typical loss</th><th className="pr-3">Worst case</th><th>At once</th></tr></thead>
              <tbody>
                {(stakeQuery.data ?? []).map((r, i) => (
                  <tr key={`${r.equity}-${i}`} className="border-t border-border" data-testid={`stake-row-${i}`}>
                    <td className="py-1 pr-4">${r.equity.toFixed(2)}{i === 0 && equity > 0 ? " (yours)" : ""}</td>
                    <td className="pr-3">{r.band ? BAND_LABEL[r.band] ?? r.band : "-"}</td>
                    <td className={`pr-3 ${r.riskCappedByBand ? "text-primary" : ""}`} title={r.riskCappedByBand ? "Tapered down from your saved setting by the balance band" : undefined}>
                      {r.riskPct != null ? `${r.riskPct}%` : "-"}{r.riskCappedByBand ? "\u2193" : ""}
                    </td>
                    <td className="pr-3">{r.ok && r.stake != null ? `$${r.stake.toFixed(2)}` : "skip"}</td>
                    <td className={`pr-3 ${r.contract === "binary" ? "text-amber-400" : ""}`}>
                      {r.contract ?? "-"}
                    </td>
                    <td className="pr-3">{r.typicalLoss != null ? `$${r.typicalLoss.toFixed(2)}` : "-"}</td>
                    <td className={`pr-3 ${r.worstCasePctOfEquity != null && r.worstCasePctOfEquity > 15 ? "text-amber-400" : ""}`}>
                      {r.worstCaseLoss != null ? `$${r.worstCaseLoss.toFixed(2)} (${r.worstCasePctOfEquity}%)` : (r.reason ?? "-")}
                    </td>
                    <td className={r.fundablePositions != null && r.configuredPositions != null && r.fundablePositions < r.configuredPositions ? "text-amber-400" : ""}>
                      {r.fundablePositions != null && r.configuredPositions != null
                        ? `${r.fundablePositions} of ${r.configuredPositions}`
                        : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-start gap-2 rounded-lg border border-border p-3 text-[11px] text-muted-foreground">
            <TrendingUp className="w-3.5 h-3.5 mt-0.5 shrink-0 text-primary" />
            <span>
              <strong className="text-foreground">Typical loss</strong> is the stop the order actually carries: 0.6% of price from
              entry, which at x100 is $0.60 plus Deriv's commission (about $0.02) on a $1.00 stake. If Deriv's minimum
              stop-loss is higher, the stop is widened to it, and a trade whose reward:risk then no longer clears your floor
              is not sent. <strong className="text-foreground">Worst case</strong> is a stop that gaps — capped at 80% of
              stake, where Deriv's own stop-out would otherwise take the whole stake. Every majority vote is traded at this
              stake, one position per pair, until only one stake of free balance is left; there is no daily-loss stop.
              The bot trades multipliers only, never binaries.
            </span>
          </div>
          {yourRow && !yourRow.ok && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-[11px] text-amber-400" data-testid="warn-no-trade">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>
                At ${equity.toFixed(2)} the bot does not trade: {yourRow.reason ?? "no stake survives the risk caps"}.
                It trades again as soon as an open trade closes and frees the stake.
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {bandsQuery.data && (
        <Card className="border-border">
          <CardHeader className="pb-3">
            <CardTitle className="uppercase tracking-wider text-sm flex items-center gap-2">
              <Layers className="w-4 h-4 text-primary" />
              Risk ladder
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              The most a stopped-out trade may lose, by balance. Your "Risk per trade" setting applies, and as the balance
              grows the ladder caps it lower; the lower of the two is what trades. It only ever tightens.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono-numbers">
                <thead><tr className="text-left text-muted-foreground uppercase tracking-wider"><th className="py-1 pr-4">Balance</th><th className="pr-3">Band</th><th className="pr-3">Risk / trade</th><th>Why</th></tr></thead>
                <tbody>
                  {bandsQuery.data.bands.map((b) => {
                    const active = equity > 0 && equity >= b.from && (b.to == null || equity < b.to);
                    return (
                      <tr key={b.band} className={`border-t border-border ${active ? "text-primary" : ""}`} data-testid={`band-${b.band}`}>
                        <td className="py-1 pr-4">
                          {b.to == null ? `$${b.from} +` : `$${b.from} – $${b.to}`}{active ? " ←" : ""}
                        </td>
                        <td className="pr-3">{BAND_LABEL[b.band] ?? b.band}</td>
                        <td className="pr-3">
                          {b.appliedRiskPct}%{b.appliedRiskPct < b.riskPct ? ` (yours, band allows ${b.riskPct}%)` : ""}
                        </td>
                        <td className="text-muted-foreground font-sans">{b.why}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Stakes track your balance automatically: every stake is a percentage of the equity synced from Deriv, so a
              win raises the next one and a loss lowers it, with no action from you. The ladder is what stops that
              compounding from turning into a $100 trade.
            </p>
          </CardContent>
        </Card>
      )}

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
                  {/*
                    The empty-value guard is load-bearing, not defensive noise.
                    Radix keeps a hidden native <select> whose <option>s come
                    from the items, and the items only exist once the menu has
                    been opened. This form mounts with hardcoded defaults and is
                    filled from the server afterwards by form.reset(), so a
                    saved "auto_demo" arrived when Radix had no option for it —
                    Radix then reported the mismatch back as onValueChange("")
                    and wiped the field a moment after reset set it. That is why
                    the mode looked blank after every reload while the server
                    had it saved correctly the whole time. No item has an empty
                    value, so "" can only ever be that spurious clear.
                  */}
                  <Select onValueChange={(v) => { if (v) field.onChange(v); }} value={field.value}>
                    <FormControl>
                      <SelectTrigger data-testid="select-autotrade-mode">
                        <SelectValue placeholder="Select a mode">{AUTOTRADE_LABEL[field.value]}</SelectValue>
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {(Object.keys(AUTOTRADE_LABEL) as Array<FormValues["autotradeMode"]>).map((m) => (
                        <SelectItem key={m} value={m}>{AUTOTRADE_LABEL[m]}</SelectItem>
                      ))}
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
                  <FormControl><Input type="number" step="1" min="1" max="100" {...field} data-testid="input-max-positions" /></FormControl>
                  <FormDescription className="text-[11px]">
                    14 (one per pair) means every majority vote opens a position until only one stake of free balance
                    is left — the "At once" column above shows how many that is at each balance. Lower it to cap how
                    many trades can be open together (the backtest's weekly cycle used 4).
                  </FormDescription>
                  {yourRow?.fundablePositions != null && yourRow.configuredPositions != null
                    && yourRow.fundablePositions < yourRow.configuredPositions && (
                    <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-400">
                      <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      <span>
                        At your current ${equity.toFixed(2)} balance only <strong>{yourRow.fundablePositions}</strong> of
                        these {yourRow.configuredPositions} can actually open
                        — each open trade holds its stake until it closes, and the balance pays for that many.
                      </span>
                    </div>
                  )}
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="minConfidence" render={({ field }) => (
                <FormItem>
                  <FormLabel>Poll agreement needed (0–1)</FormLabel>
                  <FormControl><Input type="number" step="0.01" min="0.5" max="1" {...field} data-testid="input-min-confidence" /></FormControl>
                  <FormDescription className="text-[11px]">
                    Each M30 close, 60 strategies (40 quantitative, 20 technical, each on its own timeframe) vote buy,
                    sell or abstain. The bot trades when at least this share of the strategies that voted agree, and at
                    least 30 of the 60 voted at all. 0.50 is simple majority — the tested default (a tie never trades);
                    0.70 would need 70%. It is a vote count, not a win probability.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="riskPerTradePct" render={({ field }) => (
                <FormItem>
                  <FormLabel>Risk per trade % (loss if stopped out)</FormLabel>
                  <FormControl><Input type="number" step="0.1" min="0" max="100" {...field} data-testid="input-risk-per-trade" /></FormControl>
                  <FormDescription className="text-[11px]">The share of your balance one trade loses if it hits its stop. The stake is sized from it: a $1.00 stake loses about $0.62 at the 0.6% stop, so 5% of a $20 balance ($1.00) gives a $1.61 stake. Never below Deriv's $1.00 multiplier minimum, so on a small balance the real loss can be higher than this. 5% was chosen by backtest: higher settings (bigger stakes) wiped out more small accounts.</FormDescription>
                  {Number(riskPerTradePctValue) > 8 && (
                    <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-400">
                      <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      <span>
                        At {Number(riskPerTradePctValue)}% a single stopped-out trade loses that much of the balance, and two can be
                        open at once. Above about 8% the stakes pass what the backtest's own edge can carry (the Kelly stake), and
                        small accounts were wiped out far more often.
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
              <CardTitle className="uppercase tracking-wider text-sm">Trade rules</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {([
                ["minRiskReward", "Reward:risk — the take-profit is this many times the stop (checked again at the fill, after commission)", "0.1"],
                ["maxPerAssetClass", "Max open positions per asset class — every pair is forex, so this is a second ceiling on open trades (14 = no extra limit)", "1"],
                ["newsBlackoutBeforeMin", "News blackout: minutes before a high-impact release", "1"],
                ["newsBlackoutAfterMin", "News blackout: minutes after a high-impact release", "1"],
                ["maxSpreadCostPct", "Max trading cost (% of position size, i.e. stake × multiplier) — Deriv's commission from a live quote of the exact order", "0.01"],
                ["maxPositionHoldHours", "Buy back any open position after this many hours if it has hit neither stop nor target (the poll was tested at 96 — four days; 120 holds to the Friday close, which always closes positions before Deriv's weekend)", "1"],
              ] as const).map(([name, label, step]) => (
                <FormField key={name} control={form.control} name={name} render={({ field }) => (
                  <FormItem>
                    <FormLabel>{label}</FormLabel>
                    <FormControl><Input type="number" step={step} {...field} data-testid={`input-${name}`} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              ))}
              <FormField control={form.control} name="lastEntryWeekday" render={({ field }) => (
                <FormItem>
                  <FormLabel>New trades open on</FormLabel>
                  <Select onValueChange={(v) => { if (v) field.onChange(Number(v)); }} value={String(field.value)}>
                    <FormControl>
                      <SelectTrigger data-testid="select-last-entry-weekday">
                        <SelectValue>{ENTRY_DAYS_LABEL[field.value] ?? "Every weekday"}</SelectValue>
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {[2, 1, 3, 4, 5].map((d) => <SelectItem key={d} value={String(d)}>{ENTRY_DAYS_LABEL[d]}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <FormDescription className="text-[11px]">
                    Weekly cycle (UTC days). Trades opened Monday–Tuesday had the whole week to work and earned most of the
                    backtest's profit; ones opened later were cut short by the Friday close. Open positions are never closed by this.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="cotVeto" render={({ field }) => (
                <FormItem className="flex flex-row items-start justify-between gap-4 rounded-lg border border-border p-3">
                  <div className="space-y-1">
                    <FormLabel>COT veto</FormLabel>
                    <FormDescription className="text-[11px]">
                      Skip a trade that would follow speculators when their positioning on the pair is at a 3-year extreme
                      (CFTC weekly report, used from the Monday after it). If the report cannot be fetched, every vote trades as before.
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} className="data-[state=checked]:bg-primary" data-testid="switch-cot-veto" />
                  </FormControl>
                </FormItem>
              )} />
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
                  <FormDescription className="text-[11px]">Forex only. Blank scans all 14 pairs Deriv offers multipliers on; synthetics, crypto and commodities are not traded or analyzed. Enter comma-separated forex symbols to narrow the scan.</FormDescription>
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
