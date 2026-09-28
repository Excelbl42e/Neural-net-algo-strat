import { Router, type IRouter } from "express";
import { eq, desc, and } from "drizzle-orm";
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
  const result = await db
    .delete(signalsTable)
    .where(eq(signalsTable.id, params.data.id))
    .returning();
  if (result.length === 0) {
    res.status(404).json({ error: "Signal not found" });
    return;
  }
  res.status(204).send();
});

export default router;
