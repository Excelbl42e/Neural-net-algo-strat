import { getSecret, setSecret } from "./secrets.js";
import { getSyntheticSymbol } from "./synthetic-catalog.js";

/**
 * Entries for pairs the bot no longer scans are dropped. The log is stored,
 * so after the catalogue shrank to Deriv's 14 multiplier pairs the old rows
 * for removed pairs would otherwise sit in the panel for hours, reading as
 * though the bot were still analysing pairs it cannot trade.
 */
const stillScanned = (e: RejectionEntry) => getSyntheticSymbol(e.symbol) !== null;

const KEY = "quant_rejections";
const MAX = 200;
let queue: Promise<void> = Promise.resolve();

export interface RejectionEntry {
  at: string;
  symbol: string;
  /**
   * Where in the pipeline the symbol was dropped. `pre_gpt`, `expert_judge`
   * and `post_gpt` belong to the retired ICT pipeline; they stay in the type
   * only so entries stored before the strategy poll replaced it still render.
   */
  stage:
    | "poll"             // the strategy poll did not reach agreement
    | "pre_gpt"          // retired: quant pre-filter
    | "no_tick"          // no fresh price tick for the symbol
    | "expert_judge"     // retired: ICT judge
    | "post_gpt"         // retired: geometry / cited-structure checks
    | "portfolio"
    | "sizing"
    | "entry"            // waiting for price to reach the approved zone, or setup over
    | "execution"
    | "forex_readiness"
    | "cot_veto";       // speculators' COT positioning at a 3-year extreme on the trade's side
  reason: string;
  metrics?: Record<string, unknown>;
}

/**
 * The same refusal for the same symbol inside this window is recorded once.
 * The entry watcher re-attempts pending signals every few seconds, and many
 * refusals — outside the killzone, today's loss budget already spent — stay
 * true for hours; recording each attempt would push every other entry out of
 * the 200-entry log within the hour and bury the one line that matters.
 */
const REPEAT_WINDOW_MS = 10 * 60_000;
const lastRecorded = new Map<string, { key: string; at: number }>();

/** Persists the last 200 filter rejections so the journal can show what blocked what. */
export function recordRejection(e: Omit<RejectionEntry, "at">): void {
  const key = `${e.stage}|${e.reason}`;
  const prev = lastRecorded.get(e.symbol);
  const now = Date.now();
  if (prev && prev.key === key && now - prev.at < REPEAT_WINDOW_MS) return;
  lastRecorded.set(e.symbol, { key, at: now });
  queue = queue.then(async () => {
    try {
      const raw = await getSecret(KEY);
      const list: RejectionEntry[] = (raw ? JSON.parse(raw) as RejectionEntry[] : []).filter(stillScanned);
      list.unshift({ ...e, at: new Date().toISOString() });
      await setSecret(KEY, JSON.stringify(list.slice(0, MAX)));
    } catch { /* journal logging must never break the worker */ }
  });
}

export async function listRejections(): Promise<RejectionEntry[]> {
  try {
    const raw = await getSecret(KEY);
    return raw ? (JSON.parse(raw) as RejectionEntry[]).filter(stillScanned) : [];
  } catch { return []; }
}
