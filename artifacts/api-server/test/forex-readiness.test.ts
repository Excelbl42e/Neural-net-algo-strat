import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isForexWeekendClosed, activeSessions, parseKillzones, sessionAllowed,
  symbolCurrencyPair, newsBlackoutActive, forexPreScanGate, forexDispatchGate,
} from "../src/lib/forex-readiness.ts";
import type { NewsEvent } from "../src/lib/news-calendar.ts";

test("weekend closure: Saturday closed, Friday evening closed, Sunday before reopen closed", () => {
  assert.equal(isForexWeekendClosed(new Date("2026-10-03T12:00:00Z")), true); // Saturday
  assert.equal(isForexWeekendClosed(new Date("2026-10-02T22:00:00Z")), true); // Friday 22:00 UTC
  assert.equal(isForexWeekendClosed(new Date("2026-10-04T18:00:00Z")), true); // Sunday 18:00 UTC
  assert.equal(isForexWeekendClosed(new Date("2026-10-04T22:00:00Z")), false); // Sunday 22:00 UTC — open
  assert.equal(isForexWeekendClosed(new Date("2026-10-02T10:00:00Z")), false); // Friday midday — open
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
  assert.equal(forexDispatchGate({ ...base, costPct: null, maxCostPct: 0.5 }).ok, false);
  assert.equal(forexDispatchGate({ ...base, costPct: 0.2, maxCostPct: 0.5 }).ok, true);
  assert.equal(forexDispatchGate({ ...base, costPct: 0.9, maxCostPct: 0.5 }).ok, false);
});
