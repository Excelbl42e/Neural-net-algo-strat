# Changes in this build (vs. your Replit export)

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
