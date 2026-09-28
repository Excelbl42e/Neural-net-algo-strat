import type { Request, Response, NextFunction } from "express";
import { machineKeyMatches, SESSION_COOKIE, verifySession } from "../lib/auth.js";

const PUBLIC_PATHS = new Set([
  "/healthz",
  "/auth/status",
  "/auth/setup",
  "/auth/login",
  "/auth/logout",
]);

/**
 * Every /api route requires either the owner session cookie or the optional
 * BOT_API_KEY machine key (x-api-key header, for scripts). Only /healthz and the
 * login/setup endpoints are public.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (PUBLIC_PATHS.has(req.path)) {
    next();
    return;
  }
  try {
    const cookieToken = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    if ((await verifySession(cookieToken)) || machineKeyMatches(req.header("x-api-key"))) {
      next();
      return;
    }
  } catch {
    /* fall through to 401 */
  }
  res.status(401).json({ error: "Authentication required", code: "auth_required" });
}
