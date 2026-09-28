import { useListReports, useGetLatestScoring } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Report } from "@workspace/api-client-react";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export default function ReportsPage() {
  const { data: reports, isLoading, isError, refetch } = useListReports();
  const { data: scoring, isLoading: scoringLoading, isError: scoringError } = useGetLatestScoring();

  if (isLoading || scoringLoading) {
    return <Skeleton className="w-full h-96 rounded-xl" />;
  }
  if (isError) return <div className="border border-amber-500/30 rounded-lg p-6 text-sm">Reports unavailable. <button className="underline" onClick={() => refetch()}>Retry</button></div>;

  const dailyReports = reports?.filter(r => r.type === 'daily') || [];
  const monthlyReports = reports?.filter(r => r.type === 'monthly') || [];
  const scores = scoring ? safeScores(scoring.scores) : {};
  const hasAssessment = !!scoring
    && !!reports?.some(report => report.period === scoring.period)
    && Object.keys(scores).length > 0
    && Number.isFinite(scoring.totalScore);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold uppercase tracking-wider border-b border-border pb-4">Performance Reports</h1>

      {hasAssessment && scoring ? (
        <Card className="border-primary/30 bg-primary/5 mb-8">
          <CardHeader className="pb-2 border-b border-primary/10">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-mono-numbers uppercase tracking-widest text-primary">Latest Stored Scoring Result</CardTitle>
              <Badge variant="outline" className={cn("uppercase text-xs", scoring.enterpriseViable ? "text-green-500 border-green-500/50" : "text-red-500 border-red-500/50")}>
                {scoring.enterpriseViable ? 'PASSED' : 'FAILED'}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="pt-4 flex items-center justify-between">
            <div className="text-4xl font-bold font-mono-numbers text-foreground">
              {scoring.totalScore} <span className="text-lg text-muted-foreground">threshold {scoring.threshold ?? "not provided"}</span>
            </div>
            <div className="flex gap-4">
               {Object.entries(scores).map(([k, v]) => (
                 <div key={k} className="flex flex-col items-center justify-center bg-card p-3 rounded border border-border min-w-[80px]">
                   <span className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1">{k.replace(/([A-Z])/g, ' $1').trim()}</span>
                   <span className={cn("font-mono-numbers text-lg font-bold", v >= 4 ? "text-primary" : v >= 3 ? "text-yellow-500" : "text-red-500")}>{v}</span>
                 </div>
               ))}
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-border bg-card/50 mb-8">
          <CardContent className="p-5">
            <div className="text-sm font-semibold">No assessment available</div>
            <p className="text-xs text-muted-foreground mt-1">{scoringError ? "The scoring endpoint is unavailable; report records below remain accessible." : "No stored scoring result is associated with an available report. No score or pass/fail assessment can be inferred."}</p>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="daily" className="w-full">
        <TabsList className="grid w-[400px] grid-cols-2 bg-muted/20 border border-border">
          <TabsTrigger value="daily" className="font-mono-numbers uppercase tracking-wider text-xs data-[state=active]:bg-card">Daily</TabsTrigger>
          <TabsTrigger value="monthly" className="font-mono-numbers uppercase tracking-wider text-xs data-[state=active]:bg-card">Monthly</TabsTrigger>
        </TabsList>
        <TabsContent value="daily" className="mt-4 space-y-4">
          {dailyReports.map(report => <ReportCard key={report.id} report={report} />)}
          {dailyReports.length === 0 && <div className="text-muted-foreground text-sm py-4">No daily reports available.</div>}
        </TabsContent>
        <TabsContent value="monthly" className="mt-4 space-y-4">
          {monthlyReports.map(report => <ReportCard key={report.id} report={report} />)}
          {monthlyReports.length === 0 && <div className="text-muted-foreground text-sm py-4">No monthly reports available.</div>}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function safeScores(raw: string): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
    }
  } catch { /* malformed stored score */ }
  return {};
}

function ReportCard({ report }: { report: Report }) {
  const pnlIsPositive = report.totalPnl >= 0;

  return (
    <Card className="border-border">
      <CardHeader className="py-3 px-4 border-b border-border bg-muted/10 flex flex-row items-center justify-between">
        <div className="font-mono-numbers text-sm font-bold tracking-wider">{report.period}</div>
        <div className={cn("font-mono-numbers text-sm font-bold", pnlIsPositive ? "text-green-500" : "text-red-500")}>
          {pnlIsPositive ? '+' : ''}${report.totalPnl.toLocaleString()}
        </div>
      </CardHeader>
      <CardContent className="p-4 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4">
        <Metric label="Win Rate" value={`${(report.winRate * 100).toFixed(1)}%`} highlight={report.winRate > 0.5} />
        <Metric label="Trades" value={report.tradesCount} />
        <Metric label="Max Drawdown" value={report.maxDrawdown ? `${(report.maxDrawdown * 100).toFixed(2)}%` : '---'} highlight={false} isNegative={(report.maxDrawdown || 0) > 0.05} />
        <Metric label="Risk/Reward" value={report.riskReward?.toFixed(2) || '---'} highlight={(report.riskReward || 0) > 1.5} />
        {/* Not tracked anywhere in this codebase — no underlying measurement exists, so this is never rendered as a real value. */}
        <Metric label="Strategy Adherence" value="Not tracked" highlight={false} />
        <Metric label="Gambling Score" value="Not tracked" highlight={false} />
      </CardContent>
    </Card>
  );
}

function Metric({ label, value, highlight, isNegative }: { label: string, value: string | number, highlight?: boolean, isNegative?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] text-muted-foreground uppercase font-mono-numbers tracking-widest mb-1 truncate" title={label}>{label}</span>
      <span className={cn(
        "font-mono-numbers text-sm font-medium",
        highlight ? "text-primary" : isNegative ? "text-red-500" : "text-foreground"
      )}>
        {value}
      </span>
    </div>
  );
}
