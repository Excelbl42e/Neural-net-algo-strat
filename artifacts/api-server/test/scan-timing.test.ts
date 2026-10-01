import { test } from "node:test";
import assert from "node:assert/strict";
import { isClosedCandle, nextAlignedScanAt } from "../src/lib/scan-rules.ts";

const HALF_HOUR = 30 * 60_000;
const OFFSET = 20_000;
const at = (iso: string) => Date.parse(iso);

test("scans land just after each M30 close, not wherever the process happened to start", () => {
  // Production ran at 17:28:54 and 17:58:55 — a minute before each close.
  assert.equal(nextAlignedScanAt(at("2026-09-30T17:28:54Z"), HALF_HOUR, OFFSET), at("2026-09-30T17:30:20Z"));
  assert.equal(nextAlignedScanAt(at("2026-09-30T17:30:00Z"), HALF_HOUR, OFFSET), at("2026-09-30T17:30:20Z"));
  assert.equal(nextAlignedScanAt(at("2026-09-30T17:30:20Z"), HALF_HOUR, OFFSET), at("2026-09-30T18:00:20Z"));
  assert.equal(nextAlignedScanAt(at("2026-09-30T17:45:00Z"), HALF_HOUR, OFFSET), at("2026-09-30T18:00:20Z"));
  assert.equal(nextAlignedScanAt(at("2026-09-30T23:59:59Z"), HALF_HOUR, OFFSET), at("2026-10-01T00:00:20Z"));
});

test("a scan never reads the candle still forming", () => {
  const now = at("2026-09-30T17:30:20Z");
  assert.equal(isClosedCandle(at("2026-09-30T17:00:00Z"), "M30", now), true, "17:00 M30 closed at 17:30");
  assert.equal(isClosedCandle(at("2026-09-30T17:30:00Z"), "M30", now), false, "17:30 M30 is forming");
  assert.equal(isClosedCandle(at("2026-09-30T17:00:00Z"), "H1", now), false, "17:00 H1 closes at 18:00");
  assert.equal(isClosedCandle(at("2026-09-30T16:00:00Z"), "H1", now), true);
  assert.equal(isClosedCandle(at("2026-09-30T16:00:00Z"), "H4", now), false, "16:00 H4 closes at 20:00");
});
