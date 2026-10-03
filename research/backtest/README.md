# Backtest scripts

The research scripts behind every number in CHANGES.md. They import the live
code (artifacts/api-server/src/lib/poll-engine.ts, poll-strategies.ts), so a
backtest always runs the same strategies the bot trades.

Run from this folder with the api-server's import hooks:

    H=../../artifacts/api-server/test/register-hooks.mjs
    node --experimental-strip-types --import $H <script>.mts

## Data (data/)

- `candles2y.json`: Deriv M30 and H1 candles for the 14 forex pairs, about one
  year up to 2026-10-01 (Deriv serves no older history). H4 is built from H1.
  Committed because it cannot be fetched again once it ages out of Deriv.
- `cot.json`: CFTC Commitments of Traders data (COT voters, tested and rejected).
- `votes-M30.json`, `votes-H1.json`, `votes-H4.json`: every strategy's vote at
  every bar. Not committed (large); rebuild them first, about a minute each:

      for tf in M30 H1 H4; do node --experimental-strip-types --import $H tf-votes.mts $tf; done

  Rebuild them after any change to poll-strategies.ts.

## Scripts that matter now

- `cand-lib.mts`: shared loader (candles, votes per timeframe, commission by hour).
- `horizon2.mts`: live rules, one position per pair; how trades end (target,
  stop, 4-day limit, Friday close), hold times, and direction accuracy at
  24/48/72/96h. Check: 1,041 trades, 48.5% win, +$0.017 per $1 stake.
- `every-until.mts`: $10 account runs starting every Monday (sizing and stops).
- `every-vote*.mts`, `real-sim.mts`, `live-sim.mts`: account-level simulations.

Everything else is earlier research (the strategy selection, the ICT voter, COT
and chaos-theory voters, the old binary/ICT backtests). Some of those import
modules that no longer exist and will not run as they are; read them as a
record of what was tried.
