import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, brainLayersTable, botConfigTable } from "@workspace/db";
import { runWorkerTick, getWorkerStatus } from "../lib/signal-worker.js";
import { getBalanceSyncStatus } from "../lib/balance-sync.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

router.get("/brain/layers", async (_req, res): Promise<void> => {
  const layers = await db.select().from(brainLayersTable).orderBy(brainLayersTable.id);
  res.json(layers);
});

// Signal worker + balance sync status
router.get("/brain/worker-status", async (_req, res): Promise<void> => {
  const [config] = await db.select().from(botConfigTable).where(eq(botConfigTable.id, 1));
  const workerStatus = getWorkerStatus();
  res.json({
    ...workerStatus,
    // Always reflect live DB config, not cached values from last tick
    enabled: config?.enabled ?? workerStatus.enabled,
    autotradeMode: config?.autotradeMode ?? workerStatus.autotradeMode,
    balanceSync: getBalanceSyncStatus(),
  });
});

// Manually trigger one signal generation cycle
router.post("/brain/generate-signals", async (_req, res): Promise<void> => {
  // runWorkerTick() returns immediately without doing anything if a cycle is
  // already in flight, so reporting an unconditional "started" was telling the
  // operator a scan had begun when none had. Say which of the two happened.
  const alreadyRunning = getWorkerStatus().running;
  if (alreadyRunning) {
    res.json({ ok: true, started: false, message: "A signal generation cycle is already running; this request did not start another" });
    return;
  }
  // The tick handles its own errors and records them in the worker status;
  // this catch is only here so an unexpected rejection cannot crash the process.
  runWorkerTick().catch((err) => {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "Manual signal generation cycle failed");
  });
  res.json({ ok: true, started: true, message: "Signal generation cycle started" });
});

export default router;
