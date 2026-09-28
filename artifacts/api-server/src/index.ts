import app, { boot } from "./app";
import { logger } from "./lib/logger";
import { flushCandles } from "./lib/candle-feeder";

process.on("unhandledRejection", (reason) => {
  logger.error({ msg: reason instanceof Error ? reason.message : String(reason) }, "unhandledRejection");
});
process.on("uncaughtException", (err) => {
  logger.error({ msg: err.message, stack: err.stack }, "uncaughtException");
});

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");
  void boot();
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Graceful shutdown: flushing candle buckets");
  const force = setTimeout(() => process.exit(0), 8_000);
  try { await flushCandles(); } catch { /* best effort */ }
  server.close(() => { clearTimeout(force); process.exit(0); });
}
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT", () => { void shutdown("SIGINT"); });
