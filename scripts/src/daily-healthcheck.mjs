/**
 * Daily health check — run this at the start of every session.
 * Checks: API server, signal worker status, candle feeder, critical endpoints,
 * invalid symbol errors, broker connections, and pending signals.
 */

import { randomBytes } from "node:crypto";

const BASE = (process.env.HEALTHCHECK_API_BASE ?? "http://localhost:80/api").replace(/\/$/, "");
let passed = 0;
let failed = 0;

function ok(label) {
  console.log(`  ✓  ${label}`);
  passed++;
}

function fail(label, detail = "") {
  console.error(`  ✗  ${label}${detail ? ` — ${detail}` : ""}`);
  failed++;
}

let authHeaders_ = {};
async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders_ });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

console.log("\n══════════════════════════════════════════");
console.log("  NeuralTrade · Daily Health Check");
console.log(`  ${new Date().toLocaleString()}`);
console.log("══════════════════════════════════════════\n");

// ── 1. API Server reachable ───────────────────────────────────────────────
console.log("[ 1 ] API Server");
try {
  await get("/healthz");
  ok("API server responding");
} catch (e) {
  fail("API server unreachable", e.message);
}

// Auth: unauthenticated read must be 401, login must work, an authenticated write must work.
// Set HEALTHCHECK_PASSWORD (owner password) or BOT_API_KEY (machine key) to run the authenticated checks.
console.log("\n[ 1a ] Authentication");
let authHeaders = {};
try {
  const unauth = await fetch(`${BASE}/accounts`, { cache: "no-store" });
  unauth.status === 401 ? ok("Unauthenticated read is rejected (401)") : fail("Unauthenticated read NOT rejected", `HTTP ${unauth.status}`);
  const machineKey = process.env.BOT_API_KEY?.trim();
  const password = process.env.HEALTHCHECK_PASSWORD;
  if (password) {
    const login = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    if (login.ok && cookie) { ok("Login works"); authHeaders = { cookie }; authHeaders_ = authHeaders; } else fail("Login failed", `HTTP ${login.status}`);
  } else if (machineKey) {
    authHeaders = { "x-api-key": machineKey }; authHeaders_ = authHeaders;
    ok("Using BOT_API_KEY machine key");
  } else {
    console.log("  -  Skipping authenticated checks (set HEALTHCHECK_PASSWORD or BOT_API_KEY)");
  }
  if (Object.keys(authHeaders).length) {
    const read = await fetch(`${BASE}/accounts`, { headers: authHeaders });
    read.ok ? ok("Authenticated read works") : fail("Authenticated read failed", `HTTP ${read.status}`);
    const write = await fetch(`${BASE}/auth/check`, { method: "POST", headers: authHeaders });
    write.ok ? ok("Authenticated write works") : fail("Authenticated write failed", `HTTP ${write.status}`);
  }
} catch (e) {
  fail("Auth check errored", e.message);
}

console.log("\n[ 2 ] Signal Worker");
try {
  const s = await get("/brain/worker-status");
  if (s.enabled === false) {
    fail("Bot is disabled (safe default); do not enable until feed, broker and risk checks pass");
  } else {
    ok(`Bot enabled, autotrade mode: ${s.autotradeMode ?? "unknown"}`);
  }
  if (s.lastError) {
    fail(`Last worker error: ${s.lastError}`);
  } else {
    ok("No worker errors");
  }
  if (s.lastRunAt) {
    const ageMin = Math.round((Date.now() - new Date(s.lastRunAt).getTime()) / 60000);
    if (ageMin > 15) {
      fail(`Last tick was ${ageMin} min ago — worker may be stalled`);
    } else {
      ok(`Last tick ${ageMin} min ago`);
    }
  } else {
    ok("Worker not yet run this session (normal on fresh start)");
  }

  const bs = s.balanceSync;
  if (bs) {
    if (!bs.running) {
      fail("Balance sync poller NOT running — restart the API server");
    } else {
      ok("Balance sync poller running (60s interval)");
    }
    if (bs.lastCycleAt) {
      const ageSec = Math.round((Date.now() - new Date(bs.lastCycleAt).getTime()) / 1000);
      if (ageSec > 180) {
        fail(`Balance sync last cycle ${ageSec}s ago — may be stalled`);
      } else {
        ok(`Balance sync last cycle ${ageSec}s ago`);
      }
    } else {
      ok("Balance sync cycle pending (will fire once a broker is connected)");
    }
    for (const c of bs.connections ?? []) {
      if (c.consecutiveFailures >= 3) {
        fail(`${c.label}: ${c.consecutiveFailures} consecutive sync failures — ${c.lastError}`);
      } else if (c.lastSyncAt) {
        const ageSec = Math.round((Date.now() - new Date(c.lastSyncAt).getTime()) / 1000);
        ok(`${c.label}: balance synced ${ageSec}s ago`);
      } else if (c.lastError) {
        fail(`${c.label}: sync error — ${c.lastError}`);
      }
    }
  }
} catch (e) {
  fail("Worker status endpoint failed", e.message);
}

// ── 3. Candle feeder / live ticks ────────────────────────────────────────
console.log("\n[ 3 ] Candle Feeder");
try {
  const status = await get("/candles/feeder-status");
  const symbols = status.symbols ?? [];
  ok(`Feeder tracking ${symbols.length} symbol(s)`);

  const KEY_SYMBOLS = ["R_75", "R_100", "BOOM1000", "CRASH1000"];
  for (const sym of KEY_SYMBOLS) {
    try {
      const data = await get(`/candles?symbol=${sym}&timeframe=M5&limit=3`);
      if (!data.candles?.length) {
        fail(`${sym}: no candles returned`);
      } else if (!data.lastTick) {
        fail(`${sym}: candles OK but no live tick yet`);
      } else {
        const ageS = Math.round((Date.now() - data.lastTick.at) / 1000);
        if (ageS > 120) {
          fail(`${sym}: last tick is ${ageS}s old — feed may be stale`);
        } else {
          ok(`${sym}: live @ ${data.lastTick.price} (${ageS}s ago)`);
        }
      }
    } catch (e) {
      fail(`${sym}: ${e.message}`);
    }
  }
} catch (e) {
  fail("Feeder status endpoint failed", e.message);
}

// ── 4. Accounts ──────────────────────────────────────────────────────────
console.log("\n[ 4 ] Accounts");
try {
  const accounts = await get("/accounts");
  if (!accounts.length) {
    fail("No verified account in DB — link a demo broker or add an account in Accounts; sample accounts are not seeded");
  } else {
    const active = accounts.filter((a) => a.status === "active");
    const live   = active.filter((a) => a.accountType === "live" || a.accountType === "prop");
    const demo   = active.filter((a) => a.accountType === "demo");
    ok(`${accounts.length} account(s), ${active.length} active`);
    if (live.length) {
      fail(`LIVE/PROP accounts active: ${live.map((a) => a.name).join(", ")} — confirm this is intentional`);
    }
    if (demo.length) {
      ok(`Demo mode: ${demo.map((a) => a.name).join(", ")}`);
    }
    if (!active.length) {
      fail("No active accounts — set at least one account to active");
    }
  }
} catch (e) {
  fail("Accounts endpoint failed", e.message);
}

// ── 5. Broker connections ────────────────────────────────────────────────
console.log("\n[ 5 ] Broker Connections");
try {
  const brokers = await get("/brokers/connections");
  const connected = (brokers ?? []).filter((b) => b.status === "connected" && b.enabled);
  if (!connected.length) {
    fail("No connected broker — bot cannot place trades until a Deriv token is linked on the Brokers page");
  } else {
    for (const b of connected) {
      ok(`${b.label} (${b.environment}) connected`);
      if (!b.credential || b.credential.trim() === "") {
        fail(`${b.label}: credential token is EMPTY — trades will fail`);
      }
    }
  }
} catch (e) {
  fail("Brokers endpoint failed", e.message);
}

// ── 6. Active signals ────────────────────────────────────────────────────
console.log("\n[ 6 ] Signals");
try {
  const signals = await get("/signals?status=active&limit=50");
  const list = Array.isArray(signals) ? signals : signals.signals ?? [];
  ok(`${list.length} active signal(s)`);
  const undispatched = list.filter((s) => !s.dispatchedAt);
  if (undispatched.length) {
    ok(`${undispatched.length} pending dispatch (will fire on next worker tick)`);
  }
} catch (e) {
  fail("Signals endpoint failed", e.message);
}

// ── 7. Dashboard overview ────────────────────────────────────────────────
console.log("\n[ 7 ] Dashboard");
try {
  const ov = await get("/dashboard/overview");
  ok(`Bot status: ${ov.botStatus ?? "unknown"}`);
  ok(`Open trades: ${ov.openTrades ?? 0}  |  Win rate: ${ov.lastTradeAt && ov.winRate != null ? (ov.winRate * 100).toFixed(1) + "%" : "no trades recorded"}`);
} catch (e) {
  fail("Dashboard overview failed", e.message);
}

// ── Summary ───────────────────────────────────────────────────────────────
console.log("\n══════════════════════════════════════════");
const total = passed + failed;
if (failed === 0) {
  console.log(`  ALL ${total} CHECKS PASSED ✓`);
} else {
  console.log(`  ${passed}/${total} passed — ${failed} issue(s) need attention`);
}
console.log("══════════════════════════════════════════\n");

if (failed > 0) process.exit(1);
