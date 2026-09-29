import { desc, eq, sql } from "drizzle-orm";
import { botConfigTable, brokerConnectionsTable, candlesTable, db } from "@workspace/db";
import { getCandleFeederStatus } from "./candle-feeder.js";
import { getWorkerStatus } from "./signal-worker.js";
import { getReconcilerStatus, getExecutionLock } from "./reconciler.js";
import { getContractMonitorStatus } from "./contract-monitor.js";
import { getBalanceSyncStatus } from "./balance-sync.js";
import { getSecret } from "./secrets.js";
import { isAIConfigured } from "./ai-client.js";
import { getNewsCalendarStatus } from "./news-calendar.js";

export type Health = "ok" | "degraded" | "down" | "idle";
export interface Component { name: string; status: Health; reason: string }

export async function getSystemStatus() {
  const components: Component[] = [];
  const push = (name: string, status: Health, reason: string) => components.push({ name, status, reason });

  try { await db.execute(sql`select 1`); push("database", "ok", "query succeeded"); }
  catch (e) { push("database", "down", e instanceof Error ? e.message : "query failed"); }

  const feeder = getCandleFeederStatus() as { connected?: boolean; feedState?: string; lastError?: string | null };
  push("candle_feed", feeder.connected ? "ok" : "down",
    feeder.connected ? "Deriv public WebSocket connected" : `state=${feeder.feedState ?? "unknown"}${feeder.lastError ? `; last error: ${feeder.lastError}` : ""}`);

  let conns: Array<typeof brokerConnectionsTable.$inferSelect> = [];
  try { conns = await db.select().from(brokerConnectionsTable); } catch { /* db down already reported */ }
  const connected = conns.filter((c) => c.enabled && c.status === "connected");
  push("broker", connected.length ? "ok" : conns.length ? "degraded" : "idle",
    connected.length ? `${connected.length} connected (${connected.map((c) => c.environment).join(", ")})`
      : conns.length ? `no connected broker; last errors: ${conns.map((c) => c.lastError).filter(Boolean).join(" | ") || "none"}` : "no broker connection added yet");

  // The signal worker's active judge is hardcoded to runExpertJudge() (deterministic,
  // no LLM) regardless of this — see the "signal_judge" component below for what's
  // actually driving signals. This just reports whether GPT credentials exist to swap
  // back to later; their absence is not a problem today, so it's never "degraded".
  push("ai", isAIConfigured() ? "ok" : "idle", isAIConfigured() ? "AI client configured (unused — see signal_judge)" : "Not configured — has no effect while the deterministic judge is active (see signal_judge)");
  push("signal_judge", "ok", "Deterministic expert-system judge active (no LLM, no API cost): liquidity sweep -> structure break -> FVG. To use GPT instead, see runExpertJudge()'s call site in signal-worker.ts.");

  const news = getNewsCalendarStatus();
  push("news_calendar", news.trusted ? "ok" : "degraded",
    news.trusted ? `${news.cachedEvents} events cached, fetched ${news.fetchedAt}` : `Calendar unreachable or stale (${news.lastError ?? "never fetched yet"}); forex trading fails closed until it recovers`);

  const w = getWorkerStatus();
  let cfg: typeof botConfigTable.$inferSelect | undefined;
  try { [cfg] = await db.select().from(botConfigTable).where(eq(botConfigTable.id, 1)); } catch { /* */ }
  const staleMs = w.lastRunAt ? Date.now() - Date.parse(w.lastRunAt) : Infinity;
  push("signal_worker", !w.running && !w.lastRunAt ? "idle" : w.lastError ? "degraded" : staleMs > 2 * w.intervalMs + 60_000 ? "degraded" : "ok",
    w.lastError ? `last error: ${w.lastError}` : w.lastRunAt ? `last tick ${w.lastRunAt}` : "no tick yet");

  const r = getReconcilerStatus();
  const lock = await getExecutionLock().catch(() => ({ locked: false, reason: null, signalId: null }));
  push("reconciler", r.running ? (r.lastError ? "degraded" : "ok") : "down",
    r.lastError ? `last error: ${r.lastError}` : lock.locked ? (lock.reason ?? "resolving") : `last run ${r.lastRunAt ?? "not yet"}`);

  const m = getContractMonitorStatus();
  push("contract_monitor", m.running ? (m.lastError ? "degraded" : "ok") : "down", m.lastError ?? `last cycle ${m.lastCycleAt ?? "not yet"}`);

  const bs = getBalanceSyncStatus();
  push("balance_sync", bs.running ? "ok" : "down", bs.running ? `last cycle ${bs.lastCycleAt ?? "not yet"}` : "poller not running");

  let selftest: { passed?: boolean; at?: string } = {};
  try { selftest = JSON.parse((await getSecret("selftest:last")) ?? "{}"); } catch { /* */ }
  let candleCount = 0;
  try { const [c] = await db.select({ n: sql<number>`count(*)::int` }).from(candlesTable); candleCount = c?.n ?? 0; } catch { /* */ }

  const mode = cfg?.autotradeMode ?? "off";
  const reason =
    !cfg?.enabled ? "Bot switch is OFF"
    : mode === "off" ? "Mode is off: signals only, no orders"
    : mode === "auto_demo" ? "Auto trading on a Deriv DEMO account"
    : selftest.passed ? "Auto trading on a REAL account" : "auto_live blocked: no passed demo self-test";

  const worst: Health = components.some((c) => c.status === "down") ? "down" : components.some((c) => c.status === "degraded") ? "degraded" : "ok";
  return {
    status: worst,
    components,
    bot: { enabled: cfg?.enabled ?? false, mode, reason },
    selfTest: { passed: selftest.passed === true, at: selftest.at ?? null },
    executionLock: lock,
    candleCount,
    hosting: {
      deploymentTarget: process.env.REPLIT_DEPLOYMENT ? "deployment" : "workspace",
      alwaysOn: process.env.NT_ALWAYS_ON === "1" || process.env.REPLIT_DEPLOYMENT_TYPE === "vm" || process.env.REPLIT_DEPLOYMENT_TYPE === "reserved-vm",
    },
    now: new Date().toISOString(),
  };
}
