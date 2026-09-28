import { Router, type IRouter } from "express";
import { eq, desc, and, inArray } from "drizzle-orm";
import { db, tradesTable } from "@workspace/db";
import {
  CreateTradeBody,
  UpdateTradeBody,
  GetTradeParams,
  UpdateTradeParams,
  ListTradesQueryParams,
  GetRecentTradesQueryParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/trades", async (req, res): Promise<void> => {
  const query = ListTradesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const { accountId, status, symbol, limit } = query.data;
  const conditions = [];
  if (accountId != null) conditions.push(eq(tradesTable.accountId, accountId));
  if (status) conditions.push(eq(tradesTable.status, status));
  if (symbol) conditions.push(eq(tradesTable.symbol, symbol));

  const trades = await db
    .select()
    .from(tradesTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(tradesTable.createdAt))
    .limit(limit ?? 50);

  res.json(trades);
});

router.get("/trades/recent", async (req, res): Promise<void> => {
  const query = GetRecentTradesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const limit = query.data.limit ?? 10;
  const trades = await db
    .select()
    .from(tradesTable)
    .orderBy(desc(tradesTable.createdAt))
    .limit(limit);
  res.json(trades);
});

router.post("/trades", async (req, res): Promise<void> => {
  const parsed = CreateTradeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // Drizzle numeric columns require string values; coerce from parsed numbers
  const insertData = {
    ...parsed.data,
    openPrice: String(parsed.data.openPrice),
    lotSize: String(parsed.data.lotSize),
    ...(parsed.data.stopLoss != null ? { stopLoss: String(parsed.data.stopLoss) } : {}),
    ...(parsed.data.takeProfit != null ? { takeProfit: String(parsed.data.takeProfit) } : {}),
  };
  const [trade] = await db.insert(tradesTable).values(insertData as any).returning();
  res.status(201).json(trade);
});

router.get("/trades/:id", async (req, res): Promise<void> => {
  const params = GetTradeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [trade] = await db.select().from(tradesTable).where(eq(tradesTable.id, params.data.id));
  if (!trade) {
    res.status(404).json({ error: "Trade not found" });
    return;
  }
  res.json(trade);
});

router.patch("/trades/:id", async (req, res): Promise<void> => {
  const params = UpdateTradeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateTradeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const updateData: Record<string, unknown> = { ...parsed.data };
  for (const key of ["openPrice", "closePrice", "stopLoss", "takeProfit", "lotSize", "pnl"]) {
    if (updateData[key] != null) updateData[key] = String(updateData[key]);
  }
  const [trade] = await db
    .update(tradesTable)
    .set(updateData as any)
    .where(eq(tradesTable.id, params.data.id))
    .returning();
  if (!trade) {
    res.status(404).json({ error: "Trade not found" });
    return;
  }
  res.json(trade);
});

router.delete("/trades/:id", async (req, res): Promise<void> => {
  const params = GetTradeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [deleted] = await db
    .delete(tradesTable)
    .where(eq(tradesTable.id, params.data.id))
    .returning({ id: tradesTable.id });
  if (!deleted) {
    res.status(404).json({ error: "Trade not found" });
    return;
  }
  res.status(204).end();
});

router.post("/trades/bulk-delete", async (req, res): Promise<void> => {
  const { status } = req.body as { status?: string };
  let ids: number[];
  if (status) {
    const rows = await db
      .select({ id: tradesTable.id })
      .from(tradesTable)
      .where(eq(tradesTable.status, status as any));
    ids = rows.map((r) => r.id);
  } else {
    const rows = await db.select({ id: tradesTable.id }).from(tradesTable);
    ids = rows.map((r) => r.id);
  }
  if (ids.length === 0) {
    res.json({ deleted: 0 });
    return;
  }
  await db.delete(tradesTable).where(inArray(tradesTable.id, ids));
  res.json({ deleted: ids.length });
});

export default router;
