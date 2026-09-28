import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, brainLayersTable, botConfigTable } from "@workspace/db";
import { runWorkerTick, getWorkerStatus } from "../lib/signal-worker.js";
import { getBalanceSyncStatus } from "../lib/balance-sync.js";

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
  runWorkerTick().catch(() => {}); // fire in background
  res.json({ ok: true, message: "Signal generation cycle started" });
});

export default router;
