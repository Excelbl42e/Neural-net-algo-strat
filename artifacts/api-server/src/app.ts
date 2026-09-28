import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";
import { requireAuth } from "./middlewares/api-key.js";
import { startSignalWorker } from "./lib/signal-worker.js";
import { processPendingSources } from "./lib/ingest.js";
import { startCandleFeeder } from "./lib/candle-feeder.js";
import { seedDefaults } from "./lib/seed.js";
import { ensureSchema } from "./lib/migrate.js";
import { startBalanceSync } from "./lib/balance-sync.js";
import { startContractMonitor } from "./lib/contract-monitor.js";
import { startReconciler } from "./lib/reconciler.js";

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

// JSON error handler (Express 5 forwards async route rejections here).
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message.replace(/otp=[^&\s]+/g, "otp=[redacted]") : "Internal error";
  logger.error({ msg: message }, "Unhandled route error");
  if (res.headersSent) return;
  res.status(500).json({ error: "Internal server error", detail: message });
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
  processPendingSources().catch(() => { /* surfaced per-source */ });
  logger.info({ started }, "Startup self-check: workers started");
}

export default app;
