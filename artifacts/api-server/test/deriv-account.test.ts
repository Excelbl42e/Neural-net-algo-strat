import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenProblem } from "../src/lib/deriv-account.ts";

test("a rejected Deriv token is explained, not reported as a bare HTTP status", () => {
  // The expired demo token on 2026-10-01 surfaced only as "HTTP 401".
  assert.match(tokenProblem(401)!, /expired or was deleted/);
  assert.match(tokenProblem(401)!, /\(HTTP 401\)/); // balance sync keys off this to flag it at once
  assert.match(tokenProblem(403)!, /Trade scope/);
  assert.equal(tokenProblem(500), null);
  assert.equal(tokenProblem(429), null);
});
