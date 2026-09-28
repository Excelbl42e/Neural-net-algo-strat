import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import {
  db,
  educationSourcesTable,
  strategiesTable,
  brokerConnectionsTable,
} from "@workspace/db";
import { RunAnalysisBody } from "@workspace/api-zod";

const router: IRouter = Router();

router.post("/analysis/run", async (req, res): Promise<void> => {
  const parsed = RunAnalysisBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const symbol = parsed.data.symbol.toUpperCase();
  const timeframe = parsed.data.timeframe ?? "H1";

  const [readySources, pendingSources, activeStrategies, connectedBrokers] = await Promise.all([
    db.select().from(educationSourcesTable).where(eq(educationSourcesTable.status, "ready")),
    db.select().from(educationSourcesTable).where(eq(educationSourcesTable.status, "pending")),
    db.select().from(strategiesTable).where(eq(strategiesTable.active, true)),
    db.select().from(brokerConnectionsTable).where(and(
      eq(brokerConnectionsTable.status, "connected"),
      eq(brokerConnectionsTable.enabled, true),
    )),
  ]);

  const counts = {
    readySources: readySources.length,
    pendingSources: pendingSources.length,
    activeStrategies: activeStrategies.length,
    connectedBrokers: connectedBrokers.length,
  };

  if (readySources.length === 0 && pendingSources.length === 0) {
    res.json({
      ok: false,
      status: "no_data",
      symbol,
      timeframe,
      message: "No knowledge sources uploaded yet. Open Education and add the books, videos, or playlists you want the brain to learn from.",
      ...counts,
    });
    return;
  }

  if (readySources.length === 0) {
    res.json({
      ok: false,
      status: "brain_warming",
      symbol,
      timeframe,
      message: `Knowledge sources are still processing (${pendingSources.length} pending). Try again once at least one source reaches "ready" on the Education page.`,
      ...counts,
    });
    return;
  }

  // Sources are ready, but the C++ training pipeline has not been built yet.
  res.json({
    ok: false,
    status: "brain_not_trained",
    symbol,
    timeframe,
    message: `Knowledge ingested (${readySources.length} source${readySources.length === 1 ? "" : "s"} ready) but the C++ neural-network trainer has not been hooked up yet. On-demand analysis will start working once training completes.`,
    ...counts,
  });
});

export default router;
