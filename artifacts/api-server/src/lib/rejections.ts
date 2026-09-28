import { getSecret, setSecret } from "./secrets.js";

const KEY = "quant_rejections";
const MAX = 200;
let queue: Promise<void> = Promise.resolve();

export interface RejectionEntry {
  at: string;
  symbol: string;
  stage: "pre_gpt" | "post_gpt" | "portfolio" | "sizing" | "execution" | "forex_readiness";
  reason: string;
  metrics?: Record<string, unknown>;
}

/** Persists the last 200 filter rejections so the journal can show what blocked what. */
export function recordRejection(e: Omit<RejectionEntry, "at">): void {
  queue = queue.then(async () => {
    try {
      const raw = await getSecret(KEY);
      const list: RejectionEntry[] = raw ? JSON.parse(raw) : [];
      list.unshift({ ...e, at: new Date().toISOString() });
      await setSecret(KEY, JSON.stringify(list.slice(0, MAX)));
    } catch { /* journal logging must never break the worker */ }
  });
}

export async function listRejections(): Promise<RejectionEntry[]> {
  try { const raw = await getSecret(KEY); return raw ? JSON.parse(raw) : []; } catch { return []; }
}
