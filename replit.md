# NeuralTrade (Algo-Strategist)

Private trading desk. Read this file to know what actually exists.

## What runs
- **api-server** (Node/Express 5, port 8080): auth, signal worker (every 30 min), Deriv candle feed, balance sync, contract monitor, order reconciler, book ingestion (PDF/EPUB/text/YouTube).
- **trading-dashboard** (React/Vite): login gate + Overview, Education, Analysis, Signals, Chart, Strategy, Brokers (self-test, raw frames, filter rejections), Accounts, Trades, Journal, Reports, Configuration.
- **expert-system** (C++): counts a fixed ICT concept list in ingested text. It does NOT compute quant rules.
- **elixir-engine**: dormant, not used.

## Signal pipeline
1. Deriv candles -> `candles` table (M1..D1).
2. `lib/quant-filters.ts` (pure code, unit-tested): H4 ATR percentile, efficiency ratio; skips dead/spiking/choppy symbols before any GPT call.
3. GPT reads candles + measured facts and proposes a setup.
4. Code re-checks: geometry, RR, noise stop, premium/discount, cited FVG/sweeps exist in the candles, portfolio caps. Rejections are logged (Brokers page).
5. Sizing (`execution-risk.ts`): risk % cap, daily-loss budget, small-account rule.
6. Order over Deriv's OTP account WebSocket. Ambiguous results are never replayed; `reconciler.ts` resolves them against Deriv.

## Auth
First launch asks for an owner password (scrypt). Signed httpOnly cookie sessions. Every `/api` route needs a session except `/api/healthz` and login/setup. `BOT_API_KEY` is optional (machine key for scripts, `x-api-key` header).

## Modes
`off` (signals only), `auto_demo`, `auto_live`. auto_live needs a connected real connection AND a passed demo self-test.

## Honest limits
- Deriv synthetics are RNG-generated: no institutional counterparties. Candle data is OHLC only, so "order flow" is inferred from price.
- Order path was never exercised against real Deriv from CI. Run the demo self-test (Brokers page) first.
- Forex is refused until market-hours / news-blackout / spread handling exists.
- PDF pages without extractable text are not ingested (no OCR). Sources under 90% coverage show status "partial".
- Deploy as a Reserved VM (`deploymentTarget = "vm"`); autoscale would sleep and stop the workers.

## Env (all optional)
`APP_ENCRYPTION_KEY`, `DERIV_APP_ID` (default 1089), `DERIV_BINARY_DURATION_DAYS` (default 3), `BOT_API_KEY`, `AI_INTEGRATIONS_OPENAI_*`.
