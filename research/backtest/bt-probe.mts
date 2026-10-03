import { openPublic } from "./bt-derivws.mts";
const c = await openPublic();
for (const d of ["2026-10-02", "2026-10-05", "2026-11-06", "2026-12-04", "2027-01-08", "2027-03-05", "2027-04-02"]) {
  const t = await c.req({ trading_times: d });
  if (t.error) { console.log(d, t.error.message); continue; }
  const syms = t.trading_times.markets.flatMap((m: any) => m.submarkets.flatMap((s: any) => s.symbols));
  const pick = ["frxEURUSD", "frxUSDJPY", "frxGBPAUD", "frxAUDJPY"].map((u) => syms.find((s: any) => s.underlying_symbol === u));
  console.log(d, new Date(d + "T12:00:00Z").toUTCString().slice(0, 3), pick.map((s: any) => `${s?.underlying_symbol}: open ${s?.times?.open} close ${s?.times?.close}`).join(" | "));
}
c.close(); process.exit(0);
