import { Router, type IRouter } from "express";
import {
  SESSION_COOKIE, SESSION_TTL_MS, MIN_PASSWORD_LENGTH,
  checkOwnerPassword, createOwner, issueSession, loginAllowed, ownerExists,
  recordLoginFailure, recordLoginSuccess, revokeAllSessions, verifySession, machineKeyMatches,
} from "../lib/auth.js";

const router: IRouter = Router();

function cookieOpts(secure: boolean) {
  return { httpOnly: true, sameSite: "lax" as const, secure, path: "/", maxAge: SESSION_TTL_MS };
}
function isSecure(req: { secure: boolean; header(name: string): string | undefined }): boolean {
  return req.secure || req.header("x-forwarded-proto") === "https";
}

router.get("/auth/status", async (req, res) => {
  const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
  res.json({
    ownerExists: await ownerExists(),
    authenticated: (await verifySession(token)) || machineKeyMatches(req.header("x-api-key")),
    minPasswordLength: MIN_PASSWORD_LENGTH,
  });
});

router.post("/auth/setup", async (req, res) => {
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (password.length < MIN_PASSWORD_LENGTH) {
    res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    return;
  }
  if (!(await createOwner(password))) {
    res.status(409).json({ error: "Owner already exists. Log in instead." });
    return;
  }
  res.cookie(SESSION_COOKIE, await issueSession(), cookieOpts(isSecure(req)));
  res.status(201).json({ ok: true });
});

router.post("/auth/login", async (req, res) => {
  const ip = req.ip ?? "unknown";
  const gate = loginAllowed(ip);
  if (!gate.ok) {
    res.setHeader("Retry-After", String(gate.retryAfterSec ?? 900));
    res.status(429).json({ error: "Too many attempts. Try again later." });
    return;
  }
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!(await checkOwnerPassword(password))) {
    recordLoginFailure(ip);
    res.status(401).json({ error: "Wrong password", code: "bad_password" });
    return;
  }
  recordLoginSuccess(ip);
  res.cookie(SESSION_COOKIE, await issueSession(), cookieOpts(isSecure(req)));
  res.json({ ok: true });
});

router.post("/auth/logout", (_req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ ok: true });
});

router.post("/auth/logout-everywhere", async (_req, res) => {
  await revokeAllSessions();
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ ok: true });
});

// Kept for the daily healthcheck: 200 only when the caller is authenticated.
router.get("/auth/check", (_req, res) => res.json({ ok: true }));
router.post("/auth/check", (_req, res) => res.json({ ok: true }));

export default router;
