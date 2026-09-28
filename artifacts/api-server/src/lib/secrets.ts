import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, appSecretsTable } from "@workspace/db";

const cache = new Map<string, string>();

export async function getSecret(key: string): Promise<string | null> {
  const hit = cache.get(key);
  if (hit) return hit;
  const [row] = await db.select().from(appSecretsTable).where(eq(appSecretsTable.key, key)).limit(1);
  if (row) cache.set(key, row.value);
  return row?.value ?? null;
}

export async function setSecret(key: string, value: string): Promise<void> {
  await db.insert(appSecretsTable).values({ key, value })
    .onConflictDoUpdate({ target: appSecretsTable.key, set: { value, updatedAt: new Date() } });
  cache.set(key, value);
}

/** Returns the secret, generating and persisting a random one on first use. */
export async function getOrCreateSecret(key: string, bytes = 32): Promise<string> {
  const existing = await getSecret(key);
  if (existing) return existing;
  const value = randomBytes(bytes).toString("hex");
  // onConflictDoNothing + re-read keeps this safe if two boots race.
  await db.insert(appSecretsTable).values({ key, value }).onConflictDoNothing();
  cache.delete(key);
  return (await getSecret(key)) ?? value;
}

export function clearSecretCache(): void {
  cache.clear();
}
