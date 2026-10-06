// Fundamental voters: daily data (Yahoo Finance, CFTC COT, central-bank policy rates) turned into
// buy / sell / abstain votes for the 14 traded pairs. Every voter scores currencies; a pair's vote is
// the sign of (base score - quote score) when the gap clears the voter's threshold, else abstain.
// A value dated D (the trading day in its exchange's time zone) is used only from D+1.
import fs from "node:fs";

const DIR = new URL("./data", import.meta.url).pathname;
export const CCYS = ["USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF"] as const;
export type Ccy = (typeof CCYS)[number];
export const PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "EURGBP", "EURJPY", "EURAUD", "EURCAD", "EURCHF", "GBPAUD", "AUDJPY", "GBPJPY"];

const yahoo: Record<string, [string, number][]> = JSON.parse(fs.readFileSync(`${DIR}/yahoo.json`, "utf8"));
const rates: Record<string, [string, number][]> = JSON.parse(fs.readFileSync(`${DIR}/policy-rates.json`, "utf8"));

/** Trading calendar: every day with a EURUSD close. */
export const DAYS: string[] = yahoo["EURUSD=X"].map((r) => r[0]);
const dayIdx = new Map(DAYS.map((d, i) => [d, i]));

/** Daily close of a Yahoo symbol, carried forward onto DAYS (value on day i = last close dated <= DAYS[i]). */
export function series(sym: string): Float64Array {
  const rows = yahoo[sym]; const out = new Float64Array(DAYS.length).fill(NaN);
  if (!rows) return out;
  let j = 0, last = NaN;
  for (let i = 0; i < DAYS.length; i++) { while (j < rows.length && rows[j][0] <= DAYS[i]) { if (rows[j][1] > 0) last = rows[j][1]; j++; } out[i] = last; }
  return out;
}
/** Policy rate of a currency on each day. */
export function policyRate(ccy: Ccy): Float64Array {
  const tab = rates[ccy]; const out = new Float64Array(DAYS.length).fill(NaN); let j = 0, last = NaN;
  for (let i = 0; i < DAYS.length; i++) { while (j < tab.length && tab[j][0] <= DAYS[i]) { last = tab[j][1]; j++; } out[i] = last; }
  return out;
}
/** Price of one unit of `ccy` in USD, from the USD pairs. */
export function usdValue(ccy: Ccy): Float64Array {
  if (ccy === "USD") return new Float64Array(DAYS.length).fill(1);
  const direct: Record<string, [string, boolean]> = { EUR: ["EURUSD=X", false], GBP: ["GBPUSD=X", false], AUD: ["AUDUSD=X", false], JPY: ["USDJPY=X", true], CAD: ["USDCAD=X", true], CHF: ["USDCHF=X", true] };
  const [s, inv] = direct[ccy]; const p = series(s); return p.map((x) => (inv ? 1 / x : x));
}
export const pairPrice = (pair: string) => series(pair + "=X");

/** COT: net non-commercial positioning / open interest, per currency, usable from the Monday after the Tuesday report. */
export function cotNet(): Record<string, Float64Array> {
  const code: Record<string, Ccy> = { "099741": "EUR", "096742": "GBP", "097741": "JPY", "232741": "AUD", "090741": "CAD", "092741": "CHF" };
  const pts: Record<string, [string, number][]> = {};
  for (const r of JSON.parse(fs.readFileSync(new URL("../backtest/data/cot.json", import.meta.url).pathname, "utf8"))) {
    const c = code[r.cftc_contract_market_code]; if (!c) continue;
    const tue = Date.parse(r.report_date_as_yyyy_mm_dd.slice(0, 10) + "T00:00:00Z");
    const from = new Date(tue + 6 * 86_400_000).toISOString().slice(0, 10); // Monday after (the report is out Friday)
    (pts[c] ??= []).push([from, (+r.noncomm_positions_long_all - +r.noncomm_positions_short_all) / Math.max(1, +r.open_interest_all)]);
  }
  const out: Record<string, Float64Array> = {};
  for (const c of CCYS) {
    const a = new Float64Array(DAYS.length).fill(NaN); const p = (pts[c] ?? []).sort((x, y) => (x[0] < y[0] ? -1 : 1)); let j = 0, last = NaN;
    for (let i = 0; i < DAYS.length; i++) { while (j < p.length && p[j][0] <= DAYS[i]) { last = p[j][1]; j++; } a[i] = last; }
    out[c] = a;
  }
  return out;
}

// ── helpers ──────────────────────────────────────────────────────────────────
export const ret = (a: Float64Array, i: number, n: number) => (i - n >= 0 && a[i] > 0 && a[i - n] > 0 ? Math.log(a[i] / a[i - n]) : NaN);
export const chg = (a: Float64Array, i: number, n: number) => (i - n >= 0 && Number.isFinite(a[i]) && Number.isFinite(a[i - n]) ? a[i] - a[i - n] : NaN);
export function zLevel(a: Float64Array, i: number, n: number) {
  if (i < n) return NaN; let s = 0, s2 = 0, k = 0;
  for (let j = i - n + 1; j <= i; j++) { const v = a[j]; if (!Number.isFinite(v)) continue; s += v; s2 += v * v; k++; }
  if (k < n * 0.8) return NaN; const m = s / k, sd = Math.sqrt(Math.max(1e-18, s2 / k - m * m)); return (a[i] - m) / sd;
}
export function pctRank(a: Float64Array, i: number, n: number, step = 1) {
  if (i < n) return NaN; const x = a[i]; if (!Number.isFinite(x)) return NaN; let lo = 0, eq = 0, k = 0;
  for (let j = i - n; j < i; j += step) { const v = a[j]; if (!Number.isFinite(v)) continue; k++; if (v < x) lo++; else if (v === x) eq++; }
  return k < n / step * 0.7 ? NaN : (lo + 0.5 * eq) / k;
}

/** A fundamental voter: currency scores on day i (NaN/0 = no view) and the gap needed to vote. */
export type FundVoter = { id: string; family: string; summary: string; score: (i: number) => Partial<Record<Ccy, number>>; gap: number };

/** Vote of a voter for a pair on day i: +1 buy base, -1 sell base, 0 abstain. */
export function pairVote(v: FundVoter, pair: string, i: number, cache?: Map<number, Partial<Record<Ccy, number>>>): number {
  const sc = cache?.get(i) ?? v.score(i); cache?.set(i, sc);
  const b = sc[pair.slice(0, 3) as Ccy] ?? 0, q = sc[pair.slice(3, 6) as Ccy] ?? 0;
  if (!Number.isFinite(b) || !Number.isFinite(q)) return 0;
  const g = b - q; return g >= v.gap ? 1 : g <= -v.gap ? -1 : 0;
}

// ── the voters ───────────────────────────────────────────────────────────────
const R = Object.fromEntries(CCYS.map((c) => [c, policyRate(c)])) as Record<Ccy, Float64Array>;
const V = Object.fromEntries(CCYS.map((c) => [c, usdValue(c)])) as Record<Ccy, Float64Array>;
const COT = cotNet();
const S = (sym: string) => series(sym);
const oil = S("CL=F"), copper = S("HG=F"), gold = S("GC=F"), iron = S("TIO=F"), china = S("000001.SS"), hsi = S("^HSI"), cny = S("CNY=X");
const vix = S("^VIX"), spx = S("^GSPC"), nik = S("^N225"), dax = S("^GDAXI"), stoxx = S("^STOXX50E"), ftse = S("^FTSE"), asx = S("^AXJO"), tsx = S("^GSPTSE"), smi = S("^SSMI"), dxy = S("DX-Y.NYB");
const irx = S("^IRX"), fvx = S("^FVX"), tnx = S("^TNX"), zt = S("ZT=F");
const each = (f: (c: Ccy) => number) => Object.fromEntries(CCYS.map((c) => [c, f(c)])) as Record<Ccy, number>;
/** Risk sensitivity: + gains in risk-off. */
const RISK: Record<Ccy, number> = { JPY: 1, CHF: 1, USD: 0.5, EUR: 0, GBP: -0.5, CAD: -0.5, AUD: -1 };
const riskOff = (on: number) => (on === 0 ? {} : each((c) => RISK[c] * on));
const thr = (x: number, t: number) => (!Number.isFinite(x) ? 0 : x > t ? 1 : x < -t ? -1 : 0);
const NONUSD: Ccy[] = ["EUR", "GBP", "JPY", "AUD", "CAD", "CHF"];

export const FUND_VOTERS: FundVoter[] = [
  // carry: interest-rate gap (policy rates)
  { id: "carry_any", family: "carry", summary: "Buys the higher-rate currency when policy rates differ by 0.25pp or more.", gap: 0.25, score: (i) => each((c) => R[c][i]) },
  { id: "carry_1pp", family: "carry", summary: "Carry when the rate gap is at least 1pp.", gap: 1, score: (i) => each((c) => R[c][i]) },
  { id: "carry_2_5pp", family: "carry", summary: "Carry only for big gaps (2.5pp+).", gap: 2.5, score: (i) => each((c) => R[c][i]) },
  // rate path: which central bank has been hiking or cutting
  { id: "rate_path_3m", family: "rate_path", summary: "Buys the currency whose policy rate rose more over 3 months.", gap: 0.25, score: (i) => each((c) => chg(R[c], i, 63)) },
  { id: "rate_path_6m", family: "rate_path", summary: "Rate path over 6 months (gap 0.5pp).", gap: 0.5, score: (i) => each((c) => chg(R[c], i, 126)) },
  { id: "rate_path_12m", family: "rate_path", summary: "Rate path over 12 months (gap 0.75pp).", gap: 0.75, score: (i) => each((c) => chg(R[c], i, 252)) },
  // US yields (USD legs)
  { id: "us_3m_yield_20d", family: "us_yields", summary: "US 3-month bill yield up 0.15pp+ in 20 days -> USD up.", gap: 1, score: (i) => ({ USD: thr(chg(irx, i, 20), 0.15) }) },
  { id: "us_5y_yield_20d", family: "us_yields", summary: "US 5-year yield up 0.15pp+ in 20 days -> USD up.", gap: 1, score: (i) => ({ USD: thr(chg(fvx, i, 20), 0.15) }) },
  { id: "us_10y_yield_20d", family: "us_yields", summary: "US 10-year yield up 0.15pp+ in 20 days -> USD up.", gap: 1, score: (i) => ({ USD: thr(chg(tnx, i, 20), 0.15) }) },
  { id: "us_10y_yield_60d", family: "us_yields", summary: "US 10-year yield up 0.3pp+ in 60 days -> USD up.", gap: 1, score: (i) => ({ USD: thr(chg(tnx, i, 60), 0.3) }) },
  { id: "us_curve_20d", family: "us_yields", summary: "US curve (10y - 3m) steepening 0.15pp+ in 20 days -> USD up.", gap: 1, score: (i) => ({ USD: thr(chg(tnx, i, 20) - chg(irx, i, 20), 0.15) }) },
  // value: far from the long-run average against USD -> expect a pull back
  { id: "value_5y", family: "value", summary: "Fades a currency more than 1 sd above or below its 5-year average (vs USD).", gap: 1, score: (i) => each((c) => (c === "USD" ? 0 : -zLevel(V[c], i, 1260))) },
  { id: "value_3y", family: "value", summary: "Value over 3 years (gap 1 sd).", gap: 1, score: (i) => each((c) => (c === "USD" ? 0 : -zLevel(V[c], i, 756))) },
  { id: "value_1y_extreme", family: "value", summary: "Fades 2-sd extremes against the 1-year average.", gap: 2, score: (i) => each((c) => (c === "USD" ? 0 : -zLevel(V[c], i, 252))) },
  // COT positioning
  { id: "cot_fade_3y", family: "cot", summary: "Fades speculators at a 3-year positioning extreme (top/bottom 10%).", gap: 1, score: (i) => each((c) => (c === "USD" ? 0 : -thr(pctRank(COT[c], i, 780, 5) - 0.5, 0.4))) },
  { id: "cot_fade_1y", family: "cot", summary: "Fades a 1-year positioning extreme.", gap: 1, score: (i) => each((c) => (c === "USD" ? 0 : -thr(pctRank(COT[c], i, 260, 5) - 0.5, 0.4))) },
  { id: "cot_flow_4w", family: "cot", summary: "Follows a big 4-week change in speculator positioning.", gap: 1, score: (i) => each((c) => (c === "USD" ? 0 : thr(chg(COT[c], i, 20) / 0.08, 1))) },
  { id: "cot_flow_13w", family: "cot", summary: "Follows a big 13-week change in positioning.", gap: 1, score: (i) => each((c) => (c === "USD" ? 0 : thr(chg(COT[c], i, 65) / 0.12, 1))) },
  { id: "cot_follow_mid", family: "cot", summary: "Follows speculators when they lean one way but are not yet extreme (65-90th percentile).", gap: 1, score: (i) => each((c) => { if (c === "USD") return 0; const p = pctRank(COT[c], i, 780, 5); return p >= 0.65 && p <= 0.9 ? 1 : p <= 0.35 && p >= 0.1 ? -1 : 0; }) },
  // oil
  { id: "oil_cad_20d", family: "oil", summary: "Oil up 5%+ in 20 days -> CAD up (down 5% -> CAD down).", gap: 1, score: (i) => ({ CAD: thr(ret(oil, i, 20), 0.05) }) },
  { id: "oil_cad_5d", family: "oil", summary: "Oil 3%+ move in 5 days -> CAD with it.", gap: 1, score: (i) => ({ CAD: thr(ret(oil, i, 5), 0.03) }) },
  { id: "oil_cad_60d", family: "oil", summary: "Oil 10%+ move in 60 days -> CAD with it.", gap: 1, score: (i) => ({ CAD: thr(ret(oil, i, 60), 0.1) }) },
  { id: "oil_importers_20d", family: "oil", summary: "Oil up 5%+ in 20 days -> EUR and JPY (energy importers) down.", gap: 1, score: (i) => { const o = thr(ret(oil, i, 20), 0.05); return { EUR: -o, JPY: -o }; } },
  // metals and China -> AUD
  { id: "copper_aud_20d", family: "metals_china", summary: "Copper 4%+ move in 20 days -> AUD with it.", gap: 1, score: (i) => ({ AUD: thr(ret(copper, i, 20), 0.04) }) },
  { id: "iron_ore_aud_20d", family: "metals_china", summary: "Iron ore 5%+ move in 20 days -> AUD with it.", gap: 1, score: (i) => ({ AUD: thr(ret(iron, i, 20), 0.05) }) },
  { id: "gold_aud_20d", family: "metals_china", summary: "Gold 3%+ move in 20 days -> AUD with it (gold exporter).", gap: 1, score: (i) => ({ AUD: thr(ret(gold, i, 20), 0.03) }) },
  { id: "gold_chf_20d", family: "metals_china", summary: "Gold 3%+ move in 20 days -> CHF with it (both havens).", gap: 1, score: (i) => ({ CHF: thr(ret(gold, i, 20), 0.03) }) },
  { id: "china_stocks_aud_20d", family: "metals_china", summary: "Shanghai stocks 4%+ move in 20 days -> AUD with it.", gap: 1, score: (i) => ({ AUD: thr(ret(china, i, 20), 0.04) }) },
  { id: "hang_seng_aud_20d", family: "metals_china", summary: "Hang Seng 4%+ move in 20 days -> AUD with it.", gap: 1, score: (i) => ({ AUD: thr(ret(hsi, i, 20), 0.04) }) },
  { id: "yuan_aud_20d", family: "metals_china", summary: "Yuan 1%+ weaker in 20 days -> AUD down (stronger -> AUD up).", gap: 1, score: (i) => ({ AUD: -thr(ret(cny, i, 20), 0.01) }) },
  // risk mood
  { id: "vix_high", family: "risk", summary: "VIX more than 1 sd above its 1-year average: risk-off (JPY, CHF up; AUD down).", gap: 1, score: (i) => riskOff(thr(zLevel(vix, i, 252), 1)) },
  { id: "vix_jump_5d", family: "risk", summary: "VIX up 20%+ in 5 days: risk-off; down 20%: risk-on.", gap: 1, score: (i) => riskOff(thr(ret(vix, i, 5), 0.2)) },
  { id: "spx_20d", family: "risk", summary: "S&P 500 4%+ move in 20 days: risk-on if up (AUD up, JPY down).", gap: 1, score: (i) => riskOff(-thr(ret(spx, i, 20), 0.04)) },
  { id: "spx_5d", family: "risk", summary: "S&P 500 2%+ move in 5 days: risk-on or off.", gap: 1, score: (i) => riskOff(-thr(ret(spx, i, 5), 0.02)) },
  { id: "nikkei_jpy_20d", family: "risk", summary: "Nikkei 5%+ up in 20 days -> JPY down (and the reverse).", gap: 1, score: (i) => ({ JPY: -thr(ret(nik, i, 20), 0.05) }) },
  // equity flows: a market beating the S&P draws money into its currency
  { id: "dax_eur_rel_20d", family: "equity_flows", summary: "DAX beats the S&P by 3%+ over 20 days -> EUR up.", gap: 1, score: (i) => ({ EUR: thr(ret(dax, i, 20) - ret(spx, i, 20), 0.03) }) },
  { id: "stoxx_eur_rel_60d", family: "equity_flows", summary: "Euro Stoxx 50 beats the S&P by 5%+ over 60 days -> EUR up.", gap: 1, score: (i) => ({ EUR: thr(ret(stoxx, i, 60) - ret(spx, i, 60), 0.05) }) },
  { id: "ftse_gbp_rel_20d", family: "equity_flows", summary: "FTSE beats the S&P by 3%+ over 20 days -> GBP up.", gap: 1, score: (i) => ({ GBP: thr(ret(ftse, i, 20) - ret(spx, i, 20), 0.03) }) },
  { id: "asx_aud_rel_20d", family: "equity_flows", summary: "ASX 200 beats the S&P by 3%+ over 20 days -> AUD up.", gap: 1, score: (i) => ({ AUD: thr(ret(asx, i, 20) - ret(spx, i, 20), 0.03) }) },
  { id: "tsx_cad_rel_20d", family: "equity_flows", summary: "TSX beats the S&P by 3%+ over 20 days -> CAD up.", gap: 1, score: (i) => ({ CAD: thr(ret(tsx, i, 20) - ret(spx, i, 20), 0.03) }) },
  { id: "smi_chf_rel_20d", family: "equity_flows", summary: "SMI beats the S&P by 3%+ over 20 days -> CHF up.", gap: 1, score: (i) => ({ CHF: thr(ret(smi, i, 20) - ret(spx, i, 20), 0.03) }) },
  { id: "dollar_index_60d", family: "equity_flows", summary: "Dollar index 3%+ move in 60 days -> USD with it.", gap: 1, score: (i) => ({ USD: thr(ret(dxy, i, 60), 0.03) }) },
  // variants added before the out-of-sample check (directions are chosen on 2012-2022 only)
  { id: "cot_flow_2w", family: "cot", summary: "Big 2-week change in speculator positioning.", gap: 1, score: (i) => each((c) => (c === "USD" ? 0 : thr(chg(COT[c], i, 10) / 0.06, 1))) },
  { id: "cot_flow_8w", family: "cot", summary: "Big 8-week change in speculator positioning.", gap: 1, score: (i) => each((c) => (c === "USD" ? 0 : thr(chg(COT[c], i, 40) / 0.1, 1))) },
  { id: "rate_path_1m", family: "rate_path", summary: "Policy-rate change over the last month.", gap: 0.25, score: (i) => each((c) => chg(R[c], i, 21)) },
  { id: "copper_aud_5d", family: "metals_china", summary: "Copper 2%+ move in 5 days, for AUD.", gap: 1, score: (i) => ({ AUD: thr(ret(copper, i, 5), 0.02) }) },
  { id: "copper_aud_60d", family: "metals_china", summary: "Copper 8%+ move in 60 days, for AUD.", gap: 1, score: (i) => ({ AUD: thr(ret(copper, i, 60), 0.08) }) },
  { id: "china_stocks_aud_60d", family: "metals_china", summary: "Shanghai stocks 8%+ move in 60 days, for AUD.", gap: 1, score: (i) => ({ AUD: thr(ret(china, i, 60), 0.08) }) },
  { id: "spx_10d", family: "risk", summary: "S&P 500 3%+ move in 10 days (risk-on/off).", gap: 1, score: (i) => riskOff(-thr(ret(spx, i, 10), 0.03)) },
  { id: "spx_60d", family: "risk", summary: "S&P 500 8%+ move in 60 days (risk-on/off).", gap: 1, score: (i) => riskOff(-thr(ret(spx, i, 60), 0.08)) },
  { id: "vix_high_3m", family: "risk", summary: "VIX 1 sd above its 3-month average (risk-off).", gap: 1, score: (i) => riskOff(thr(zLevel(vix, i, 63), 1)) },
  { id: "oil_cad_10d", family: "oil", summary: "Oil 4%+ move in 10 days, for CAD.", gap: 1, score: (i) => ({ CAD: thr(ret(oil, i, 10), 0.04) }) },
  { id: "us_2y_note_20d", family: "us_yields", summary: "US 2-year note futures down 0.5%+ in 20 days (yields up) -> USD up.", gap: 1, score: (i) => ({ USD: -thr(ret(zt, i, 20), 0.005) }) },
  { id: "dax_eur_rel_60d", family: "equity_flows", summary: "DAX vs S&P over 60 days (5%+ gap), for EUR.", gap: 1, score: (i) => ({ EUR: thr(ret(dax, i, 60) - ret(spx, i, 60), 0.05) }) },
  { id: "ftse_gbp_rel_60d", family: "equity_flows", summary: "FTSE vs S&P over 60 days (5%+ gap), for GBP.", gap: 1, score: (i) => ({ GBP: thr(ret(ftse, i, 60) - ret(spx, i, 60), 0.05) }) },
  { id: "asx_aud_rel_60d", family: "equity_flows", summary: "ASX 200 vs S&P over 60 days (5%+ gap), for AUD.", gap: 1, score: (i) => ({ AUD: thr(ret(asx, i, 60) - ret(spx, i, 60), 0.05) }) },
  { id: "tsx_cad_rel_60d", family: "equity_flows", summary: "TSX vs S&P over 60 days (5%+ gap), for CAD.", gap: 1, score: (i) => ({ CAD: thr(ret(tsx, i, 60) - ret(spx, i, 60), 0.05) }) },
  { id: "smi_chf_rel_60d", family: "equity_flows", summary: "SMI vs S&P over 60 days (5%+ gap), for CHF.", gap: 1, score: (i) => ({ CHF: thr(ret(smi, i, 60) - ret(spx, i, 60), 0.05) }) },
  { id: "nikkei_jpy_60d", family: "risk", summary: "Nikkei 8%+ move in 60 days, for JPY.", gap: 1, score: (i) => ({ JPY: -thr(ret(nik, i, 60), 0.08) }) },
  { id: "gold_copper_risk_20d", family: "risk", summary: "Gold beating copper by 5%+ over 20 days (risk-off).", gap: 1, score: (i) => riskOff(thr(ret(gold, i, 20) - ret(copper, i, 20), 0.05)) },
];
export { NONUSD };
