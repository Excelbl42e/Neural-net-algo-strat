// "Liquidity -> VWAP -> structure" day-trading rule (from a video the owner shared), on M30 Deriv forex.
// Deriv forex candles carry no volume, so "VWAP" is the session's time-weighted average of the typical
// price (h+l+c)/3 anchored at 00:00 UTC (what any VWAP becomes when every bar has equal weight).
// Buy setup (sell is the mirror):
//   1. Sweep: during London/NY (07:00-17:00 UTC) a bar trades below a liquidity level: previous day low
//      or the Asian-session (00:00-07:00) low. Variant: the bar must also close back above the level.
//   2. VWAP reclaim: within the next W bars a bar closes above the session VWAP.
//   3. Structure shift: at or after the reclaim (still within W bars of the sweep) a bar closes above the
//      swing high, the highest high of the 6 bars before the sweep. All three in this order, else no trade.
// Entry at the next bar's open. Stop just beyond the sweep extreme (lowest low since the sweep), target
// R x the risk, flat at 20:00 UTC. One trade per pair per day. Results in R (multiples of the risk, after
// commission) and as % of equity at the bot's 5% risk. Also tried: only in the direction of the trend
// (the video's "continuation"), and as a 61st voter in the poll with the live 4-day rules.
import { m30, SYMS, SPLIT, START, LIVE, decisions, runPairs, summary, rollingRuns, aligned } from "./book-lib.mts";
import { commissionBps } from "./cand-lib.mts";

type T = { gross: number; risk: number; s: string; t: number; d: number; R: number; eqPct: number; part: string; reason: string };
const H = 3600_000;
function setups(opt: { W: number; R: number; closeBack: boolean; trend: number; levels: "both" | "pd" | "asia" }) {
  const out: T[] = []; const votes: Record<string, Int8Array> = {};
  for (const s of SYMS) {
    const b = m30[s], n = b.t.length, v = new Int8Array(n); votes[s] = v;
    // daily EMA of closes for the trend variant (20 days), updated at each day's last bar
    let ema = b.c[0], day = -1, pdh = NaN, pdl = NaN, dh = -Infinity, dl = Infinity, ah = -Infinity, al = Infinity, vw = 0, vn = 0, traded = false;
    let pend: { d: number; k: number; ext: number; swing: number; reclaimed: boolean } | null = null;
    for (let i = 7; i < n - 1; i++) {
      const dt = new Date(b.t[i]), dd = Math.floor(b.t[i] / (24 * H)), hr = dt.getUTCHours();
      if (dd !== day) { if (day >= 0) { pdh = dh; pdl = dl; ema = ema + (2 / 21) * (b.c[i - 1] - ema); } day = dd; dh = -Infinity; dl = Infinity; ah = -Infinity; al = Infinity; vw = 0; vn = 0; traded = false; pend = null; }
      dh = Math.max(dh, b.h[i]); dl = Math.min(dl, b.l[i]); vw += (b.h[i] + b.l[i] + b.c[i]) / 3; vn++; const vwap = vw / vn;
      if (hr < 7) { ah = Math.max(ah, b.h[i]); al = Math.min(al, b.l[i]); continue; }
      if (b.t[i] < START - 30 * 24 * H || !Number.isFinite(pdh) || traded || hr >= 17) continue;
      // 1. sweep (a new sweep replaces a pending one)
      const lowLv = opt.levels === "pd" ? [pdl] : opt.levels === "asia" ? [al] : [pdl, al], highLv = opt.levels === "pd" ? [pdh] : opt.levels === "asia" ? [ah] : [pdh, ah];
      let sw6h = -Infinity, sw6l = Infinity; for (let k = i - 6; k < i; k++) { sw6h = Math.max(sw6h, b.h[k]); sw6l = Math.min(sw6l, b.l[k]); }
      if (lowLv.some((L) => Number.isFinite(L) && b.l[i] < L && (!opt.closeBack || b.c[i] > L))) pend = { d: 1, k: i, ext: b.l[i], swing: sw6h, reclaimed: false };
      else if (highLv.some((L) => Number.isFinite(L) && b.h[i] > L && (!opt.closeBack || b.c[i] < L))) pend = { d: -1, k: i, ext: b.h[i], swing: sw6l, reclaimed: false };
      if (!pend) continue;
      if (i - pend.k > opt.W) { pend = null; continue; }
      const p = pend; p.ext = p.d > 0 ? Math.min(p.ext, b.l[i]) : Math.max(p.ext, b.h[i]);
      // 2. VWAP reclaim, 3. structure shift (same bar allowed, reclaim first)
      if (!p.reclaimed && p.d * (b.c[i] - vwap) > 0) p.reclaimed = true;
      if (!p.reclaimed || p.d * (b.c[i] - p.swing) <= 0) continue;
      if (opt.trend && p.d * (b.c[i] - ema) * opt.trend < 0) continue; // trend: 1 = only with the daily trend
      traded = true; pend = null;
      for (let k = i; k < Math.min(n, i + 8); k++) v[k] = p.d; // as a voter: speaks for 4 hours after the setup
      if (b.t[i] < START || b.t[i + 1] - b.t[i] > 1800_000) continue;
      const e0 = b.o[i + 1], comm = commissionBps(b.t[i + 1]) / 100, stop = p.ext - p.d * 0.0001 * e0, risk = Math.abs(e0 - stop) / e0 * 100; // % move to stop
      if (risk <= 0.02 || p.d * (e0 - stop) <= 0) continue;
      const tp = e0 + p.d * opt.R * Math.abs(e0 - stop); let px = NaN, reason = "";
      for (let j = i + 1; j < n; j++) { const h2 = new Date(b.t[j]).getUTCHours();
        if (p.d > 0 ? b.l[j] <= stop : b.h[j] >= stop) { px = stop; reason = "stop"; } else if (p.d > 0 ? b.h[j] >= tp : b.l[j] <= tp) { px = tp; reason = "target"; }
        else if (h2 >= 20 || Math.floor(b.t[j] / (24 * H)) !== dd) { px = b.o[j]; reason = "day end"; }
        if (reason) break; }
      if (!reason) continue;
      const pct = p.d * (px - e0) / e0 * 100 - comm;
      out.push({ s, t: b.t[i], d: p.d, gross: (pct + comm) / risk, risk, R: pct / risk, eqPct: 5 * pct / (risk + comm), part: b.t[i] < SPLIT ? "sel" : "test", reason });
    }
  }
  return { trades: out, votes };
}
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const line = (t: T[]) => { const g = (p: string) => { const a = t.filter((x) => x.part === p); return `${p} n ${String(a.length).padStart(4)} win ${(100 * a.filter((x) => x.R > 0).length / (a.length || 1)).toFixed(0).padStart(2)}% avg ${mean(a.map((x) => x.R)).toFixed(3).padStart(6)}R (${mean(a.map((x) => x.eqPct)).toFixed(2).padStart(5)}% of equity)`; };
  return `${g("sel")} | ${g("test")} | trades/day ${(t.length / 230).toFixed(1)}`; };

console.log("== Sweep -> VWAP reclaim -> structure shift, own exits (stop beyond the sweep, flat 20:00 UTC) ==");
const base = { W: 8, R: 2, closeBack: false, trend: 0, levels: "both" as const };
const grid: [string, Partial<typeof base>][] = [
  ["video rule: 4h window, 2R", {}], ["target 1.5R", { R: 1.5 }], ["target 3R", { R: 3 }], ["window 2h", { W: 4 }], ["window 8h", { W: 16 }],
  ["sweep must close back inside", { closeBack: true }], ["previous-day levels only", { levels: "pd" }], ["Asian-session levels only", { levels: "asia" }],
  ["only with the daily trend", { trend: 1 }], ["only against the daily trend", { trend: -1 }], ["close back + with trend + 1.5R", { closeBack: true, trend: 1, R: 1.5 }],
];
let best: { name: string; votes: Record<string, Int8Array>; sel: number } | null = null;
for (const [name, o] of grid) { const r = setups({ ...base, ...o }); console.log(name.padEnd(34), line(r.trades));
  const sel = mean(r.trades.filter((x) => x.part === "sel").map((x) => x.R)); if (!best || sel > best.sel) best = { name, votes: r.votes, sel }; }
const vr = setups(base).trades; console.log(`video rule before commission: avg ${mean(vr.map((x) => x.gross)).toFixed(3)}R; median distance to stop ${[...vr.map((x) => x.risk)].sort((a, b) => a - b)[vr.length >> 1].toFixed(3)}% (commission 0.02-0.06%)`); console.log("exits (video rule):", ["stop", "target", "day end"].map((k) => `${k} ${Math.round(100 * vr.filter((x) => x.reason === k).length / vr.length)}%`).join(", "));

console.log(`\n== As a 61st voter in the live poll (setting with the best Nov-Jun result: ${best!.name}) ==`);
for (const s of SYMS) aligned.M30[s]["vwap_sweep"] = best!.votes[s];
const live = decisions(LIVE), plus = decisions([...LIVE, { id: "vwap_sweep", tf: "M30" }]);
console.log("live poll".padEnd(24), summary(runPairs(live)));
console.log("+ vwap_sweep".padEnd(24), summary(runPairs(plus)));
for (const days of [12, 26]) { console.log("$10 live ".padEnd(24), days, rollingRuns(live, days)); console.log("$10 + vwap_sweep".padEnd(24), days, rollingRuns(plus, days)); }
