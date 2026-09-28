import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import {
  db,
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

  const [activeStrategies, connectedBrokers] = await Promise.all([
    db.select().from(strategiesTable).where(eq(strategiesTable.active, true)),
    db.select().from(brokerConnectionsTable).where(and(
      eq(brokerConnectionsTable.status, "connected"),
      eq(brokerConnectionsTable.enabled, true),
    )),
  ]);

  const counts = {
    activeStrategies: activeStrategies.length,
    connectedBrokers: connectedBrokers.length,
  };

  // The hardcoded strategy library is seeded at boot (seedDefaults); this
  // should only read 0 if the server hasn't finished its first boot yet.
  if (activeStrategies.length === 0) {
    res.json({
      ok: false,
      status: "no_data",
      symbol,
      timeframe,
      message: "The hardcoded strategy library has not been seeded yet. This happens automatically on server boot; try again shortly.",
      ...counts,
    });
    return;
  }

  if (connectedBrokers.length === 0) {
    res.json({
      ok: false,
      status: "brain_warming",
      symbol,
      timeframe,
      message: `Strategy library is ready (${activeStrategies.length} strategies) but no connected, enabled broker account is configured yet. Connect one on the Brokers page.`,
      ...counts,
    });
    return;
  }

  res.json({
    ok: true,
    status: "ready",
    symbol,
    timeframe,
    message: `Strategy library ready (${activeStrategies.length} strategies) with a connected broker. The signal worker scans automatically on its own interval — this endpoint reports readiness, it does not trigger an immediate scan.`,
    ...counts,
  });
});

export default router;
