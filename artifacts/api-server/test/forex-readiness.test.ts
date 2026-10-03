import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isForexWeekendClosed, activeSessions, parseKillzones, sessionAllowed, isFridayNewTradeCutoff, isFridayFlattenWindow,
  symbolCurrencyPair, newsBlackoutActive, forexPreScanGate, tradingCostGate, isPastLastEntryDay,
} from "../src/lib/forex-readiness.ts";
import type { NewsEvent } from "../src/lib/news-calendar.ts";

test("weekend closure follows Deriv's trading_times: Friday 20:55 UTC to Monday 00:00 UTC", () => {
  assert.equal(isForexWeekendClosed(new Date("2026-10-03T12:00:00Z")), true); // Saturday
  assert.equal(isForexWeekendClosed(new Date("2026-10-02T22:00:00Z")), true); // Friday 22:00 UTC
  assert.equal(isForexWeekendClosed(new Date("2026-10-02T20:55:00Z")), true); // Friday at Deriv's close
  assert.equal(isForexWeekendClosed(new Date("2026-10-02T20:54:00Z")), false); // one minute before it
  assert.equal(isForexWeekendClosed(new Date("2026-10-04T18:00:00Z")), true); // Sunday 18:00 UTC
  // Deriv does not reopen forex on Sunday evening, unlike the interbank week.
  assert.equal(isForexWeekendClosed(new Date("2026-10-04T22:00:00Z")), true); // Sunday 22:00 UTC
  assert.equal(isForexWeekendClosed(new Date("2026-10-05T00:00:00Z")), false); // Monday 00:00 UTC — open
  assert.equal(isForexWeekendClosed(new Date("2026-10-02T10:00:00Z")), false); // Friday midday — open
});

test("no new trades from 16:00 UTC on Friday; open trades are flattened from 20:30 until Deriv's 20:55 close", () => {
  assert.equal(isFridayNewTradeCutoff(new Date("2026-10-02T15:59:00Z")), false);
  assert.equal(isFridayNewTradeCutoff(new Date("2026-10-02T16:00:00Z")), true);
  assert.equal(isFridayNewTradeCutoff(new Date("2026-10-01T18:00:00Z")), false); // Thursday
  assert.equal(isFridayFlattenWindow(new Date("2026-10-02T20:29:00Z")), false);
  assert.equal(isFridayFlattenWindow(new Date("2026-10-02T20:30:00Z")), true);
  assert.equal(isFridayFlattenWindow(new Date("2026-10-02T20:54:00Z")), true);
  assert.equal(isFridayFlattenWindow(new Date("2026-10-02T20:55:00Z")), false); // market shut: Deriv cannot buy back
  assert.equal(isFridayFlattenWindow(new Date("2026-10-01T20:40:00Z")), false); // Thursday
  // The pre-scan/dispatch gate refuses during the cutoff, inside the New York killzone.
  const late = forexPreScanGate({ symbol: "frxEURUSD", now: new Date("2026-10-02T17:00:00Z"), killzones: "london,newyork", newsEvents: [], newsBlackoutBeforeMin: 30, newsBlackoutAfterMin: 30 });
  assert.equal(late.ok, false);
  assert.match(late.reason ?? "", /Friday/);
  const early = forexPreScanGate({ symbol: "frxEURUSD", now: new Date("2026-10-02T13:00:00Z"), killzones: "london,newyork", newsEvents: [], newsBlackoutBeforeMin: 30, newsBlackoutAfterMin: 30 });
  assert.equal(early.ok, true);
});

test("active sessions by UTC hour", () => {
  assert.deepEqual(activeSessions(new Date("2026-10-01T02:00:00Z")), ["asian"]);
  assert.deepEqual(activeSessions(new Date("2026-10-01T13:00:00Z")).sort(), ["london", "newyork"]);
  assert.deepEqual(activeSessions(new Date("2026-10-01T22:00:00Z")), []);
});

test("killzone parsing and session gating", () => {
  assert.deepEqual(parseKillzones("london, newyork"), ["london", "newyork"]);
  assert.deepEqual(parseKillzones(""), []);
  assert.deepEqual(parseKillzones(null), []);
  assert.equal(sessionAllowed(new Date("2026-10-01T13:00:00Z"), "london"), true);
  assert.equal(sessionAllowed(new Date("2026-10-01T02:00:00Z"), "london,newyork"), false);
  assert.equal(sessionAllowed(new Date("2026-10-01T02:00:00Z"), ""), true); // no restriction configured
});

test("currency legs from Deriv forex code", () => {
  assert.deepEqual(symbolCurrencyPair("frxEURUSD"), ["EUR", "USD"]);
  assert.deepEqual(symbolCurrencyPair("frxGBPJPY"), ["GBP", "JPY"]);
  assert.deepEqual(symbolCurrencyPair("R_75"), []);
});

test("news blackout: null events fails closed", () => {
  const r = newsBlackoutActive("frxEURUSD", new Date(), null, 30, 30);
  assert.equal(r.blocked, true);
});

test("news blackout: blocks only within window, for a matching currency leg, High impact only", () => {
  const eventAt = new Date("2026-10-01T14:00:00Z");
  const events: NewsEvent[] = [
    { title: "US CPI", country: "USD", date: eventAt, impact: "High" },
    { title: "EU Minor Release", country: "EUR", date: eventAt, impact: "Low" },
  ];
  // Inside window, matching leg, High impact -> blocked
  assert.equal(newsBlackoutActive("frxEURUSD", new Date("2026-10-01T14:10:00Z"), events, 30, 30).blocked, true);
  // Outside window -> not blocked
  assert.equal(newsBlackoutActive("frxEURUSD", new Date("2026-10-01T13:00:00Z"), events, 30, 30).blocked, false);
  // Non-matching pair (neither leg is USD or has this EUR release relevant) -> not blocked
  assert.equal(newsBlackoutActive("frxGBPJPY", new Date("2026-10-01T14:10:00Z"), events, 30, 30).blocked, false);
  // Low-impact EUR event alone should not block EURUSD
  const lowOnly: NewsEvent[] = [{ title: "EU Minor Release", country: "EUR", date: eventAt, impact: "Low" }];
  assert.equal(newsBlackoutActive("frxEURUSD", new Date("2026-10-01T14:05:00Z"), lowOnly, 30, 30).blocked, false);
});

test("pre-scan gate composes weekend + session + news", () => {
  const weekday = new Date("2026-10-01T13:00:00Z"); // Thursday, London+NY overlap
  const weekend = new Date("2026-10-03T13:00:00Z"); // Saturday
  assert.equal(forexPreScanGate({
    symbol: "frxEURUSD", now: weekday, killzones: "", newsEvents: [], newsBlackoutBeforeMin: 30, newsBlackoutAfterMin: 30,
  }).ok, true);
  assert.equal(forexPreScanGate({
    symbol: "frxEURUSD", now: weekend, killzones: "", newsEvents: [], newsBlackoutBeforeMin: 30, newsBlackoutAfterMin: 30,
  }).ok, false);
  assert.equal(forexPreScanGate({
    symbol: "frxEURUSD", now: weekday, killzones: "", newsEvents: null, newsBlackoutBeforeMin: 30, newsBlackoutAfterMin: 30,
  }).ok, false); // fails closed with no calendar
});

test("dispatch gate additionally requires a readable, acceptable cost", () => {
  const weekday = new Date("2026-10-01T13:00:00Z");
  const base = { symbol: "frxEURUSD", now: weekday, killzones: "", newsEvents: [] as NewsEvent[], newsBlackoutBeforeMin: 30, newsBlackoutAfterMin: 30 };
  // An unreadable quote refuses the trade: placing an order without knowing its
  // cost is trading blind, which is worse than missing the setup.
  assert.equal(tradingCostGate(null, 0.5).ok, false);
  assert.equal(tradingCostGate(0.2, 0.5).ok, true);
  assert.equal(tradingCostGate(0.9, 0.5).ok, false);
  assert.equal(tradingCostGate(0.5, 0.5).ok, true, "exactly at the ceiling is allowed");
  assert.equal(tradingCostGate(0.2, Number.NaN).ok, false, "an invalid ceiling must not wave trades through");
});

// ── Time correctness ─────────────────────────────────────────────────────────

test("calendar timestamps parse the same on every host, whatever TZ is set", async () => {
  const { parseEventDate } = await import("../src/lib/news-calendar.ts");
  // A string that names its zone is honoured exactly.
  assert.equal(parseEventDate("2026-09-30T08:30:00-04:00")!.date.toISOString(), "2026-09-30T12:30:00.000Z");
  assert.equal(parseEventDate("2026-09-30T12:30:00Z")!.date.toISOString(), "2026-09-30T12:30:00.000Z");
  assert.equal(parseEventDate("2026-09-30T08:30:00-04:00")!.assumedUtc, false);

  // One that does not is read as UTC explicitly, not as host-local time. This
  // is the case that silently shifted every blackout window on a non-UTC host.
  const bare = parseEventDate("2026-09-30T08:30:00")!;
  assert.equal(bare.date.toISOString(), "2026-09-30T08:30:00.000Z");
  assert.equal(bare.assumedUtc, true);

  // A space separator is not ISO and parses inconsistently across engines.
  assert.equal(parseEventDate("2026-09-30 08:30:00")!.date.toISOString(), "2026-09-30T08:30:00.000Z");

  assert.equal(parseEventDate("not a date"), null);
  assert.equal(parseEventDate(""), null);
});

test("the forex week opens and closes on Deriv's UTC boundaries (trading_times)", () => {
  const at = (iso: string) => new Date(iso);
  // Friday: Deriv "Closes early (at 20:55)".
  assert.equal(isForexWeekendClosed(at("2026-09-25T20:54:00Z")), false, "Friday before 20:55 is open");
  assert.equal(isForexWeekendClosed(at("2026-09-25T20:55:00Z")), true, "Friday from 20:55 is closed");
  // All Saturday and all Sunday.
  assert.equal(isForexWeekendClosed(at("2026-09-26T12:00:00Z")), true);
  assert.equal(isForexWeekendClosed(at("2026-09-27T21:00:00Z")), true, "Deriv does not open forex on Sunday evening");
  assert.equal(isForexWeekendClosed(at("2026-09-27T23:59:00Z")), true);
  // Monday 00:00 UTC open.
  assert.equal(isForexWeekendClosed(at("2026-09-28T00:00:00Z")), false, "Monday from 00:00 is open");
  // Midweek.
  assert.equal(isForexWeekendClosed(at("2026-09-30T07:00:00Z")), false);
});

test("blank killzones means every open hour, not a hidden default", () => {
  // The Configuration field is free text; clearing it must not fall back to
  // some built-in session list.
  for (const hour of [0, 3, 7, 11, 15, 19, 23]) {
    const t = new Date(Date.UTC(2026, 8, 30, hour, 0, 0)); // a Wednesday
    assert.equal(sessionAllowed(t, ""), true, `blank should allow ${hour}:00 UTC`);
    assert.equal(sessionAllowed(t, null), true);
    assert.equal(sessionAllowed(t, "   "), true);
  }
});

test("each named session covers the UTC window it claims", () => {
  const wed = (h: number) => new Date(Date.UTC(2026, 8, 30, h, 0, 0));
  // london 07:00-16:00
  assert.equal(sessionAllowed(wed(6), "london"), false);
  assert.equal(sessionAllowed(wed(7), "london"), true);
  assert.equal(sessionAllowed(wed(15), "london"), true);
  assert.equal(sessionAllowed(wed(16), "london"), false);
  // newyork 12:00-21:00
  assert.equal(sessionAllowed(wed(11), "newyork"), false);
  assert.equal(sessionAllowed(wed(12), "newyork"), true);
  assert.equal(sessionAllowed(wed(20), "newyork"), true);
  assert.equal(sessionAllowed(wed(21), "newyork"), false);
  // london,newyork together cover 07:00-21:00 with no gap at the handover.
  for (let h = 7; h < 21; h++) {
    assert.equal(sessionAllowed(wed(h), "london,newyork"), true, `${h}:00 UTC should be inside london,newyork`);
  }
  assert.equal(sessionAllowed(wed(6), "london,newyork"), false);
  assert.equal(sessionAllowed(wed(21), "london,newyork"), false);
  // An unrecognised name is ignored rather than silently blocking everything.
  assert.equal(sessionAllowed(wed(3), "tokyo"), true, "no valid session parsed = no restriction");
});

test("weekly cycle: new trades open Monday up to the last entry weekday (UTC), every weekday when unset", () => {
  // 2026-10-05 is a Monday
  const at = (iso: string) => new Date(iso);
  assert.equal(isPastLastEntryDay(at("2026-10-05T07:00:00Z"), 2), false); // Monday
  assert.equal(isPastLastEntryDay(at("2026-10-06T20:59:00Z"), 2), false); // Tuesday
  assert.equal(isPastLastEntryDay(at("2026-10-07T00:00:00Z"), 2), true);  // Wednesday
  assert.equal(isPastLastEntryDay(at("2026-10-09T10:00:00Z"), 2), true);  // Friday
  assert.equal(isPastLastEntryDay(at("2026-10-06T10:00:00Z"), 1), true);  // Monday only: Tuesday refused
  assert.equal(isPastLastEntryDay(at("2026-10-08T10:00:00Z"), 5), false); // every weekday
  assert.equal(isPastLastEntryDay(at("2026-10-08T10:00:00Z"), undefined), false);
  assert.equal(isPastLastEntryDay(at("2026-10-08T10:00:00Z"), Number.NaN), false); // unreadable = no restriction
  const gate = (iso: string, last?: number) => forexPreScanGate({ symbol: "frxEURUSD", now: at(iso), killzones: "london,newyork", newsEvents: [], newsBlackoutBeforeMin: 30, newsBlackoutAfterMin: 30, lastEntryWeekday: last });
  assert.equal(gate("2026-10-06T13:00:00Z", 2).ok, true);
  const wed = gate("2026-10-07T13:00:00Z", 2);
  assert.equal(wed.ok, false);
  assert.match(wed.reason ?? "", /Monday to Tuesday only/);
  assert.equal(gate("2026-10-07T13:00:00Z").ok, true);
});
