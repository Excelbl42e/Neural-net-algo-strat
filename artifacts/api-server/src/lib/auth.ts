import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { db, appOwnerTable } from "@workspace/db";
import { getOrCreateSecret, setSecret } from "./secrets.js";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
export const SESSION_COOKIE = "nt_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 10;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function ownerExists(): Promise<boolean> {
  const [row] = await db.select({ id: appOwnerTable.id }).from(appOwnerTable).limit(1);
  return Boolean(row);
}

/** Creates the owner only if none exists. Returns false if one already does (race-safe enough for single-user). */
export async function createOwner(password: string): Promise<boolean> {
  if (await ownerExists()) return false;
  await db.insert(appOwnerTable).values({ passwordHash: await hashPassword(password) });
  return true;
}

export async function checkOwnerPassword(password: string): Promise<boolean> {
  const [row] = await db.select().from(appOwnerTable).orderBy(appOwnerTable.id).limit(1);
  return row ? verifyPassword(password, row.passwordHash) : false;
}

async function signingKey(): Promise<string> {
  return getOrCreateSecret("session_signing_key", 32);
}

export async function issueSession(): Promise<string> {
  const exp = Date.now() + SESSION_TTL_MS;
  const nonce = randomBytes(8).toString("hex");
  const body = `${exp}.${nonce}`;
  const sig = createHmac("sha256", await signingKey()).update(body).digest("hex");
  return `${body}.${sig}`;
}

export async function verifySession(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [expStr, nonce, sig] = parts as [string, string, string];
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = createHmac("sha256", await signingKey()).update(`${expStr}.${nonce}`).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Rotating the signing key logs everyone out. */
export async function revokeAllSessions(): Promise<void> {
  await setSecret("session_signing_key", randomBytes(32).toString("hex"));
}

export function machineKeyMatches(provided: string | undefined): boolean {
  const expected = process.env.BOT_API_KEY?.trim();
  if (!expected || !provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided.trim());
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Login rate limiting (in-memory, per IP) ────────────────────────────────
const attempts = new Map<string, { count: number; windowStart: number; lockedUntil: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const LOCK_MS = 15 * 60 * 1000;

export function loginAllowed(ip: string): { ok: boolean; retryAfterSec?: number } {
  const e = attempts.get(ip);
  if (e && e.lockedUntil > Date.now()) return { ok: false, retryAfterSec: Math.ceil((e.lockedUntil - Date.now()) / 1000) };
  return { ok: true };
}

export function recordLoginFailure(ip: string): void {
  const now = Date.now();
  const e = attempts.get(ip);
  if (!e || now - e.windowStart > WINDOW_MS) {
    attempts.set(ip, { count: 1, windowStart: now, lockedUntil: 0 });
    return;
  }
  e.count += 1;
  if (e.count >= MAX_ATTEMPTS) e.lockedUntil = now + LOCK_MS;
}

export function recordLoginSuccess(ip: string): void {
  attempts.delete(ip);
}
