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
import { getCotSeries, getCotStatus } from "./cot-positioning.js";

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

  // Signals come from the deterministic strategy poll (see "signal_judge"); no
  // language model is in the trading path. This only reports whether AI
  // credentials exist; their absence is not a problem, so it is never "degraded".
  push("ai", isAIConfigured() ? "ok" : "idle", isAIConfigured() ? "AI client configured (unused — see signal_judge)" : "Not configured — not used by the strategy poll (see signal_judge)");
  // Kept short: this string is rendered in the dashboard's System health panel,
  // so it reads as operator status rather than a code pointer.
  push("signal_judge", "ok", "Strategy poll active: 60 deterministic strategies vote — no LLM, no API cost");

  const news = getNewsCalendarStatus();
  // Reported as "down", not "degraded": while this feed is untrusted every
  // forex order is refused, so the system is not running in a reduced state,
  // it is not trading at all. The top-level badge should be red for that.
  push("news_calendar", news.trusted ? "ok" : "down",
    news.trusted
      ? `${news.cachedEvents} events cached, fetched ${news.fetchedAt}`
      : `NO TRADES CAN BE PLACED. The high-impact news calendar is ${news.lastError ? `unreachable (${news.lastError})` : "not yet fetched"}, and forex trading fails closed until it recovers. Set NEWS_CALENDAR_URL to a reachable mirror if this host stays blocked.`);

  const w = getWorkerStatus();
  let cfg: typeof botConfigTable.$inferSelect | undefined;
  try { [cfg] = await db.select().from(botConfigTable).where(eq(botConfigTable.id, 1)); } catch { /* */ }
  const staleMs = w.lastRunAt ? Date.now() - Date.parse(w.lastRunAt) : Infinity;
  push("signal_worker", !w.running && !w.lastRunAt ? "idle" : w.lastError ? "degraded" : staleMs > 2 * w.intervalMs + 60_000 ? "degraded" : "ok",
    w.lastError ? `last error: ${w.lastError}` : w.lastRunAt ? `last tick ${w.lastRunAt}` : "no tick yet");

  // COT veto: informational only. Without the report the veto stands down and
  // every vote trades, so this is never "down".
  // Warm the cache in the background (never awaited) so the first order of
  // the week does not wait on the download and this row shows the real state.
  if (cfg?.cotVeto) void getCotSeries();
  const cot = getCotStatus();
  push("cot_report", !cfg?.cotVeto ? "idle" : cot.usable ? "ok" : "degraded",
    !cfg?.cotVeto ? "COT veto is off (Configuration page)"
      : cot.usable ? `CFTC report of ${cot.latestReport} in use${cot.lastError ? `; last refresh failed (${cot.lastError}), using the cached report` : ""}`
      : cot.lastError ? `CFTC report unreachable (${cot.lastError}); the veto stands down and every vote trades`
      : cot.latestReport ? `No CFTC report for this week yet (latest ${cot.latestReport}); the veto stands down and every vote trades`
      : "Fetching the CFTC report…");

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
