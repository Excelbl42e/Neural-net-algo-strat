/**
 * Automatic order reconciliation. Replaces the old in-memory "manual reconciliation
 * required" flag (never cleared) with a lock derived from the database each tick and
 * a job that resolves awaiting_broker / ambiguous signals against Deriv itself.
 *
 * Rules:
 *  - Never re-submit a buy for an ambiguous signal (double-buy risk).
 *  - A match by symbol + stake + purchase-time window links the trade and marks the
 *    signal executed.
 *  - No match is only declared after the grace window AND two clean polls.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { brokerConnectionsTable, db, signalsTable, tradesTable } from "@workspace/db";
import { decryptSecret } from "./crypto.js";
import { fetchRecentContracts, type DerivContractInfo } from "./deriv.js";
import { logger } from "./logger.js";

const RECONCILE_INTERVAL_MS = 60_000;
export const GRACE_MS = 3 * 60_000;
const CLEAN_POLLS_REQUIRED = 2;
const MATCH_BEFORE_SEC = 60;
const MATCH_AFTER_SEC = 15 * 60;

const cleanPolls = new Map<number, number>();
let timer: NodeJS.Timeout | null = null;
let running = false;
let lastRunAt: Date | null = null;
let lastError: string | null = null;
let lastResolved = 0;

/**
 * What the reconciler matches a Deriv contract by. Every reason written while
 * the order's outcome is unknown must keep it: without it a placed contract
 * cannot be matched and the signal is declared "not placed".
 */
export function claimTag(stake: number, connId: number, t: number = Date.now()): string {
  return `[stake=${stake.toFixed(2)} conn=${connId} t=${t}]`;
}

export function claimReason(stake: number, connId: number, t: number = Date.now()): string {
  return `Deriv order submission started; awaiting broker confirmation ${claimTag(stake, connId, t)}`;
}

export function parseClaim(reason: string | null): { stake: number | null; connId: number | null; t: number | null } {
  const m = reason?.match(/stake=([0-9.]+) conn=(\d+) t=(\d+)/);
  return m ? { stake: Number(m[1]), connId: Number(m[2]), t: Number(m[3]) } : { stake: null, connId: null, t: null };
}

export async function getExecutionLock(): Promise<{ locked: boolean; reason: string | null; signalId: number | null }> {
  const [unresolved] = await db.select({ id: signalsTable.id, s: signalsTable.executionStatus })
    .from(signalsTable)
    .where(inArray(signalsTable.executionStatus, ["awaiting_broker", "ambiguous"]))
    .limit(1);
  if (unresolved) {
    return { locked: true, signalId: unresolved.id, reason: `Signal ${unresolved.id} is ${unresolved.s}; the reconciler is resolving it against Deriv` };
  }
  const [orphan] = await db.select({ id: signalsTable.id })
    .from(signalsTable)
    .leftJoin(tradesTable, eq(tradesTable.signalId, signalsTable.id))
    .where(and(eq(signalsTable.executionStatus, "executed"), isNull(tradesTable.id)))
    .limit(1);
  if (orphan) return { locked: true, signalId: orphan.id, reason: `Executed signal ${orphan.id} has no linked trade yet; the reconciler is linking it` };
  return { locked: false, reason: null, signalId: null };
}

export function getReconcilerStatus() {
  return { running: timer !== null, lastRunAt: lastRunAt?.toISOString() ?? null, lastError, lastResolved };
}

type Conn = typeof brokerConnectionsTable.$inferSelect;
type SignalRow = typeof signalsTable.$inferSelect;

async function createTradeFor(signal: SignalRow, contractId: number, info: DerivContractInfo | null, stake: number | null, accountId: number): Promise<void> {
  const [existing] = await db.select({ id: tradesTable.id }).from(tradesTable).where(eq(tradesTable.signalId, signal.id)).limit(1);
  if (existing) return;
  const buy = info?.buyPrice ?? stake ?? 0;
  // Deriv's contract list carries no entry spot, and the buy price is the
  // stake, not a price. The signal's entry zone is the nearest real price.
  const zone = (Number(signal.entryLow) + Number(signal.entryHigh)) / 2;
  const openPrice = signal.entryLow != null && signal.entryHigh != null && Number.isFinite(zone) && zone > 0 ? zone : null;
  await db.insert(tradesTable).values({
    signalId: signal.id, accountId, symbol: signal.symbol, direction: signal.direction,
    openPrice: String(openPrice ?? buy), lotSize: String(stake ?? buy),
    stopLoss: signal.stopLevel, takeProfit: signal.target1Level,
    status: "open", strategy: signal.strategy,
    // The hold limit and the free-balance arithmetic both count from the
    // purchase, not from when the reconciler found it.
    ...(info?.purchaseTime != null ? { openedAt: new Date(info.purchaseTime * 1000) } : {}),
    reasonChain: signal.reasoning ?? "Recovered by reconciler",
    annotations: JSON.stringify({
      contractId, recoveredByReconciler: true, confidence: signal.confidence,
      openPriceSource: openPrice != null ? "signal_entry_zone" : "contract_buy_price",
      // Unknown when Deriv doesn't echo contract_type back (or wasn't fetched):
      // the max-hold-time safety net then can't tell this is a multiplier
      // position and won't force-close it. Manual close is still available.
      ...(info?.contractType ? { contractType: info.contractType } : {}),
    }),
  }).onConflictDoNothing();
}

function matches(signal: SignalRow, claim: ReturnType<typeof parseClaim>, c: DerivContractInfo, used: Set<number>): boolean {
  if (used.has(c.contractId) || !c.symbol || c.purchaseTime == null || claim.t == null) return false;
  if (c.symbol.toUpperCase() !== signal.symbol.toUpperCase()) return false;
  if (claim.stake != null && c.buyPrice != null && Math.abs(c.buyPrice - claim.stake) > 0.011) return false;
  const claimSec = Math.floor(claim.t / 1000);
  return c.purchaseTime >= claimSec - MATCH_BEFORE_SEC && c.purchaseTime <= claimSec + MATCH_AFTER_SEC;
}

export async function reconcileOnce(): Promise<{ resolved: number; pending: number }> {
  const unresolved = await db.select().from(signalsTable)
    .where(inArray(signalsTable.executionStatus, ["awaiting_broker", "ambiguous"]));
  const orphans = await db.select({ s: signalsTable }).from(signalsTable)
    .leftJoin(tradesTable, eq(tradesTable.signalId, signalsTable.id))
    .where(and(eq(signalsTable.executionStatus, "executed"), isNull(tradesTable.id)));
  if (unresolved.length === 0 && orphans.length === 0) return { resolved: 0, pending: 0 };

  const conns = await db.select().from(brokerConnectionsTable)
    .where(and(eq(brokerConnectionsTable.enabled, true), eq(brokerConnectionsTable.status, "connected")));
  const cache = new Map<number, DerivContractInfo[] | null>();
  const load = async (conn: Conn): Promise<DerivContractInfo[] | null> => {
    if (cache.has(conn.id)) return cache.get(conn.id)!;
    try {
      const list = await fetchRecentContracts(await decryptSecret(conn.credential), conn.environment === "real" ? "real" : "demo");
      cache.set(conn.id, list);
    } catch (err) {
      lastError = err instanceof Error ? err.message : "reconcile poll failed";
      cache.set(conn.id, null);
    }
    return cache.get(conn.id)!;
  };

  const linked = await db.select({ annotations: tradesTable.annotations }).from(tradesTable);
  const used = new Set<number>();
  for (const t of linked) {
    try { const id = JSON.parse(t.annotations ?? "{}").contractId; if (typeof id === "number") used.add(id); } catch { /* */ }
  }

  let resolved = 0;
  let pending = 0;
  for (const signal of unresolved) {
    const claim = parseClaim(signal.executionReason);
    const candidates = claim.connId != null ? conns.filter((c) => c.id === claim.connId) : conns;
    let matched: { conn: Conn; info: DerivContractInfo } | null = null;
    let pollOk = false;
    for (const conn of candidates) {
      const list = await load(conn);
      if (!list) continue;
      pollOk = true;
      const hit = list.find((c) => matches(signal, claim, c, used));
      if (hit) { matched = { conn, info: hit }; break; }
    }
    if (matched && matched.conn.accountId == null) {
      // The contract exists on Deriv, but its connection has no linked account
      // yet (the balance sync links it). Wait; never declare it "not placed".
      pending++;
      logger.warn({ signalId: signal.id, contractId: matched.info.contractId }, "reconciler: contract found but its connection has no linked account yet");
      continue;
    }
    if (matched && matched.conn.accountId != null) {
      used.add(matched.info.contractId);
      await db.update(signalsTable).set({
        executionStatus: "executed", executionReason: "Reconciled against Deriv contract " + matched.info.contractId,
        contractId: matched.info.contractId, dispatchedAt: signal.dispatchedAt ?? new Date(), status: "executed",
      }).where(eq(signalsTable.id, signal.id));
      await createTradeFor(signal, matched.info.contractId, matched.info, claim.stake, matched.conn.accountId);
      cleanPolls.delete(signal.id);
      resolved++;
      logger.info({ signalId: signal.id, contractId: matched.info.contractId }, "reconciler: signal matched to Deriv contract");
      continue;
    }
    const ageMs = claim.t != null ? Date.now() - claim.t : Date.now() - (signal.updatedAt?.getTime() ?? Date.now());
    if (!pollOk || ageMs < GRACE_MS) { pending++; continue; }
    const n = (cleanPolls.get(signal.id) ?? 0) + 1;
    cleanPolls.set(signal.id, n);
    if (n < CLEAN_POLLS_REQUIRED) { pending++; continue; }
    await db.update(signalsTable).set({
      executionStatus: "rejected", status: "cancelled", dispatchedAt: signal.dispatchedAt ?? new Date(),
      executionReason: `Reconciler: no matching Deriv contract after the grace window and ${n} clean polls; treated as not placed`,
    }).where(eq(signalsTable.id, signal.id));
    cleanPolls.delete(signal.id);
    resolved++;
    logger.warn({ signalId: signal.id }, "reconciler: no Deriv contract found; signal rejected");
  }

  for (const { s: signal } of orphans) {
    if (signal.contractId == null) { pending++; continue; }
    // Link the trade to the account that actually holds the contract. This
    // used to take the first connected account, which with a demo and a real
    // connection could file a real trade under demo: the contract monitor
    // would then ask the demo account about it forever, and the real
    // account's loss budget and position count would never see it.
    let owner: { conn: Conn; info: DerivContractInfo } | null = null;
    let allPolled = true;
    for (const conn of conns) {
      if (conn.accountId == null) continue;
      const list = await load(conn);
      if (!list) { allPolled = false; continue; }
      const info = list.find((c) => c.contractId === signal.contractId);
      if (info) { owner = { conn, info }; break; }
    }
    if (!owner) {
      // Not in any account's open contracts or recent history. Leave it for
      // the next poll rather than guess an account; the lock this holds says
      // which signal is waiting.
      if (allPolled) logger.warn({ signalId: signal.id, contractId: signal.contractId }, "reconciler: executed contract not found on any connected account yet");
      pending++;
      continue;
    }
    const claim = parseClaim(signal.executionReason);
    await createTradeFor(signal, signal.contractId, owner.info, claim.stake ?? owner.info.buyPrice ?? null, owner.conn.accountId!);
    resolved++;
  }
  return { resolved, pending };
}

export async function runReconciler(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const r = await reconcileOnce();
    lastResolved = r.resolved;
    if (r.pending === 0) lastError = null;
  } catch (err) {
    lastError = err instanceof Error ? err.message.replace(/otp=[^&\s]+/g, "otp=[redacted]") : "reconciler error";
    logger.error({ msg: lastError }, "reconciler run failed");
  } finally {
    lastRunAt = new Date();
    running = false;
  }
}

export function startReconciler(): void {
  if (timer) return;
  void runReconciler(); // on boot
  timer = setInterval(() => { void runReconciler(); }, RECONCILE_INTERVAL_MS);
}
