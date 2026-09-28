import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, strategiesTable, type Strategy } from "@workspace/db";
import {
  CreateStrategyBody,
  UpdateStrategyBody,
  UpdateStrategyParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

function serialize(row: Strategy) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    description: row.description,
    explanation: row.explanation,
    weight: row.weight != null ? parseFloat(row.weight) : null,
    active: row.active,
    parameters: row.parameters,
    tradeCount: row.tradeCount,
    winRate: row.winRate != null ? parseFloat(row.winRate) : null,
    concepts: row.concepts,
    rules: row.rules,
    sourcesUsed: row.sourcesUsed,
    wordsAnalyzed: row.wordsAnalyzed,
    summary: row.summary,
    synthesizedAt: row.synthesizedAt ? row.synthesizedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

router.get("/strategies", async (_req, res): Promise<void> => {
  const rows = await db.select().from(strategiesTable).orderBy(strategiesTable.name);
  res.json(rows.map(serialize));
});

// IMPORTANT: literal-path routes must come BEFORE /:id

router.post("/strategies", async (req, res): Promise<void> => {
  const parsed = CreateStrategyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db.insert(strategiesTable).values(parsed.data).returning();
  res.status(201).json(serialize(row));
});

router.patch("/strategies/:id", async (req, res): Promise<void> => {
  const params = UpdateStrategyParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateStrategyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .update(strategiesTable)
    .set(parsed.data)
    .where(eq(strategiesTable.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Strategy not found" });
    return;
  }
  res.json(serialize(row));
});

export default router;
