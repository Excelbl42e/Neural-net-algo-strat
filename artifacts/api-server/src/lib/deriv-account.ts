import WebSocket from "ws";
import type { DerivSyncResult } from "./deriv.js";

type Environment = "demo" | "real";
export type OptionsAccount = {
  account_id: string;
  account_type: Environment;
  status: "active" | "inactive";
  balance: number;
  currency: string;
};

const API_BASE = "https://api.derivws.com/trading/v1/options";
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Deriv returns monetary amounts (balance, etc.) as quoted JSON strings, not
 * numbers — verified against a live /accounts response ("balance":"10005.83").
 * Accept either shape rather than assuming one.
 */
export function toFiniteNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// 1089 (Deriv's shared test app id) is purely numeric, but an app registered
// for PAT/Deriv-App-ID auth in Deriv's current Developer Dashboard can be
// alphanumeric with dashes — don't reject a legitimately registered id.
const APP_ID_PATTERN = /^[A-Za-z0-9-]+$/;

function patHeaders(token: string): Record<string, string> {
  const appId = (process.env.DERIV_APP_ID?.trim() || "1089");
  if (!APP_ID_PATTERN.test(appId)) {
    throw new Error("DERIV_APP_ID has an unexpected format (expected letters, digits and dashes)");
  }
  if (!token.trim()) throw new Error("Deriv Personal Access Token is missing");
  return { Authorization: `Bearer ${token.trim()}`, "Deriv-App-ID": appId };
}

/**
 * A plain instruction for the two statuses that mean the token itself is the
 * problem. Deriv's error docs: 401 is a missing or invalid token (or a missing
 * Deriv-App-ID with a PAT, which this client always sends), 403 is a valid
 * token without the scope the call needs. A PAT expires after at most 90 days;
 * "HTTP 401" on its own read like a server fault, and the connection quietly
 * stopped trading until someone worked out the token had run out.
 */
export function tokenProblem(status: number): string | null {
  if (status === 401) {
    return "Deriv rejected the API token (HTTP 401): it has expired or was deleted. " +
      "Create a new token with the Trade scope on Deriv's API token page (Deriv allows up to 90 days) and replace this connection.";
  }
  if (status === 403) {
    return "Deriv refused this API token (HTTP 403): it does not have the Trade scope. " +
      "Create a token with Trade ticked and replace this connection.";
  }
  return null;
}

/** Never include bearer tokens, OTP URLs, or raw upstream responses in errors. */
export async function inspectDerivAccount(
  token: string,
  environment: Environment,
): Promise<{ account: OptionsAccount; headers: Record<string, string> }> {
  const headers = patHeaders(token);
  const response = await fetch(`${API_BASE}/accounts`, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: "error",
  });
  if (!response.ok) throw new Error(tokenProblem(response.status) ?? `Deriv account lookup returned HTTP ${response.status}`);
  let body: { data?: unknown };
  try {
    body = await response.json() as { data?: unknown };
  } catch {
    throw new Error("Deriv account lookup returned invalid JSON");
  }
  if (!Array.isArray(body.data)) throw new Error("Deriv account lookup did not return an account list");
  const matches = body.data
    .map((item): OptionsAccount | null => {
      if (item === null || typeof item !== "object") return null;
      const r = item as Record<string, unknown>;
      const balance = toFiniteNumber(r.balance);
      if (
        r.account_type !== environment || r.status !== "active" ||
        typeof r.account_id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(r.account_id) ||
        balance === null ||
        typeof r.currency !== "string" || r.currency.length === 0
      ) return null;
      return { account_id: r.account_id, account_type: environment, status: "active", balance, currency: r.currency };
    })
    .filter((a): a is OptionsAccount => a !== null);
  // A login often holds more than one real account (a USD account next to a
  // crypto one, say). Every stake, minimum and cost in this system is in USD,
  // so exactly one USD account is an unambiguous choice; anything else still
  // refuses rather than guess which account to trade.
  if (matches.length > 1) {
    const usd = matches.filter((a) => a.currency.toUpperCase() === "USD");
    if (usd.length === 1) return { account: usd[0]!, headers };
  }
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? `No active ${environment} Options account confirmed by Deriv`
      : `Multiple active ${environment} Options accounts found and none is the single USD account; keep one active ${environment} USD account for this token`);
  }
  return { account: matches[0], headers };
}

export async function accountWebSocketUrl(
  account: OptionsAccount,
  headers: Record<string, string>,
): Promise<string> {
  const response = await fetch(`${API_BASE}/accounts/${encodeURIComponent(account.account_id)}/otp`, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: "error",
  });
  if (!response.ok) throw new Error(tokenProblem(response.status) ?? `Deriv OTP request returned HTTP ${response.status}`);
  let body: { data?: { url?: unknown } };
  try {
    body = await response.json() as { data?: { url?: unknown } };
  } catch {
    throw new Error("Deriv OTP request returned invalid JSON");
  }
  if (typeof body.data?.url !== "string") throw new Error("Deriv OTP response had no WebSocket URL");
  let url: URL;
  try {
    url = new URL(body.data.url);
  } catch {
    throw new Error("Deriv OTP response contained an invalid WebSocket URL");
  }
  if (url.protocol !== "wss:" || url.hostname !== "api.derivws.com" ||
      url.pathname !== `/trading/v1/options/ws/${account.account_type}` ||
      !url.searchParams.get("otp")) {
    throw new Error("Deriv OTP response contained an unexpected WebSocket destination");
  }
  return url.toString();
}

function readAccountSession(url: string, account: OptionsAccount): Promise<DerivSyncResult> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      resolve({ ok: false, status: "error", message: "Deriv account WebSocket could not be created" });
      return;
    }
    let finished = false;
    let balance: number | null = null;
    let currency = account.currency;
    let openPositions: number | null = null;
    const finish = (result: DerivSyncResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closed */ }
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, status: "error", message: "Deriv account WebSocket timed out" }),
      REQUEST_TIMEOUT_MS,
    );
    ws.on("open", () => {
      // The OTP authenticates this session. Do not send a legacy authorize frame.
      try {
        ws.send(JSON.stringify({ balance: 1 }));
        ws.send(JSON.stringify({ portfolio: 1 }));
      } catch {
        finish({ ok: false, status: "error", message: "Deriv account requests could not be sent" });
      }
    });
    ws.on("unexpected-response", (_request, response) => {
      finish({ ok: false, status: "error", message: `Deriv account WebSocket upgrade returned HTTP ${response.statusCode ?? "unknown"}` });
      response.resume();
      ws.terminate();
    });
    ws.on("error", () => {
      // ws errors may include the URL's OTP. Never relay or log their text.
      finish({ ok: false, status: "error", message: "Deriv account WebSocket connection failed" });
    });
    ws.on("close", () => finish({ ok: false, status: "error", message: "Deriv account WebSocket closed before sync completed" }));
    ws.on("message", (raw) => {
      let msg: {
        msg_type?: string;
        error?: { code?: string };
        balance?: { balance?: number | string; currency?: string };
        portfolio?: { contracts?: unknown[] };
      };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.error) {
        const code = typeof msg.error.code === "string" && /^[a-zA-Z0-9_]{1,60}$/.test(msg.error.code) ? ` (${msg.error.code})` : "";
        finish({ ok: false, status: "error", message: `Deriv account request rejected${code}` });
        return;
      }
      if (msg.msg_type === "balance" && msg.balance) {
        const parsedBalance = toFiniteNumber(msg.balance.balance);
        if (parsedBalance === null) {
          finish({ ok: false, status: "error", message: "Deriv balance response was invalid" });
          return;
        }
        balance = parsedBalance;
        if (typeof msg.balance.currency === "string" && msg.balance.currency) currency = msg.balance.currency;
      } else if (msg.msg_type === "portfolio" && msg.portfolio) {
        if (!Array.isArray(msg.portfolio.contracts)) {
          finish({ ok: false, status: "error", message: "Deriv portfolio response was invalid" });
          return;
        }
        openPositions = msg.portfolio.contracts.length;
      }
      if (balance !== null && openPositions !== null) {
        finish({
          ok: true, status: "connected", isVirtual: account.account_type === "demo",
          loginid: account.account_id, balance, equity: balance, currency, openPositions,
        });
      }
    });
  });
}

export async function syncDerivPatAccount(token: string, environment: Environment): Promise<DerivSyncResult> {
  const { account, headers } = await inspectDerivAccount(token, environment);
  const url = await accountWebSocketUrl(account, headers);
  return readAccountSession(url, account);
}