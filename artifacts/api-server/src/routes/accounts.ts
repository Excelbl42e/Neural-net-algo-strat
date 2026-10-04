import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, accountsTable, brokerConnectionsTable } from "@workspace/db";
import {
  CreateAccountBody,
  UpdateAccountBody,
  GetAccountParams,
  UpdateAccountParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/accounts", async (req, res): Promise<void> => {
  const accounts = await db.select().from(accountsTable).orderBy(accountsTable.createdAt);
  res.json(accounts);
});

router.get("/accounts/summary", async (req, res): Promise<void> => {
  const accounts = await db.select().from(accountsTable).where(eq(accountsTable.status, "active"));
  const totalBalance = accounts.reduce((sum, a) => sum + parseFloat(a.balance ?? "0"), 0);
  const totalEquity = accounts.reduce((sum, a) => sum + parseFloat(a.equity ?? "0"), 0);
  const totalMargin = accounts.reduce((sum, a) => sum + parseFloat(a.margin ?? "0"), 0);
  res.json({
    totalBalance,
    totalEquity,
    totalMargin,
    accountCount: accounts.length,
    activeAccounts: accounts.filter(a => a.status === "active").length,
    totalPnlToday: totalEquity - totalBalance,
  });
});

router.post("/accounts", async (req, res): Promise<void> => {
  const parsed = CreateAccountBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const accountData: Record<string, unknown> = { ...parsed.data };
  for (const key of ["balance", "equity", "margin", "openPnl"]) {
    if (accountData[key] != null) accountData[key] = String(accountData[key]);
  }
  const [account] = await db.insert(accountsTable).values(accountData as any).returning();
  res.status(201).json(account);
});

router.get("/accounts/:id", async (req, res): Promise<void> => {
  const params = GetAccountParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [account] = await db.select().from(accountsTable).where(eq(accountsTable.id, params.data.id));
  if (!account) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  res.json(account);
});

router.patch("/accounts/:id", async (req, res): Promise<void> => {
  const params = UpdateAccountParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateAccountBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const updateData: Record<string, unknown> = { ...parsed.data };
  for (const key of ["balance", "equity", "margin", "openPnl"]) {
    if (updateData[key] != null) updateData[key] = String(updateData[key]);
  }
  const [account] = await db
    .update(accountsTable)
    .set(updateData as any)
    .where(eq(accountsTable.id, params.data.id))
    .returning();
  if (!account) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  res.json(account);
});

router.delete("/accounts/:id", async (req, res): Promise<void> => {
  const params = GetAccountParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  // Refuse deletion if a broker connection is still linked to this account
  const linked = await db
    .select({ id: brokerConnectionsTable.id, label: brokerConnectionsTable.label })
    .from(brokerConnectionsTable)
    .where(eq(brokerConnectionsTable.accountId, params.data.id));
  if (linked.length > 0) {
    res.status(409).json({
      error: `Account is linked to broker connection "${linked[0]!.label}". Remove the broker connection first.`,
    });
    return;
  }
  const result = await db
    .delete(accountsTable)
    .where(eq(accountsTable.id, params.data.id))
    .returning();
  if (result.length === 0) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(204).send();
});

export default router;
