# NeuralTrade

A Deriv forex multiplier bot: 60 strategies vote and a simple majority trades (see the header of
artifacts/api-server/src/lib/poll-engine.ts). It runs on a real Deriv account.

- **Read CHANGES.md first.** It records every decision and every backtest result, newest first.
- **Backtests:** research/backtest/ (see its README). They import the live strategy code.
- **Workflow:** work on a claude/ branch, PR to main, merge. Replit deploys from main; the owner redeploys by hand.
  Before merging: `cd artifacts/api-server && npm run typecheck && npm test && npm run build`, and add a CHANGES.md entry.
- **Code map (artifacts/api-server/src/lib):** order path `signal-worker.ts` (dispatchTradeUnlocked), stake
  `execution-risk.ts` (pollStake), Deriv calls `deriv.ts` / `deriv-account.ts`, closing `contract-monitor.ts`,
  unclear orders `reconciler.ts`, balance `balance-sync.ts`, one-time settings changes `migrate.ts`.

## Owner's preferences

- They know the risks: don't lecture or argue. Every majority vote trades until one stake of free balance is left.
- They stop the bot themselves (Autotrade Off, then close positions in Deriv).
- No AI/LLM integration for now.

## Security rules

- Never add, change or delete APP_ENCRYPTION_KEY in Replit Secrets.
- Deriv API tokens: Read + Trade scopes only, never Payments or Admin.
- Never pass the trading token to an MCP server or any other tool that asks for it.
- Don't suggest Replit's "Fix with Agent".
