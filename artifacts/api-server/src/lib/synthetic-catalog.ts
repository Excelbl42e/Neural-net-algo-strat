/**
 * Catalog of Deriv instruments exposed to the dashboard.
 *
 * Originally synthetic-only; now covers real-market FX, crypto and commodities
 * via the same Deriv WebSocket API. Each entry's `code` is exactly the symbol
 * Deriv expects in the `ticks: <code>` subscription frame and in the trade
 * `symbol` field.
 *
 * `tradeType`:
 *   - "multiplier" — uses MULTUP/MULTDOWN contracts (CFD-like, has SL/TP, holds
 *     until target/stop or manual close). Preferred for ICT-style strategies on
 *     real markets and supported synthetics.
 *   - "binary"     — uses CALL/PUT short-duration contracts. House edge applies.
 *     Used as fallback for synthetics where multipliers may be restricted.
 */
export interface SyntheticSymbol {
  /** Deriv WebSocket code (e.g. "R_75", "frxEURUSD", "cryBTCUSD"). */
  code: string;
  /** Display name shown in the dashboard. */
  display: string;
  /** UI grouping. */
  group:
    | "Volatility"
    | "Volatility (1s)"
    | "Boom"
    | "Crash"
    | "Jump"
    | "Step"
    | "Range Break"
    | "Forex"
    | "Crypto"
    | "Commodities";
  /** Number of decimal places for price formatting. */
  pipDecimals: number;
  /** Preferred contract style. Defaults to multiplier where supported. */
  tradeType: "multiplier" | "binary";
  /** Multiplier value to request when tradeType === "multiplier". */
  multiplier: number;
}

export const SYNTHETIC_CATALOG: SyntheticSymbol[] = [
  // ── REAL MARKETS — preferred for ICT/SMC trading ──────────────────────────
  // Forex majors + crosses (24/5, real institutional liquidity). Not
  // independently verified against Deriv's live active_symbols list from
  // this sandbox (no outbound network here) — if any one of these isn't
  // actually offered, it simply never gets candle data or trades; nothing
  // else breaks. Majors stay in DEFAULT_FEED_SYMBOLS for a fast boot
  // subscribe; the rest lazy-subscribe the first time the signal worker
  // scans them or a chart requests them.
  //
  // multiplier: 100 — live-verified. A real self-test run against
  // frxEURUSD returned ContractBuyValidationError/MultiplierOutOfRangeFrontOfficeError:
  // "Multiplier is not in acceptable range. Accepts 100,200,300,500,800."
  // 30 (this file's original value, presumably carried over from the
  // synthetic/volatility indices below, which have a different accepted
  // range) was never a valid forex multiplier on this account. 100 is the
  // lowest of Deriv's accepted tier, chosen deliberately: computeLimitOrder
  // in deriv.ts converts a price-based stop into a dollar stop_loss as
  // stake * multiplier * price_move_fraction, capped at 80% of stake — a
  // higher multiplier makes that cap clip a structurally-correct wide stop
  // more often, silently tightening it below what the quant gates actually
  // approved. Verified only for frxEURUSD; applied to the other forex
  // pairs by inference that Deriv's multiplier tiers are set per asset
  // class, not per symbol — not independently confirmed for each one.
  { code: "frxEURUSD", display: "EUR / USD", group: "Forex", pipDecimals: 5, tradeType: "multiplier", multiplier: 100 },
  { code: "frxGBPUSD", display: "GBP / USD", group: "Forex", pipDecimals: 5, tradeType: "multiplier", multiplier: 100 },
  { code: "frxUSDJPY", display: "USD / JPY", group: "Forex", pipDecimals: 3, tradeType: "multiplier", multiplier: 100 },
  { code: "frxAUDUSD", display: "AUD / USD", group: "Forex", pipDecimals: 5, tradeType: "multiplier", multiplier: 100 },
  { code: "frxUSDCAD", display: "USD / CAD", group: "Forex", pipDecimals: 5, tradeType: "multiplier", multiplier: 100 },
  { code: "frxGBPJPY", display: "GBP / JPY", group: "Forex", pipDecimals: 3, tradeType: "multiplier", multiplier: 100 },
  { code: "frxUSDCHF", display: "USD / CHF", group: "Forex", pipDecimals: 5, tradeType: "multiplier", multiplier: 100 },
  { code: "frxNZDUSD", display: "NZD / USD", group: "Forex", pipDecimals: 5, tradeType: "multiplier", multiplier: 100 },
  { code: "frxEURGBP", display: "EUR / GBP", group: "Forex", pipDecimals: 5, tradeType: "multiplier", multiplier: 100 },
  { code: "frxEURJPY", display: "EUR / JPY", group: "Forex", pipDecimals: 3, tradeType: "multiplier", multiplier: 100 },
  { code: "frxEURAUD", display: "EUR / AUD", group: "Forex", pipDecimals: 5, tradeType: "multiplier", multiplier: 100 },
  { code: "frxEURCAD", display: "EUR / CAD", group: "Forex", pipDecimals: 5, tradeType: "multiplier", multiplier: 100 },
  { code: "frxEURCHF", display: "EUR / CHF", group: "Forex", pipDecimals: 5, tradeType: "multiplier", multiplier: 100 },
  { code: "frxEURNZD", display: "EUR / NZD", group: "Forex", pipDecimals: 5, tradeType: "multiplier", multiplier: 100 },
  { code: "frxGBPAUD", display: "GBP / AUD", group: "Forex", pipDecimals: 5, tradeType: "multiplier", multiplier: 100 },
  { code: "frxGBPCAD", display: "GBP / CAD", group: "Forex", pipDecimals: 5, tradeType: "multiplier", multiplier: 100 },
  { code: "frxGBPCHF", display: "GBP / CHF", group: "Forex", pipDecimals: 5, tradeType: "multiplier", multiplier: 100 },
  { code: "frxGBPNZD", display: "GBP / NZD", group: "Forex", pipDecimals: 5, tradeType: "multiplier", multiplier: 100 },
  { code: "frxAUDJPY", display: "AUD / JPY", group: "Forex", pipDecimals: 3, tradeType: "multiplier", multiplier: 100 },
  { code: "frxAUDCAD", display: "AUD / CAD", group: "Forex", pipDecimals: 5, tradeType: "multiplier", multiplier: 100 },
  { code: "frxAUDCHF", display: "AUD / CHF", group: "Forex", pipDecimals: 5, tradeType: "multiplier", multiplier: 100 },
  { code: "frxAUDNZD", display: "AUD / NZD", group: "Forex", pipDecimals: 5, tradeType: "multiplier", multiplier: 100 },
  { code: "frxNZDJPY", display: "NZD / JPY", group: "Forex", pipDecimals: 3, tradeType: "multiplier", multiplier: 100 },
  { code: "frxNZDCAD", display: "NZD / CAD", group: "Forex", pipDecimals: 5, tradeType: "multiplier", multiplier: 100 },
  { code: "frxNZDCHF", display: "NZD / CHF", group: "Forex", pipDecimals: 5, tradeType: "multiplier", multiplier: 100 },
  { code: "frxCADJPY", display: "CAD / JPY", group: "Forex", pipDecimals: 3, tradeType: "multiplier", multiplier: 100 },
  { code: "frxCADCHF", display: "CAD / CHF", group: "Forex", pipDecimals: 5, tradeType: "multiplier", multiplier: 100 },
  { code: "frxCHFJPY", display: "CHF / JPY", group: "Forex", pipDecimals: 3, tradeType: "multiplier", multiplier: 100 },

  // Commodities
  { code: "frxXAUUSD", display: "Gold / USD",  group: "Commodities", pipDecimals: 2, tradeType: "multiplier", multiplier: 30 },
  { code: "frxXAGUSD", display: "Silver / USD", group: "Commodities", pipDecimals: 3, tradeType: "multiplier", multiplier: 30 },

  // Crypto (24/7, real exchanges)
  { code: "cryBTCUSD", display: "BTC / USD", group: "Crypto", pipDecimals: 2, tradeType: "multiplier", multiplier: 100 },
  { code: "cryETHUSD", display: "ETH / USD", group: "Crypto", pipDecimals: 2, tradeType: "multiplier", multiplier: 100 },

  // ── SYNTHETIC INDICES (Volatility / Boom / Crash / Jump / Step) ─────────
  // Primary trading instruments. ICT/CRT structure (liquidity sweeps, FVGs,
  // order blocks, premium/discount) applies cleanly because Deriv synthetics
  // are tick-uniform with no spread/news/session noise — making them well-
  // suited to systematic structure-based execution.
  // Standard volatility indices
  { code: "R_10",   display: "Volatility 10",   group: "Volatility", pipDecimals: 3, tradeType: "multiplier", multiplier: 30 },
  { code: "R_25",   display: "Volatility 25",   group: "Volatility", pipDecimals: 3, tradeType: "multiplier", multiplier: 30 },
  { code: "R_50",   display: "Volatility 50",   group: "Volatility", pipDecimals: 4, tradeType: "multiplier", multiplier: 30 },
  { code: "R_75",   display: "Volatility 75",   group: "Volatility", pipDecimals: 4, tradeType: "multiplier", multiplier: 30 },
  { code: "R_100",  display: "Volatility 100",  group: "Volatility", pipDecimals: 2, tradeType: "multiplier", multiplier: 30 },

  // 1-second volatility indices
  { code: "1HZ10V",  display: "Volatility 10 (1s)",  group: "Volatility (1s)", pipDecimals: 3, tradeType: "multiplier", multiplier: 30 },
  { code: "1HZ25V",  display: "Volatility 25 (1s)",  group: "Volatility (1s)", pipDecimals: 3, tradeType: "multiplier", multiplier: 30 },
  { code: "1HZ50V",  display: "Volatility 50 (1s)",  group: "Volatility (1s)", pipDecimals: 4, tradeType: "multiplier", multiplier: 30 },
  { code: "1HZ75V",  display: "Volatility 75 (1s)",  group: "Volatility (1s)", pipDecimals: 4, tradeType: "multiplier", multiplier: 30 },
  { code: "1HZ100V", display: "Volatility 100 (1s)", group: "Volatility (1s)", pipDecimals: 2, tradeType: "multiplier", multiplier: 30 },

  // Boom / Crash — binary only on most accounts
  { code: "BOOM300N",  display: "Boom 300",  group: "Boom",  pipDecimals: 4, tradeType: "binary", multiplier: 0 },
  { code: "BOOM500",   display: "Boom 500",  group: "Boom",  pipDecimals: 4, tradeType: "binary", multiplier: 0 },
  { code: "BOOM1000",  display: "Boom 1000", group: "Boom",  pipDecimals: 4, tradeType: "binary", multiplier: 0 },
  { code: "CRASH300N", display: "Crash 300",  group: "Crash", pipDecimals: 2, tradeType: "binary", multiplier: 0 },
  { code: "CRASH500",  display: "Crash 500",  group: "Crash", pipDecimals: 2, tradeType: "binary", multiplier: 0 },
  { code: "CRASH1000", display: "Crash 1000", group: "Crash", pipDecimals: 2, tradeType: "binary", multiplier: 0 },

  // Jump indices (binary)
  { code: "JD10",  display: "Jump 10",  group: "Jump", pipDecimals: 2, tradeType: "binary", multiplier: 0 },
  { code: "JD25",  display: "Jump 25",  group: "Jump", pipDecimals: 2, tradeType: "binary", multiplier: 0 },
  { code: "JD50",  display: "Jump 50",  group: "Jump", pipDecimals: 2, tradeType: "binary", multiplier: 0 },
  { code: "JD75",  display: "Jump 75",  group: "Jump", pipDecimals: 2, tradeType: "binary", multiplier: 0 },
  { code: "JD100", display: "Jump 100", group: "Jump", pipDecimals: 2, tradeType: "binary", multiplier: 0 },

  // Step / Range Break (binary)
  { code: "stpRNG", display: "Step Index",        group: "Step",        pipDecimals: 4, tradeType: "binary", multiplier: 0 },
  { code: "RDBEAR", display: "Bear Market Index", group: "Range Break", pipDecimals: 4, tradeType: "binary", multiplier: 0 },
  { code: "RDBULL", display: "Bull Market Index", group: "Range Break", pipDecimals: 4, tradeType: "binary", multiplier: 0 },
];

const BY_CODE: Map<string, SyntheticSymbol> = new Map(
  SYNTHETIC_CATALOG.map((s) => [s.code.toUpperCase(), s])
);

export function isSyntheticCode(code: string): boolean {
  return BY_CODE.has(code.toUpperCase());
}

export function getSyntheticSymbol(code: string): SyntheticSymbol | null {
  return BY_CODE.get(code.toUpperCase()) ?? null;
}

/**
 * Symbols the candle feeder subscribes to on boot.
 *
 * This used to be six majors, with everything else lazy-subscribing the first
 * time it was needed. But the signal worker scans every forex pair, and it
 * checks for a price tick in the same instant it subscribes — so on the first
 * scan after any restart, the other twenty-two pairs had no tick by
 * definition and were all dropped with "no price tick received yet". The next
 * scan is thirty minutes later, so a restart cost a full cycle across most of
 * the catalogue. Subscribing everything the worker can scan, at boot, means
 * ticks are already flowing when the first scan runs.
 */
export const DEFAULT_FEED_SYMBOLS = SYNTHETIC_CATALOG
  .filter((s) => s.group === "Forex")
  .map((s) => s.code);

/**
 * Asset-class exports are kept separate so enabling a market class in a
 * caller cannot silently expand the bot's conservative synthetic-only scan.
 */
export const ALL_TRADABLE_INSTRUMENTS = SYNTHETIC_CATALOG.map((s) => s.code);
export const ALL_SYNTHETIC_MARKETS = SYNTHETIC_CATALOG
  .filter((s) => !["Forex", "Crypto", "Commodities"].includes(s.group))
  .map((s) => s.code);
export const ALL_FOREX_INSTRUMENTS = SYNTHETIC_CATALOG
  .filter((s) => s.group === "Forex")
  .map((s) => s.code);
export const ALL_CRYPTO_INSTRUMENTS = SYNTHETIC_CATALOG
  .filter((s) => s.group === "Crypto")
  .map((s) => s.code);

export function isSyntheticMarketCode(code: string): boolean {
  const symbol = getSyntheticSymbol(code);
  return Boolean(symbol && !["Forex", "Crypto", "Commodities"].includes(symbol.group));
}

/** Only forex is traded and analyzed by the bot (synthetics/crypto/commodities are not). */
export function isForexCode(code: string): boolean {
  return getSyntheticSymbol(code)?.group === "Forex";
}
