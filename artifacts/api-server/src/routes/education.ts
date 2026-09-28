import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import { db, educationSourcesTable } from "@workspace/db";
import {
  CreateEducationSourceBody,
  UpdateEducationSourceBody,
  UpdateEducationSourceParams,
  DeleteEducationSourceParams,
} from "@workspace/api-zod";
import { ingestSource } from "../lib/ingest.js";

import { mkdirSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, "../../uploads");

// Ensure uploads directory always exists at startup — won't fail if already present
mkdirSync(UPLOADS_DIR, { recursive: true });

const MIME_TYPES_BY_EXTENSION: Record<string, Set<string>> = {
  ".pdf": new Set(["application/pdf"]),
  ".epub": new Set(["application/epub+zip", "application/zip"]),
  ".jpg": new Set(["image/jpeg", "image/jpg"]),
  ".jpeg": new Set(["image/jpeg", "image/jpg"]),
  ".png": new Set(["image/png"]),
  ".webp": new Set(["image/webp"]),
  ".gif": new Set(["image/gif"]),
  ".bmp": new Set(["image/bmp"]),
  ".tif": new Set(["image/tiff"]),
  ".tiff": new Set(["image/tiff"]),
};
const ACCEPTED_EXTENSIONS = new Set(Object.keys(MIME_TYPES_BY_EXTENSION));
const GENERIC_MIME_TYPES = new Set(["application/octet-stream"]);

function fileExtension(originalname: string): string {
  return path.extname(originalname).toLowerCase() || ".bin";
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const id = (req.params as any).id;
    cb(null, `${id}${fileExtension(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
  fileFilter: (_req, file, cb) => {
    const ext = fileExtension(file.originalname);
    const expectedMimes = MIME_TYPES_BY_EXTENSION[ext];
    if (!expectedMimes) {
      cb(new Error("Unsupported file format. Accepted formats: PDF, EPUB, JPG, PNG, WEBP, GIF, BMP, TIFF."));
    } else if (expectedMimes.has(file.mimetype.toLowerCase()) || GENERIC_MIME_TYPES.has(file.mimetype.toLowerCase())) {
      cb(null, true);
    } else {
      cb(new Error(`File extension ${ext} does not match its content type (${file.mimetype}).`));
    }
  },
});

const uploadSingleFile = upload.single("file");

const router: IRouter = Router();

router.get("/education/sources", async (_req, res): Promise<void> => {
  const sources = await db
    .select()
    .from(educationSourcesTable)
    .orderBy(educationSourcesTable.createdAt);
  res.json(sources);
});

router.post("/education/sources", async (req, res): Promise<void> => {
  const parsed = CreateEducationSourceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [created] = await db
    .insert(educationSourcesTable)
    .values({ ...parsed.data, status: "pending" })
    .returning();

  // Only kick off ingestion if actual content was provided at creation time.
  // If the user is uploading a file, ingestion is triggered by the file upload
  // endpoint instead — calling it here before the file arrives always fails.
  if (parsed.data.sourceUrl || parsed.data.contentText) {
    ingestSource(created.id).catch(() => {});
  }

  res.status(201).json(created);
});

// File upload endpoint — must be registered BEFORE the /:id param route
router.post(
  "/education/sources/:id/file",
  (req, res, next) => {
    uploadSingleFile(req, res, (err) => {
      if (err) {
        const status = err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
        res.status(status).json({ error: err.message });
        return;
      }
      next();
    });
  },
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid source ID" });
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    const filePath = req.file.path;

    // Store the file path in the source's metadata field and reset to pending
    const [source] = await db
      .select()
      .from(educationSourcesTable)
      .where(eq(educationSourcesTable.id, id));

    if (!source) {
      res.status(404).json({ error: "Source not found" });
      return;
    }

    const existingMeta = source.metadata ? (() => { try { return JSON.parse(source.metadata!); } catch { return {}; } })() : {};
    const newMeta = JSON.stringify({ ...existingMeta, filePath });

    await db
      .update(educationSourcesTable)
      .set({ metadata: newMeta, status: "pending", errorMessage: null })
      .where(eq(educationSourcesTable.id, id));

    // Trigger ingestion in the background
    ingestSource(id).catch(() => {});

    res.json({ ok: true });
  }
);

// Manually trigger or retry ingestion for a persisted source. Ready sources
// are idempotent no-ops; processing sources are never started a second time.
router.post("/education/sources/:id/ingest", async (req, res): Promise<void> => {
  const params = UpdateEducationSourceParams.safeParse(req.params);
  if (!params.success || params.data.id < 1 || !Number.isSafeInteger(params.data.id)) {
    res.status(400).json({ ok: false, error: params.success ? "Invalid source ID" : params.error.message });
    return;
  }
  const sourceId = params.data.id;
  const [source] = await db.select().from(educationSourcesTable)
    .where(eq(educationSourcesTable.id, sourceId));
  if (!source) {
    res.status(404).json({ ok: false, sourceId, error: "Education source not found" });
    return;
  }
  if (source.status === "ready") {
    res.json({
      ok: true,
      sourceId,
      status: "ready",
      message: "Source is already ingested; no duplicate ingestion was started.",
    });
    return;
  }
  if (source.status === "processing") {
    res.status(409).json({
      ok: false,
      sourceId,
      status: "processing",
      error: "Source ingestion is already processing; no duplicate ingestion was started.",
    });
    return;
  }

  // A source in error is deliberately retryable. ingestSource atomically
  // claims pending/error state, de-duplicates chunk content, and persists any
  // extraction failure back to errorMessage.
  try {
    await ingestSource(sourceId);
    const [current] = await db.select({
      status: educationSourcesTable.status,
      errorMessage: educationSourcesTable.errorMessage,
    }).from(educationSourcesTable).where(eq(educationSourcesTable.id, sourceId));
    if (!current) {
      res.status(404).json({ ok: false, sourceId, error: "Education source no longer exists" });
      return;
    }
    if (current.status === "processing") {
      res.status(409).json({
        ok: false,
        sourceId,
        status: "processing",
        error: "Another ingestion process claimed this source; no duplicate ingestion was started.",
      });
      return;
    }
    if (current.status === "error") {
      res.status(500).json({
        ok: false,
        sourceId,
        status: "error",
        error: current.errorMessage ?? "Ingestion failed without an error message.",
      });
      return;
    }
    res.json({
      ok: true,
      sourceId,
      status: current.status,
      message: source.status === "error" ? "Previous ingestion error was retried successfully." : "Ingestion completed.",
    });
  } catch (err: unknown) {
    res.status(500).json({
      ok: false,
      sourceId,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

router.patch("/education/sources/:id", async (req, res): Promise<void> => {
  const params = UpdateEducationSourceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateEducationSourceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [updated] = await db
    .update(educationSourcesTable)
    .set(parsed.data)
    .where(eq(educationSourcesTable.id, params.data.id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(updated);
});

router.delete("/education/sources/:id", async (req, res): Promise<void> => {
  const params = DeleteEducationSourceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const result = await db
    .delete(educationSourcesTable)
    .where(eq(educationSourcesTable.id, params.data.id))
    .returning();
  if (result.length === 0) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(204).send();
});

export default router;
