# Monte Carlo of the owner's $10 account (Monday-only, every vote until one stake is left, 5% risk sizing,
# $1 minimum stake). Each simulated week is a real week of Monday-only trades drawn at random (with its whole
# trade list, so trades that move together stay together). Sources: the 3 years of the H1/H4 half-poll on
# Yahoo candles (Dec 2023 - Sep 2026), or only its 2 unseen years, or only the year the strategies were chosen on.
import json, random
W = json.load(open("data/monday-weeks.json"))
def pool(a, z): return [v for k, v in W.items() if a <= k < z]
SRC = {"all 3 years": pool("2023-12-01", "2026-10-01"), "unseen 2 years (Dec 23 - Nov 25)": pool("2023-12-01", "2025-11-10"), "chosen-on year (Nov 25 - Sep 26)": pool("2025-11-10", "2026-10-01")}
def week(bal, trades):
  cash, pnl = bal, 0.0
  for t in random.sample(trades, len(trades)):
    st = max(1.0, int(0.05 * bal / 0.62 * 100) / 100)
    if cash - st < st: continue
    cash -= st; pnl += st * t
  return bal + pnl
random.seed(7)
print("source".ljust(36), "weeks | after 4 weeks: median, P(>=$20), P(<=$5) | 12 weeks | 26 weeks | 52 weeks (balance kept and compounded)")
for name, P in SRC.items():
  res = {4: [], 12: [], 26: [], 52: []}
  for _ in range(10000):
    bal = 10.0
    for w in range(1, 53):
      if bal >= 2: bal = week(bal, random.choice(P))
      if w in res: res[w].append(bal)
  cells = []
  for w, xs in res.items():
    xs.sort(); n = len(xs); cells.append(f"${xs[n//2]:5.2f} {100*sum(x>=20 for x in xs)/n:4.1f}% {100*sum(x<=5 for x in xs)/n:4.1f}%")
  print(name.ljust(36), str(len(P)).rjust(5), "|", " | ".join(cells))
# withdrawing every Friday (start each week from $10)
print("\nwithdraw every Friday (each week starts at $10): average weekly result and weeks up")
for name, P in SRC.items():
  r = [week(10.0, wk) - 10 for wk in P]; print(name.ljust(36), f"avg ${sum(r)/len(r):+.2f}/week, up {100*sum(x>0 for x in r)/len(r):.0f}% of weeks, worst ${min(r):+.2f}, best ${max(r):+.2f}")
