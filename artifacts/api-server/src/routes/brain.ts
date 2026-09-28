import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, brainLayersTable, botConfigTable } from "@workspace/db";
import { ingestSource, processPendingSources } from "../lib/ingest.js";
import { runWorkerTick, getWorkerStatus } from "../lib/signal-worker.js";
import { getBalanceSyncStatus } from "../lib/balance-sync.js";

const router: IRouter = Router();

router.get("/brain/layers", async (_req, res): Promise<void> => {
  const layers = await db.select().from(brainLayersTable).orderBy(brainLayersTable.id);
  res.json(layers);
});

// Process ALL pending sources — must be BEFORE /:id to avoid param conflict
router.post("/brain/ingest/all", async (_req, res): Promise<void> => {
  processPendingSources().catch(() => {});
  res.json({ ok: true, message: "Ingestion started in background" });
});

// Manually trigger ingestion of one source
router.post("/brain/ingest/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    await ingestSource(id);
    res.json({ ok: true, sourceId: id });
  } catch (err: unknown) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
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
