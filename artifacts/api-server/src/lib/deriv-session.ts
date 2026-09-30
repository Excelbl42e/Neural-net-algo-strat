/**
 * Authenticated Deriv Options WebSocket session (OTP channel) with request/response
 * correlation via req_id and raw-frame capture. Tokens / OTPs are redacted before
 * anything is persisted or logged.
 */
import WebSocket from "ws";
import { lt } from "drizzle-orm";
import { db, derivFramesTable } from "@workspace/db";
import { accountWebSocketUrl, inspectDerivAccount, type OptionsAccount } from "./deriv-account.js";
import { logger } from "./logger.js";

const REDACT_KEYS = new Set(["authorize", "token", "otp", "url", "passthrough_secret"]);

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.has(k) ? "[redacted]" : redact(v);
    }
    return out;
  }
  return value;
}

/**
 * Retention for the raw-frame journal.
 *
 * Every Deriv frame in and out is written here, up to 20 KB each, and nothing
 * ever deleted them. The contract monitor alone opens a session every 30s
 * while a position is open, so on a 24/7 bot this table grows without bound
 * until the database fills — at which point every write fails and the bot
 * stops trading, long after anyone would connect the two. The journal is a
 * debugging aid for recent orders, so keep a bounded recent window.
 */
const FRAME_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const FRAME_PRUNE_EVERY_MS = 60 * 60 * 1000;
let lastFramePruneAt = 0;

/** Deletes frames past the retention window. Cheap, best-effort, and never blocks a caller. */
async function pruneFramesIfDue(): Promise<void> {
  const now = Date.now();
  if (now - lastFramePruneAt < FRAME_PRUNE_EVERY_MS) return;
  lastFramePruneAt = now;
  try {
    await db.delete(derivFramesTable).where(lt(derivFramesTable.receivedAt, new Date(now - FRAME_RETENTION_MS)));
  } catch (err) {
    // Never surface this: failing to prune must not stop a trade being recorded.
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "deriv_frames prune failed");
  }
}

export async function recordFrame(
  direction: "in" | "out",
  frame: unknown,
  ctx: { signalId?: number | null; contractId?: number | string | null } = {},
): Promise<void> {
  try {
    const f = (frame ?? {}) as Record<string, unknown>;
    const kind = typeof f.msg_type === "string" ? f.msg_type
      : Object.keys(f).find((k) => !["req_id", "passthrough", "subscribe"].includes(k)) ?? "unknown";
    await db.insert(derivFramesTable).values({
      direction,
      kind,
      signalId: ctx.signalId ?? null,
      contractId: ctx.contractId != null ? String(ctx.contractId) : null,
      payload: JSON.stringify(redact(frame)).slice(0, 20_000),
      ok: direction === "in" ? !f.error : null,
    });
  } catch {
    /* frame capture is best effort and must never break trading logic */
  }
  void pruneFramesIfDue();
}

export class DerivRequestTimeout extends Error {
  // Written out longhand rather than as a constructor parameter property so the
  // module loads under `node --experimental-strip-types`, which the unit tests use.
  readonly sent: boolean;
  constructor(sent: boolean) {
    super(sent ? "Deriv did not answer after the request was sent" : "Deriv connection timed out");
    this.sent = sent;
  }
}

export interface DerivSession {
  account: OptionsAccount;
  isVirtual: boolean;
  request<T = Record<string, unknown>>(req: Record<string, unknown>, opts?: { timeoutMs?: number; signalId?: number | null }): Promise<T>;
  close(): void;
}

export async function openDerivSession(token: string, environment: "demo" | "real"): Promise<DerivSession> {
  const { account, headers } = await inspectDerivAccount(token, environment);
  const url = await accountWebSocketUrl(account, headers);
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    let sock: WebSocket;
    try { sock = new WebSocket(url); } catch { reject(new Error("Deriv account WebSocket could not be created")); return; }
    const timer = setTimeout(() => { try { sock.terminate(); } catch { /* */ } reject(new Error("Deriv WebSocket connect timed out")); }, 15_000);
    sock.once("open", () => { clearTimeout(timer); resolve(sock); });
    sock.once("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      logger.warn({ status: res.statusCode }, "Deriv WebSocket upgrade rejected");
      res.resume();
      reject(new Error(`Deriv WebSocket upgrade returned HTTP ${res.statusCode ?? "unknown"}`));
    });
    // ws error text can include the OTP URL: never relay it.
    sock.once("error", () => { clearTimeout(timer); reject(new Error("Deriv WebSocket connection failed")); });
  });

  let nextId = 1;
  let closed = false;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; signalId?: number | null }>();

  ws.on("message", (raw) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const id = typeof msg.req_id === "number" ? msg.req_id : null;
    const entry = id != null ? pending.get(id) : undefined;
    const poc = msg.proposal_open_contract as { contract_id?: number } | undefined;
    void recordFrame("in", msg, { signalId: entry?.signalId, contractId: poc?.contract_id ?? (msg.buy as { contract_id?: number } | undefined)?.contract_id });
    if (id != null && entry) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.resolve(msg);
    }
  });
  const failAll = () => {
    closed = true;
    for (const [id, e] of pending) { clearTimeout(e.timer); pending.delete(id); e.reject(new DerivRequestTimeout(true)); }
  };
  ws.on("close", failAll);
  ws.on("error", failAll);

  return {
    account,
    isVirtual: account.account_type === "demo",
    request<T>(req: Record<string, unknown>, opts: { timeoutMs?: number; signalId?: number | null } = {}) {
      return new Promise<T>((resolve, reject) => {
        if (closed || ws.readyState !== WebSocket.OPEN) { reject(new Error("Deriv session is closed")); return; }
        const id = nextId++;
        const frame = { ...req, req_id: id };
        const timer = setTimeout(() => { pending.delete(id); reject(new DerivRequestTimeout(true)); }, opts.timeoutMs ?? 15_000);
        pending.set(id, { resolve, reject, timer, signalId: opts.signalId });
        void recordFrame("out", frame, { signalId: opts.signalId });
        try { ws.send(JSON.stringify(frame)); } catch (err) {
          clearTimeout(timer); pending.delete(id);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
    close() { closed = true; try { ws.close(); } catch { /* */ } },
  };
}
