import { Router, type IRouter } from "express";
import { getSystemStatus } from "../lib/system-status.js";
import { listRejections } from "../lib/rejections.js";
import { desc, eq } from "drizzle-orm";
import { db, derivFramesTable } from "@workspace/db";

const router: IRouter = Router();

// Public liveness only. Details are behind auth at /system/status.
router.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

router.get("/system/status", async (_req, res) => {
  res.json(await getSystemStatus());
});

router.get("/system/rejections", async (_req, res) => {
  res.json(await listRejections());
});

router.get("/system/frames", async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
  const signalId = req.query.signalId ? Number(req.query.signalId) : null;
  const rows = await db.select().from(derivFramesTable)
    .where(signalId ? eq(derivFramesTable.signalId, signalId) : undefined)
    .orderBy(desc(derivFramesTable.receivedAt)).limit(limit);
  res.json(rows);
});

export default router;
