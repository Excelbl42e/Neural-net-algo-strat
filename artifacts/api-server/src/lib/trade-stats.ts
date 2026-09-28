/** Shared, real trade-history statistics — no placeholder/fabricated numbers. */

/** Peak-to-trough drawdown of the cumulative closed-trade P&L curve, as a fraction of current equity. */
export function computeMaxDrawdown(
  closedTrades: { pnl: string | null; closedAt: Date | null }[],
  totalEquity: number,
): number {
  if (closedTrades.length === 0) return 0;

  const sorted = [...closedTrades].sort((a, b) => {
    const ta = a.closedAt ? new Date(a.closedAt).getTime() : 0;
    const tb = b.closedAt ? new Date(b.closedAt).getTime() : 0;
    return ta - tb;
  });

  let runningPnl = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of sorted) {
    runningPnl += parseFloat(t.pnl ?? "0");
    if (runningPnl > peak) peak = runningPnl;
    const dd = peak - runningPnl;
    if (dd > maxDd) maxDd = dd;
  }
  if (maxDd === 0) return 0;

  const denominator = totalEquity > 0 ? totalEquity : peak > 0 ? peak : 1;
  return maxDd / denominator;
}
