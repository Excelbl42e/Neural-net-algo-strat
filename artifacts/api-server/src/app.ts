import path from "node:path";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";
import { requireAuth } from "./middlewares/api-key.js";
import { startSignalWorker } from "./lib/signal-worker.js";
import { startCandleFeeder } from "./lib/candle-feeder.js";
import { seedDefaults } from "./lib/seed.js";
import { ensureSchema } from "./lib/migrate.js";
import { startBalanceSync } from "./lib/balance-sync.js";
import { startContractMonitor } from "./lib/contract-monitor.js";
import { startReconciler } from "./lib/reconciler.js";
import { getNewsEvents } from "./lib/news-calendar.js";

const app: Express = express();
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);
// Same-origin app: reflect the origin only so the session cookie works; no wildcard with credentials.
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use("/api", (req, res, next) => { void requireAuth(req, res, next); }, router);

// Single-process deploy: this same server also serves the built dashboard, so
// Replit only needs one always-on port. dist/public is a sibling of this
// server's own dist (or src, in dev) under artifacts/, so the relative path
// resolves the same way whether running bundled or via tsx.
const dashboardDist = path.resolve(import.meta.dirname, "../../trading-dashboard/dist/public");
if (existsSync(dashboardDist)) {
  app.use(express.static(dashboardDist, { index: false }));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(dashboardDist, "index.html"));
  });
} else {
  logger.warn({ dashboardDist }, "Dashboard build not found; run the dashboard build before starting in production");
}

/**
 * JSON error handler (Express 5 forwards async route rejections here).
 *
 * The detail stays in the log and never goes to the client. It used to be
 * returned verbatim, which on a failed query answered with the SQL itself —
 * `Failed query: select "id" from "app_owner" limit $1` — and `/auth/status`
 * is a public path, so anyone who could reach the app could read it. Internal
 * error text also carries file paths, driver internals and connection details;
 * the existing `otp=` redaction shows that was already understood, but a single
 * pattern cannot cover what an arbitrary error decides to say.
 *
 * A short correlation id goes to both sides instead, so an error on screen can
 * still be matched to the log line that explains it.
 */
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message.replace(/otp=[^&\s]+/g, "otp=[redacted]") : "Internal error";
  const errorId = randomBytes(6).toString("hex");
  // Keyed `detail`, not `msg`: pino treats `msg` as its own message field, so
  // the second argument overwrote it and the error text never reached the log
  // at all. It survived only in the response body — the one place it should
  // not have been.
  logger.error({ errorId, detail: message }, "Unhandled route error");
  if (res.headersSent) return;
  res.status(500).json({ error: "Internal server error", errorId });
});

const started: string[] = [];
function safeStart(name: string, fn: () => void): void {
  try { fn(); started.push(name); }
  catch (err) { logger.error({ name, msg: err instanceof Error ? err.message : String(err) }, "Worker failed to start"); }
}

export async function boot(): Promise<void> {
  try {
    await ensureSchema();
    await seedDefaults();
  } catch (err) {
    // Even if provisioning fails, bring up workers so the app stays visible and self-reports.
    logger.error({ msg: err instanceof Error ? err.message : String(err) }, "Boot provisioning failed");
  }
  safeStart("signal_worker", startSignalWorker);
  safeStart("candle_feeder", () => startCandleFeeder());
  safeStart("balance_sync", startBalanceSync);
  safeStart("contract_monitor", startContractMonitor);
  safeStart("reconciler", startReconciler);
  getNewsEvents().catch(() => { /* surfaced via news_calendar system-status component */ });
  logger.info({ started }, "Startup self-check: workers started");
}

export default app;
