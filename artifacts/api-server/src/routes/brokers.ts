import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, brokerConnectionsTable, accountsTable } from "@workspace/db";
import {
  CreateBrokerConnectionBody,
  UpdateBrokerConnectionParams,
  UpdateBrokerConnectionBody,
  DeleteBrokerConnectionParams,
  SyncBrokerConnectionParams,
} from "@workspace/api-zod";
import { authorizeDerivAccount, syncDerivAccount } from "../lib/deriv";
import { decryptSecret, encryptSecret } from "../lib/crypto.js";
import { runDemoSelfTest } from "../lib/self-test.js";

const router: IRouter = Router();

function sanitize(row: typeof brokerConnectionsTable.$inferSelect) {
  const { credential: _credential, ...rest } = row;
  return rest;
}

router.get("/brokers/connections", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(brokerConnectionsTable)
    .orderBy(brokerConnectionsTable.createdAt);
  res.json(rows.map(sanitize));
});

router.post("/brokers/connections", async (req, res): Promise<void> => {
  const parsed = CreateBrokerConnectionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const environment = parsed.data.environment ?? "real";
  const enabled = parsed.data.enabled ?? true;
  if (enabled) {
    const authorization = await authorizeDerivAccount(parsed.data.credential.trim(), environment);
    if (!authorization.ok || (environment === "demo" && authorization.isVirtual !== true)) {
      res.status(400).json({
        error: authorization.message ?? "Deriv could not confirm an active account in the selected environment.",
      });
      return;
    }
  }
  const [created] = await db
    .insert(brokerConnectionsTable)
    .values({
      broker: parsed.data.broker,
      label: parsed.data.label,
      environment,
      accountId: parsed.data.accountId ?? null,
      credential: await encryptSecret(parsed.data.credential.trim()),
      enabled,
      status: "disconnected",
    })
    .returning();
  res.status(201).json(sanitize(created));
});

router.patch("/brokers/connections/:id", async (req, res): Promise<void> => {
  const params = UpdateBrokerConnectionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateBrokerConnectionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [existing] = await db
    .select()
    .from(brokerConnectionsTable)
    .where(eq(brokerConnectionsTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // The linked account, its balance and its trades belong to the environment
  // the connection was made for; switching it would file one under the other.
  if (parsed.data.environment && parsed.data.environment !== existing.environment) {
    res.status(400).json({ error: "A connection's environment cannot be changed. Add a new connection for the other environment instead." });
    return;
  }
  const environment = existing.environment;
  const enabled = parsed.data.enabled ?? existing.enabled;
  if (enabled) {
    const authorization = await authorizeDerivAccount(parsed.data.credential?.trim() ?? await decryptSecret(existing.credential), environment);
    if (!authorization.ok || (environment === "demo" && authorization.isVirtual !== true)) {
      res.status(400).json({
        error: authorization.message ?? "Deriv could not confirm an active account in the selected environment.",
      });
      return;
    }
  }
  // A new token may reach a different balance: wait for a fresh sync before sizing anything.
  const patch = { ...parsed.data, ...(parsed.data.credential ? { credential: await encryptSecret(parsed.data.credential.trim()), lastSyncAt: null } : {}) };
  const [updated] = await db
    .update(brokerConnectionsTable)
    .set(patch)
    .where(eq(brokerConnectionsTable.id, params.data.id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(sanitize(updated));
});

router.delete("/brokers/connections/:id", async (req, res): Promise<void> => {
  const params = DeleteBrokerConnectionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const result = await db
    .delete(brokerConnectionsTable)
    .where(eq(brokerConnectionsTable.id, params.data.id))
    .returning();
  if (result.length === 0) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(204).send();
});

router.post("/brokers/connections/:id/sync", async (req, res): Promise<void> => {
  const params = SyncBrokerConnectionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [conn] = await db
    .select()
    .from(brokerConnectionsTable)
    .where(eq(brokerConnectionsTable.id, params.data.id));
  if (!conn) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  if (conn.broker !== "deriv") {
    res.status(400).json({
      ok: false,
      broker: conn.broker,
      status: "error",
      message: `Unknown broker: ${conn.broker}`,
    });
    return;
  }

  await db
    .update(brokerConnectionsTable)
    .set({ status: "connecting", lastError: null })
    .where(eq(brokerConnectionsTable.id, conn.id));

  const plainToken = await decryptSecret(conn.credential);
  // Stakes opened while the request is in flight count from its start (see balance-sync).
  const requestedAt = new Date();
  const result = await syncDerivAccount(plainToken, conn.environment);

  if (!result.ok) {
    const message = result.message?.replaceAll(plainToken, "[redacted]") ?? "Unknown error";
    await db
      .update(brokerConnectionsTable)
      .set({ status: "error", lastError: message })
      .where(eq(brokerConnectionsTable.id, conn.id));
    res.status(502).json({
      ok: false,
      broker: conn.broker,
      status: "error",
      message,
    });
    return;
  }

  if (conn.environment === "demo" && result.isVirtual !== true) {
    const message = "Deriv did not confirm this account is virtual; demo connection was rejected.";
    await db
      .update(brokerConnectionsTable)
      .set({ status: "error", lastError: message })
      .where(eq(brokerConnectionsTable.id, conn.id));
    res.status(400).json({ ok: false, broker: conn.broker, status: "error", message });
    return;
  }

  const brokerDisplay = "Deriv";

  // Upsert into accounts table — link or create
  let linkedAccountId = conn.accountId;
  if (linkedAccountId) {
    await db
      .update(accountsTable)
      .set({
        balance: String(result.balance ?? 0),
        equity: String(result.equity ?? 0),
        currency: result.currency ?? "USD",
        status: "active",
      })
      .where(eq(accountsTable.id, linkedAccountId));
  } else {
    const [acct] = await db
      .insert(accountsTable)
      .values({
        name: `${conn.label} (${result.loginid ?? brokerDisplay})`,
        broker: brokerDisplay,
        balance: String(result.balance ?? 0),
        equity: String(result.equity ?? 0),
        margin: "0",
        currency: result.currency ?? "USD",
        accountType: conn.environment === "demo" ? "demo" : "live",
        status: "active",
        notes: `Auto-linked from ${brokerDisplay} API. Login: ${result.loginid ?? "unknown"}`,
      })
      .returning();
    linkedAccountId = acct.id;
  }

  await db
    .update(brokerConnectionsTable)
    .set({
      status: "connected",
      lastSyncAt: requestedAt,
      lastError: null,
      accountId: linkedAccountId,
    })
    .where(eq(brokerConnectionsTable.id, conn.id));

  res.json({
    ok: true,
    broker: conn.broker,
    status: "connected",
    balance: result.balance ?? null,
    equity: result.equity ?? null,
    currency: result.currency ?? null,
    openPositions: result.openPositions ?? null,
    message: `Balance synced as ${result.loginid ?? brokerDisplay}`,
  });
});

router.post("/brokers/connections/:id/self-test", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [conn] = await db.select().from(brokerConnectionsTable).where(eq(brokerConnectionsTable.id, id));
  if (!conn) { res.status(404).json({ error: "Not found" }); return; }
  const result = await runDemoSelfTest(conn);
  res.status(result.ok ? 200 : 400).json(result);
});

export default router;
