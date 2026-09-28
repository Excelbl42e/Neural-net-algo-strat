import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { getOrCreateSecret } from "./secrets.js";

const PREFIX = "enc:v1:";
let keyPromise: Promise<Buffer> | null = null;

/**
 * AES-256-GCM key. APP_ENCRYPTION_KEY wins if set; otherwise an auto-generated
 * key is kept in the app_secrets table. That protects against table exports and
 * casual reads, not against a full database compromise.
 */
function getKey(): Promise<Buffer> {
  keyPromise ??= (async () => {
    const env = process.env.APP_ENCRYPTION_KEY?.trim();
    const material = env && env.length > 0 ? env : await getOrCreateSecret("encryption_key", 32);
    return createHash("sha256").update(material).digest();
  })();
  return keyPromise;
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

export async function encryptSecret(plain: string): Promise<string> {
  if (isEncrypted(plain)) return plain;
  const key = await getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

/** Decrypts values written by encryptSecret. Legacy plaintext rows pass through unchanged. */
export async function decryptSecret(stored: string): Promise<string> {
  if (!isEncrypted(stored)) return stored;
  const key = await getKey();
  const [ivB64, tagB64, ctB64] = stored.slice(PREFIX.length).split(":");
  if (!ivB64 || !tagB64 || !ctB64) throw new Error("Stored credential is malformed");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Stored credential could not be decrypted (encryption key changed?). Re-enter the Deriv token.");
  }
}
