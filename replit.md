# NeuralTrade (Algo-Strategist)

Private trading desk. Read this file to know what actually exists.

## Scope: forex only
Only forex is traded and analyzed — six majors (EURUSD, GBPUSD, USDJPY, AUDUSD,
USDCAD, GBPJPY) traded as Deriv multiplier contracts. Synthetics, crypto and
commodities are in the Deriv catalog for historical charting only; the signal
worker, `/api/symbols`, the chart's default view, and the candle feed's boot
subscriptions are all forex-scoped. A non-forex symbol is refused at both the
pre-scan and dispatch stages (`lib/forex-readiness.ts`).

## What runs
- **api-server** (Node/Express 5, single port from `PORT`): auth, signal worker (every 30 min), Deriv candle feed, balance sync, contract monitor, order reconciler, book ingestion (PDF/EPUB/text/YouTube). Also serves the built dashboard as static files — one process, one port.
- **trading-dashboard** (React/Vite): login gate + Overview, Education, Analysis, Signals, Chart, Strategy, Brokers (self-test, raw frames, filter rejections), Accounts, Trades, Journal, Reports, Configuration.
- **expert-system** (C++): counts a fixed ICT concept list in ingested text. It does NOT compute quant rules.
- **elixir-engine**: dormant, not used.

## Run on Replit
- Install workspace dependencies with `pnpm install --frozen-lockfile` on a fresh checkout.
- For the development preview, start the existing `artifacts/api-server: API Server` and `artifacts/trading-dashboard: web` workflows. Open `/` for the dashboard; the API is routed under `/api` (`/api/healthz` is the public health check).
- `.replit` uses `router = "application"` with per-artifact services: `artifacts/trading-dashboard: web` serves `/` and `artifacts/api-server: API Server` serves `/api`. The `Project` run button runs `typecheck` and `healthcheck`; it does not start another app server.
- On first launch, create your own owner password in the dashboard. No broker account is connected and the bot starts disabled. Connect a Deriv account and run the demo self-test before considering any live mode.

## Signal pipeline
1. Deriv candles -> `candles` table (M1..D1), forex majors only.
2. `lib/forex-readiness.ts`: weekend/market-hours closure, killzone session gate (`botConfig.killzones`, e.g. "london,newyork"), and a high-impact news blackout (free ForexFactory-style calendar feed, cached, **fails closed** — if the calendar can't be fetched and the cache is too stale to trust, forex trading is refused rather than trading blind). Runs before the GPT call (skip symbol) and again right before order placement, where it additionally requires a readable live indicative cost quote under `botConfig.maxSpreadCostPct`.
3. `lib/quant-filters.ts` (pure code, unit-tested): H4 ATR percentile, efficiency ratio; skips dead/spiking/choppy symbols before any GPT call.
4. GPT reads candles + measured facts and proposes a setup.
5. Code re-checks: geometry, RR, noise stop, premium/discount, cited FVG/sweeps exist in the candles, portfolio caps. Rejections are logged (Brokers page).
6. Sizing (`execution-risk.ts`): risk % cap, daily-loss budget, small-account rule.
7. Order over Deriv's OTP account WebSocket. Ambiguous results are never replayed; `reconciler.ts` resolves them against Deriv.

## Auth
First launch asks for an owner password (scrypt). Signed httpOnly cookie sessions. Every `/api` route needs a session except `/api/healthz` and login/setup. `BOT_API_KEY` is optional (machine key for scripts, `x-api-key` header).

## Modes
`off` (signals only), `auto_demo`, `auto_live`. auto_live needs a connected real connection AND a passed demo self-test.

## Honest limits
- Order path (buy, the reconciler, the demo self-test) was never exercised against real Deriv from CI — the sandbox this was built in had no outbound network access to Deriv. Run the demo self-test (Brokers page) first, and watch the Diagnostics/raw-frames view on the first live signals.
- The news-blackout calendar and the live indicative-cost probe (`getIndicativeCostPct` in `lib/deriv.ts`) are code-review only for the same reason: the request shapes match Deriv's documented API, but have not been confirmed against a live connection. Both fail closed (refuse to trade) rather than silently skip the check if they can't get real data.
- Candle data is OHLC only, so "order flow" is inferred from price, not observed.
- PDF pages without extractable text are not ingested (no OCR). Sources under 90% coverage show status "partial".
- `quant_rules` extraction from ingested books is not built; the quant filters run on configured defaults independent of any book.
- Deploy as a Reserved VM (`deploymentTarget = "vm"`); autoscale would sleep and stop the workers.

## Env (all optional)
`APP_ENCRYPTION_KEY`, `DERIV_APP_ID` (default 1089), `DERIV_BINARY_DURATION_DAYS` (default 3), `BOT_API_KEY`, `AI_INTEGRATIONS_OPENAI_*`, `PORT` (set by the deployment run command).
