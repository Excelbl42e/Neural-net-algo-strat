/**
 * Node wrapper around the native C++ expert system binary.
 *
 * The binary lives at `bin/expert-system` and is invoked with the source
 * count as argv[1]. The full concatenated knowledge text is piped in on
 * stdin. It acts as a deterministic ingestion concept tagger, not a model or
 * adaptive strategy synthesizer; the legacy strategy-shaped result is retained
 * for existing consumers.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, and } from "drizzle-orm";
import {
  db,
  strategiesTable,
  knowledgeChunksTable,
  educationSourcesTable,
} from "@workspace/db";
import { logger } from "./logger.js";

// Exported here as a convenient integration point for the signal worker. The
// worker can use this persisted, sample-adjusted gate before making its prompt.
export { scoreConcepts } from "./trade-review.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPERT_BIN = path.join(__dirname, "../bin/expert-system");

const MEGA_STRATEGY_NAME = "NeuralTrade Synthesized Mega-Strategy";

export interface ExpertConcept {
  name: string;
  definition: string;
  hitCount: number;
  weight: number;
  evidence: string;
}

export interface ExpertRule {
  id: string;
  title: string;
  trigger: string;
  entry: string;
  stop: string;
  target: string;
  priority: number;
}

export interface ExpertOutput {
  name: string;
  type: string;
  sourcesUsed: number;
  wordsAnalyzed: number;
  totalHits: number;
  summary: string;
  concepts: ExpertConcept[];
  rules: ExpertRule[];
}

const EXPERT_TIMEOUT_MS = 30_000;

function runExpertSystem(text: string, sourcesUsed: number): Promise<ExpertOutput> {
  return new Promise((resolve, reject) => {
    const proc = spawn(EXPERT_BIN, [String(sourcesUsed)]);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

    const timer = setTimeout(() => {
      finish(() => {
        try { proc.kill("SIGKILL"); } catch { /* noop */ }
        reject(new Error(`expert-system timed out after ${EXPERT_TIMEOUT_MS}ms`));
      });
    }, EXPERT_TIMEOUT_MS);

    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.stdin.write(text, "utf8");
    proc.stdin.end();
    proc.on("close", (code) => {
      clearTimeout(timer);
      finish(() => {
        if (code !== 0) return reject(new Error(`expert-system exited ${code}: ${stderr}`));
        try { resolve(JSON.parse(stdout) as ExpertOutput); }
        catch { reject(new Error("expert-system produced invalid JSON")); }
      });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      finish(() => reject(err));
    });
  });
}

// ── Ingestion scan coalescer ────────────────────────────────────────────────
// Prevents parallel ingestions from spawning concurrent C++ processes that
// would race on the legacy strategy-shaped concept-tag row. While one scan is in
// flight, additional callers receive the same in-flight promise. If one or
// more callers arrive *during* a synthesis, exactly one follow-up run is
// scheduled afterwards so that the latest knowledge is always reflected.

let inFlight: Promise<{ output: ExpertOutput; strategyId: number } | null> | null = null;
let pendingFollowup = false;

/**
 * Legacy function name retained for route compatibility. Scans text chunks
 * from every ready source using the C++ concept tagger. The strategy-shaped
 * database row is not a fused or historically weighted trading strategy.
 */
export async function synthesizeMegaStrategy(): Promise<{
  output: ExpertOutput;
  strategyId: number;
} | null> {
  // Coalesce overlapping synthesis requests
  if (inFlight) {
    pendingFollowup = true;
    return inFlight;
  }
  inFlight = doSynthesizeMegaStrategy()
    .finally(() => {
      inFlight = null;
      if (pendingFollowup) {
        pendingFollowup = false;
        // Fire and forget the follow-up so it picks up any chunks that
        // landed mid-flight.
        synthesizeMegaStrategy().catch((err) =>
          logger.warn({ err: String(err) }, "Follow-up ingestion concept scan failed")
        );
      }
    });
  return inFlight;
}

async function doSynthesizeMegaStrategy(): Promise<{
  output: ExpertOutput;
  strategyId: number;
} | null> {
  // Pull all ready sources and their chunks
  const readySources = await db
    .select()
    .from(educationSourcesTable)
    .where(eq(educationSourcesTable.status, "ready"));

  if (readySources.length === 0) {
    logger.info("Ingestion concept tagger: no ready sources; skipping scan");
    return null;
  }

  const chunks = await db
    .select({ content: knowledgeChunksTable.content })
    .from(knowledgeChunksTable);

  if (chunks.length === 0) {
    logger.info("Ingestion concept tagger: no chunks; skipping scan");
    return null;
  }

  const text = chunks.map((c) => c.content).join("\n\n");

  logger.info(
    { sources: readySources.length, chunks: chunks.length, chars: text.length },
    "Ingestion concept tagger: invoking C++ scanner"
  );
  const output = await runExpertSystem(text, readySources.length);

  // Upsert the legacy row so existing readers can consume tagged concepts.
  const [existing] = await db
    .select()
    .from(strategiesTable)
    .where(and(eq(strategiesTable.name, MEGA_STRATEGY_NAME), eq(strategiesTable.type, "mega")))
    .limit(1);

  const description = `Deterministic C++ keyword-concept scan over ${output.sourcesUsed} knowledge source${output.sourcesUsed === 1 ? "" : "s"}; this is ingestion tagging, not a fused trading strategy.`;

  if (existing) {
    await db
      .update(strategiesTable)
      .set({
        description,
        explanation: output.summary,
        concepts: JSON.stringify(output.concepts),
        rules: JSON.stringify(output.rules),
        sourcesUsed: output.sourcesUsed,
        wordsAnalyzed: output.wordsAnalyzed,
        summary: output.summary,
        synthesizedAt: new Date(),
        active: true,
      })
      .where(eq(strategiesTable.id, existing.id));
    logger.info(
      { id: existing.id, concepts: output.concepts.length, rules: output.rules.length },
      "Ingestion concept tags updated in compatibility row"
    );
    return { output, strategyId: existing.id };
  }

  const [created] = await db
    .insert(strategiesTable)
    .values({
      name: MEGA_STRATEGY_NAME,
      type: "mega",
      description,
      explanation: output.summary,
      concepts: JSON.stringify(output.concepts),
      rules: JSON.stringify(output.rules),
      sourcesUsed: output.sourcesUsed,
      wordsAnalyzed: output.wordsAnalyzed,
      summary: output.summary,
      synthesizedAt: new Date(),
      active: true,
    })
    .returning();
  logger.info(
    { id: created.id, concepts: output.concepts.length, rules: output.rules.length },
    "Ingestion concept tags stored in compatibility row"
  );
  return { output, strategyId: created.id };
}

/** Fetch the persisted mega strategy row (or null). */
export async function getMegaStrategyRow() {
  const [row] = await db
    .select()
    .from(strategiesTable)
    .where(and(eq(strategiesTable.name, MEGA_STRATEGY_NAME), eq(strategiesTable.type, "mega")))
    .limit(1);
  return row ?? null;
}

export const MEGA_STRATEGY_KEY = MEGA_STRATEGY_NAME;
