# Changes in this build (vs. your Replit export)

## Fix: the COT row turned System health yellow while the first report was still downloading

Right after a restart the "COT report (veto)" row said "Fetching the CFTC report…" and was marked degraded, which turned the whole panel's badge yellow. While the first download is in progress it is now idle (grey). It turns yellow only if the download failed or this week's report is missing.

## COT veto, and the weekly cycle as an option

Built from the research below. On upgrade only the **COT veto is switched on** (once; a later choice is kept). The owner keeps the other settings as they are: new trades every weekday, Max positions 14, Max hold 96h. The weekly cycle can be chosen on the Configuration page: "New trades open on" Monday–Tuesday, Max positions 4, Max hold 120h.

- **System health:** a new "COT report (veto)" row shows which CFTC report is in use, or that the veto is standing down and why. It is never red, because without the report every vote trades. The report is fetched in the background when the dashboard checks status. After a failed download the next try waits 30 minutes, so a down CFTC site cannot slow orders.

- **The veto runs at the scan too.** A vetoed vote no longer creates a signal that the dispatcher would cancel and the scan would recreate every hour. It is logged under "COT veto" in Analysis rejections. The dispatcher check stays as a backstop.

### Checked against Deriv's current API docs (developers.deriv.com/llms, fetched 2026-10-03)

- **`buy`:** `buy: "1"` with `price` and `parameters` {`contract_type` MULTUP/MULTDOWN, `underlying_symbol`, `amount`, `basis: "stake"`, `currency`, `multiplier`, `limit_order` {`stop_loss`, `take_profit`}}. Matches the schema.
- **`sell`:** {`sell`: contract_id, `price`: 0} = sell at market. Matches. `portfolio: 1` and `proposal_open_contract` with `contract_id` also match.
- **Contract status fields read:** `is_sold`, `profit`, `buy_price`, `purchase_time`, `underlying_symbol`, `status`, `sell_price`. All are in the schema.
- **Login:** an OTP WebSocket URL from `POST /trading/v1/options/accounts/{id}/otp` with `Authorization: Bearer` plus `Deriv-App-ID`. Market data comes from `wss://api.derivws.com/trading/v1/options/ws/public`. Matches.
- **Multipliers:** `contracts_for` on frxEURUSD returns multipliers 100/200/300/500/800. The bot uses 100, the smallest. Rate limits (100 requests/s per connection, 5 connections) are far above what the bot sends.

**News data:** ForexFactory's weekly calendar, `https://nfs.faireconomy.media/ff_calendar_thisweek.json`, overridable with `NEWS_CALENDAR_URL`. This research sandbox's network blocks that host, so it could not be fetched here. After redeploying, the Dashboard's System health "News calendar" row must read OK ("N events cached"). If it is red, no forex trade is placed (fail-closed by design). The COT data comes from the CFTC public API, which was fetched successfully.

**Deploy:** no new packages (lockfile unchanged). The two new columns are added by `ensureSchema()` at boot, before any worker starts. The Replit build commands (`pnpm --filter @workspace/api-server run build`, `... trading-dashboard run build`) both pass locally.

### Pre-deploy check: every page clicked through, desktop and phone

A local build with a test database and sample account, trades and signals was opened in Chromium at 1440px and 375px. On all 11 pages it checked for page errors, failed API calls, "NaN" / "undefined" / "Invalid Date" text, overflow and clipped text, then clicked every button. Fixed:

- **Signals:** the "RECORD: CANCELLED / EXECUTED" badge was cut off at the card edge on desktop; the card header now wraps.
- **Trades:** on a phone, "Log Trade" was pushed off the right edge; the header buttons now wrap.
- **Chart:**
  - Prices showed 2 decimals (EURUSD "1.13"); now 5, or 3 for JPY pairs.
  - The last price had two overlapping labels; now one.
- **Signals "Clear History" and Brokers "remove connection":** these used the browser's built-in confirm popup, which embedded views such as Replit's preview can block silently, leaving the button looking dead. They now use the same inline "Confirm / ✕" as the Trades page. Both checked: cancel keeps everything; confirm deletes.
- **Text:**
  - The Dashboard said "1 broker connections".
  - The COT veto reason said "3th percentile"; it now reads "more one-sided than in 97% of the last 3 years".
- **Unused Inter font:** no longer downloaded (the app uses DM Sans).

Checked and fine:
- Brokers "Sync" with a bad token shows a clear "Sync failed" message with Deriv's reason.
- A code review of the branch's bot changes found only the COT status row overstating usability, now fixed (it checks a report exists for the current week).
- Typecheck, 64 tests and both builds pass.

- **Entry days.** `forexPreScanGate` refuses new signals and orders after the last entry day. It runs in the scan and again in the dispatcher, next to the Friday 16:00 cutoff. Open positions are never closed by it. Choices: Monday only, Mon–Tue, Mon–Wed, Mon–Thu or every weekday.
- **COT veto** (`cot-positioning.ts`). Each week the bot reads the CFTC's legacy futures report from its public API (no key; `COT_URL` overrides the address).
  - It computes speculators' positioning per pair (base minus quote currency, USD = 0) and its percentile among the last 156 weeks.
  - In the dispatcher, a buy at the 90th percentile or above, or a sell at the 10th or below, is cancelled with the reason shown on the Signals page and under "COT veto" in Analysis rejections.
  - A report is used from the Monday after its Tuesday, as backtested.
  - The data is cached for 6 hours; two missed weekly reports or no data means the veto stands down and every vote trades as before.
- **Checked:**
  - The live COT module gives the same signal as the research code for all 658 pair-Mondays of the backtest year (0 differences).
  - The real CFTC feed returns the 2026-09-29 report. For Monday 2026-10-05 it would block sells on GBPUSD, GBPJPY, USDCHF and EURCHF, where speculators are at 3-year extreme shorts.
  - Against a local Postgres, the upgrade switches the veto on and leaves every other setting alone. Saving other values works, and a weekday of 9 is refused.
  - The Configuration page shows the new controls with no page errors and no overflow at 375px.
  - New tests: entry-day gate, COT timing, extreme detection, veto direction, too-little-history. `npm run typecheck && npm test && npm run build` pass (64 tests), and the dashboard builds.
- **Expected, on the owner's settings** (every weekday, every vote until one stake left, 4-day hold; `research/backtest/r-veto-live.mts`). Without → with the veto:
  - Per $1 trade, sel / test: $0.011 / $0.036 → $0.027 / $0.048; year $18.01 → $30.39 (127 trades skipped).
  - $10 in each Monday, out each Friday, 46 weeks: average $10.16 → $10.32, weeks up 48% → 52%, under $8 17% → 15%, worst $4.83 → $6.38.
  - Withdrawn: +$7.52 → +$14.78 (Nov–Jun +$4.26 → +$8.50, Jul–Sep +$3.26 → +$6.29).
  - 12 weeks from $10: median $5.63 → $8.33, under $5 47% → 21%.

## Research: the week-by-week view, magnetohydrodynamics and more physics models (no bot changes)

**$10 in every Monday 07:00 UTC, out on Friday after the close, 46 weeks** (`research/backtest/r-weekly.mts`):

| | Live now | Weekly cycle (Mon–Tue, to Friday, max 4) | + COT veto |
|---|---|---|---|
| Average Friday balance | $10.16 | $10.38 | $10.59 |
| Median | $9.93 | $10.12 | $10.35 |
| Weeks up | 48% | 52% | 63% |
| Weeks under $8 | 17% | 9% | 9% |
| Worst / best week | $4.83 / $18.52 | $6.99 / $14.27 | $7.66 / $14.12 |
| Total withdrawn over 46 weeks | +$7.52 | +$17.48 | +$27.33 |

In Jul–Sep the COT veto changed nothing (+$9.60 both). Its gain in the Deriv year is all Nov–Jun; the 12-year COT test is the stronger evidence for it.

**Physics and maths models** (`r-mhd.mts`; weekly-cycle poll, 60 voters: $35.06 per $1 trade-year, +$17.48 withdrawn weekly):

| Model | FX version | Alone (bps per vote, sel / test) | Added to the poll |
|---|---|---|---|
| Alfvén waves (MHD) | Do crosses lag what the USD pairs imply? | Deviations are about 0.2 bps per M30 bar and snap back (autocorrelation −0.4); commission is 2–6 bps | Not tradable |
| Magnetic tension (MHD) | Fade a pair's 4-day move not explained by the 3 main market factors (z > 2) | +1.5 / +33.7 (votes on 2% of bars) | $34.22; weekly +$17.76 |
| Dynamo / Ising magnetisation | Follow the dollar when all 6 USD pairs moved the same way over a day | +0.2 / +1.3 | $33.03; weekly +$11.70 |
| Hawkes self-excitation | Follow the side whose large moves are clustering | −8.0 / +8.3 | $35.34; weekly +$15.55 |

None added.

**Random matrix theory** (Marchenko–Pastur), from 1,499 H4 returns of the 14 pairs:
- Correlation eigenvalues are 4.60, 3.62, 2.27, 1.57 and 1.20, then zeros. Noise would stay below 1.20.
- So the 14 pairs contain about 4 real independent bets (5 at most). They span only 6 dimensions, because every cross is two USD pairs combined.
- This is why "at most 4 open" was the best cap: a 5th to 9th position mostly repeats a bet already held.

## Research: COT over 12 years, more voters, physics and topology models (no bot changes)

These were tested on the weekly cycle from the entry below (Mon–Tue entries, hold to Friday, max 4 open), live poll and stop/target. Scripts: `research/backtest/r-cot.mts`, `r-cot2`, `r-nvoters`, `r-physics`, `r-tda`, `r-extra`, `r-combo` (`.mts`).

**COT positioning, 12 years (2014–2026, 639 weeks × 14 pairs).** Each pair was traded from the week's first open to its last close, using Yahoo daily prices (not committed; see README) and `data/cot.json`.

| Rule | bps per trade after 2 bps | 2014–17 | 2018–20 | 2021–23 | 2024–26 |
|---|---|---|---|---|---|
| Follow speculators' net position | −4.9 (t −2.9) | −4.3 | −7.0 | −2.0 | −6.4 |
| Follow its 1-week / 4-week change | −4.0 / −4.0 | | | | |
| **Fade 3-year extremes (above 90th pct sell, below 10th buy)** | **+7.6 (t 1.8)** | +1.9 | +13.5 | +2.5 | +9.7 |
| Fade 1-year extremes | +3.3 | +2.0 | +6.5 | −4.3 | +8.3 |

That's 7 rules tried. Only fading 3-year extremes was positive in every era.

**COT inside the bot (Deriv year, weekly cycle):**

| | Per trade sel / test | 12 weeks from $10: median, growth (scan / random order), under $5 | Rest of year from 1st Mondays Dec–Jun |
|---|---|---|---|
| Weekly cycle | $0.053 / $0.081 | $13.11, ×1.29 / ×1.10, 3% | $32, 36, 24, 8, 26, 18, 22 |
| **+ COT veto (skip a trade that follows the crowd into a 3-year extreme)** | $0.059 / $0.101 | **$14.71, ×1.49 / ×1.27, 0%** | **$52, 46, 30, 24, 26, 21, 25** |
| + COT as a 61st voter | $0.048 / $0.081 | $10.77, ×1.04, 11% | $21, 22, 8, 2, 22, 14, 19 |
| COT-agreeing pairs get the slots first | | $10.55, ×1.10, 1% | |

The veto removes 68 trades in Nov–Jun and 7 in Jul–Sep. It is better in both start halves (×1.36→×1.65 for Nov–Mar, ×1.19→×1.29 for Apr–Jul). In the bot, CFTC's weekly report (Tuesday positions, published Friday) would have to be fetched each weekend.

**Would more voters help? Yes, if they are good on their own and different.** With random subsets of the 60, per trade sel / test and year total:
- 10 voters: $0.019 / $0.053, $19.86
- 30 voters: $0.033 / $0.059, $26.13
- 50 voters: $0.044 / $0.071, $30.39
- 60 voters: $0.053 / $0.081, $35.06

The curve is still rising at 60. The voters agree 66% of the time (50% = independent). New voters so far failed because they lose money alone.

**Physics-style voters (alone over 4 days; then added to the poll):**
- Kramers–Moyal/Fokker–Planck drift: about 0 alone; $34.01 when added (vs $35.06).
- Schrödinger-style potential well, the data version of the quantum harmonic oscillator: loses alone (−3 to −9 bps); $33.37 when added.
- Viscous Burgers shock fade: loses alone (−12 bps in Jul–Sep); $35.44 when added.
- Navier–Stokes "Reynolds number" (follow smooth trends): +$5 per trade-year when added, but it agrees with the poll 99% of the time, and in the $10 account it is worse (×1.18 vs ×1.29).

None added.

**Algebraic topology (persistent homology, Gidea & Katz 2018).** Total H1 persistence of the Rips complex of the last 50 H4 moves of the 6 USD pairs. The code passes its self-check: a circle gives one loop of about 1.4. Trade results by its percentile show no steady pattern; the bottom fifth was −$0.087 in sel and +$0.154 in test. "Stand aside when high" cut the year to $24.51–$33.63 (vs $35.06). Rejected.

## Research: how to make the $10 account grow: open early in the week, hold to Friday, at most 4 open (no bot changes)

This uses the live poll and live stop/target throughout. Balances include open positions. Runs start at 07:00 UTC on every weekday. A new simulator, `research/backtest/r-lib.mts`, makes every rule a parameter; with the live rules it reproduces 1,041 trades and $18.01 exactly. Scripts: `r-anatomy`, `r-exits`, `r-exits2`, `r-days`, `r-mech`, `r-account`, `r-account2`, `r-priority`, `r-signal`, `r-final`, `r-risk`, `r-prune` (all `.mts`).

**The problem: the edge per trade is positive, but the account shrinks.** From $10 with every vote traded, the median after 12 weeks is $5.55, with 47% of runs under $5. Run through the whole year without resetting, it ends at $2 from 5 of 7 starting months. At $10 every stake is the $1 minimum, which is 6.2% at risk. Up to 9 correlated positions are open at once, so ups and downs compound away the small edge.

**Finding 1: trades opened on Monday make most of the money; late-week trades lose.** Per $1 trade, Nov–Jun / Jul–Sep: Mon +0.056 / +0.089, Tue +0.030 / +0.017, Wed −0.042 / +0.082, Thu −0.060 / −0.079, Fri −0.011 / +0.002. Monday trades get their full hold; later ones are cut by the Friday close (55–92% of them end there). Trading only Mon–Tue: +$0.047 / +$0.071 per trade (vs +$0.011 / +$0.036), $30.84 vs $18.01 for the year. It beat trading every day in 7 of 11 months, and only 4% of random day choices of the same size did as well. Allowing entries before 07:00 UTC makes it worse.

**Finding 2: with only early-week entries, hold until the Friday close instead of 4 days.** Per trade +$0.053 / +$0.081, $35.06 for the year.

**Finding 3: at most 4 positions open.** This is the best cap with every day traded and with Mon–Tue, from $10 and from $25. Fewer grows too slowly; more lets the swings eat the edge (8-week growth, Mon–Tue: 3 open ×0.98, 4 ×1.18, 5 ×1.10, every vote ×0.92). The live scan order (majors first) picks which simultaneous votes get the slots. Random order is worse (×1.05) but still above the current setup.

| From $10 | Live now | Live + max 4 open | **Mon–Tue entries, hold to Friday, max 4** | Monday only, to Friday, max 4 |
|---|---|---|---|---|
| 1 week: median / up | $9.46 / 39% | $9.94 / 48% | $10.01 / 51% | $10.10 / 53% |
| 4 weeks: median / under $5 | $9.37 / 13% | $10.62 / 3% | $10.61 / 2% | $10.41 / 1% |
| 12 weeks: median / under $5 / $20+ | $5.55 / 47% / 1% | $11.12 / 21% / 10% | **$13.11 / 3% / 20%** | $12.28 / 0% / 9% |
| Rest of year from the 1st Monday of Dec, Jan, Feb, Mar, Apr, May, Jun | $2, 2, 2, 2, 16, 2, 16 | $20, 20, 18, 11, 18, 2, 16 | **$32, 36, 24, 8, 26, 18, 22** | $29, 30, 23, 18, 26, 19, 22 |
| 8-week growth: starts Nov–Jun / Jul–Aug | ×0.62 / ×1.28 | ×0.90 / ×1.67 | ×1.12 / ×1.73 | ×1.10 / ×1.69 |

**Tested and not worth changing:**
- Stop/target grid (0.4–0.78% × 1–3R or no target): the surface is noisy and nothing beats 0.6% / 1.5R in both periods.
- Break-even stop and trailing stops: at best ±$3 over the year.
- Holding through the weekend: Nov–Jun got worse.
- Meta-labeling on top of Mon–Tue: +$1.34 for the year, no gain in Jul–Sep.
- A walk-forward pair filter: worse.
- Priority by vote share or by currency overlap: worse than scan order.
- Risk per trade 3–7%: about the same growth, so 5% stays; 10% is worse.
- Dropping the worst voters (6-block cross-validation): $11.93–$23.41 held-out vs $35.06 for all 60.

**How it could be run:** "Max positions" = 4 and "Max hold" = 120h (until the Friday close) are existing settings. "New trades only Monday–Tuesday" needs a small code change. With only the cap changed (every day traded), 12-week runs median $11.12 with 21% under $5.

**Limits:** one year of data (Deriv serves no more). The weekday rule and the cap were found on this same year, though both hold in each half. The cap's best value is sharp: 3 grows little and 5 grows less. The news blackout is not simulated.

## Research: "liquidity sweep -> VWAP reclaim -> structure shift" day-trading rule (no bot changes)

This rule comes from a video the owner shared. It was tested on M30 candles, all 14 pairs, Nov 2025–Sep 2026. Script: `research/backtest/vwap-sweep.mts`. Deriv forex has no volume, so VWAP is the session's time-weighted average from 00:00 UTC.

The setup, in order:
1. During 07:00–17:00 UTC, price sweeps the previous day's high/low or the Asian session's high/low.
2. A close back over VWAP follows.
3. A close beyond the swing point of the 6 bars before the sweep follows.

Entry is at the next open, with the stop just beyond the sweep extreme, a 2R target and a flat exit at 20:00 UTC.

- **Result:** 1,508 trades, about 6.6 a day, 36–37% winners. Average −0.22R in Nov–Jun and −0.20R in Jul–Sep, which is about −0.8% of equity per trade at 5% risk. Before commission it averages −0.025R, so there is no edge to begin with. The stop is only about 0.12% away, so commission takes about a fifth of the risk on every trade.
- **Variants:** all 10 lost in both periods. These were 1.5R or 3R targets, 2h or 8h windows, requiring the sweep bar to close back inside, previous-day or Asian levels only, and with or against the daily trend.
- **As a 61st voter:** the best variant made $16.30 instead of $18.01. In the $10 account, 26-day runs ended up 37% of the time, against 42%.

Rejected, consistent with the earlier ICT sweep → structure break → FVG result.

## Research: balance from 4 hours to 8 weeks, and when $10 reaches $20 (no bot changes)

This uses the live poll on the $10 account, starting at 07:00 UTC on each of 233 weekdays. The balance includes open positions. Script: `research/backtest/to-twenty.mts`.

| After | Average | Median | Middle half | Up | Under $5 | Worst / best |
|---|---|---|---|---|---|---|
| 4 hours | $9.85 | $9.91 | $9.66–$10.07 | 33% | 0% | $7.12 / $12.02 |
| 8 hours | $9.94 | $9.95 | $9.41–$10.33 | 44% | 0% | $6.09 / $13.34 |
| 1 day | $9.93 | $9.95 | $9.14–$10.64 | 46% | 0% | $5.35 / $15.64 |
| 2 days | $9.90 | $9.67 | $8.73–$11.04 | 42% | 0% | $5.45 / $17.49 |
| 4 days | $9.79 | $9.45 | $8.35–$11.04 | 40% | 1% | $4.17 / $17.78 |
| 1 week | $9.99 | $9.46 | $7.92–$11.57 | 39% | 2% | $3.21 / $23.39 |
| 2 weeks | $10.12 | $9.56 | $7.67–$12.19 | 43% | 6% | $3.46 / $26.30 |
| 4 weeks | $9.93 | $9.37 | $6.27–$12.58 | 44% | 13% | $1.84 / $24.43 |
| 8 weeks | $8.43 | $7.42 | $4.34–$12.55 | 36% | 33% | $1.56 / $28.82 |

$10 reached $20 within 8 weeks in 48 of 193 starts (25%): never within 4 days, 2% by 1 week, 7% by 2 weeks, 9% by 4 weeks. When it did, it took 4.9 days at the fastest and 33 days at the median. Along the way the balance fell under $5 at some point in 56% of starts. Of the 26 starts from July, 2 reached $20.

## Research: what $10 becomes after 4 days (no bot changes)

This uses the live poll on the $10 account: every vote trades until one stake of free balance is left. Positions still open at the end are valued at that moment's price. Script: `research/backtest/four-day.mts`.

| Window | Runs | Average | Median | Middle half | Up | $12+ | Under $8 | Worst / best |
|---|---|---|---|---|---|---|---|---|
| Any weekday, 4 days | 230 | $9.86 | $9.53 | $8.44–$10.91 | 37% | 17% | 21% | $4.14 / $17.80 |
| Monday 00:00 to Friday 00:00 | 46 | $10.43 | $9.84 | $8.64–$12.25 | 48% | 26% | 20% | $5.63 / $17.80 |
| Monday to Friday close (all closed) | 46 | $10.33 | $10.02 | $8.68–$12.32 | 50% | 26% | 17% | $5.07 / $18.52 |

About 12 trades are opened per 4 days. Jul–Sep weekday windows averaged $10.07 (under $8 in 8%); Nov–Jun windows averaged $9.77 (under $8 in 26%).

After 2 days (live 4-day hold, open positions valued at day 2), Monday starts averaged $10.25 (median $9.67, middle half $9.08–$11.54, up 45%, under $8 13%, worst $6.14). Mon–Thu starts averaged $9.93. Switching to a 2-day hold barely changes the 2-day balance, but over a full week it averages $10.12 instead of $10.33, and 26% of weeks end under $8 instead of 17%.

## Research: 2- or 3-day holds and other timeframes (no bot changes)

Holds of 2, 3 and 4 days were each tested with seven timeframe setups. All other rules are the live ones. Script: `research/backtest/hold-tf.mts`; `book-lib.mts` now has `setHold`. "Re-tuned" re-picks each voter's timeframe for that hold using only Nov–Jun. "Decide on H1/H4" polls only at those closes.

| Hold | Setup | Total (1 yr) | Test Jul–Sep avg | $10 12d: up / typical | $10 26d: up / typical / under $5 |
|---|---|---|---|---|---|
| 4d | **live mix (now)** | **+$18.01** | **$0.036** | **56% / $10.07** | **42% / $9.45 / 7%** |
| 4d | decide on H1 closes | +$12.03 | $0.026 | 49% / $9.80 | 35% / $9.22 / 7% |
| 4d | decide on H4 closes | +$6.39 | $0.036 | 47% / $9.71 | 37% / $8.74 / 16% |
| 4d | all M30 / all H1 / all H4 | −$22.19 / −$16.82 / −$8.37 | | 44–47% | 26–40%, under $5 14–23% |
| 3d | live mix | +$8.13 | $0.020 | 49% / $9.83 | 30% / $8.42 / 16% |
| 3d | decide on H4 closes | +$6.85 | $0.034 | 49% / $10.00 | 40% / $8.46 / 16% |
| 3d | re-tuned mix | +$4.52 | $0.020 | 44% / $9.52 | 30% / $8.34 / 21% |
| 3d | all M30 / H1 / H4 | −$19.76 / −$13.48 / −$7.88 | | | |
| 2d | live mix | +$11.74 | −$0.011 | 44% / $9.76 | 42% / $8.49 / 21% |
| 2d | re-tuned mix | +$4.45 | −$0.007 | 40% / $8.85 | 37% / $7.69 / 21% |
| 2d | other setups | −$33.84 to −$4.10 | | | |

The current settings are best on every measure: a 4-day hold, each voter on its own timeframe, and a poll at every M30 close. This includes the unseen Jul–Sep months, where 2-day holds lose and 3-day holds make about half as much. Putting all voters on one timeframe loses money at every hold. No change.

## Research: three more books checked (no bot changes)

Books: Aronson, *Evidence-Based Technical Analysis*; Qian, Hua & Sorensen, *Quantitative Equity Portfolio Management* (scanned, read via OCR); Hull, *Options, Futures and Other Derivatives*. Same rules and data as the entry below. Script: `research/backtest/book3.mts`.

**Is the poll's edge real? (Aronson ch. 1, 6): yes, the side it picks matters.** It trades 52% long, and leaning with each pair's drift explains $0.0001 of its $0.0173 per $1 per trade. In a permutation test that keeps every entry and exit rule but picks the side at random (5,000 runs), only 0.9% of runs beat its $18.01 total, and only 1.9% beat its $9.84 in the test months.

**Three Aronson rule types as new voters: none added.** These were a divergence between channel-normalized price and RSI, a Fisher transform of channel position, and nearness to the 20-day high or low (his "52-week high" anchoring effect). Alone, only the divergence rule at the slowest setting made money (+3 bps in the selection months, +10 bps in the test months); the others lost in both. Added to the 60, divergence gave +$0.57 and the 20-day-high rule +$0.77 over 1,041 trades, both with a lower test-month average. In the $10 account, both were within a run or two of the current poll (26-day runs: 40% up vs 42%).

**Weighting voters by their information coefficient (QEPM ch. 4, 7, 9): rejected.** This replaces one vote each with weights refit every month on earlier data, trading the same share of bars. From Jan, the majority poll made +$8.70. Mean-IC weights made −$54.41, IC/variance weights −$22.48, the book's optimal weights (Σ⁻¹·IC, shrunk) −$54.18, positive-IC voters only −$1.24, and quiet/busy contextual weights −$4.24 and +$0.10. Every variant was worse in the $10 account.

**Volatility-based stop (Hull ch. 23, EWMA λ 0.94): rejected.** This sets the stop at k × EWMA daily volatility (median 0.41% at entries) instead of 0.6%, keeping 5% risk. Per trade, as % of equity, selection / test months: fixed 0.6% gave 0.088 / 0.289; k = 0.75 gave −0.006 / −0.181; k = 1 gave 0.102 / 0.079; k = 1.5 gave 0.048 / 0.265; k = 2 gave 0.028 / 0.314. No setting beats the fixed stop in both periods.

Hull's remaining chapters (options pricing, interest-rate and credit derivatives, VaR) and the rest of QEPM (stock valuation, fundamental factors, turnover) don't apply to a forex multiplier poll.

## Research: strategies and filters from the two books (no bot changes)

Everything below uses the live rules (0.6% stop, 1.5x target, 4-day limit, Friday close, every Deriv forex pair, Nov 2025 – Sep 2026; selection to Jun, test Jul–Sep). Scripts: `research/backtest/book-voters.mts`, `book-lib.mts`, `book-poll.mts`, `book-meta.mts`, `book-filters.mts`. Every setting tried is listed.

**Seven new voters from the books: none added.** Chan's turning point (ex. 7.1), pair-spread reversion against the most correlated pair (Chan ch. 7), SADF explosiveness, Chu-Stinchcombe-White CUSUM break, fractionally differentiated reversion, CUSUM filter trend and low-entropy momentum (AFML ch. 2, 5, 17, 18). Alone, none earns money after commission in both periods. Added to the 60 voters one at a time, the best two (fracdiff +$1.10, SADF +$0.07 over 1,041 trades) change nothing that matters; all seven together lose $11 instead of making $18.

**CUSUM "real move" entry filter (AFML ch. 2): rejected.** All 8 settings did worse than no filter ($18.01): from −$9.27 to +$17.32.

**Meta-labeling (AFML ch. 3): promising.** A second model (logistic regression, 15 features known at the entry: vote share, H4-vs-M30 voter agreement, volatility percentile, hour, weekday, recent poll win rate on the pair and overall, trend, stretch, high/low spread and volatility estimates) predicts whether the poll's trade wins; predicted losers are skipped. It skips about half the votes.
- Trained Nov–Jun, tested Jul–Sep: kept trades averaged $0.083 per $1 vs $0.036 for all (skipped ones −$0.006); total $10.74 vs $9.84.
- Combinatorial purged cross-validation (AFML ch. 12, 45 fits, 9 out-of-sample histories): better in 9 of 9 histories, +$5.52 on average over $18.01, and better than 87–99% of random skips of the same size.
- Not sensitive to its settings: kept trades averaged $0.056–$0.236 for every regularization (0.1–100) and threshold (0.45–0.55) tried.
- $10 account (every vote until one stake left, model refit monthly from Feb): 26-day runs up 51% (vs 42%), typical $10.17 (vs $9.45), under $5 5% (vs 7%), but worst $2.06 (vs $4.22); 12-day runs about the same.

**Correlation between open positions (Chan ch. 6, AFML ch. 16): mixed.** $10 account, every vote until one stake left:

| | 12 days: up / under $5 / typical / best | 26 days: up / under $5 / typical / best |
|---|---|---|
| No limit (now) | 56% / 7% / $10.07 / $23.60 | 42% / 7% / $9.45 / $21.08 |
| At most 2 trades on the same side of a currency | 53% / 0% / $10.08 / $16.39 | 47% / 9% / $9.82 / $13.93 |
| At most 3 | 58% / 2% / $10.80 / $22.63 | 40% / 0% / $9.19 / $17.06 |
| Skip if correlation with an open trade > 0.5 | 53% / 0% / $10.12 / $13.57 | 53% / 5% / $10.16 / $13.91 |
| Skip if correlation with an open trade > 0.7 | 58% / 2% / $10.64 / $17.89 | 51% / 5% / $10.32 / $21.47 |

Deploy: `.replitignore` now leaves `research/` and the PDFs out of the deployed image. The bot never read them; it trades on live Deriv candles.

## Research: two trading books checked against the bot (no bot changes)

Read Chan, *Quantitative Trading* (2008) and López de Prado, *Advances in Financial Machine Learning* (2018), both added to the repo root, and tested the ideas that fit a 60-vote forex poll on Deriv multipliers. Script: `research/backtest/book-tests.mts` (live rules, every Deriv forex pair, Nov 2025 – Sep 2026; selection period to Jun, test Jul–Sep).

| Idea (source) | Result | Verdict |
|---|---|---|
| Close a trade when a newer vote points the other way (Chan ch.7) | −$0.011 per $1 trade vs +$0.017 now; win rate 48.5% → 41% | Rejected |
| Same, without the target | −$0.011 per trade | Rejected |
| Size stakes by vote share (AFML ch.10) | No pattern: 80–100% share earned $0.023 (sel) / $0.019 (test), 70–80% earned −$0.015 / +$0.075 | Rejected: share does not rank trades |
| Probabilistic Sharpe ratio (AFML ch.14) | 85% chance the per-trade edge is above zero (all 1,041 trades) | Edge likely but small |
| Deflated Sharpe ratio, for the number of settings tried in the poll search | 29% if 10 were tried, 6% if 100, 1% if 1,000 | After the search, the edge cannot be told apart from luck |
| Win rate needed to break even (AFML ch.15) | 48.5% won vs 46.6% needed; 11% chance the true rate is below break-even | Thin margin |

Already in the bot and endorsed by the books: Kelly-style sizing (Chan ch.6), one out-of-sample test period (Chan ch.3), the look-ahead truncation test (Chan ex.3.6), stop/target/time-limit exits (AFML's triple barrier), and commission in every backtest.

## Real-money audit fixes

Checked before connecting the real account: the order path, the Deriv buy/sell/status calls, the balance sync, the contract monitor and the reconciler. Four fixes:

- **No second position on a pair, enforced at the order itself.** The one-per-pair check ran only when a signal was created; a signal retried for its 30 minutes, or replayed, could have opened a second position on a pair that already had one. The dispatcher now refuses it.
- **Free balance cannot be overstated by a trade opened during a balance read.** The sync time is now taken when the balance request starts, not when it returns, so a stake spent while the request was in flight is still taken off the free balance.
- **The 4-day close and the Friday 20:30 UTC flatten run even when a connection is flagged "error".** The contract monitor used only "connected" connections, so a few failed balance reads could have left positions open into the weekend. It now tries every enabled connection.
- **A trade the reconciler recovers keeps its real purchase time**, so its 4-day limit counts from when it was bought.

Checked and unchanged: the buy refuses a virtual account when real is requested (and the reverse); an unanswered buy is never replayed, and new orders wait until the reconciler resolves it; the stop is capped at 80% of the stake and at Deriv's own maximum; the stake and the one-stake reserve.

## Every vote opens a position until one stake is left

As the operator asked: positions keep opening from the votes, one per pair, until only one stake of free balance is left.

- The position ceilings are set to 14 (one per pair) once on upgrade; lower "Max positions" to cap it again.
- One stake is kept in reserve: a trade opens only if the free balance after it still covers another stake. At $10 with $1.00 stakes that is up to 9 open.
- The currency-exposure cap (no third position on the same side of one currency) is removed.
- Unchanged: the 5% risk sizing, the 0.6% stop, the 4-day hold, the Friday close, sessions, news blackout and the live quote.

Backtest on $10 (live rules, runs starting every Monday):

| | Up after 12 days | $15+ | Under $5 | Typical (26 days) | Worst | Best |
|---|---|---|---|---|---|---|
| At most 2 open (previous) | 51% | 0% | 0% | $10.20 | $5.44 | $13.67 |
| **Every vote until 1 stake left** | 49% | 7% | 2–4% | $8.82 | $3.72 | $23.77 |

## Stakes sized by risk (Kelly-style), tested against volatility stops

Tested on $10 with the live rules (every majority vote, at most 2 open), 26-day runs starting every Monday; chosen on Nov–Jun starts:

| | Ended up | Fell under $5 | Typical end | Worst | Best |
|---|---|---|---|---|---|
| Before: stake 20% of balance ($2 at $10) | 41% | 9% | $9.30 | $3.21 | $17.50 |
| **Now: stake sized so a stopped-out trade loses 5% of the balance** | **47%** | **0%** | **$9.90** | **$5.44** | $13.61 |
| Volatility-forecast (EWMA/GARCH-style) stop, 0.75 sigma of the 4-day move | 38% | 9% | $9.36 | $4.46 | $19.52 |

- **"Risk per trade %" now means what a stopped-out trade loses**, and the stake is sized from it: stake = balance × risk% ÷ $0.62 (what a $1 stake loses at the 0.6% stop, with commission), never under Deriv's $1.00 minimum. Set to 5% once on upgrade; a later change is kept. At $10 that is $1.00 a trade, at $20 $1.61, at $100 $8.06. The balance ladder still lowers it on large balances (2% from $200, 1% from $1,000).
- Why: the backtest's per-trade mean and spread put the Kelly stake near 8% of the balance; $2 on $10 was about 2.5 times that, which is where the wipe-outs came from.
- **Volatility-forecast stops were not adopted**: they did no better than the fixed 0.6% stop.
- Over all start dates (both periods) on $10: 26-day runs ended up 53% of the time, never under $5, typical $10.20, range $5.44 to $13.67. The old sizing had more upside (best $17.50) and more wipe-outs (7% under $5).

## Trade every majority vote until the balance runs out

Asked for by the operator, funding $5: every majority vote is now traded, and nothing stops trading except money.

- **Stake:** the balance band's risk percentage, never under Deriv's $1.00 multiplier minimum. At $5 that is $1.00 a trade.
- **Trades while $1.00 is free.** The synced balance is Deriv's cash (an open contract's stake has already left it); stakes opened since the last sync are taken off too. When less than $1.00 is free the bot waits, and trades again as soon as a closing trade returns its stake.
- **Removed:** the daily-loss stop, the $4.00 balance floor and the small-account risk cap (and their settings on the Configuration page). Kept: at most 2 trades open at once (the position ceiling — the lower of "Max positions" and "Max open positions per asset class"), one per pair, Deriv's market hours, the sessions you configure, no new trades after Friday 16:00 UTC, the news blackout, the stale-price check, Deriv's live quote and limits, and the stop on every trade.
- The commission allowance in the target is 6 bps (Deriv charges 2 bps in London/New York and about 6 bps late), so a vote in the last session hour is traded rather than held back.

### What to expect on $5 (backtest, every Deriv forex pair, live rules)
34 three-month runs, one starting each week from Nov 2025 to Jun 2026:

| Trades open at most | Ended above $5 | Ended below $2 | Median end | Best | Worst |
|---|---|---|---|---|---|
| 1 | 24% | 26% | $3.40 | $6.57 | $0.45 |
| **2 (default)** | **38%** | **41%** | **$3.12** | **$10.24** | **$0.58** |
| 3 | 41% | 47% | $3.67 | $15.30 | $0.58 |

On $5 the result is mostly which few trades happen to come first: a small change to the target moved one whole-year run from $11.13 to $0.61. Over many runs it is close to a coin flip, slightly more often down than up.

## The poll, tuned: each strategy on its best timeframe, majority rules, four-day hold

The first poll used every strategy on 30-minute candles, a fixed 70% threshold and a 24-hour hold, and lost money after commission. This version was chosen properly:

- **Search.** 180 candidates (each of the 60 strategies on 30-minute, 1-hour and 4-hour candles — a 4-hour strategy looks back 8 times as long, so this also tunes each strategy's look-back), holding times of 12 hours to 4 days, majority thresholds of 50% to 80%, quorums of 10 to 40, and stop/target sizes. Every forex pair Deriv offers multipliers on (14), one year of Deriv candles (all Deriv serves). Everything was chosen on Nov 2025 – Jun 2026 only and tested once on Jul – Sep 2026.
- **What won.** Each strategy on its best timeframe (28 on 30-minute, 14 on 1-hour, 18 on 4-hour), **simple majority** (more buy than sell votes; a tie never trades), at least 30 of the 60 holding an opinion, held **up to four days** and always closed before Deriv's Friday close. Short holds lose to commission (Deriv charges once, at the open, so a longer hold pays it once over a bigger move).
- **Stop 0.6% from entry, target 1.5x the stop after commission.** At x100 a stop can be at most about 0.78% of price before it passes the 80%-of-stake cap; 0.6% was in the middle of the range that held up.
- **No binary fallback.** Below about $4 the $1.00 multiplier minimum is over 20% of the balance; the poll was tested on multipliers only, so it now waits rather than buying 1-day Rise/Fall contracts.
- On upgrade, the agreement setting is set once to 0.50 and the hold to 96 hours.
- **History paging fix.** The previous build's history pages left a 500-candle hole between the first request and the older pages. Pages now join exactly (tested). H1 is kept 100 days and H4 400 days, since the poll reads up to 1,600 H4 candles.
- ICT is not one of the voters: as a voter it would speak on 1.5% of candles, and its four-day value was +2.2 bps on Nov–Jun and +0.3 bps on Jul–Sep — weaker than the poll itself.

### Backtest of exactly what ships
| | Trades | Win % | Net ($1 x100 per trade) | Worst drawdown |
|---|---|---|---|---|
| Direction only (4-day or Friday exit, no stop), Nov–Jun | 575 | 56 | +5.5 bps per trade | |
| Direction only, Jul–Sep (unseen) | 238 | 55 | +8.5 bps per trade | |
| Live rules, $20 account, Nov–Jun | 152 | 52 | +$3.24 | $4.57 |
| Live rules, $20 account, Jul–Sep (unseen) | 62 | 48 | +$0.64 | $3.81 |
| Live rules, $5 account, whole year | 115 | 50 | −$1.35 (ends $3.65, then below the $4 floor) | $7.64 |

The direction is right a little more often than not in every month of the year (11 of 11), for buys and sells alike. Deriv's stop limit and the account's risk rules cut that edge down to about one or two cents per $1 trade, and settings next to the chosen one swing between small gains and small losses. Treat the edge as small and unproven. On $5 a normal losing run takes the balance under the $4 needed to keep trading.

## ICT replaced by a 60-strategy poll

### Why ICT is gone
Re-run over a full year of Deriv candles (Nov 2025 – Sep 2026, all 14 pairs), the ICT setting the bot traded (sweep → structure break → FVG, reward:risk 1.5 at the fill) took 45 trades at a 33% win rate and lost **$2.16** on $1 x100. The three-month test that looked positive (+$0.71) was one good September. No ICT variant made money over the year; taking every ICT setup lost $10.48. The judge, its filters (ATR percentile, efficiency ratio, geometry, premium/discount, claim checks) and the concept-suppression gate are deleted.

### What trades now
- **60 strategies vote on every closed M30 candle of every pair: 40 quantitative, 20 technical.** Quantitative: Markov chains (up/down, three-state, second-order, candle-type, regime, run-length uplift), Monte Carlo (bootstrap, block bootstrap, permutation test), Brownian barrier probability, Fourier (dominant cycle, low-pass projection, spectral trend), Kalman filter, Hurst exponent, DFA, Ornstein-Uhlenbeck, z-score, autocorrelation, variance ratio, regression t-stat, Bayesian posterior, logistic regression, k-nearest-neighbour patterns, intraday and weekday-hour seasonality, currency strength (momentum and reversion across all 14 pairs), cross-sectional momentum, KAMA, Ehlers super smoother and instantaneous trendline, Haar wavelet, fractal dimension, entropy, and more. Technical: RSI, MACD, EMA 20/50, Bollinger, Stochastic, ADX/DMI, Ichimoku, Keltner, ROC, Williams %R, CCI, Donchian, Parabolic SAR, daily pivots, **Fibonacci retracement + MACD**, Supertrend, Aroon, Heikin-Ashi, TRIX, Vortex. None use volume (Deriv forex candles have none).
- **The rule: when at least 70% of the strategies with an opinion agree, and at least 30 of the 60 have one, the bot buys or sells at market.** "Minimum signal confidence" on the Configuration page is now this agreement threshold; it is set to 0.70 once on upgrade.
- **Stop 8 M30 ATRs, target 1.5× the stop after Deriv's commission, closed at the 24-hour hold limit** (and before Deriv's Friday close) if neither is reached. That is about a day's range, so most trades run to the hold limit: the stop and target are sized to the 24-hour hold.
- **One position per pair.** The account rules are unchanged: Deriv trading hours, no new trades from Friday 16:00 UTC, sessions, news blackout, cooldown, daily loss budget, $1.00 multiplier floor, stop cap, currency-leg and asset-class caps, Deriv's minimum stop and take-profit, and the live cost quote.
- Each strategy uses only closed candles (tested: adding later candles never changes an earlier vote). The live scan computes only the newest candle and votes exactly as the backtest does (tested against the full computation); polling all 14 pairs takes about a second.
- The Strategy page lists the 60 voters, generated from the voting code. Each scan records the vote count for every pair it did not trade (Analysis → "Strategy poll"). Trade reviews credit the strategies that voted for each trade.

### Deriv history
Deriv returns at most about 695 M30 candles per `ticks_history` request (measured). The poll needs about 87 trading days, so the candle feed now fetches M30 history in six pages and keeps M30 candles for 130 days. A page's first candle can start mid-bucket (e.g. 11:20:58 on a 30-minute bar); such partial candles are no longer stored.

### Backtest: it does not make money
Replayed with the bot's own poll code, Deriv's measured commission ($0.02 per $1 x100 in London/New York hours, $0.06 otherwise), the $0.10 minimum stop and take-profit, the 80% stop cap, the live sessions and Friday rules. A candle that reaches both stop and target counts as a loss.

| | Trades | Win % | Net | Per $1 trade |
|---|---|---|---|---|
| Every signal, one per pair (Nov–Jun) | 1,236 | 48.5 | −$8.60 | −0.7¢ |
| Every signal, one per pair (Jul–Sep, out of sample) | 571 | 46.2 | −$4.09 | −0.7¢ |
| $5 account, one position at a time (Nov–Jun) | 55 | 38.2 | −$3.54 | |
| $5 account, one position at a time (Jul–Sep) | 68 | 47.1 | +$1.34 | |

Before commission the poll's direction is worth +0.03 to +0.05 of the risk per trade; Deriv's commission is about the same size, so after costs it is slightly negative. On a $5 account, whether a given quarter ends up or down is mostly the order the trades came in. Requiring 80% agreement did worse. Selecting only the strategies that scored best on Nov–Jun did not help out of sample. Each strategy alone, and ICT, did worse than the poll per trade.

## Trade the backtest's middle setting

Chosen by the operator after the three-month backtest:

- **Reward:risk is judged at the actual fill, not from the FVG midpoint.** The scan no longer demands it from the midpoint; `planEntry` enforces it at the live entry price, after Deriv's minimums and commission.
- **The H1 premium/discount veto is removed.** Premium/discount and OTE still add to the judge's confidence score; they no longer veto a setup. The veto removed 86% of setups.
- **Minimum reward:risk 1.5** (was 2.0) and **force-close after 24 hours** (was 36). Existing settings are moved once, only where they still held the old defaults, so a later choice is never overwritten.
- Volatility (ATR percentile 15–90), chop (efficiency ratio 0.15), minimum stop (1 H1 ATR), confidence (0.70), killzones, news blackout, Friday cutoff and every risk cap are unchanged.

On the backtest this setting took 22 trades in three months instead of 2: 50% winners, +$0.71 at a 36h hold and +$0.88 at 24h, on $1 x100 after $0.02 commission. That is a small sample: August was negative, and at $0.04 commission it was −$0.24. Taking every setup lost money, which is why the other filters stay.


## Friday cutoff on Deriv's hours, plain token errors, and what a 3-month backtest showed

### Deriv's real trading hours
Deriv's `trading_times` (checked for every Friday from October 2026 to April 2027, across the clock change, for all 14 pairs): forex opens **Monday 00:00 UTC**, trades through the week, and **"Closes early (at 20:55)" on Fridays**. The bot used the interbank week instead (Sunday 21:00 reopen, Friday 21:00 close). It now follows Deriv.

### No weekend holding
- **No new trades from Friday 16:00 UTC** (no new setups, no entries on pending ones). A trade opened late on Friday may not reach its stop or target before the close.
- **Open positions are bought back from Friday 20:30 UTC**, before Deriv's 20:55 close. Deriv only buys a contract back while its market is open, and the contract monitor retries every 30 seconds. Monday can open far from Friday's close, straight past a stop, and a multiplier then loses up to its whole stake.

### A rejected token says so
Deriv's error docs: HTTP 401 is a missing or invalid token, 403 is a valid token without the needed scope. The demo token expired overnight on 2026-10-01 and showed only as "Deriv account lookup returned HTTP 401". It now reads "Deriv rejected the API token (HTTP 401): it has expired or was deleted. Create a new token with the Trade scope... (Deriv allows up to 90 days)". Because a rejected token never recovers on retry, the connection is flagged at once instead of after three failed polls.

### Setups the order planner could never enter
In 16% of the setups the judge found, the entry FVG reached a fraction of a pip past the stop. The order planner refuses such levels, so each became a signal that was always cancelled at entry. The judge now declines them at the scan with a clear reason. On three months of Deriv candles this changes no trade under any tested setting; it only removes signals that could not trade.

### Backtest (2026-07-01 to 2026-09-30, real Deriv candles, all 14 pairs)
The bot's own decision code (pre-filter, judge, geometry gate, entry planner, setup invalidation, market-hours gate) was replayed on the live 30-minute schedule. Entries were simulated on the retrace and brackets on 5-minute bars, at a $1 x100 stake with $0.02 commission. Of 24,052 pair-scans the strategy found 622 setups:

| Setting | Trades | Win % | Net |
|---|---|---|---|
| Current | 2 | 50 | +$0.05 |
| Volatility cap 95 and/or chop 0.10 | 2 | 50 | +$0.05 (no change) |
| No premium/discount rule, reward:risk 1.5 judged at the fill | 22 | 50 | +$0.71 (+$0.88 with a 24h hold) |
| Take every setup | 59 | 39 | -$2.86 |

The volatility and chop filters are not what keeps the bot idle; the premium/discount rule and reward:risk measured from the FVG midpoint are. Loosening those trades more, but 22 trades in three months is too few to show an edge: August was negative, and at $0.04 commission it turns to -$0.24. Taking every setup loses. No setting was changed.


## Commission read as dollars, as measured

The demo self-test compared Deriv's `commission` field at two stakes: 0.02 at $1, 0.2 at $10. It scales with the stake, so it is a dollar amount, which settles the conflict in Deriv's docs. The dispatcher had been taking the larger of the two possible readings. That is identical at the $1 stake, but at $10 it would have counted $2.00 instead of $0.20 and turned away trades that clear reward:risk. It now uses the dollar value. The same self-test run confirmed x100 is offered on all 14 pairs and that Deriv's shortest forex Rise/Fall is 1 day, which is what the bot sends.


## Second pass against Deriv's docs: rate limits, connection limits, keep-alive

- **Self-test would have tripped Deriv's rate limit.** With `contracts_for` now working, the self-test would have learned Deriv's short minimum binary duration (likely ~15 minutes). It would then have bought one and polled for settlement with a fresh login every few seconds: about 40 REST calls a minute against Deriv's documented 60-per-minute limit, for up to 17 minutes. That branch had never run live. The binary step is now quote-only at the duration the bot actually sends; Deriv's minimum is reported for information.
- **One failed balance poll paused trading for five minutes.** The first failed sync marked the connection "error". An errored connection is neither traded nor monitored, and is retried only every 5 minutes. It is now marked after 3 consecutive failures. A stale balance is still refused on its own: the dispatcher rejects equity older than 10 minutes.
- **Balance polls run one at a time.** Deriv allows 5 concurrent WebSocket connections per user, and the contract monitor, reconciler and dispatcher open their own.
- **Re-subscribing a quiet pair cancels the old stream first** (`forget` with Deriv's subscription id), so repeated re-subscribes over a weekend can never stack duplicate streams toward the 100-per-connection limit.
- **`profit_table` rows with a null `contract_id`** (allowed by the schema) are skipped instead of being read as contract 0.
- Removed the unused `binaryDurationMs` helper.


## Checked against Deriv's own API documentation and schemas

Every request the bot sends was validated against Deriv's published JSON schemas (developers.deriv.com/schemas), and every response field it reads was checked to exist. Deriv's schemas reject any field they do not list.

**Requests:** 13 of 14 were valid. `contracts_for` sent a `currency` field its schema does not allow, which is why the self-test reported "Could not read Deriv's minimum duration via contracts_for". Fixed.

**Responses read under names Deriv no longer sends:**
- **Reconciler could lose track of a real position.** `portfolio` contracts carry `underlying_symbol`, not `symbol`. When a buy's outcome was ambiguous (connection dropped after sending), the contract Deriv had in fact opened never matched, and after the grace window the signal was marked "not placed". That left a live position the bot did not know about: not in the loss budget, not in the position count, not force-closed at the hold limit. It now reads `underlying_symbol`.
- **Closing price was always empty.** `proposal_open_contract` has `exit_spot`, not `sell_spot`, and `underlying_symbol`, not `underlying`. Closed trades now record where they closed.
- **Expired binaries.** A contract settling at expiry reports `status: won/lost`; that now counts as closed alongside `is_sold`.

**Recovered trades filed under the wrong account.** The reconciler linked an executed-but-unrecorded contract to the first connected account. With a demo and a real connection, a real trade could be filed under demo. It now searches every account for the contract and links it to the one that holds it.

**Commission unit.** Deriv's proposal schema calls `commission` "Commission changed in percentage (%)", while `proposal_open_contract` calls it "Commission in payout currency amount". At $1 x100 both readings give $0.02, which is why the self-test could not tell them apart. The dispatcher now takes the larger of the two readings, which only ever widens the stop, and the self-test quotes $1 and $10 (no order) to report which unit Deriv actually uses.

**Multipliers per pair.** The self-test now asks `contracts_for` which multipliers each of the 14 pairs offers and reports any pair where x100 is not available.

**Keep-alive.** Deriv's best practice is a `ping` every 30 seconds; the price feed never sent one. It does now.

**Quote refusals are explained.** When Deriv refuses a price quote, its own reason is shown in the rejections panel instead of a generic "could not read a price".


## Scan right after each M30 close, and never read the candle still forming

**Scan timing.** The scan ran every 30 minutes counted from process start. In production that put it at 17:28:54, 17:58:55 and so on, a minute *before* each M30 close. Setups are read from M30 candles, so a setup completed at 17:30 was not seen until 17:58, and a quick retrace into its FVG could be over by then. Scans now run 20 seconds after every M30 close (:00:20 and :30:20 UTC), which cuts the delay from up to ~30 minutes to ~20 seconds. The dashboard's "next scan in" shows the real time.

**Forming candles.** The newest stored H4, H1 or M30 row can be the candle still in progress: Deriv's history includes it, and the feed writes it on every reconnect. The analysis could judge "did price close beyond structure?" on a close that had not happened yet. The scan now uses only finished candles.


## Scan only the 14 pairs Deriv offers as multipliers

The catalogue listed 28 forex pairs. Deriv's Multipliers → Forex list for this account has 14: EUR/USD, GBP/USD, USD/JPY, AUD/USD, USD/CAD, USD/CHF, EUR/GBP, EUR/JPY, EUR/AUD, EUR/CAD, EUR/CHF, GBP/JPY, GBP/AUD, AUD/JPY.

- Five pairs Deriv does not recognise at all ("Invalid symbol"): NZD/CAD, NZD/CHF, CAD/JPY, CAD/CHF, CHF/JPY.
- Nine stream prices but are not offered as multipliers: NZD/USD, EUR/NZD, GBP/CAD, GBP/CHF, GBP/NZD, AUD/CAD, AUD/CHF, AUD/NZD, NZD/JPY. The bot could find a setup on one of these and never be able to trade it.

The catalogue drives the scan, the price feed and the allow-list, so all three now use the same 14 pairs.


## Pre-funding audit: the trade that executed was not the trade that was approved

### Critical: the bracket was measured from the wrong price

A multiplier fills **at market**. Signals fire while price is still *above* the FVG it is expected to retrace into, and the dispatcher measured the stop-loss and take-profit dollar amounts from the **FVG midpoint** — then sent them with a market order. On the judge's own test setup:

| | approved | as it would have executed |
|---|---|---|
| stop | at the sweep, beyond structure | ~100 pips higher, **on top of the FVG** the retrace goes into |
| target | the liquidity pool | ~100 pips **past** the pool |
| reward:risk | 2.73 | **0.59** |

The strategy's normal entry (the retrace) would have stopped it out.

**Now:** a signal waits for price to actually come into its entry zone. A new entry watcher checks pending signals against live ticks every 15 seconds; the full dispatch runs only once price is in the zone. The bracket is measured **from the live price to the structural stop and target**, and reward:risk is re-checked there, after Deriv's minimums, cent rounding and commission. A signal whose stop is hit, or whose target is reached before entry, is cancelled rather than chased. A 20,000-case property test holds the invariants: executed RR ≥ floor, stop never tighter than structure, target never beyond the pool, no entry outside the zone.

### A setup that was already broken could still be entered

The dispatcher cancelled a setup whose stop had been hit only when it reached its own entry check, and it only looked at the price *now*. The killzone, news and loss-budget gates run first and return early. So a buy whose stop was taken at 03:00 UTC stayed pending, and when price came back into the zone at the London open it would have been entered on a structure that no longer existed. A wick through the stop between two checks was missed the same way, and so was anything that happened while the server was restarting.

The entry watcher now cancels a pending setup **before any gate**. It judges on every price traded since the signal was created: stored M5 candles, the candle still forming, and the live tick. The partial candle the signal was born in is left out, so earlier price can never cancel it. Verified against the database: the broken setup was cancelled with *"Price traded down to 1.00000, through the stop 1.00100, before an entry"*, and the valid one next to it stayed pending.

### The trading-cost gate measured nothing

It computed `|ask_price − stake| / stake`. On a stake-basis proposal Deriv's `ask_price` **always equals the stake** (the self-test showed `ask_price 1` for $1), so the cost was 0% on every quote. It now reads Deriv's **commission** from a quote of the exact contract (real stake, real direction, account currency) as a % of position size, and reads Deriv's own stop-loss / take-profit min/max from the same response.

### The bracket now includes the commission

Deriv books the commission as a loss at open. A stop-loss of $X therefore fires after a price move worth only $X − commission, and a take-profit of $Y needs $Y + commission. Both amounts now include it, so the stop fires at structure and the target at the pool, and reward:risk is measured in money actually won or lost.

### An unverified $0.50 minimum would have kept a $5 account idle

When Deriv's quote does not state a minimum, the dispatcher assumed $0.50, a value carried over from the original import and never checked. On the $1.00 stake at x100 that forces every stop to at least **~58 pips** on EURUSD and, at 2:1, every target to **117+ pips**. Almost no M30 setup qualifies. The assumed minimum is now **$0.10** (a lower minimum only ever permits a *tighter* stop, never more money at risk). If Deriv's real minimum is higher it refuses the order, nothing opens, and the dispatcher **learns the minimum from the refusal** and re-plans the signal. The demo self-test now prints Deriv's actual limits and commission.

### Each stop is capped at what is left of today's loss budget

After a loss on a small account the daily-loss guard shrinks the stake below $1.00, then the multiplier floor lifts it back to $1.00. That lifted trade could carry a stop larger than the budget it was sized against. The stop is now capped at the lowest of 80% of stake, Deriv's maximum, and the remaining daily budget.

### Other fixes

- **Open price was the stake.** Trades stored the contract's buy price ($1.00) as the open price on every pair, so the trade review could not classify anything. It now stores the live price the order was placed against.
- **Pending signals stacked.** A new signal on a symbol now supersedes older pending ones on that symbol, rather than several waiting to fire at once.
- **Position ceiling is enforced per account at dispatch.** Signals now wait hours for entry, so the count checked at signal time was stale by the time one filled.
- **Price feed could silently lose pairs.** Any Deriv error naming a symbol dropped it for good, including "market is closed" and rate limits. A reconnect over the weekend could leave Monday with no live prices until a restart. Only an invalid symbol is dropped now, and any pair with no tick for 5 minutes is re-subscribed.
- **Multiple real accounts.** A login holding a USD account next to, say, a crypto account failed to connect ("multiple active accounts"). The single USD account is now chosen.
- **Contract monitor health stayed "degraded" forever** after one transient Deriv error. Errors now describe the current cycle.
- **Rejections panel churn.** The watcher re-evaluates every 15s; identical reasons are recorded once (10-minute dedupe per symbol) and unchanged reasons are not re-written to the database.
- **Demo self-test** now also proves the contract monitor can see a closed contract (the path that notices a real stop-loss or take-profit being hit), and fails loudly if it cannot.

### ATR percentile: checked, left as is

The computation is correct (Wilder ATR-14 on H1, ranked within the last 200 values). The 91–98 readings on the AUD/NZD crosses were clustered in one region at one time, consistent with a genuine volatility event rather than a bug. The baseline includes quiet Asian hours while the bot only scans London/New York. Modelled on a pair whose session range is 2.2x its Asian range, that raises how often an ordinary in-session reading exceeds the 90th percentile from ~9% to ~13%. That is a mild extra strictness, not a blocker. `atrPercentileMax` stays at 90 and the efficiency-ratio floor at 0.15.

75 tests pass. Production build boots cleanly; all 11 pages render with zero console errors at 1440px and 375px.


## Fix: take-profit targets were noise, so reward:risk could almost never pass

The first live scan showed the judge **finding real setups** and every one of them dying at the geometry gate — not narrowly, but by an order of magnitude: `RR 0.06`, `RR 0.35`, `RR 0.51` against a floor of 2.0.

### Why

```ts
const stop      = sweep.level - stopBuffer;     // the sweep extreme
const target    = Math.min(...opposingSwings);  // the NEAREST swing
const m30Swings = swingPoints(m30, 2);          // any 2-bar fractal
```

Risk was measured to the sweep extreme — the whole displacement leg. Reward was measured to the first two-bar bump above entry, which on M30 is noise. The comment above it already said *"the next **real** opposing swing"*; the code did not implement "real".

### Measured, not assumed

Across 20,227 sweep-into-FVG geometries from seeded markets:

| target rule | setups still with a target | pass RR ≥ 2 | median RR |
|---|---|---|---|
| **k=2, no distance floor (old)** | 19,713 | **4%** | **0.11** |
| k=5, at least 1 ATR beyond entry (new) | 16,983 | 16% | 0.70 |
| k=5, at least 1.5 ATR | 14,158 | 29% | 1.17 |

A median of 0.11 against a 2.0 floor means the gate almost never passed. That is the bug, quantified.

### A correction to my own first reasoning

I initially expected the wider fractal to do the work. It doesn't: a fractal measures *isolation*, not *size* — a small bump sitting on a flat shelf is a valid fractal at any width. What actually separates a liquidity pool from noise is **distance**. The fractal width still helps (confirmed swings only), but the one-ATR floor is the rule that matters, and a test now documents that so nobody makes the same assumption later.

### What changed

- Targets come from a **k=5 fractal** (a confirmed swing) that sits **at least one ATR beyond entry** — the same yardstick the minimum stop distance already uses.
- Structure detection stays at k=2; a small pivot is enough to confirm a break.
- If no swing qualifies, the setup is declined with a specific reason rather than handed a target that is not a liquidity pool.
- **`minRiskReward` stays at 2.0.** I deliberately did not use the 1.5-ATR setting that would have let more trades through, and did not derive the target from the ratio it is judged against — both would be tuning until it trades rather than fixing what was wrong.

### Also

The self-test summary printed its round trip as `$0.02` while the step correctly read `-0.02`. The sign is now kept.

58 tests pass. All 11 pages render with zero console errors.


## Make candle pruning safe on a real-sized table

The retention prune filtered on `(timeframe, open_time)`, but the only index on `candles` leads with `symbol` — so every prune fell back to a **sequential scan of the whole table**. Measured on 480,000 rows: ~200ms per timeframe, seven times an hour, growing with the table forever.

It also issued one unbounded `DELETE` per timeframe. On a table this feed writes to continuously, a single large delete holds row locks for its whole duration and builds one enormous transaction, so live candle inserts queue up behind housekeeping.

Three changes:

- **An index the prune can actually use** — `candles (timeframe, open_time)`. Verified: the plan goes from `Seq Scan` to `Bitmap Heap Scan`.
- **Batched deletes** — 5,000 rows per statement, so each lock is brief and inserts are never blocked behind a cleanup. Verified against 120,000 stale M1 rows: cleared completely while the app answered `200` throughout.
- **The first prune waits 90 seconds after boot** instead of running during startup, so a large cleanup can never compete with the feed coming up.

Verified end to end: the production bundle boots against a 480,000-row candles table, responds on its port immediately, prunes in the background, and clears every retired row without a single failed request.


## Fix: the demo self-test never placed an order

You noticed the Deriv balance never moved when you ran it. It never moved because **nothing was ever bought**, and I had told you otherwise. That was wrong, and it mattered — it was the one thing the test was supposed to prove.

Both paths were quote-only:

- The multiplier check was a `proposal`, explicitly "never a `buy`".
- The binary check *could* buy, but only when Deriv's own reported minimum duration fits inside the 20-minute synchronous wait. A forex binary runs for **days**, so that branch is unreachable for forex and it fell through to another proposal.

A proposal never creates a contract, so the balance was correct to stay still.

### Why it was built that way, and why that reason expired

The comment says the multiplier stayed quote-only because the codebase "has no way to close a multiplier position early". That has not been true for a while — `sellDerivTrade` exists and both the contract monitor and the manual-close route call it.

Meanwhile the sell path had **never run against Deriv at all**. Its own note read: *"treat a first real use of this as a genuine test, not a proven capability."* So the first real use of selling would have been the contract monitor closing a **funded** position. That is the worst imaginable place to discover a bug, and this whole file exists to stop exactly that — the buy path once had a wrong field name that no amount of review caught and only a live order exposed.

### What it does now

A genuine multiplier round trip on the demo account:

1. Quote the multiplier shape (unchanged)
2. **Buy** at Deriv's $1.00 minimum, with a stop-loss and take-profit attached so `limit_order` is exercised too
3. Confirm the contract opened
4. **Sell it straight back**
5. Report the buy price, the sell price and the round-trip cost

The demo balance moves by the spread — that movement is the proof an order really went out. If the buy confirms but the sell fails, it says so loudly, names the contract, and tells you not to fund until the sell path works.

The binary path stays a quote-only check, honestly labelled: a forex binary runs for days and cannot be bought and waited out inside a self-test.

This also makes the `auto_live` gate mean something. "A passed demo self-test" now implies an order went out and came back, rather than that two quotes were accepted.


## Audit pass: numeric edge cases, and an error handler that talked too much

Rather than read the quant layer and hope, this pass drove every exported function with degenerate inputs — empty series, a single bar, sixty flat bars, all zeros, negatives, values near the floating-point floor — and reported anything that threw or produced a non-finite number. 37 functions x 8 inputs, then the judge itself across 125 combinations of those series.

### One indicator threw where every other one returns null

`srFlipSignal` read the last bar behind a non-null assertion:

```ts
const price = c[c.length - 1]!.close;
```

On an empty series that is `undefined.close` — a `TypeError`. Every sibling indicator returns `null` when it has insufficient data; this one crashed. And it runs inside the worker tick, whose only error handler is the catch around the **whole cycle**, so one symbol with no stored candles would abort the scan for every remaining symbol.

Fixed at the source, and hardened around it: each of the fourteen confluence voters now runs behind its own guard, so an exception in any one costs that one vote rather than the scan. A missing opinion was already a first-class outcome there (`direction: null`), so a failed indicator degrades into exactly that.

After the fix: no throws, no non-finite levels, and every decline carries a reason, across all 125 series combinations. Three tests pin it.

### The error handler returned internal details to anyone

```ts
res.status(500).json({ error: "Internal server error", detail: message });
```

A failed query answered with the SQL itself — `Failed query: select "id" from "app_owner" limit $1` — and `/auth/status` is a public path, so anyone who could reach the app could read it. Internal error text also carries file paths and driver internals; the existing `otp=` redaction shows the risk was understood, but one pattern cannot cover whatever an arbitrary error decides to say.

Worse, the detail was not even reaching the log. `logger.error({ msg: message }, "Unhandled route error")` keys the detail as `msg`, which is pino's own message field, so the second argument overwrote it — the error text survived **only** in the response body, the one place it should not have been.

Now a short correlation id goes to both sides: the client gets `{"error":"Internal server error","errorId":"174c9d058e54"}` and the log gets that id plus the full cause under `detail`. Verified by taking the database down and calling the public endpoint.

56 tests pass. All 11 pages render with zero console errors, no overflow at 1440px or 375px.


## Audit pass: time, dates and session boundaries

A trading bot lives on UTC correctness, so this pass looked at nothing else. One real finding.

### News event times depended on the host's timezone

Every date in the server is computed in UTC — except the one that parses the news calendar:

```ts
const date = new Date(item.date);
```

An ISO string with no offset (`"2026-09-30T08:30:00"`) is interpreted in **local** time by the JavaScript spec. This container resolves to UTC, so it read correctly *by luck*. On a host with `TZ` set to anything else, every high-impact blackout window would silently shift by that offset — and the bot would trade straight through NFP believing it was clear. Exactly the kind of failure that never announces itself.

A timestamp that names its zone is now honoured; one that does not is read as UTC explicitly, so the answer is the same on every machine. When the feed sends zone-less dates it says so once in the log, instead of quietly guessing.

### Verified correct, with tests to keep them that way

Nothing else in the server uses a local-time method — no `getHours()`, `getDate()` or `toLocaleString()` anywhere in date math. The remaining boundaries are now pinned by tests:

- **The forex week** — open until Friday 21:00 UTC, closed all Saturday, reopens Sunday 21:00 UTC, checked either side of each edge
- **Session windows** — london 07:00–16:00, newyork 12:00–21:00, and that together they cover 07:00–21:00 with no gap at the handover
- **Blank killzones really means every open hour**, not a hidden default, for blank, null and whitespace alike; an unrecognised name is ignored rather than silently blocking everything
- **The daily-loss budget** rolls on the UTC day, and position age is an epoch difference, so neither moves with the host clock
- **D1 candles** are chart-only and never reach the judge, so their 00:00 UTC bucket boundary cannot affect a trading decision

53 tests pass.


## Add: "Run scan now"

The scan loop runs every thirty minutes, and `POST /api/brain/generate-signals` existed to run one on demand — but nothing in the app ever called it. Waiting out the interval was the only way to see the effect of a settings change, which makes every adjustment a thirty-minute experiment.

There is now a button on the Analysis page, next to the refusal panel. It reports which of the two things happened (a scan started, or one was already running), and refreshes the refusals a few seconds later so the result of that scan is on screen without a reload.

Verified in a browser: click → "Signal generation cycle started" → the panel repopulates with that scan's refusals.


## Fix: why every scan said "No price tick received yet"

The refusal panel did its job — it showed the real reason immediately, and the reason was a bug.

Three faults compounding:

**The feeder only subscribed six pairs at boot.** `DEFAULT_FEED_SYMBOLS` was the six majors; everything else lazy-subscribed the first time it was needed. But the signal worker scans **every** forex pair, and it checks for a tick in the same instant it subscribes — so on the first scan after any restart, the other twenty-two pairs had no tick *by definition* and were all dropped. The next scan is thirty minutes later, so every restart cost a full cycle across most of the catalogue. The feeder now subscribes every pair the worker can scan, at boot, so ticks are already flowing when the first scan runs.

**Pairs Deriv refuses were re-analysed forever.** Five pairs — `frxCHFJPY`, `frxCADJPY`, `frxCADCHF`, `frxNZDCAD`, `frxNZDCHF` — are not offered on this account. They can never produce a tick, yet every scan re-checked them and logged a feed complaint. They are now skipped with the truthful reason ("Deriv does not offer this symbol on this account"), which also clears five permanent false alarms out of the panel.

**The message blamed the wrong thing.** "candle feed may be disconnected" was printed while the feed was plainly connected and streaming, which sends every investigation down the wrong path. It now distinguishes the cases: a connected feed with no tick yet says the pair is thinly traded or its market is closed and will be analysed as soon as one arrives; a genuinely disconnected feed says so.

**Paced the history backfill.** Subscribing the full catalogue turns the boot backfill into one request per symbol per timeframe — well over a hundred frames. Fired in a tight loop that invites a rate limit which would cost the whole backfill, so history requests are now spaced ~150ms apart. Tick subscriptions still go out immediately, since those are what the worker waits on.

Verified: the feeder now subscribes **28** pairs at boot instead of 6.


## Fix: "Signal worker — Not running" on a perfectly healthy worker

The Overview tile read **Not running**, and the Analysis page read **WORKER IDLE**, while the System Health panel right below said the worker was `OK` with a tick two minutes earlier. The health panel was right.

`running` is true only while a tick is actually executing — a few seconds out of every thirty minutes. Both displays reported that flag directly, so a healthy, scheduled worker looked stopped for 29 minutes out of every 30, contradicting the panel beside it.

The status now distinguishes the states that matter:

- `scheduled` — the scan loop is running, which is what "is the worker working?" actually asks
- `stalled` — scheduled, but ticks are overdue (same rule the health panel already used)
- `nextRunAt` — when the next scan is due

Overview now reads **Scheduled · next scan in ~30 min**, Analysis reads **SCHEDULED · Next scan in ~29 min**, and both say **SCANNING NOW** during a tick, **SCAN OVERDUE** if ticks stop, **STOPPED** if the loop is not scheduled at all. That also answers "when will it trade?" without anyone having to know the interval.

Verified against a live server: `scheduled: true`, `stalled: false`, `nextRunAt` 30 minutes after the last tick, and both pages rendering it.


## Whole-repo audit: five more, one of them dangerous

Read the ~16,400 hand-written lines outside the vendored UI primitives. Five findings.

### "Clear All" on the Trades page could orphan a live position

`POST /trades/bulk-delete` with an empty body deleted **every** trade row, open positions included — and "Clear All" in the UI was two clicks away from calling it.

Deleting an open row does not close anything at Deriv. The position stays open with real money on it while the only record of it disappears: the contract monitor stops tracking it, so it is never force-closed or settled, and the daily-loss guard stops counting its stake as open exposure, so **the very next trade is sized as though that risk were not there**.

The server now refuses to delete an open row whatever it is asked, reports how many it kept and why, and rejects an explicit `status: "open"` outright. Verified against a live server with a real open row: both the old "clear all" call and a direct attempt left it untouched. The button is now "Clear History".

### Two tables grew forever

- **`deriv_frames`** — every Deriv frame in and out, up to 20 KB each, never deleted. The contract monitor alone opens a session every 30s while a position is open. Left long enough the database fills, every write starts failing, and the bot dies weeks later with no obvious cause. Now kept to a 7-day window, pruned hourly.
- **`candles`** — nothing ever pruned them either. Now retained per timeframe (M5 7d, M15 14d, M30 30d, H1 90d, H4 180d, D1 2y), comfortably more than anything that reads them needs: the judge's deepest look-back is 250 H1 bars (~10 days) and 150 M30 bars (~3 days).

### M1 candles were built and stored but read by nothing

The chart offers M5 and up; the judge uses H4/H1/M30. Nothing has ever queried M1 — and at 1,440 bars a day per symbol it was roughly **three quarters of all candle writes**, plus 500 rows per symbol re-fetched on every reconnect. Removed, and the prune sweeps up any left behind. Verified: 400 M1 rows deleted, M5 trimmed 400 → 6, H1 650 → 339, everything else inside its window.

### The cost gate quoted the wrong instrument

`getIndicativeCostPct` always asked Deriv for a **$1 multiplier** quote, then the gate refused the trade if it came back empty — "refusing to trade blind". But on a sub-$1 account the order is a *binary*, so it was pricing an instrument that would never be traded, and a refusal of that irrelevant quote refused the real trade.

It was also running *before* sizing, so it could not have known. The market-hours/killzone/news checks stay early where they are free; the cost check moved to after sizing, and now quotes the actual contract type at the actual stake. `forexDispatchGate` was replaced by a `tradingCostGate` the worker really calls, so the tested helper and the production path cannot drift — two new tests cover the boundary and an invalid ceiling.

### Checked and found correct

- **No SQL injection** — every user-supplied value goes through drizzle's parameterisation, including the journal's `ilike` search and the weighted-decay `sql` templates
- **No other page has the autotrade dropdown bug** — the four pages that pair a Select with `form.reset()` all reset to static defaults after a create, never to async server data
- **Schema** — the unique index `onConflictDoUpdate` depends on exists in both the bootstrap and the migration; stake and P&L precision are far above anything this account can produce
- **The daily healthcheck script** is read-only diagnostics
- **Credentials** are stripped from every broker response and only ever leave the DB decrypted at the point of a Deriv call

49 tests pass. All 11 pages render with zero console errors, no overflow at 1440px or 375px.


## Full codebase audit before real money: three more bugs, two of them accounting

Went through the money paths line by line — execution, reconciliation, settlement, the risk math, the live-trading gate and the auth surface.

### A settled trade with unknown P&L stopped the bot for the rest of the day

The daily-loss guard refused **every** subsequent trade when it found a closed trade whose P&L it could not read:

```ts
if (!Number.isFinite(pnl)) { ...refusing execution; return; }
```

That is the wrong trade-off. The guard exists to bound losses, and halting the account until the next UTC midnight costs far more than the gap it is reacting to. It now counts such a trade at its true worst case — a full loss of the stake — which is *more* conservative for the budget and keeps the system running. The same applied to a closed row with no timestamp, which was worse still: those are never aged out of the query, so one of them blocked trading **permanently**, with a message you could not act on.

And it was reachable. Three separate paths could write a closed trade with a null P&L: the force-close and the settled-contract handler in the contract monitor, and the manual close route — any time Deriv returned a sell without a price.

### A fabricated $10 stake in the P&L calculation

Three places computed settlement as:

```ts
parseFloat(trade.lotSize ?? "10")
```

On a $1.00 trade, a row with no stake turns a **$0.50 profit into an $8.50 loss**. Worse, a non-numeric stake makes `parseFloat` return `NaN`, `NaN.toFixed(2)` is the string `"NaN"`, and that was headed for a numeric P&L column. Both results feed the daily-loss guard, so a fabricated stake does not merely misreport history — it mis-sizes the next trade.

Replaced with `settlementPnl()`, which returns null when the answer genuinely cannot be determined, so "unknown" is recorded as unknown instead of as a number nobody can stand behind. Four tests cover it.

### "3 of 3" concurrent trades was never reachable

`maxPerAssetClass` defaults to **2**, every forex pair is the same asset class, and this bot trades forex only — so the portfolio gate always refused a third position while the Configuration page kept promising one. The preview now reports the lower of the two caps (`2 of 2`, `limitedBy: asset_class_cap`) and the page says plainly that "Max open positions per asset class" — not "Max positions" — is the real ceiling.

### What I checked and found correct

Worth stating, because "no findings" is information too:

- **Execution** — the claim is a single atomic conditional `UPDATE`; a buy whose outcome is unknown is marked `ambiguous` and never replayed; pre-buy failures retry at most twice; the DB write retries three times and screams if it fails after a confirmed fill.
- **Reconciliation** — matches on symbol, stake and purchase time within a window, tracks already-linked contract ids so one contract cannot be claimed twice, and requires several clean polls past a grace window before declaring a signal not placed.
- **The live-money gate** — `auto_live` is refused at both the config endpoint and the dispatcher, needs a passed demo self-test *and* a connected real connection, and `placeDerivTrade` independently re-checks Deriv's `is_virtual` flag against the requested environment.
- **Auth** — every `/api` route is behind the session check bar a small login allowlist; the cookie is `httpOnly`, `sameSite: lax` and `secure`, which is what makes the permissive CORS reflection harmless rather than exploitable; login is rate-limited per IP.
- **Self-learning suppression** — unseen concepts stay eligible and scoring uses a Bayesian prior, so it cannot suppress the whole library on day one and starve the bot of setups.
- **Numeric columns** — stake and P&L precision are far above anything this account can produce.

49 tests pass. All 11 pages: zero console errors, no overflow at 1440px or 375px.


## Audit before funding: four findings, all fixed

### "Why no trade was placed" is now a panel, not an API call

Every refusal the pipeline makes was already being recorded — which gate, which symbol, the exact reason, last 200 kept — and served at `/api/system/rejections`. **No page displayed it.** The one question that actually matters when nothing happens was answerable only by typing a URL into the address bar.

It is now a panel at the top of the Analysis page, newest first, refreshed every 15s, with the pipeline stages named in plain language instead of their wire names (`pre_gpt` → "Quant pre-filter", `post_gpt` → "Geometry / claim check", and so on — those names stay in the stored data so entries recorded before the language model was removed still render).

On this machine it immediately explained the silence: 18 entries, all `Market readiness — News calendar unavailable; forex trading fails closed until it can be fetched`.

### An unreachable news calendar was reported as "degraded". It is not degraded, it is stopped.

While that feed is untrusted **every forex order is refused** — `newsBlackoutActive()` returns blocked when the event list is null, by design. Reporting that as amber understated it to the point of being misleading: the system was not running in a reduced state, it was not trading at all, and the top-level badge stayed green-ish.

It now reports **down**, turning the overall badge red, and says so directly: *"NO TRADES CAN BE PLACED… Set NEWS_CALENDAR_URL to a reachable mirror if this host stays blocked."* The fail-closed behaviour itself is correct and unchanged — trading blind through a high-impact release is how accounts die — but you should never have to guess that it is what is happening.

### The binary duration probe asked with the wrong stake

The probe that asks Deriv whether a 1-day binary is allowed sent a hardcoded `amount: 0.5`. If Deriv refused that proposal because of the *stake* rather than the *duration*, the result was read as "1 day not allowed" and the contract silently fell back to 3 days for no reason. It now probes with the stake actually about to be sent. The cache stays keyed by symbol alone, since Deriv's allowed durations are a property of the instrument, not the stake.

### Stale copy on two pages

The Overview flow still said the strategy list "feeds the signal prompt directly" — there is no prompt. The Strategy page called the expert system a budget stopgap: *"while no AI budget is configured… ready for GPT"*. Both now describe what the code does.

Verified: 46 tests pass, all 11 pages render with zero console errors, no overflow at 1440px or 375px, and the rejection panel renders 18 real entries.


## Fix: "Invalid symbol" that named no symbol and never cleared

The Chart page showed `Feeder error: Invalid symbol.` next to a feed badge reading `FEED CONNECTED · 28 symbols`. Both were true at once, and neither was useful.

Three separate faults:

- **The error named no symbol.** Deriv echoes the failing request back in `echo_req`, which is the only way to learn which of the 28 subscriptions it refused. That field was being parsed and then discarded, leaving a message nothing could be done about.
- **It never cleared.** `lastError` was only reset when a new socket opened, so a single refused symbol pinned an error into the status forever while the other 27 streamed normally — making a healthy feed look broken indefinitely.
- **The refused symbol was re-subscribed on every reconnect**, guaranteeing the same rejection again.

Now: the symbol is named, dropped from the subscription set so it is not asked for again, and recorded with Deriv's reason. Any tick arriving clears a stale feed error, because a tick is proof the feed is alive. The Chart page distinguishes the three cases it could not before — *this* symbol was refused and is not streaming; *other* symbols were refused and this one is fine; or the feed itself is in trouble.

## Fix: smaller honesty problems found in the same pass

- **"Generate signals" always reported success.** The worker returns immediately without doing anything if a cycle is already in flight, and the route reported `Signal generation cycle started` regardless. It now says which of the two actually happened.
- **The Strategy page still described the LLM as a budget stopgap** — "while no AI budget is configured… ready for GPT". The language model is gone by design, with no API key and no per-signal cost. The four concepts that are listed and scored but not independently computed (Parabolic SAR, Pivot Point Confluence, SMT Divergence, Inducement) were correct and are stated plainly.

Verified: 46 tests pass, all 11 pages render with zero console errors, no overflow at 1440px or 375px, and the Autotrade dropdown survives reloads.


## Fix: Autotrade mode went blank on every reload

Reported twice; it was a real bug, and the cause was not where it looked.

The server was never wrong. The mode saved correctly, the banner across the top read `MODE: AUTO_DEMO`, and `/api/config` returned `"autotradeMode":"auto_demo"` to the page. Only the dropdown on the Configuration page rendered empty.

Traced by instrumenting the form. `form.reset()` set the field to `auto_demo` correctly — and roughly a second later something set it back to an empty string:

```
DBG effect: config.autotradeMode = "auto_demo"
DBG after reset: getValues = "auto_demo"
DBG 1s later:    getValues = ""
```

That something is the Select component itself. Radix keeps a hidden native `<select>` for form integration, whose `<option>`s come from the menu items — and it does not mount the menu until the select is first opened. This form mounts with hardcoded defaults (`off`) and is only filled from the server afterwards, so a saved `auto_demo` arrived at a moment when Radix had no option matching it. Radix reported that mismatch back as `onValueChange("")`, which wiped the form field just after `reset()` had set it.

Which is why the symptom was so specific: `off` always displayed fine (it is the value present at mount), and only `auto_demo` and `auto_live` disappeared.

Two changes:
- Empty values coming back from the Select are ignored. No item has an empty value, so `""` can only ever be that spurious clear, never a real choice.
- The trigger's text is now derived from the form value through a single `AUTOTRADE_LABEL` map used for both the trigger and the menu, instead of relying on Radix to know the label of an item it has not mounted. The trigger and the options can no longer drift apart either.

Verified in a browser against a database holding `auto_demo`: correct after reload, correct after a second reload, correct after picking a different mode and saving. Zero page errors.

Worth noting for later: only this page populates a dropdown from server data, so no other Select had the bug. Any new one filled the same way would need the same care.


## Update: the stake ladder — risk that adapts to the balance

Sizing was one flat percentage applied at every balance, which cannot be right at both ends of this account's life. At $5, 20% is not aggression: it is the *smallest* number that reaches Deriv's $1.00 multiplier stake. At $500 that same 20% is a $100 swing per trade. Your saved settings are now a ceiling, and the balance applies a second one; the lower of the two trades.

| balance | band | risk | stake | contract | typical loss | worst case |
|---|---|---|---|---|---|---|
| $3.00 | Floor | 20% | $0.60 | binary | $0.60 | $0.60 (20%) |
| $4.99 | Floor | 20% | **$1.00** ↑ | multiplier | $0.50 | $0.80 (16%) |
| $5.00 | Floor | 20% | $1.00 | multiplier | $0.50 | $0.80 (16%) |
| $20.00 | Build | 10% ↓ | $2.00 | multiplier | $0.50 | $1.60 (8%) |
| $50.00 | Grow | 5% ↓ | $2.50 | multiplier | $0.50 | $2.00 (4%) |
| $200.00 | Steady | 2% ↓ | $4.00 | multiplier | $0.50 | $3.20 (1.6%) |
| $1000.00 | Mature | 1% ↓ | $10.00 | multiplier | $1.00 | $8.00 (0.8%) |

Worst case as a share of the balance falls the whole way down that column — 20% to 0.8%. That property, not any single setting, is what stops a losing run from ending the account, and there is a test asserting it stays true.

### The $4.99 row is the important one

Previously a $0.99 stake was sent as a binary, because Deriv will not open a multiplier under $1.00. That is backwards. A binary has no stop-loss: a loser costs the entire stake. A $1.00 multiplier's loss is bounded by its attached stop, capped at 80% of stake. **So $1.00 as a multiplier risks at most $0.80, while $0.99 as a binary risks a certain $0.99** — shrinking the stake *increased* money at risk, which is the opposite of what a risk cap is for.

A sub-$1.00 stake is now raised to exactly $1.00 whenever the balance can carry it, which holds down to about $4.00 (below that, $0.80 is more than 20% of the account and the lift correctly stops). This is the one and only place a cap is allowed to round up, and it does so because it lowers risk.

**A correction to what I told you earlier:** I said a typical loss on a $1.00 multiplier was $0.10–$0.15. That is wrong. Deriv will not accept a stop under **$0.50**, so the order builder clamps it there — the strategy's own 1-ATR stop models to about $0.10 but cannot be sent. A losing trade at the $1.00 floor costs **$0.50**, half the stake. The floor stops binding once the stake passes about $5. The table now shows this per row rather than leaving it to be discovered.

### The bands

`Floor` under $12 (20% / 20% daily) · `Build` $12–$50 (10% / 15%) · `Grow` $50–$200 (5% / 10%) · `Steady` $200–$1000 (2% / 6%) · `Mature` $1000+ (1% / 4%).

The cuts are not arbitrary: at each boundary the stake stays above $1.00 ($12 x 10% = $1.20, $50 x 5% = $2.50, $200 x 2% = $4.00, $1000 x 1% = $10), so stepping risk down never drops the account back onto the binary path. A test enforces that. The ladder can only tighten a configured setting, never loosen it — set 1% and you get 1% everywhere.

One consequence worth knowing: in the Floor band the daily-loss budget is held at 20% whatever you set. A $5 account allowed to lose 60% in a day is exactly the outcome this ladder exists to prevent. At your current 20/20 settings nothing changes today.

### The strategy now knows which contract it is getting

A binary costs the whole stake for being wrong where a multiplier costs its stop, so the binary path asks for more evidence: **minimum confidence + 0.08** before it will take one. Below ~$4.00 you will see fewer trades, deliberately.

### Seeing it

The Configuration page shows band, effective risk, stake, contract, typical loss, worst case and worst case as a share of equity, per balance — and a new **Risk ladder** panel serving the actual bands from the sizing code rather than restating them, with your current band marked. Both come from `describeStakePlan()`, which calls the real sizing functions rather than re-deriving them, so the preview cannot drift from what the worker sends.

46 tests pass. Verified live at $5.00: the table, the ladder and both advisories render correctly, all 11 pages have zero console errors and no overflow at 1440px or 375px.


## Update: keep the hold inside a day, size against live equity, drop the threshold to 0.70

Four things, all from the same question: *if profit grows do stakes grow, and is anything holding for more than a day?*

**Stakes do grow with equity — and now they refuse to grow against a stale number.** Every stake is a percentage of `accounts.equity`, read fresh from the database at the moment the order is sized, and `balance-sync` overwrites that row from Deriv every 60 seconds. So a win raises the next stake without any action from you, and a loss lowers it. The gap was the failure case: if the sync breaks, the figure freezes, and sizing keeps working off money that may no longer be there. The worker now refuses to size a trade when the broker connection has not synced in 10 minutes (the poller runs every 60s and retries a failing connection every 5 min, so 10 minutes means broken, not slow) and records it as a visible rejection instead of trading on a guess.

**Binaries no longer run for three days.** Two separate problems, both fixed:

- The binary duration was a hardcoded 3 days, because 3 days was the only value ever confirmed to work live (a 5-minute attempt came back `TradingDurationNotAllowed`). It now *asks* Deriv first: a quote-only `proposal` at 1 day, which never creates a contract, and only falls back to the verified 3 days if Deriv actually refuses. The answer is cached per symbol for 6 hours, so it costs one extra round-trip, not one per trade, and the chosen duration and the reason for it are recorded on the trade rather than left silent.
- The `maxPositionHoldHours` force-close **explicitly skipped binaries** — the filter was `contractType !== "multiplier"`, so a binary was exempt from the one control meant to bound holding time. That was the real conflict with the 4h–1day target: a fallback 3-day binary would have run for three days regardless of the setting. Both contract types are now bought back at that age. Where Deriv declines a buyback the contract still settles at expiry, and that is logged once per contract instead of every cycle.

Net effect at the 36-hour setting: a binary resolves within 24 hours where Deriv allows a 1-day contract, and within 36 hours where it does not.

**Minimum confidence: 0.78 → 0.70.** The expert judge replaced the LLM judge and produces confidence on a different scale (0.35 base, plus up to 0.40 from confluence and 0.25 from structure). A saved 0.78 was calibrated against the old scale and is far stricter than intended on the new one — on a small account that mostly means no trades at all. A one-time boot migration rewrites it, guarded by a marker row so it runs exactly once and only touches a row still holding the old default. Verified against Postgres: it moves 0.780 → 0.700 on the first boot, and if you later set 0.78 deliberately it is left alone.

**Seven unit tests were silently not running.** The `forex-readiness` suite died on import with `ERR_MODULE_NOT_FOUND` — the source uses bundler-style `.js` specifiers that do not exist on disk when Node runs the `.ts` directly — and the failure was easy to read as one flaky file. A small resolution hook maps `./x.js` to `./x.ts` only when the `.js` genuinely is not there, and one constructor parameter property that strip-only mode rejects was written out longhand. **32 tests pass**, up from 24 passing and 1 dead file. `pnpm test` in `artifacts/api-server` now runs them.

Verified live: server booted against Postgres, the migration applied cleanly at boot with no warnings, `/api/config` reports `minConfidence: 0.7`, and the configuration page renders with no console errors and no horizontal overflow at 1440px.


## Update: warn about the $1.00 multiplier boundary before it is crossed
Final pre-funding check, run by walking a $5 account through the real sizing functions rather than reasoning about them.

At 20% risk, a $5.00 balance produces a stake of exactly **$1.00** — precisely Deriv's multiplier minimum, with zero margin. Verified against the real code:

| balance | stake | contract |
|---|---|---|
| $5.00 | $1.00 | multiplier |
| $4.99 | $0.99 | **binary** |

So a single losing trade of any size — even a few cents — drops the account under the line, and every subsequent trade becomes a 3-day binary: no stop-loss, no take-profit, full stake at risk until expiry, and `maxPositionHoldHours` does not apply to it. Winning trades push back over. Nothing in the code is wrong here; it is the arithmetic of a $5 balance against a $1 floor, and no risk setting avoids it (20% is already the *minimum* that reaches $1.00 at $5).

That is too consequential to leave as a thing you discover after the fact, so the stake-preview card now warns on it directly, computing the exact crossover balance from the configured risk percentage:
- **Near the boundary** (stake ≥ $1.00 but < $1.20): names the balance at which the drop happens and what changes.
- **Already below it** (stake < $1.00): says trades are currently 3-day binaries and what balance restores multipliers.

Also worth recording from the same pass: the forex multiplier is **100×** (live-verified for `frxEURUSD`), so P&L ≈ stake × 100 × (price move ÷ entry). With the geometry gate's minimum stop of 1× H1 ATR (~0.1% of price on the majors), a typical loss on a $1.00 stake is roughly **$0.10–$0.15**, not the $0.80 the 80%-of-stake cap suggests — that cap is a backstop for unusually wide stops, not the normal case.

Verified in a browser at a real $5.00 synced balance: the warning renders correctly, zero page errors. 24 tests pass.

## Update: System health panel on the Dashboard
The readiness check that decides whether it is safe to fund or go live — `signal_judge`, `candle_feed`, `news_calendar` and the rest — was only reachable by opening DevTools or typing `/api/status` into the address bar. That is a bad answer for the one thing you check before risking money.

The data was already there: `app-layout.tsx` has been polling `/api/system/status` every 15 seconds for the mode banner, using `bot`/`executionLock`/`hosting` and **discarding the entire `components` array**. The Dashboard — whose heading is literally "Trading system status" — now renders it: one row per component with a colour-coded dot, its status, and its reason, plus an overall badge ("All systems go" / degraded / down). Same query key, so it shares the layout's existing poll rather than adding a second one.

Also trimmed the `signal_judge` reason string, which pointed at `runExpertJudge()`'s call site in `signal-worker.ts` — useful in a log, out of place in a panel an operator reads before funding. The swap-back instructions stay in the code comment where they belong.

Verified in a browser against a running server: renders correctly (green/amber/red/idle states all exercised, including a genuinely-down candle feed), zero page errors, zero horizontal overflow at 375px.

## Update: integration test — a judge signal survives every downstream gate
Closes the one seam the audit flagged but never actually proved. `runExpertJudge()` being correct is not the same as its output being *tradeable*: between the judge and a real order sit `geometryGate`, `verifyClaims` (which re-checks the judge's own cited levels against the candles) and `portfolioGate`. If any of those quietly rejected the judge's own output — a units mismatch, or the zero-width sweep range failing its own tolerance check — every signal would die at the last step, and the symptom would once again be "nothing ever trades" with nothing obviously broken.

The new test runs the exact chain `signal-worker.ts` runs after the judge returns, on the same fixture: geometry gate with real thresholds (R:R ≥ 2, stop ≥ 1 ATR, premium/discount), then `verifyClaims` for every cited level against M30/H1/H4, then portfolio caps. All pass. It also pins that the padded H1 fixture has enough history for `atrPercentile` — the worker asserts that non-null, relying on `preTradeGate` having already guaranteed it.

24 tests pass. No production code changed.

## Update: honest confidence scale + real concurrent-position capacity
Both of these were flagged by the audit as "you should know this"; fixed properly rather than left as advice.

**Confidence now spans a real 0–1 band.** The judge scored `0.50 + ratio*0.25 + bonuses*0.04`, which could only ever land between 0.50 and 0.95 — so a configured minimum of 0.78 silently meant "near-unanimous confluence required" rather than the plain 0–1 reading the Configuration field advertises. The fix is on the producer side, so an existing stored threshold immediately starts meaning what it says without anyone editing it:
- `0.35` baseline for clearing the structural trigger itself (sweep → structure break → unfilled FVG, plus the geometry and R:R gates) — real evidence, so it earns a floor rather than starting at zero.
- `+0.40 × agreement ratio` across the strategy-library voters that have an opinion. With no voter holding an opinion this now contributes **nothing** rather than a free half-share (the old formula handed out 0.125 for silence).
- `+0.25 × (structural confirmations / 5)` — displacement, OTE zone, order block, Judas timing, H4 agreement.
- Capped at 0.98; it is an evidence-strength score, not a win probability, and the field description now says so along with the band.
- `minConfidence` default unified to **0.70** across the schema, bootstrap SQL, boot seed, API defaults and the form — it was previously 0.780/0.780/0.78/0.7/0.78 in five places.

**"Max positions" no longer advertises capacity the account cannot fund.** New `maxFundablePositions()` in `execution-risk.ts` walks the *real* sizing functions one position at a time exactly as the dispatcher does (rather than duplicating the interaction), so the number shown is the number the trading path will honour. Surfaced two ways: a new "Trades at once" column in the stake preview (`1 of 3`, amber when short), and a warning under the field itself naming the binding constraint.

This immediately surfaced something worth knowing: **at 20% risk with a 20% daily-loss cap, the answer is "1 of 3" at *every* balance** — $5 or $10,000. That is not a small-account artifact; when risk-per-trade equals the daily budget, the first trade always consumes the whole allowance. Two or three concurrent positions require the daily cap to be roughly 2–3× risk-per-trade.

It also caught a genuine trap in the existing sizing math: each stake is capped at `equity / slots`, so **raising Max positions shrinks every stake**. At $5, going 3 → 8 drops the first trade from $1.00 to $0.62 — back under Deriv's $1.00 multiplier minimum, i.e. silently from multiplier contracts to 3-day binaries, purely from raising a number that looks like it can only ever permit more. The warning says this explicitly and a regression test pins it.

Verified live in a browser against a running server and fresh database: both the column and the warning render correctly with zero page errors. 23 tests pass (three new).

## Update: full system audit — real bugs found and fixed, plus first live UI verification
Requested as a deliberate high-focus pass over every field, page and config before funding. Ran the built server against a local Postgres and drove all 11 pages in a real headless Chromium, rather than reasoning from source alone.

**Genuine bugs fixed (not cosmetic):**
- **`efficiencyRatioMin` was never enforced.** The chop filter was stored in the DB, validated by the API, shown on the Configuration page, passed into `QuantThresholds`, and explicitly documented in strategy-library rank 28 as "gated by bot_config's efficiencyRatioMin" — but `preTradeGate` computed the ratio into its metrics and **never compared it**. Choppy, directionless markets have been passing straight through this whole time. Now enforced, with a regression test that a zig-zag series is rejected at the default 0.15 floor and passes at 0. Expect somewhat fewer signals — that filter doing its job is the point, and the field is on the Configuration page if you want it looser.
- **`srFlipSignal` could call a failed retest bullish.** Its "price above the level" check was written as `price > s.price - tol`, which the enclosing tolerance check had already guaranteed — so it was vacuous, and price sitting *below* a broken high (a failed retest, i.e. bearish) still voted buy. Now requires price to actually hold on the correct side.
- **`orderBlockPresent` confirmed almost everything.** It matched "any opposite candle followed by a 1.5x bigger one", which occurs constantly in normal volatility, so the Order Block confluence was a near-free confidence bonus. Re-anchored to `findDisplacements()` (a real ≥1.5x-ATR impulse) with a look-back for the candle that started the leg. Verified it fires on a genuine impulse and abstains on displacement-free data.
- **`stochasticSignal` took a `dPeriod` argument and never computed %D.** The library defines the signal as the %K/%D crossover out of the extreme zone; only %K was checked. %D is now computed and required (with the cross allowed to trail the zone exit by a bar — demanding both on the same bar never fired in practice).
- **`adxSignal` could divide by zero** on a fully flat window; now returns null instead of `NaN`/`Infinity`.
- **"DAILY P&L" in the header was not daily P&L.** `/dashboard/overview` computed `totalEquity - totalBalance` — that is *unrealized P&L on open positions* — and displayed it under a "daily" label on every page. Now computes realized P&L for the current UTC day, the same definition the daily-loss guard sizes against, so the number on screen and the number that can halt trading finally agree. Unrealized is still reported separately as `openPnl`.

**Silent-failure visibility (the class of problem that hid the missing AI key for months):**
- **The expert judge declining was completely invisible.** `if (!result) continue;` logged nothing and recorded no rejection — so "scanned six pairs, none had a setup" looked identical to "nothing ran at all". All 11 decline paths now report a specific reason (no H1 bias / no sweep in the last 20 M30 candles / structure never broke / FVG already filled / confluence disagrees, naming the dissenting voters / confidence X < minimum Y with the vote count / a suppressed concept), surfaced in the Analysis page's rejection log.
- **"No fresh price tick" was also a silent skip.** Now recorded as its own `no_tick` rejection stage naming the likely cause (candle feed disconnected) — verified live: it was the exact reason the local end-to-end run produced no signal, and it now says so on screen instead of nowhere.
- `NEWS_CALENDAR_URL` is now an env override. The forex path fails closed when the calendar feed is unreachable, so that one hardcoded host was a single point of "zero trades, everything looks green" — there is now a way to repoint it without a code change.

**Dead weight and stale claims removed:**
- `HardcodedStrategy.key` deleted from all 40 entries. Nothing read it (`conceptKey(name)` is the real identity everywhere), and several entries had already drifted out of sync with their own names — a misleading second source of truth.
- The workflow endpoint's stage 3 still described "GPT reads candles plus measured facts"; now describes the deterministic judge and keys off the `signal_judge` component.
- The "Enable bot configuration" switch claimed it only saves a setting; it actually gates the entire scan loop (no analysis, no signals, no orders when off). Description corrected.
- Unused `brainLayersTable` import in `dashboard.ts`; stale "skipping GPT analysis" log line; `weeklyPnl`/`monthlyPnl` documented as what they actually measure.
- **Minimum signal confidence now explains its own scale.** The judge scores 0.50–0.95, so the inherited 0.78 (set when GPT emitted free-form 0–1 confidence) demands near-unanimous confluence. The field description now states the real range and what each threshold implies.

**Verified by running, not by reading:**
- Sizing swept across 17 balances ($1 → $10,005) on three config profiles. Behaves correctly everywhere: refuses below Deriv's floor, the small-account rule engages where intended, `$5 @ 20%/20%` yields exactly the $1.00 multiplier-eligible stake. Two honest consequences of the current settings: at $5 a second concurrent trade is refused (the daily budget is fully consumed by the first, so `maxConcurrentPositions: 3` is unreachable at that balance), and one full stop-out ends trading for the UTC day.
- All 11 pages loaded in headless Chromium against a live server + fresh database: **zero page errors, zero failed API calls, no `NaN`/`undefined`/`[object Object]`/`Invalid Date` reaching the DOM, and zero horizontal overflow at both 1440px and 375px** — the 375px pass was previously listed under "Not built".
- Server boots clean on an empty database, first-launch owner setup works, and the candle feeder retries gracefully rather than crashing when Deriv is unreachable.
- 21 tests pass (four new regression tests covering the efficiency-ratio gate, order-block discrimination, the S/R-flip side check, and the decline reasons).

**Known, unchanged, and deliberate:** manual signals created on the Signals page are *not* auto-dispatched (no `expiresAt`, so the replay pass skips them) — the execution boundary holds. `auto_live` remains gated on both a connected real broker and a passed demo self-test, and demo/real connections are selected by environment so the two can never cross.

## Update: full-library confluence — most of the 40 strategies now actually vote
- Per explicit request: the previous pass replaced GPT with a deterministic judge, but scoped it to just the 4 concepts behind the core sweep→FVG trigger. This pass keeps that trigger mechanism (there can only be one real entry/stop/target per signal) but makes the *decision to fire* a genuine confluence vote across most of the 40-entry strategy library, computed live on real candles — not just the core setup alone.
- New indicator functions in `quant-filters.ts`: `rsiDivergenceSignal`, `macdCrossSignal`, `maStackSignal` (EMA 20/50/200), `bollingerBreakoutSignal`, `srFlipSignal`, `stochasticSignal`, `adxSignal`, `ichimokuSignal`, `keltnerBreakoutSignal`, `rocSignal`, `williamsRSignal`, `cciSignal`, `donchianBreakoutSignal`, `orderBlockPresent`, `failureSwingSignal`, `isJudasSwingTiming` — each a textbook implementation of one strategy-library entry, returning `"buy"`/`"sell"`/`null` (null = insufficient history or genuinely neutral, never forced).
- New `computeConfluence(h1, m30)`: runs 14 of those as independent voters (the ones with no natural place elsewhere — MA stack, Bollinger, S/R flip, Stochastic, ADX, Ichimoku, Keltner, ROC, Williams %R, CCI, Donchian, RSI divergence, MACD, Failure Swing) and returns every vote, including the nulls, so it's auditable what did and didn't have an opinion.
- `runExpertJudge` now: requires agreeing votes >= disagreeing votes among whichever voters have an opinion (silence isn't held against a trade, but active disagreement can now block one that the core setup alone would have taken); replaced the old ad-hoc "+0.1 per bonus" confidence formula with `0.5 + agreementRatio*0.25 + structuralBonuses*0.04`; and names every concept that actually contributed — including two that were already being computed but never attributed (OTE-zone entry, the displacement/"Algo Candle") plus two that are always true by construction when this setup fires (AMD, BOS) — so the self-learning system can finally score them instead of silently never seeing them in a closed trade's concept list.
- Four library entries are deliberately left as listed/self-learning-scored only, not wired as live voters, disclosed rather than faked: **Parabolic SAR** (rank 34, a stateful iterative indicator with real bug risk to hand-verify quickly), **Pivot Point Confluence** (rank 35, classically needs daily/weekly data this system no longer fetches), **SMT Divergence** (rank 17, needs a second correlated symbol's candles — a signature change this pass didn't make), **Inducement** (rank 16, too fuzzy a definition to encode without guessing).
- Caught and fixed one naming bug before it shipped: the confluence voter for the EMA stack was initially mislabeled "Multi-Timeframe Trend Alignment" (rank 30's actual name, already used elsewhere for the separate H1/H4 agreement check) instead of "Moving Average Confluence" (rank 23, what it actually is) — and a second, `Stochastic Oscillator Reversal` vs. the library's actual `Stochastic Oscillator Overbought/Oversold Reversal` — both would have silently broken self-learning attribution for those two concepts (`conceptKey()` normalization doesn't bridge a genuinely different name). Every concept string used anywhere in this change was cross-checked against `strategy-library.ts`'s exact `name` fields via grep, not memory.
- Fixed the Strategy page's description again to reflect this — no longer "only 4 of these entries," now describes the confluence mechanism and names the 4 disclosed gaps precisely instead of asserting a specific count (a fragile thing to keep in sync with the code by hand).
- Verified on realistic-length synthetic data (250 H1 / 150 M30 candles, matching what production actually fetches) before trusting it: a clear synthetic uptrend produces a sensible majority-buy vote across the indicators that have enough history to fire; flat/choppy data mostly abstains rather than firing garbage; nothing crashes or NaN-poisons on either. This mattered because the hand-built 20-candle unit-test data is too short for most of these (MA200 stack, ADX, Ichimoku all need far more history), so it alone couldn't have caught a broken indicator.
- New tests in `test/expert-judge.test.ts`: two `computeConfluence` regression tests using a seeded deterministic pseudo-random generator (reproducible, not flaky) at production-realistic candle counts, checking every voter always appears (14 entries, direction possibly null) and that a clear trend produces majority-agreement. All 17 tests across both test files pass.
- Evidence label: code review + unit-tested for each indicator's formula (standard textbook definitions) and for the confluence engine's aggregate behavior on synthetic data. Not run against live Deriv candles — same caveat as the rest of this build.

## Update: deterministic expert-system judge replaces GPT entirely (no AI budget)
- Per explicit request: with no OpenAI integration available (checked both Replit's Deployment secrets and the dev workspace Secrets, and the account's Integrations catalog — genuinely not connected anywhere) and no budget for a personal OpenAI key, the GPT call in `signal-worker.ts` is fully replaced by a new deterministic, zero-cost judge. `analyzeSymbol()` (the GPT call) is left in the file, intact and unused — swapping back later, if GPT is ever funded, is a one-line change at its call site in `runWorkerTick()`.
- **What this fixes, concretely**: the signal worker had never actually had a working AI integration — `AI_INTEGRATIONS_OPENAI_API_KEY`/`AI_INTEGRATIONS_OPENAI_BASE_URL` were unset everywhere, so `isAIConfigured()` was always false and every 30-minute scan silently skipped the one step that could produce a signal, with no error surfaced anywhere. The `/api/status` "ai" component said "degraded... scans are skipped" but that specific line was easy to miss among otherwise-green components. This was found by directly reading `/api/status` and `/api/config`'s DevTools network responses together with `system-status.ts`'s source.
- **New judge** (`runExpertJudge` in `quant-filters.ts`, moved there — not left in `signal-worker.ts` — because it's a pure function of OHLC arrays with zero I/O, the same contract as everything else in that file): implements the single highest-conviction ICT setup the GPT prompt itself already treated as primary — liquidity sweep opposite the H1/H4 bias, a structure break back in the bias direction, entry at the consequent-encroachment midpoint of the FVG that break leaves, stop beyond the sweep extreme, target at the next real opposing M30 swing (external liquidity) — i.e. the "2022 Entry Model" / AMD cycle (strategy-library.ts ranks 4, 5, 8, 19). This is deliberately narrower than "all 40 library strategies" — the other 36 entries stay listed, scored by the self-learning system, and ready for GPT's broader judgment whenever that's reconnected, but are not independently reimplemented as deterministic rules in this pass.
  - Reuses `quant-filters.ts`'s existing `swingPoints`/`findSweeps`/`findFvgs`/`findDisplacements`/`premiumDiscount`/`atrPercentile`/`efficiencyRatio` — all of which already existed only to verify GPT's claims, and turned out to be exactly the primitives needed to generate a claim instead.
  - Confidence is confluence-based (base 0.6 + up to +0.35 for displacement/OTE-zone/efficiency-ratio/H4-agreement bonuses, capped at 0.95), still gated by the account's configured `minConfidence`.
  - Still runs through every existing downstream gate unchanged: `geometryGate` (RR/stop-distance/premium-discount), `verifyClaims` (now trivially true since the judge detected the structures itself, not a claim about them — kept as a real safety net against a future bug in level construction), `portfolioGate`, the daily-loss and risk-per-trade sizing, and the self-learning `suppressedConcepts` gate (a concept this judge would fire on that's performing badly in real trades is suppressed exactly as it would be for GPT).
- Deleted now-dead code that only existed to build GPT's prompt text (no functional loss, since none of it is read anywhere anymore): `buildPerformanceFeedback()` (a DB query building a win-rate summary), the `annotateCandles()`/`candleContext` HFT-flag annotation block, and the `knowledgeContext` string builder. `analyzeSymbol()` itself (the GPT call and its JSON parsing) is kept, unused, for exactly the reasons above.
- Fixed a stale UI claim on the Strategy page ("Each concept below feeds the signal worker's GPT prompt") to accurately describe the current state: all 40 concepts stay individually scored by real trade performance, but only 4 (Liquidity Sweep, MSS, FVG, 2022 Entry Model) are actually used by the active deterministic judge.
- Fixed `/api/status`'s "ai" component, which was reporting "degraded: scans are skipped" — no longer true, since scans never skip anymore (they just use a different judge). It now reports "idle" (not "degraded") when AI isn't configured, since that's an intentional, correctly-functioning state, not a problem — with a new "signal_judge" component added alongside it that plainly states the deterministic judge is what's actually active. This also means the overall system status will correctly read "ok" instead of permanently "degraded" from here on.
- New `test/expert-judge.test.ts`: 5 unit tests against hand-built, empirically-verified OHLC series — a real bullish sweep/structure-break/FVG setup produces a valid buy signal (stop < entry < target, reward:risk ~2.73, clears the 2:1 floor), and four negative cases (no sweep present, no clear H1 bias, confidence floor not met, a fired concept suppressed by real trade history) all correctly return no signal rather than a fabricated one. Run via `node --experimental-strip-types --test` (no `tsx` in this checkout, same as the existing quant-filters tests). All 15 tests across both files pass.
- Evidence label: code review + unit-tested only for the judge's own detection logic (verified by hand-tracing then empirically confirming the exact synthetic candle data actually produces the claimed sweep/FVG/RR — see the test file's comments). Not run against live Deriv candles — the first real signal this produces on your account is the first live proof this behaves as designed on real price action, same caveat as every other piece of this system that hasn't traded live yet.

## Update: full timeframe-sync audit — fixed stale "H4" label in the ATR pre-filter
- Per explicit request: re-audited the whole pipeline end-to-end (signal-worker.ts's candle fetches/prompt/quant math, strategy-library.ts's 40 entries, contract-monitor.ts, quant-filters.ts, the Configuration/Chart/Analysis dashboard pages) for anything still assuming the old D1/H4-bias/H1-entry scheme after the H4/H1/M30 shift. Confirmed clean everywhere except one spot.
- Found: `preTradeGate` in `quant-filters.ts` still had its parameter named `h4` and its two "insufficient history" reasons hardcoded to say "H4", left over from before the timeframe rename — but `signal-worker.ts` now calls it with `h1Long` (H1 candles). When that gate skips a symbol for thin history, the reason string flows straight into `recordRejection` and is what actually shows up in the Analysis page's rejection log — so it was telling you "Insufficient H4 history" about a check that was really reading H1 data. Fixed: renamed the parameter to `candles`, both reason strings now say H1, and the docstring notes which timeframe the gate is actually called with.
- Also fixed the same stale label on the Configuration page: "Skip if H4 ATR percentile below/above" (the `atrPercentileMin`/`atrPercentileMax` field labels for this same gate) now correctly say H1.
- `chart.tsx`/`analysis.tsx`'s D1/H4 timeframe pickers and `trades.tsx`/`signals.tsx`'s example placeholder text (e.g. "H4 OB, M15 CHoCH") were deliberately left as-is — those are manual chart-browsing and free-text annotation UI, unrelated to what timeframes the automated signal worker itself reads.
- Verified: `pnpm run typecheck` clean, `pnpm run build` clean, and all 10 `quant-filters.test.ts` unit tests pass (via `node --experimental-strip-types --test`, since `tsx` isn't installed in this checkout) including the `preTradeGate` case — the rename didn't change any test's expected behavior, only the label text.

## Update: inline warnings for high risk-per-trade / low daily-loss-cap on small accounts
- Per explicit request: at $5 starting equity, Deriv's $1.00 live-verified multiplier minimum is 20% of the whole account, so the only way to make the new H4/H1/M30 multiplier scheme (vs. the 3-day binary fallback) actually apply is to raise "Risk per trade %" to ~20% on the Configuration page. No code change was needed for that — `riskPerTradePct` was already a free 0-100% field with no artificial ceiling.
- Found a second, non-obvious blocker while verifying this: `calculateDailyLossCappedStake` runs *after* per-trade sizing (`signal-worker.ts`, `dispatchTradeUnlocked`) and can only shrink the stake further, never enlarge it. At the 5% `maxDailyLossPct` default, a $5 account's daily budget is $0.25 — below Deriv's $0.35 absolute floor — so it would silently refuse every trade outright, even after raising risk-per-trade to 20%. Raising risk-per-trade alone does not work; `maxDailyLossPct` has to go up to roughly the same level (~20%) too, since at $5 equity there's realistically only room for one trade's worth of daily risk anyway.
- Added two inline warnings to `configuration.tsx`, computed live off the in-progress (not-yet-saved) form values via `form.watch`, so the consequence is visible before saving rather than only discoverable live: (1) under "Risk per trade %", once it's set to 10%+, a dollar-amount warning against the synced equity, framed as a deliberate small-account exception rather than a setting to leave in place as the balance grows; (2) under "Max daily loss %", whenever it's set below "Risk per trade %", explaining that the daily-loss check runs after per-trade sizing and can silently choke a trade or refuse it outright rather than just capping it.
- Evidence label: code review only for the warning thresholds/copy (no live traffic through this sandbox). The underlying stake-sizing math itself (`calculateCappedStake`, `calculateDailyLossCappedStake`) is pre-existing, unit-tested machinery — not touched this round — traced by hand against the $5/20%/5% scenario to find the daily-loss interaction.

## Update: shortened analysis timeframes and hold period (D1/H4/H1 → H4/H1/M30)
- Per explicit request: shifted the whole analysis stack down one notch — bias timeframes from D1+H4 to H4+H1, entry timing from H1 to M30, expected/target hold from 1-4 days to 4 hours-1 day. This is the "moderate version" discussed: still reading multi-hour institutional order-flow footprints (not down into M1/M5 noise), just on a faster clock.
- Renamed every variable in `signal-worker.ts`'s per-symbol analysis to match the new roles (`h4Candles`/`h1Candles`/`m30Candles` for the GPT-facing candle context; `h1Long`/`m30Long`/`h4Asc` for the deterministic quant math) rather than leaving old names holding new data — that exact kind of stale-name/actual-data mismatch was a real bug fixed earlier this session (the candle-feeder's false-zero volume), so it wasn't worth reintroducing here.
- Rewrote the system prompt's D1/H4/H1 references throughout (the top-down analysis steps, the FVG hierarchy section, the expected-hold line). One section — "HTF LIQUIDITY CYCLE" — described multi-day/multi-week cycles that assumed D1 candles were supplied; since D1 is no longer fetched at all, that section is now explicitly marked as background context only, with the model told not to count D1 candles or claim a day-count from data it no longer has (this app's own EVIDENCE BOUNDARY rule, applied to itself).
- Cooldown-before-resignaling-a-symbol scaled from 2 hours to 1 hour, and a signal's stored expiry from 4 days to 1 day, to stay proportionate to the new shorter hold — both were sized for the old 1-4 day thesis.
- `maxPositionHoldHours` (the automatic force-close safety net for multiplier positions with no other expiry) default lowered from 96 (4 days) to 36 hours (1.5x the new 1-day target), across the schema default, the migration, `routes/config.ts`, and `configuration.tsx`. **Not retroactive** — an already-existing `bot_config` row keeps whatever value it currently has; update it manually on the Configuration page if you want the new default applied to an account that was already configured.
- Left `defaultBinaryDurationDays()` (the small-account binary-contract fallback, used only when a signal's computed stake is below Deriv's $1 multiplier minimum) at its live-verified 3 days, deliberately not shortened to match — we have no live evidence a shorter forex binary duration is accepted by Deriv (a 5-minute guess was rejected earlier this session; 3 days is the one value actually confirmed to work), and guessing a new number here risks reintroducing exactly the live-only-discoverable failures this session spent several rounds fixing.
- Evidence label: code review only for the strategy-quality impact of the timeframe shift itself — this is a real trade-off (discussed at length in conversation: still reading genuine institutional footprints at H4/H1/M30, but with less margin than the D1/H4/H1 version had, and needing to accumulate real trade history faster before you'll know if it actually performs). Build and typecheck are clean; nothing here has been run against Deriv or historical data.

## Update: expanded quant/TA strategy count from 10 to 20
- Per request: 10 more hardcoded technical-analysis strategies added to `lib/strategy-library.ts`, all computed from OHLC price data only (none assume real traded volume, which this system never has): Stochastic Oscillator Reversal, ADX Trend Strength Filter, Ichimoku Cloud Confluence, Parabolic SAR Trend Flip, Pivot Point Confluence, Keltner Channel Breakout, Rate of Change Momentum Filter, Williams %R Extreme Reversal, Donchian Channel Breakout, CCI Extreme Filter.
- Total library is now 20 ICT + 20 quant/TA = 40 strategies. No other code changed — `STRATEGY_LIBRARY`, the eligibility gate, the prompt injection, and the boot-time seed into `strategiesTable` all already operated generically over the array.

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
