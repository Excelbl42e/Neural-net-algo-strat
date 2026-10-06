// Weekly polls on 15 years of daily candles (owner's cycle: Friday close signal, Monday open -> Friday close,
// live stop/target). Electorates fixed in advance or chosen on 2011-2019 only; results per year 2020-2026.
import fs from "node:fs";
const V: Record<string, Record<string, number[]>> = JSON.parse(fs.readFileSync(new URL("./data/weekly-votes.json", import.meta.url).pathname, "utf8"));
const S: any[] = JSON.parse(fs.readFileSync(new URL("./data/weekly-score.json", import.meta.url).pathname, "utf8"));
const PAIRS = Object.keys(V);
const LIVE = S.filter((r) => r.sig.startsWith("s:")).slice(0); const liveIds = new Set((await import("../../artifacts/api-server/src/lib/poll-strategies.ts")).STRATEGIES.map((s: any) => "s:" + s.id));
type E = { sig: string; dir: number }[];
function run(name: string, el: E, quorumFrac = 0.5) {
  const q = Math.ceil(el.length * quorumFrac); const byYear = new Map<number, number[]>(); const weekly = new Map<number, number>();
  for (const p of PAIRS) { const v = V[p]; for (let k = 0; k < v.weeks.length; k++) { let b = 0, s = 0; for (const e of el) { const x = v[e.sig][k] * e.dir; if (x > 0) b++; else if (x < 0) s++; } if (b + s < q || b === s) continue; const d = b > s ? 1 : -1; const pnl = d > 0 ? v.live[k] : v.liveS[k]; const y = new Date(v.weeks[k]).getUTCFullYear(); (byYear.get(y) ?? byYear.set(y, []).get(y)!).push(pnl); weekly.set(v.weeks[k], (weekly.get(v.weeks[k]) ?? 0) + pnl); } }
  const yrs = [...byYear.keys()].sort(); const m = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const sel = yrs.filter((y) => y < 2020).flatMap((y) => byYear.get(y)!), te = yrs.filter((y) => y >= 2020).flatMap((y) => byYear.get(y)!);
  const tw = [...weekly.entries()].filter(([t]) => new Date(t).getUTCFullYear() >= 2020).map(([, x]) => x), twm = m(tw), tsd = Math.sqrt(tw.reduce((a, b) => a + (b - twm) ** 2, 0) / Math.max(1, tw.length - 1));
  console.log(`${name.padEnd(42)} ${String(el.length).padStart(3)} | 2011-19 $${m(sel).toFixed(3).padStart(6)} (${sel.length}) | 2020-26 $${m(te).toFixed(3).padStart(6)} (${te.length}) t ${(twm / (tsd / Math.sqrt(tw.length))).toFixed(1).padStart(4)} | ${yrs.filter((y) => y >= 2020).map((y) => `${y % 100}:${m(byYear.get(y)!).toFixed(2)}`).join(" ")}`);
}
const fol = (ids: string[]): E => ids.map((sig) => ({ sig, dir: 1 }));
run("live 60 strategies on daily candles", fol([...liveIds]));
run("live 40 quant on daily", fol([...liveIds].filter((x) => !["s:rsi_reversal", "s:macd_histogram", "s:ema_cross", "s:bollinger_reversion", "s:stochastic_cross", "s:adx_dmi", "s:ichimoku", "s:keltner_breakout", "s:roc_momentum", "s:williams_r", "s:cci_cross", "s:donchian_breakout", "s:parabolic_sar", "s:pivot_points", "s:fib_macd", "s:supertrend", "s:aroon", "s:heikin_ashi", "s:trix", "s:vortex"].includes(x))));
run("all 120 strategies on daily", fol(S.filter((r) => r.sig.startsWith("s:")).map((r) => r.sig)));
run("all 193 signals (follow)", fol(S.map((r) => r.sig)), 0.3);
for (const k of [10, 20, 40]) run(`top ${k} by 2011-19 t (own direction)`, S.slice(0, k).map((r) => ({ sig: r.sig, dir: r.dir })), 0.3);
run("signals with 2011-19 t >= 1 (own dir)", S.filter((r) => r.selT >= 1).map((r) => ({ sig: r.sig, dir: r.dir })), 0.3);
run("fundamental only, 2011-19 t >= 0.5", S.filter((r) => r.sig.startsWith("f:") && r.selT >= 0.5).map((r) => ({ sig: r.sig, dir: r.dir })), 0.2);
run("classic factors (follow)", fol(S.filter((r) => r.sig.startsWith("c:")).map((r) => r.sig)), 0.3);
