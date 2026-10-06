# FX history from Yahoo Finance for the edge research: daily OHLC (15 years) and hourly OHLC (730 days, the
# most Yahoo serves) for the 14 traded pairs. Writes data/fx-1d.json and data/fx-1h.json:
# {pair: [[unix_seconds, o, h, l, c], ...]}. Daily bars are stamped at the bar's start (Yahoo's FX day starts
# 23:00 UTC in summer, 00:00 UTC in winter, i.e. midnight London).
import json, time, urllib.request
PAIRS = "EURUSD GBPUSD USDJPY AUDUSD USDCAD USDCHF EURGBP EURJPY EURAUD EURCAD EURCHF GBPAUD AUDJPY GBPJPY".split()
for interval, rng, name in [("1d", "15y", "fx-1d"), ("60m", "730d", "fx-1h")]:
  out = {}
  for p in PAIRS:
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{p}=X?interval={interval}&range={rng}"
    for attempt in range(3):
      try:
        d = json.load(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=60))["chart"]["result"][0]
        q = d["indicators"]["quote"][0]; rows = []
        for i, t in enumerate(d["timestamp"]):
          o, h, l, c = q["open"][i], q["high"][i], q["low"][i], q["close"][i]
          if None in (o, h, l, c) or min(o, h, l, c) <= 0: continue
          rows.append([t, round(o, 6), round(max(h, o, c), 6), round(min(l, o, c), 6), round(c, 6)])
        out[p] = rows; print(name, p, len(rows), flush=True); break
      except Exception as e:
        print(name, p, "error", e, flush=True); time.sleep(3)
    time.sleep(1.5)
  json.dump(out, open(f"data/{name}.json", "w"), separators=(",", ":"))
