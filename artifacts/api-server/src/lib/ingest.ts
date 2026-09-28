/**
 * Knowledge ingestion pipeline.
 * Picks up "pending" education sources, extracts text, chunks it in TypeScript,
 * stores knowledge_chunks, and marks the source "ready".
 *
 * Parsing/chunking stays in this Node pipeline; the separate C++ executable
 * performs deterministic ingestion concept tagging after chunks are stored.
 */
import { and, eq } from "drizzle-orm";
import path from "path";
import { inflateRawSync } from "node:zlib";
import { db, educationSourcesTable, knowledgeChunksTable } from "@workspace/db";
import { getOpenAI } from "./ai-client.js";
import { logger } from "./logger.js";

// ── YouTube transcript ──────────────────────────────────────────────────────

async function fetchYouTubeTranscript(url: string): Promise<string> {
  const { YoutubeTranscript } = await import("youtube-transcript");
  const videoIdMatch = url.match(
    /(?:v=|youtu\.be\/|\/embed\/|\/shorts\/)([A-Za-z0-9_-]{11})/
  );
  if (!videoIdMatch) throw new Error(`Cannot extract video ID from URL: ${url}`);
  const videoId = videoIdMatch[1];
  const segments = await YoutubeTranscript.fetchTranscript(videoId);
  return segments.map((s) => s.text).join(" ");
}

// ── PDF text extraction ─────────────────────────────────────────────────────

// pdfjs-dist (used internally by pdf-parse) calls DOMMatrix which only exists
// in browsers. Polyfill a minimal stub so Node.js doesn't throw.
if (typeof (globalThis as any).DOMMatrix === "undefined") {
  (globalThis as any).DOMMatrix = class DOMMatrix {
    a=1;b=0;c=0;d=1;e=0;f=0;
    m11=1;m12=0;m13=0;m14=0;
    m21=0;m22=1;m23=0;m24=0;
    m31=0;m32=0;m33=1;m34=0;
    m41=0;m42=0;m43=0;m44=1;
    is2D=true;isIdentity=true;
    constructor(_init?: string | number[]) {}
    static fromMatrix(m?: any) { return new (globalThis as any).DOMMatrix(); }
    static fromFloat32Array(a: Float32Array) { return new (globalThis as any).DOMMatrix(Array.from(a)); }
    static fromFloat64Array(a: Float64Array) { return new (globalThis as any).DOMMatrix(Array.from(a)); }
    multiply(m?: any) { return this; }
    translate(tx=0, ty=0, tz=0) { return this; }
    scale(sx=1, sy=sx, sz=1, ox=0, oy=0, oz=0) { return this; }
    rotate(rx=0, ry=0, rz=0) { return this; }
    inverse() { return this; }
    transformPoint(p?: any) { return p ?? { x:0, y:0, z:0, w:1 }; }
    toFloat32Array() { return new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]); }
    toFloat64Array() { return new Float64Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]); }
  };
}

export interface PdfCoverage { pagesTotal: number; textPages: number; emptyPages: number; coveragePct: number }
const MIN_PAGE_CHARS = 200;

async function extractPdfText(buffer: Buffer, coverage?: PdfCoverage): Promise<string> {
  // Use pdfjs-dist legacy build directly in Node.js.
  // import.meta.resolve finds the worker module URL from the pnpm store at
  // runtime (pdfjs-dist is external — not bundled — so this always works).
  const { fileURLToPath } = await import("node:url");
  const workerPath = fileURLToPath(
    import.meta.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")
  );

  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  (pdfjsLib as any).GlobalWorkerOptions.workerSrc = workerPath;

  const uint8Array = new Uint8Array(buffer);
  const loadingTask = (pdfjsLib as any).getDocument({
    data: uint8Array,
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
    verbosity: 0,
  });
  const pdf = await loadingTask.promise;

  let text = "";
  let textPages = 0;
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const pageText = content.items.map((item: any) => item.str ?? "").join(" ");
    if (pageText.trim().length >= MIN_PAGE_CHARS) textPages++;
    text += pageText + "\n";
  }
  if (coverage) {
    coverage.pagesTotal = pdf.numPages;
    coverage.textPages = textPages;
    coverage.emptyPages = pdf.numPages - textPages;
    coverage.coveragePct = pdf.numPages > 0 ? Math.round((textPages / pdf.numPages) * 1000) / 10 : 0;
  }
  if (text.trim().length < 10) {
    throw new Error("PDF contains no extractable text; it may be scanned or image-only. PDF OCR is not available in this pipeline—upload readable page images instead.");
  }
  return text;
}

// ── EPUB text extraction ────────────────────────────────────────────────────

function decodeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#([0-9]+);/g, (_m, n: string) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function readZipEntries(buffer: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("EPUB is not a valid ZIP container.");
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error("EPUB ZIP directory is malformed.");
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (flags & 1) throw new Error("Encrypted EPUB files are not supported.");
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`EPUB entry ${name} is malformed.`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(start, start + compressedSize);
    if (method === 0) entries.set(name, Buffer.from(compressed));
    else if (method === 8) entries.set(name, inflateRawSync(compressed));
    else throw new Error(`EPUB compression method ${method} is unsupported.`);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function extractEpubText(buffer: Buffer): string {
  const entries = readZipEntries(buffer);
  const container = entries.get("META-INF/container.xml")?.toString("utf8");
  const packagePath = container?.match(/<rootfile\b[^>]*\bfull-path=["']([^"']+)["']/i)?.[1];
  if (!packagePath) throw new Error("EPUB is missing META-INF/container.xml package metadata.");
  const packageXml = entries.get(decodeURIComponent(packagePath))?.toString("utf8");
  if (!packageXml) throw new Error(`EPUB package document ${packagePath} was not found.`);
  const basePath = packagePath.includes("/") ? packagePath.slice(0, packagePath.lastIndexOf("/") + 1) : "";
  const manifest = new Map<string, string>();
  for (const match of packageXml.matchAll(/<item\b([^>]+)>?/gi)) {
    const attrs = match[1];
    const id = attrs.match(/\bid=["']([^"']+)["']/i)?.[1];
    const href = attrs.match(/\bhref=["']([^"']+)["']/i)?.[1];
    if (id && href) manifest.set(id, basePath + decodeURIComponent(href));
  }
  const spineIds = [...packageXml.matchAll(/<itemref\b[^>]*\bidref=["']([^"']+)["']/gi)]
    .map((match) => match[1]);
  const html: string[] = [];
  for (const id of spineIds) {
    const file = manifest.get(id);
    const content = file ? entries.get(file)?.toString("utf8") : undefined;
    if (!content) continue;
    html.push(decodeXml(content
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/(p|div|h[1-6]|li|br|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")));
  }
  const text = html.join("\n").replace(/[ \t]+/g, " ").replace(/\n\s+/g, "\n").trim();
  if (!text) throw new Error("EPUB contains no readable text in its spine documents.");
  return text;
}

// ── Image OCR via GPT-4 Vision ───────────────────────────────────────────────

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff"]);

function isImageFile(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function extractImageText(buffer: Buffer, filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png", ".webp": "image/webp",
    ".gif": "image/gif", ".bmp": "image/bmp",
    ".tif": "image/tiff", ".tiff": "image/tiff",
  };
  const mime = mimeMap[ext] ?? "image/jpeg";
  const base64 = buffer.toString("base64");

  logger.info({ filePath, mime }, "Running GPT-4 Vision OCR on uploaded image");

  const response = await getOpenAI().chat.completions.create({
    model: "gpt-4o",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `You are a professional trading book transcriber and ICT/SMC analyst.
This image is a page (or photo of a page) from a trading book, course material, or handwritten notes.

Your task:
1. Transcribe ALL visible text EXACTLY as written — every sentence, label, caption, diagram annotation.
2. For any diagram, chart or drawing you see: describe it in plain text, naming every concept it illustrates (liquidity zones, fair value gaps, order blocks, market structure, kill zones, premium/discount arrays, etc.).
3. Preserve any numbered lists, bullet points, or section headings.
4. Do NOT summarise or skip anything — completeness is critical because this text feeds a trading AI.

Output: raw transcribed text only, no commentary, no markdown formatting.`,
          },
          {
            type: "image_url",
            image_url: { url: `data:${mime};base64,${base64}`, detail: "high" },
          },
        ],
      },
    ],
  });

  const text = response.choices[0]?.message?.content ?? "";
  if (!text.trim()) throw new Error("GPT Vision returned empty transcription for the image.");
  return text;
}

// ── Word-overlap chunker ────────────────────────────────────────────────────

function chunkText(
  text: string,
  chunkSize = 500,
  overlap = 50,
): { index: number; wordCount: number; content: string }[] {
  if (!Number.isInteger(chunkSize) || chunkSize < 10 ||
      !Number.isInteger(overlap) || overlap < 0 || overlap >= chunkSize) {
    throw new Error("Invalid knowledge chunk size or overlap");
  }
  const words = (text.match(/\S+/gu) ?? [])
    .map((word) => word.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, ""))
    .filter(Boolean);
  const chunks: { index: number; wordCount: number; content: string }[] = [];
  for (let offset = 0; offset < words.length; offset += chunkSize - overlap) {
    const part = words.slice(offset, offset + chunkSize);
    chunks.push({ index: chunks.length, wordCount: part.length, content: part.join(" ") });
  }
  return chunks;
}

// ── Main processor ──────────────────────────────────────────────────────────

const sourceIngestions = new Map<number, Promise<void>>();

export function ingestSource(sourceId: number): Promise<void> {
  const existing = sourceIngestions.get(sourceId);
  if (existing) return existing;
  const ingestion = runSourceIngestion(sourceId).finally(() => {
    if (sourceIngestions.get(sourceId) === ingestion) sourceIngestions.delete(sourceId);
  });
  sourceIngestions.set(sourceId, ingestion);
  return ingestion;
}

async function runSourceIngestion(sourceId: number): Promise<void> {
  const [source] = await db
    .select()
    .from(educationSourcesTable)
    .where(eq(educationSourcesTable.id, sourceId));

  if (!source) throw new Error(`Source ${sourceId} not found`);
  if (source.status === "ready") {
    logger.info({ sourceId }, "Source already ready, skipping");
    return;
  }
  if (source.status === "processing") {
    logger.info({ sourceId }, "Source already processing, skipping duplicate ingestion");
    return;
  }
  if (source.status !== "pending" && source.status !== "error") {
    throw new Error(`Source ${sourceId} cannot be ingested from status ${source.status}`);
  }

  // Compare-and-set prevents another process or route from starting a second
  // ingestion after it has observed the same pending/error source.
  const [claimed] = await db
    .update(educationSourcesTable)
    .set({ status: "processing", errorMessage: null })
    .where(and(
      eq(educationSourcesTable.id, sourceId),
      eq(educationSourcesTable.status, source.status),
    ))
    .returning({ id: educationSourcesTable.id });
  if (!claimed) {
    const [current] = await db.select({ status: educationSourcesTable.status })
      .from(educationSourcesTable).where(eq(educationSourcesTable.id, sourceId));
    if (current?.status === "ready" || current?.status === "processing") return;
    throw new Error(`Source ${sourceId} changed state before ingestion could start.`);
  }

  try {
    let text = "";
    const pdfCoverage: PdfCoverage = { pagesTotal: 0, textPages: 0, emptyPages: 0, coveragePct: 100 };
    let preview = "";

    if (source.kind === "video" || source.kind === "playlist") {
      if (!source.sourceUrl) throw new Error("No URL provided for video source");
      logger.info({ sourceId, url: source.sourceUrl }, "Fetching YouTube transcript");
      text = await fetchYouTubeTranscript(source.sourceUrl);
      preview = text.slice(0, 300);
    } else if (source.kind === "text" || source.kind === "book") {
      // Check for uploaded PDF file path stored in metadata
      let uploadedFilePath: string | null = null;
      if (source.metadata) {
        try {
          const meta = JSON.parse(source.metadata);
          uploadedFilePath = meta?.filePath ?? null;
        } catch {}
      }

      if (uploadedFilePath) {
        const fs = await import("fs/promises");
        const buffer = await fs.readFile(uploadedFilePath);
        if (isImageFile(uploadedFilePath)) {
          logger.info({ sourceId, filePath: uploadedFilePath }, "Reading uploaded image — running GPT Vision OCR");
          text = await extractImageText(buffer, uploadedFilePath);
        } else if (path.extname(uploadedFilePath).toLowerCase() === ".pdf") {
          logger.info({ sourceId, filePath: uploadedFilePath }, "Extracting uploaded PDF text");
          text = await extractPdfText(buffer, pdfCoverage);
        } else if (path.extname(uploadedFilePath).toLowerCase() === ".epub") {
          logger.info({ sourceId, filePath: uploadedFilePath }, "Extracting uploaded EPUB text");
          text = extractEpubText(buffer);
        } else {
          const ext = path.extname(uploadedFilePath) || "(no extension)";
          throw new Error(`Unsupported upload format ${ext}. Supported formats: PDF, EPUB, JPG, PNG, WEBP, GIF, BMP, TIF, TIFF.`);
        }
      } else if (source.contentText && source.contentText.trim().length > 0) {
        text = source.contentText;
      } else if (source.sourceUrl) {
        if (/youtu/.test(source.sourceUrl)) {
          text = await fetchYouTubeTranscript(source.sourceUrl);
        } else {
          // Accept only explicit supported remote document formats.
          const remotePath = new URL(source.sourceUrl).pathname.toLowerCase();
          if (!remotePath.endsWith(".pdf") && !remotePath.endsWith(".epub")) {
            throw new Error("Unsupported remote source format. Provide a direct PDF or EPUB URL, or a YouTube URL.");
          }
          const https = await import("https");
          const http = await import("http");
          const url = source.sourceUrl;
          const pdfBuffer = await new Promise<Buffer>((resolve, reject) => {
            const client = url.startsWith("https") ? https : http;
            (client as any).get(url, (resp: any) => {
              const chunks: Buffer[] = [];
              resp.on("data", (d: Buffer) => chunks.push(d));
              resp.on("end", () => resolve(Buffer.concat(chunks)));
              resp.on("error", reject);
            }).on("error", reject);
          });
          text = remotePath.endsWith(".epub") ? extractEpubText(pdfBuffer) : await extractPdfText(pdfBuffer, pdfCoverage);
        }
      } else {
        throw new Error("No content, file, or URL provided.");
      }
      preview = text.slice(0, 300);
    } else {
      throw new Error(`Unknown kind: ${source.kind}`);
    }

    if (text.trim().length < 10) {
      throw new Error("Extracted text is too short — check the source.");
    }

    const isPartial = pdfCoverage.pagesTotal > 0 && pdfCoverage.coveragePct < 90;
    const chunks = chunkText(text, 500, 50);
    logger.info({ sourceId, chunkCount: chunks.length }, "Chunking complete");

    // Preserve existing knowledge rows. Re-ingestion only appends a new
    // extraction when it differs, rather than deleting previously indexed
    // material; completed sources are already idempotently skipped above.
    const existingChunks = await db.select().from(knowledgeChunksTable)
      .where(eq(knowledgeChunksTable.sourceId, sourceId));
    const existingContent = new Set(existingChunks.map((stored) => stored.content));
    const chunksToAdd = chunks.filter((chunk) => {
      if (existingContent.has(chunk.content)) return false;
      existingContent.add(chunk.content);
      return true;
    });
    let addedChunks = 0;
    if (chunksToAdd.length > 0) {
      const firstIndex = existingChunks.reduce((max, chunk) => Math.max(max, chunk.chunkIndex), -1) + 1;
      await db.insert(knowledgeChunksTable).values(chunksToAdd.map((c, offset) => ({
        sourceId,
        chunkIndex: firstIndex + offset,
        content: c.content,
        wordCount: c.wordCount,
      })));
      addedChunks = chunksToAdd.length;
    }
    const totalChunks = existingChunks.length + addedChunks;

    await db
      .update(educationSourcesTable)
      .set({
        status: isPartial ? "partial" : "ready",
        metadata: pdfCoverage.pagesTotal > 0 ? JSON.stringify({ coverage: pdfCoverage, ocr: "not available: image-only pages are NOT in the knowledge store" }) : undefined,
        chunksCount: totalChunks,
        vectorCount: totalChunks,
        transcriptPreview: preview || null,
        errorMessage: isPartial ? `Partial: only ${pdfCoverage.textPages} of ${pdfCoverage.pagesTotal} pages had extractable text (${pdfCoverage.coveragePct}%). Image-only pages were not ingested.` : null,
      })
      .where(eq(educationSourcesTable.id, sourceId));

    logger.info({ sourceId, chunksAdded: addedChunks, totalChunks }, "Source ingested successfully");

    // Run the C++ concept tagger over all persisted ingested chunks.
    try {
      const { synthesizeMegaStrategy } = await import("./expert-system.js");
      await synthesizeMegaStrategy();
    } catch (synthErr: unknown) {
      const m = synthErr instanceof Error ? synthErr.message : String(synthErr);
      logger.warn({ sourceId, err: m }, "Ingestion concept scan failed (non-fatal)");
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ sourceId, err: msg }, "Ingestion failed");
    await db
      .update(educationSourcesTable)
      .set({ status: "error", errorMessage: msg })
      .where(eq(educationSourcesTable.id, sourceId));
    throw err;
  }
}

// ── Background sweep: process all pending sources ───────────────────────────

export async function processPendingSources(): Promise<void> {
  const pending = await db
    .select()
    .from(educationSourcesTable)
    .where(eq(educationSourcesTable.status, "pending"));

  if (pending.length === 0) return;

  logger.info({ count: pending.length }, "Processing pending education sources");
  for (const src of pending) {
    try {
      await ingestSource(src.id);
    } catch {
      // individual errors already logged and stored; continue with others
    }
  }
}
