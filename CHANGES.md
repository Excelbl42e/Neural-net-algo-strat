# Changes in this build (vs. your Replit export)

## Verified by running (local Postgres, built server, curl / node:test)
- Auth: first-launch owner password, cookie session, 401 on all unauthenticated /api except /healthz + login/setup, 429 login rate limit, optional BOT_API_KEY machine key.
- Server boots with no AI env vars; fresh DB creates its own tables (no manual db push).
- Broker tokens AES-256-GCM encrypted, legacy plaintext migrated on boot, tamper detected.
- Execution lock derived from DB (in-memory flag deleted); clears itself when a signal resolves.
- Modes off/auto_demo/auto_live enforced server-side; auto_live refused without passed self-test.
- Quant filters: 10 unit tests pass (`pnpm --filter @workspace/api-server exec tsx --test test/quant-filters.test.ts`).
- Stake table @1% risk, 10% small-account cap: $5 -> $0.35, $20 -> $0.35, $50 -> $0.50, $200 -> $2.00.
- Typecheck (libs + api-server + dashboard) clean; dashboard production build succeeds.

## Written but NOT run against Deriv (sandbox gets HTTP 403 from Deriv)
- OTP-channel order placement, contract settlement polling, reconciler matching, demo self-test, raw-frame capture.
- Run the "Demo self-test" on the Brokers page before trusting anything.

## Not built
- Per-page OCR of image-only PDF pages (coverage is measured and shown as "partial" instead).
- Forex module (hours, news blackout, spread). Forex stays refused.
- quant_rules extraction from books (P1-3). Filters run on defaults, independent of books.
- 375px visual check of every page.

## Removed
attached_assets/, artifacts/mockup-sandbox, scripts/src/hello.ts, uploads 1.pdf-8.pdf (scraps), elixir module from .replit, elixir deps, .git/.mix/.hex.
The three real books (9, 11, 12.pdf) are NOT in this zip; re-upload them if the database does not already have them.

## Config
.replit: deploymentTarget = "vm" (always-on). Deploy as Reserved VM.
