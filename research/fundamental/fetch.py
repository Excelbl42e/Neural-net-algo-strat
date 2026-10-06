# Daily closes from Yahoo Finance for the fundamental voters (FX spot, currency futures, rates,
# volatility, commodities, stock indices). Writes data/yahoo.json: {symbol: [[YYYY-MM-DD, close], ...]},
# where the date is the trading day in the exchange's own time zone. Rows: [YYYY-MM-DD, close].
import json, time, urllib.request, datetime, sys
SYMS = [
  # FX spot (the 14 traded pairs) and USD crosses needed for the currency legs
  *[p + "=X" for p in "EURUSD GBPUSD USDJPY AUDUSD USDCAD USDCHF EURGBP EURJPY EURAUD EURCAD EURCHF GBPAUD AUDJPY GBPJPY".split()],
  "CNY=X", "DX-Y.NYB",
  # CME currency futures (front month): basis to spot = interest-rate differential vs USD
  "6E=F", "6J=F", "6B=F", "6A=F", "6C=F", "6S=F",
  # US rates
  "^IRX", "^FVX", "^TNX", "^TYX", "ZT=F", "SR3=F",
  # risk and commodities
  "^VIX", "CL=F", "BZ=F", "HG=F", "GC=F", "SI=F", "TIO=F", "NG=F",
  # stock indices
  "^GSPC", "^N225", "^GDAXI", "^STOXX50E", "^FTSE", "^AXJO", "^GSPTSE", "^SSMI", "000001.SS", "^HSI",
]
out = {}
for s in SYMS:
  url = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(s)}?interval=1d&range=15y"
  for attempt in range(3):
    try:
      req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
      d = json.load(urllib.request.urlopen(req, timeout=30))["chart"]["result"][0]
      off = d["meta"].get("gmtoffset", 0); q = d["indicators"]["quote"][0]; rows = []
      for i, t in enumerate(d.get("timestamp", [])):
        c = q["close"][i]
        if c is None: continue
        day = datetime.datetime.utcfromtimestamp(t + off).strftime("%Y-%m-%d")
        rows.append([day, round(c, 6)])
      out[s] = rows; print(s, len(rows), rows[0][0] if rows else "-", rows[-1][0] if rows else "-", flush=True); break
    except Exception as e:
      print(s, "error", e, flush=True); time.sleep(3)
  time.sleep(1.5)
json.dump(out, open("data/yahoo.json", "w"))
