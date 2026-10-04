import { Router, type IRouter } from "express";
import { eq, desc, and, sql } from "drizzle-orm";
import { db, signalsTable, type Signal } from "@workspace/db";
import {
  CreateSignalBody,
  UpdateSignalBody,
  GetSignalParams,
  UpdateSignalParams,
  ListSignalsQueryParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

// Drizzle returns `numeric` columns as strings. The OpenAPI contract (and
// the chart UI) expects real numbers, so we parse before serialization.
function serializeSignal(s: Signal) {
  const num = (v: string | null | undefined): number | null => {
    if (v == null) return null;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    ...s,
    // Execution tracking columns pass through from persistence; these fields
    // describe signal execution state, not current broker connectivity.
    confidence: num(s.confidence) ?? 0,
    entryLow: num(s.entryLow),
    entryHigh: num(s.entryHigh),
    stopLevel: num(s.stopLevel),
    target1Level: num(s.target1Level),
    target2Level: num(s.target2Level),
  };
}

const SIGNAL_LIST_LIMIT = 1000;

router.get("/signals", async (req, res): Promise<void> => {
  const query = ListSignalsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const { status, symbol } = query.data;
  const conditions = [];
  if (status) conditions.push(eq(signalsTable.status, status));
  if (symbol) conditions.push(eq(signalsTable.symbol, symbol));
  // The poll writes a signal on about one bar in five per pair, and three pages
  // refetch this list every 10s: the newest 1,000, plus every signal a trade
  // row links to (the Trades page shows each trade's signal).
  conditions.push(sql`(${signalsTable.id} IN (SELECT id FROM signals ORDER BY created_at DESC LIMIT ${SIGNAL_LIST_LIMIT})
    OR ${signalsTable.id} IN (SELECT signal_id FROM trades WHERE signal_id IS NOT NULL))`);

  const signals = await db
    .select()
    .from(signalsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(signalsTable.createdAt));

  res.json(signals.map(serializeSignal));
});

router.post("/signals", async (req, res): Promise<void> => {
  const parsed = CreateSignalBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const signalData = {
    ...parsed.data,
    ...(parsed.data.confidence != null ? { confidence: String(parsed.data.confidence) } : {}),
  };
  const [signal] = await db.insert(signalsTable).values(signalData as any).returning();
  res.status(201).json(serializeSignal(signal));
});

router.get("/signals/:id", async (req, res): Promise<void> => {
  const params = GetSignalParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [signal] = await db.select().from(signalsTable).where(eq(signalsTable.id, params.data.id));
  if (!signal) {
    res.status(404).json({ error: "Signal not found" });
    return;
  }
  res.json(serializeSignal(signal));
});

router.patch("/signals/:id", async (req, res): Promise<void> => {
  const params = UpdateSignalParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateSignalBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [signal] = await db
    .update(signalsTable)
    .set(parsed.data)
    .where(eq(signalsTable.id, params.data.id))
    .returning();
  if (!signal) {
    res.status(404).json({ error: "Signal not found" });
    return;
  }
  res.json(serializeSignal(signal));
});

router.delete("/signals/:id", async (req, res): Promise<void> => {
  const params = GetSignalParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [signal] = await db.select({ executionStatus: signalsTable.executionStatus })
    .from(signalsTable).where(eq(signalsTable.id, params.data.id));
  if (!signal) {
    res.status(404).json({ error: "Signal not found" });
    return;
  }
  // An order whose outcome is still unknown may be a live Deriv position; the
  // reconciler needs this row to find it.
  if (signal.executionStatus === "awaiting_broker" || signal.executionStatus === "ambiguous") {
    res.status(409).json({ error: "This signal's order is still being confirmed with Deriv; it can be deleted once that is resolved." });
    return;
  }
  await db.delete(signalsTable).where(eq(signalsTable.id, params.data.id));
  res.status(204).send();
});

export default router;
