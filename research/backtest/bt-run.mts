/**
 * Backtest: replays real Deriv candles through the bot's own decision code
 * (preTradeGate, runExpertJudge, geometryGate, verifyClaims, planEntry,
 * setupInvalidation, forexPreScanGate) on the live schedule, then simulates
 * entry on the retrace and the bracket on M5 bars.
 */
import fs from "node:fs";
import {
  atrPercentile, efficiencyRatio, geometryGate, premiumDiscount, runExpertJudge, verifyClaims,
  type OHLC, type QuantThresholds,
} from "../../artifacts/api-server/src/lib/quant-filters.ts";
import { planEntry } from "../../artifacts/api-server/src/lib/execution-risk.ts";
import { forexPreScanGate } from "../../artifacts/api-server/src/lib/forex-readiness.ts";

const SRC = new URL("./data", import.meta.url).pathname + "/candles.json";
const raw: Record<string, Record<string, number[][]>> = JSON.parse(fs.readFileSync(SRC, "utf8"));
const TF_S: Record<string, number> = { M5: 300, M30: 1800, H1: 3600, H4: 14400 };
type Bar = OHLC & { t: number };
const series: Record<string, Record<string, Bar[]>> = {};
for (const [sym, tfs] of Object.entries(raw)) {
  series[sym] = {};
  for (const [tf, rows] of Object.entries(tfs)) {
    series[sym][tf] = rows.filter((r) => r[0] % TF_S[tf] === 0)
      .map((r) => ({ t: r[0] * 1000, open: r[1], high: r[2], low: r[3], close: r[4] }));
  }
}
const SYMBOLS = Object.keys(series);

// Index of the first bar whose open time is >= ms (binary search).
function firstAtOrAfter(bars: Bar[], ms: number): number {
  let lo = 0, hi = bars.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (bars[mid].t < ms) lo = mid + 1; else hi = mid; }
  return lo;
}
// Last n bars fully closed by `nowMs`.
function closedWindow(bars: Bar[], tf: string, nowMs: number, n: number): Bar[] {
  const end = firstAtOrAfter(bars, nowMs - TF_S[tf] * 1000 + 1); // bars with t + len <= now
  return bars.slice(Math.max(0, end - n), end);
}

const START = Date.parse("2026-07-01T00:00:00Z");
const END = Date.parse("2026-09-30T21:00:00Z");
const HALF_HOUR = 30 * 60_000;
const MIN_CONFIDENCE = 0.70;
const KILLZONES = "london,newyork";

// ── 1) Candidates: everything that does not depend on the tunable thresholds ──
interface Candidate {
  sym: string; t: number; atrPct: number; er: number;
  dir: "buy" | "sell"; lo: number; hi: number; stop: number; target: number;
  rrMid: number; riskAtr: number; pdOk: boolean; claimsOk: boolean; confidence: number;
}
const candidates: Candidate[] = [];
const whereAt: Record<string, number> = {};
const preOnly: { sym: string; t: number; atrPct: number; er: number }[] = [];
let judgeDeclines: Record<string, number> = {};
for (let t = START + 20_000; t < END; t += HALF_HOUR) {
  const now = new Date(t);
  if (!forexPreScanGate({ symbol: "frxEURUSD", now, killzones: KILLZONES, newsEvents: [], newsBlackoutBeforeMin: 0, newsBlackoutAfterMin: 0 }).ok) continue;
  for (const sym of SYMBOLS) {
    const s = series[sym];
    const h1 = closedWindow(s.H1, "H1", t, 250);
    const m30 = closedWindow(s.M30, "M30", t, 150);
    const h4 = closedWindow(s.H4, "H4", t, 30).map(({ open, high, low, close }) => ({ open, high, low, close }));
    if (h1.length < 220 || m30.length < 100 || h4.length < 10) continue;
    const vol = atrPercentile(h1);
    const er = efficiencyRatio(h1.map((k) => k.close), 10);
    if (!vol || er == null) continue;
    preOnly.push({ sym, t, atrPct: vol.percentile, er });
    const declined = { reason: "" };
    const r = runExpertJudge(h1, m30, h4, MIN_CONFIDENCE, new Set(), declined);
    if (!r) { const k = declined.reason.split(":")[0].replace(/[0-9.]+/g, "#"); judgeDeclines[k] = (judgeDeclines[k] ?? 0) + 1; continue; }
    if (r.entryLow == null || r.entryHigh == null || r.stopLevel == null || r.target1Level == null) continue;
    const entryMid = (r.entryLow + r.entryHigh) / 2;
    const pd = premiumDiscount(h1, entryMid, 2, r.direction);
    const big = { atrPercentileMin: 0, atrPercentileMax: 101, efficiencyRatioMin: 0, minRiskReward: 0, minStopAtr: 1, maxPerAssetClass: 99 } as QuantThresholds;
    const geo = geometryGate({ direction: r.direction, entry: entryMid, stop: r.stopLevel, target: r.target1Level }, vol.atr, pd, big);
    const m30Atr = atrPercentile(m30)?.atr ?? vol.atr / 2;
    const h4Atr = atrPercentile(h4)?.atr ?? vol.atr * 2;
    const claimsOk = r.levels.filter((l) => l.kind === "fvg" || l.kind === "sweep").every((l) =>
      verifyClaims([l], m30, m30Atr).ok || verifyClaims([l], h1, vol.atr).ok || verifyClaims([l], h4, h4Atr).ok);
    const risk = Math.abs(entryMid - r.stopLevel), reward = Math.abs(r.target1Level - entryMid);
    candidates.push({
      sym, t, atrPct: vol.percentile, er, dir: r.direction, lo: r.entryLow, hi: r.entryHigh,
      stop: r.stopLevel, target: r.target1Level, rrMid: reward / risk, riskAtr: risk / vol.atr,
      pdOk: geo.ok, claimsOk, confidence: r.confidence,
    });
  }
}

fs.writeFileSync(new URL("./data", import.meta.url).pathname + "/candidates.json", JSON.stringify(candidates));
// ── 2) Per-variant simulation ─────────────────────────────────────────────────
interface Variant {
  name: string; atrMax: number; erMin: number; minRR: number; commission: number; maxHoldH: number; onePosition: boolean;
  /** Reward:risk the geometry gate demands from the FVG midpoint (0 = gate off). Defaults to minRR, as live. */
  geoRR?: number; minStopAtr?: number; usePd?: boolean;
  /** Trim the entry zone to the side of the stop it can actually be entered from. */
  fixZone?: boolean;
  /** Multipliers to try in order when the order is infeasible at the first (Deriv's $0.10 minimums). */
  multipliers?: number[];
}
interface Trade { sym: string; dir: string; signalAt: number; fillAt: number; exitAt: number; pnl: number; outcome: "target" | "stop" | "timeout" | "gap"; rr: number; mult?: number; riskUsd?: number }

function simulate(v: Variant) {
  const geoRR = v.geoRR ?? v.minRR, minStopAtr = v.minStopAtr ?? 1, usePd = v.usePd ?? true;
  const passes = (c: Candidate) => c.atrPct >= 15 && c.atrPct <= v.atrMax && c.er >= v.erMin
    && c.riskAtr >= minStopAtr && c.rrMid >= geoRR && (!usePd || c.pdOk) && c.claimsOk;
  const signals = candidates.filter(passes).sort((a, b) => a.t - b.t);
  const trades: Trade[] = [];
  const lastSignalAt: Record<string, number> = {};
  let accepted = 0, filled = 0, cancelled = 0, expired = 0, superseded = 0, noRoom = 0;
  const why: Record<string, number> = {};
  // Pending signals are resolved one at a time in time order; with
  // onePosition, a fill is skipped while another trade is open.
  let busyUntil = 0;
  const bySym: Record<string, Candidate[]> = {};
  for (const c of signals) {
    if (lastSignalAt[c.sym] != null && c.t - lastSignalAt[c.sym] < 60 * 60_000) continue; // 60-min cooldown
    lastSignalAt[c.sym] = c.t;
    (bySym[c.sym] ??= []).push(c);
    accepted++;
  }
  const events: { c: Candidate; until: number }[] = [];
  for (const list of Object.values(bySym)) {
    for (let i = 0; i < list.length; i++) {
      const next = list[i + 1];
      events.push({ c: list[i], until: Math.min(list[i].t + 24 * 3600_000, next ? next.t : Infinity) });
    }
  }
  events.sort((a, b) => a.c.t - b.c.t);
  const resolved: { fillAt: number; trade: Trade }[] = [];
  for (const { c, until } of events) {
    const m5 = series[c.sym].M5;
    const buy = c.dir === "buy";
    let i = firstAtOrAfter(m5, Math.ceil(c.t / 300_000) * 300_000);
    let lo = c.lo, hi = c.hi;
    if (v.fixZone) {
      const eps = Math.abs(c.hi - c.lo) * 1e-3 + 1e-7;
      if (buy) { lo = Math.max(lo, c.stop + eps); hi = Math.min(hi, c.target - eps); }
      else { hi = Math.min(hi, c.stop - eps); lo = Math.max(lo, c.target + eps); }
      if (!(lo < hi)) { expired++; continue; }
    }
    // Highest (buy) / lowest (sell) price in the zone where planEntry enters,
    // at the smallest multiplier that makes the order feasible.
    let plan = (_p: number): any => ({ action: "wait" });
    let pStar: number | null = null;
    let mult = 100;
    for (const m of v.multipliers ?? [100]) {
      const commissionUsd = v.commission * m / 100;
      const bracket = { stake: 1, multiplier: m, minStopUsd: 0.10, minTakeProfitUsd: 0.10, maxStopFraction: 0.8, commissionUsd };
      const pl = (p: number) => planEntry({ direction: c.dir, price: p, entryLow: lo, entryHigh: hi, stop: c.stop, target: c.target, minRiskReward: v.minRR, bracket });
      const step = (hi - lo) / 200 || 1e-5;
      for (let k = 0; k <= 200; k++) {
        const p = buy ? hi - k * step : lo + k * step;
        if (pl(p).action === "enter") { pStar = p; break; }
      }
      if (pStar != null) { plan = pl; mult = m; break; }
    }
    const commissionNow = v.commission * mult / 100;
    if (process.env.BT_WHY && v.name.startsWith("J")) {
      const first = m5[i];
      const where = !first ? "nodata" : buy
        ? (first.open >= c.target ? "already past target" : first.open > c.hi ? "above zone" : first.open >= c.lo ? "in zone" : first.open > c.stop ? "below zone" : "past stop")
        : (first.open <= c.target ? "already past target" : first.open < c.lo ? "below zone" : first.open <= c.hi ? "in zone" : first.open < c.stop ? "above zone" : "past stop");
      whereAt[where] = (whereAt[where] ?? 0) + 1;
      if (pStar == null) whereAt["(pStar null)"] = (whereAt["(pStar null)"] ?? 0) + 1;
    }
    let fill: { at: number; price: number; idx: number } | null = null;
    let endState: "expired" | "cancelled" | "superseded" = until < c.t + 24 * 3600_000 ? "superseded" : "expired";
    for (; i < m5.length && m5[i].t < until; i++) {
      const b = m5[i];
      // Over before entry: stop traded through or target reached (cancel).
      if (buy ? b.low <= c.stop || b.high >= c.target : b.high >= c.stop || b.low <= c.target) {
        // A bar that reaches the fill price on its way to the stop fills first.
        const reachesFill = pStar != null && (buy ? b.low <= pStar : b.high >= pStar) && !(buy ? b.high >= c.target : b.low <= c.target);
        if (!reachesFill) {
          endState = "cancelled";
          const k = pStar == null ? "no fillable price in zone" : (buy ? b.high >= c.target : b.low <= c.target) ? "target reached before entry" : "stop traded through before entry";
          why[k] = (why[k] ?? 0) + 1;
          break;
        }
      }
      if (pStar == null) continue;
      const gate = forexPreScanGate({ symbol: c.sym, now: new Date(b.t), killzones: KILLZONES, newsEvents: [], newsBlackoutBeforeMin: 0, newsBlackoutAfterMin: 0 });
      if (!gate.ok) continue;
      const openOk = buy ? b.open <= pStar && b.open > c.stop : b.open >= pStar && b.open < c.stop;
      if (openOk) { fill = { at: b.t, price: b.open, idx: i }; break; }
      if (buy ? b.low <= pStar : b.high >= pStar) { fill = { at: b.t, price: pStar, idx: i }; break; }
    }
    if (!fill) { if (endState === "cancelled") cancelled++; else if (endState === "superseded") superseded++; else expired++; continue; }
    const p = plan(fill.price);
    if (p.action !== "enter") { expired++; continue; }
    const usdPerUnit = mult / fill.price;
    // Walk the position.
    let exit: Trade | null = null;
    for (let j = fill.idx; j < m5.length; j++) {
      const b = m5[j];
      const gapOpen = j > fill.idx && b.t - m5[j - 1].t > 30 * 60_000; // weekend / market gap
      if (gapOpen) {
        const pnlAtOpen = (buy ? b.open - fill.price : fill.price - b.open) * usdPerUnit - commissionNow;
        if (buy ? b.open <= p.stopPrice : b.open >= p.stopPrice) { exit = { sym: c.sym, dir: c.dir, signalAt: c.t, fillAt: fill.at, exitAt: b.t, pnl: Math.max(-1, pnlAtOpen), outcome: "gap", rr: p.rr }; break; }
        if (buy ? b.open >= p.targetPrice : b.open <= p.targetPrice) { exit = { sym: c.sym, dir: c.dir, signalAt: c.t, fillAt: fill.at, exitAt: b.t, pnl: pnlAtOpen, outcome: "gap", rr: p.rr }; break; }
      }
      const hitStop = buy ? b.low <= p.stopPrice : b.high >= p.stopPrice;
      const hitTarget = j > fill.idx && (buy ? b.high >= p.targetPrice : b.low <= p.targetPrice);
      if (hitStop) { exit = { sym: c.sym, dir: c.dir, signalAt: c.t, fillAt: fill.at, exitAt: b.t, pnl: -p.stopLossUsd!, outcome: "stop", rr: p.rr }; break; }
      if (hitTarget) { exit = { sym: c.sym, dir: c.dir, signalAt: c.t, fillAt: fill.at, exitAt: b.t, pnl: p.takeProfitUsd!, outcome: "target", rr: p.rr }; break; }
      if (b.t - fill.at >= v.maxHoldH * 3600_000) {
        const pnl = (buy ? b.close - fill.price : fill.price - b.close) * usdPerUnit - commissionNow;
        exit = { sym: c.sym, dir: c.dir, signalAt: c.t, fillAt: fill.at, exitAt: b.t + 300_000, pnl, outcome: "timeout", rr: p.rr }; break;
      }
    }
    if (exit) { exit.mult = mult; exit.riskUsd = p.stopLossUsd; resolved.push({ fillAt: fill.at, trade: exit }); }
  }
  resolved.sort((a, b) => a.fillAt - b.fillAt);
  for (const r of resolved) {
    if (v.onePosition && r.fillAt < busyUntil) { noRoom++; continue; }
    trades.push(r.trade); filled++;
    busyUntil = r.trade.exitAt;
  }
  if (process.env.BT_WHY) console.error(v.name, JSON.stringify(why));
  return { accepted, filled, cancelled, expired, superseded, noRoom, trades };
}

function summarize(name: string, r: ReturnType<typeof simulate>) {
  const t = r.trades;
  const wins = t.filter((x) => x.pnl > 0).length;
  const net = t.reduce((s, x) => s + x.pnl, 0);
  let peak = 0, eq = 0, dd = 0;
  for (const x of [...t].sort((a, b) => a.exitAt - b.exitAt)) { eq += x.pnl; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const by = (o: string) => t.filter((x) => x.outcome === o).length;
  return {
    variant: name, signals: r.accepted, trades: t.length,
    target: by("target"), stop: by("stop"), timeout: by("timeout"), gap: by("gap"),
    winRate: t.length ? +(100 * wins / t.length).toFixed(1) : 0,
    netUsd: +net.toFixed(2), perTrade: t.length ? +(net / t.length).toFixed(3) : 0, maxDrawdownUsd: +dd.toFixed(2),
    avgRiskUsd: t.length ? +(t.reduce((s2, x) => s2 + (x.riskUsd ?? 0), 0) / t.length).toFixed(2) : 0,
    netR: +t.reduce((s2, x) => s2 + x.pnl / (x.riskUsd || 1), 0).toFixed(2),
    mults: Object.entries(t.reduce((m: Record<string, number>, x) => { m[String(x.mult)] = (m[String(x.mult)] ?? 0) + 1; return m; }, {})).map(([k, n]) => `x${k}:${n}`).join(" "),
    notFilled: { cancelled: r.cancelled, expired: r.expired, superseded: r.superseded, oneAtATime: r.noRoom },
  };
}

const base = { atrMax: 90, erMin: 0.15, minRR: 2, commission: 0.02, maxHoldH: 36, onePosition: false };
const FIX = { fixZone: true, multipliers: [100, 200, 300, 500, 800] };
const variants: Variant[] = [
  { name: "A  current settings", ...base },
  { name: "B  volatility cap 95", ...base, atrMax: 95 },
  { name: "C  chop 0.10", ...base, erMin: 0.10 },
  { name: "B+C both loosened", ...base, atrMax: 95, erMin: 0.10 },
  { name: "D  min reward:risk 1.5", ...base, minRR: 1.5 },
  { name: "E  no premium/discount rule", ...base, usePd: false },
  { name: "F  E + reward:risk judged at the fill", ...base, usePd: false, geoRR: 0 },
  { name: "H  F with reward:risk 1.5", ...base, usePd: false, geoRR: 0, minRR: 1.5 },
  { name: "J  take every setup (RR 1.0)", ...base, atrMax: 101, erMin: 0, usePd: false, geoRR: 0, minStopAtr: 0, minRR: 1.0 },
];
const results = variants.map((v) => summarize(v.name, simulate(v)));
const five = variants.map((v) => summarize(v.name, simulate({ ...v, onePosition: true })));
const pricier = variants.map((v) => summarize(v.name + " @$0.04", simulate({ ...v, commission: 0.04 })));
const hold24 = variants.map((v) => summarize(v.name + " hold 24h", simulate({ ...v, maxHoldH: 24 })));
// Month-by-month for every variant: does any edge hold up, or is it one lucky month?
const monthly: Record<string, Record<string, { n: number; net: number }>> = {};
for (const v of variants) {
  const r = simulate(v);
  for (const t of r.trades) {
    const m = new Date(t.fillAt).toISOString().slice(0, 7);
    const row = (monthly[v.name] ??= {});
    const cell = (row[m] ??= { n: 0, net: 0 });
    cell.n++; cell.net = +(cell.net + t.pnl).toFixed(2);
  }
}
const scansInZone = preOnly.length;
const atrBlocked90 = preOnly.filter((p) => p.atrPct > 90).length, atrBlocked95 = preOnly.filter((p) => p.atrPct > 95).length;
const erBlocked15 = preOnly.filter((p) => p.er < 0.15).length, erBlocked10 = preOnly.filter((p) => p.er < 0.10).length;
const out = {
  period: `${new Date(START).toISOString().slice(0, 10)} .. ${new Date(END).toISOString().slice(0, 10)}`,
  pairScans: scansInZone, judgeCandidates: candidates.length,
  filterShare: { atrAbove90: atrBlocked90, atrAbove95: atrBlocked95, erBelow015: erBlocked15, erBelow010: erBlocked10 },
  topJudgeDeclines: Object.entries(judgeDeclines).sort((a, b) => b[1] - a[1]).slice(0, 8),
  independent: results, fiveDollarAccount: five, pricier, hold24, monthly,
};
if (process.env.BT_WHY) console.error("J: price at signal time", JSON.stringify(whereAt));
fs.writeFileSync(new URL("./data", import.meta.url).pathname + "/results.json", JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
