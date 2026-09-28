# Changes in this build (vs. your Replit export)

## Update: hardcoded strategy library, book-ingestion pipeline removed
- Per explicit request: the book-upload/OCR/chunking pipeline (Education page, `/education/*` and `/brain/ingest/*` API routes, `lib/ingest.ts`, the C++ `chunker` binary) is removed from the product. Nothing in the running app depends on uploaded books anymore.
- The C++ "concept scanner" (`expert-system.ts`/`expert_system.cpp`, the `strategies/synthesize` and `strategies/mega` endpoints, the old Strategy page's "Scan ready sources" button) is also removed — it existed only to scan ingested book chunks for concept names, which no longer exist as an input.
- New `lib/strategy-library.ts`: 20 hardcoded ICT/SMC concepts (FVG, Order Block, Breaker Block, Liquidity Sweep, MSS, CHoCH, BOS, AMD, MMXM, OTE, Premium/Discount, Algo Candle, Failure Swing, Judas Swing, Strong High/Low, Inducement, SMT Divergence, Dealing Range/Equilibrium, the 2022 Entry Model, OFED) plus 10 hardcoded technical-analysis/quant strategies (RSI Divergence, MACD Crossover, Moving Average Confluence, Bollinger Band Squeeze, Fibonacci Confluence, Support/Resistance Flip, ATR Volatility Regime, Kaufman Efficiency Ratio, Ornstein-Uhlenbeck Mean Reversion, Multi-Timeframe Trend Alignment) — each with a one-line summary and a fuller rules write-up.
  - The deep ICT framework (AMD phases, MMXM, the three entry models, session/killzone timing, the Cartea/Jaimungal microstructure principles) already lived directly in `signal-worker.ts`'s system prompt and was untouched; these 20 concepts are the named list that framework's self-learning eligibility gate (`scoreConcepts`, keyed by concept name against real closed-trade P&L) now operates on, replacing the old C++-scanned concept list. The 10 quant/TA entries are new ground — they get a fuller reference block injected into the prompt since the system prompt doesn't otherwise cover them.
  - Seeded into `strategiesTable` on every boot (`seedStrategyLibrary` in `lib/seed.ts`) so the Strategy page (rewritten to a flat, grouped, expandable list) always reflects the same 30 entries the signal worker actually uses — no drift between what's shown and what's live.
- Removed now-dead dependencies (`multer`, `pdf-parse`, `pdfjs-dist`, `@types/pdf-parse`, `@types/multer`, `youtube-transcript`) and the `bin/expert-system`/`bin/chunker` C++ build step from `build.mjs`; `pnpm install` re-run, lockfile updated. Server bundle dropped from ~3.5MB to ~3.0MB.
- `educationSourcesTable`/`knowledgeChunksTable` are left in the DB schema (unused, harmless) rather than dropped, so no migration risk to any books already uploaded in a live database.
- Evidence label: code review only for the strategy content itself — the 30 write-ups are curated from established ICT/SMC and classical-TA sources, not backtested by this change. The self-learning eligibility gate (already-existing, unit-untested-but-live-used machinery) will suppress any concept that performs poorly against real trade outcomes, same as it did before.

## Update: hosting fix + forex-only scope
- Hosting was previously broken: `.replit` had no `[deployment] build`/`run` and no workflow ever started a server (only typecheck/healthcheck ran), and the dashboard's `vite.config.ts` threw without hand-set `PORT`/`BASE_PATH`, so `pnpm run build` failed in a clean checkout. Fixed: api-server now serves the built dashboard statically (one process, one port), `.replit` has real `deployment.build`/`run` and a working "App" run-button workflow, and the vite config env vars default instead of throwing. Verified live end-to-end against a local Postgres: build with zero env vars, boot, dashboard HTML served at `/`, a deep route serves the SPA fallback, a static asset serves, first-launch owner setup + login issues a working session cookie, an authenticated read succeeds, an unauthenticated write is 401.
- Scope changed to forex-only per explicit request: the signal worker, `/api/symbols`, the candle feeder's boot subscriptions, and the chart's default view are now scoped to the six forex majors (EURUSD, GBPUSD, USDJPY, AUDUSD, USDCAD, GBPJPY). Synthetics/crypto/commodities are no longer traded or analyzed (still chartable by symbol if you know the code, just not exposed in the picker).
- Built `lib/forex-readiness.ts` (weekend/market-hours closure, killzone session gate, high-impact news blackout — unit-tested, 8 passing tests) and `lib/news-calendar.ts` (free ForexFactory-style calendar feed, cached, fails closed if unreachable and the cache is too stale). Wired into the signal worker at both the pre-scan stage (skip symbol) and the dispatch stage (refuse order), the latter also requiring a live indicative-cost read via a new `getIndicativeCostPct` in `lib/deriv.ts`.
  - **Evidence label: code review only.** The news calendar and cost-probe request shapes are correct per documented formats, but neither has been run against a live Deriv connection or the real calendar feed from this sandbox (no outbound network to either). Both fail closed on error rather than silently skipping the check — run the demo self-test and watch a few real signals before trusting this in auto_live.
- `botConfig.killzones` existed in the schema and UI form state but was never rendered as a form field and was never actually saved (the submit handler silently discarded it). Fixed: it's now a real form field and wired into session gating.
- New `botConfig` fields: `newsBlackoutBeforeMin`/`newsBlackoutAfterMin` (default 30/30) and `maxSpreadCostPct` (default 0.5%), exposed in Configuration.
- GPT prompt in `signal-worker.ts` rewritten from "Deriv synthetic indices" framing to forex: sessions/weekend closure, real news/spread awareness, and a forex-appropriate SMT-divergence example (EURUSD vs GBPUSD instead of R_75 vs R_100). The underlying ICT structure logic (FVG, sweeps, displacement, premium/discount) was already market-agnostic and untouched.

## Verified by running (local Postgres, built server, curl / node:test)
- Auth: first-launch owner password, cookie session, 401 on all unauthenticated /api except /healthz + login/setup, 429 login rate limit, optional BOT_API_KEY machine key.
- Server boots with no AI env vars; fresh DB creates its own tables (no manual db push).
- Broker tokens AES-256-GCM encrypted, legacy plaintext migrated on boot, tamper detected.
- Execution lock derived from DB (in-memory flag deleted); clears itself when a signal resolves.
- Modes off/auto_demo/auto_live enforced server-side; auto_live refused without passed self-test.
- Quant filters: 10 unit tests pass (`pnpm --filter @workspace/api-server exec tsx --test test/quant-filters.test.ts`).
- Stake table @1% risk, 10% small-account cap: $5 -> $0.35, $20 -> $0.35, $50 -> $0.50, $200 -> $2.00.
- Typecheck (libs + api-server + dashboard) clean; dashboard production build succeeds.

## Written but NOT run against Deriv (sandbox has no outbound network to Deriv)
- OTP-channel order placement, contract settlement polling, reconciler matching, demo self-test, raw-frame capture, the forex news-calendar fetch, the live cost probe.
- Run the "Demo self-test" on the Brokers page before trusting anything.

## Not built
- Per-page OCR of image-only PDF pages (coverage is measured and shown as "partial" instead).
- quant_rules extraction from books (P1-3). Filters run on defaults, independent of books.
- 375px visual check of every page.

## Removed
attached_assets/, artifacts/mockup-sandbox, scripts/src/hello.ts, uploads 1.pdf-8.pdf (scraps), elixir module from .replit, elixir deps, .git/.mix/.hex.
The three real books (9, 11, 12.pdf) are NOT in this zip; re-upload them if the database does not already have them.

## Config
.replit: deploymentTarget = "vm" (always-on). Deploy as Reserved VM.
