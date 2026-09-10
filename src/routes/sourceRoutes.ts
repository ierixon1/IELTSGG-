import express, { Response } from 'express';
import multer from 'multer';
import path from 'node:path';
import { sourceStore } from '../services/sourceStore';
import { assetStore } from '../services/assetStore';
import { ingestSource, UnsupportedSourceError } from '../services/sourceIngest/ingest';
import { SUPPORTED_EXTENSIONS, fileKindFor } from '../services/sourceIngest/extract';
import { retrieve } from '../services/sourceIngest/retrieve';
import { validateUpload } from '../services/fileTypeSniffer';

/**
 * The source library: ingest a book, see what came of it, search inside it.
 *
 * Mounted under the admin router, so every route here already has an
 * authenticated admin behind it. Nothing in this file is reachable by a
 * learner: a textbook is licensed material and its extracted text is the whole
 * book in plain form.
 *
 * There is no generation endpoint, deliberately. This phase stops at "the book
 * is searchable and every passage can be traced back"; what reads those
 * passages comes later.
 *
 * Paths here are relative: the router is mounted at `/api/admin/sources` with
 * the auth and role guards attached to the mount, rather than being registered
 * openly and guarded per route. Mounting it without a path would run those
 * guards for every admin request that passed through, including the deliberately
 * anonymous `/public/*` routes.
 */
export const sourceRouter = express.Router();

type AdminRequest = express.Request & {
  adminUser?: { id: string; username: string; displayName: string; role: string };
};

const upload = multer({
  storage: multer.memoryStorage(),
  // A textbook is legitimately large; a 5MB cap would reject most of them.
  limits: { fileSize: 60 * 1024 * 1024, files: 1 },
});

const SUPPORTED = Object.keys(SUPPORTED_EXTENSIONS).sort();

function notFound(res: Response) {
  return res.status(404).json({ error: 'Source not found.' });
}

/** What the pipeline accepts, so the UI does not have to guess. */
sourceRouter.get('/supported', (_req, res) =>
  res.json({ extensions: SUPPORTED }),
);

sourceRouter.get('/', async (_req, res) => {
  try {
    return res.json({ items: await sourceStore.list() });
  } catch (error) {
    console.error('[Sources] list failed:', error);
    return res.status(500).json({ error: 'Unable to list sources.' });
  }
});

sourceRouter.get('/:id', async (req, res) => {
  try {
    const source = await sourceStore.get(req.params.id);
    return source ? res.json({ item: source }) : notFound(res);
  } catch {
    return notFound(res);
  }
});

/**
 * Uploads a book and runs it through the pipeline.
 *
 * Ingestion is awaited rather than queued. It is measured in seconds for a
 * real textbook, and a background job would need somewhere durable to record
 * failures — which, until there is a queue worth the name, means a source
 * sitting on `extracting` forever with nothing to explain it.
 */
sourceRouter.post('/', upload.single('file'), async (req: AdminRequest, res) => {
  const file = (req as unknown as { file?: { originalname: string; mimetype?: string; buffer: Buffer } })
    .file;
  if (!file?.buffer?.length) return res.status(400).json({ error: 'No file was uploaded.' });

  const extension = path.extname(file.originalname).toLowerCase();
  if (!fileKindFor(extension)) {
    return res.status(400).json({
      error: `${extension || 'That file type'} is not supported. Supported: ${SUPPORTED.join(', ')}.`,
      supported: SUPPORTED,
    });
  }

  // The same sniffing every other upload goes through: an extension is a claim,
  // and a .docx that is really an executable must not reach an extractor.
  const sniffExtension = extension === '.md' ? '.txt' : extension;
  const verdict = validateUpload({
    extension: sniffExtension,
    declaredMimeType: extension === '.md' ? 'text/plain' : file.mimetype,
    buffer: file.buffer,
  });
  if (verdict.ok !== true) return res.status(400).json({ error: verdict.error });

  try {
    const source = await ingestSource({
      filename: file.originalname,
      buffer: file.buffer,
      mimeType: verdict.mimeType,
      title: typeof req.body?.title === 'string' ? req.body.title : undefined,
      author: typeof req.body?.author === 'string' ? req.body.author : undefined,
      description: typeof req.body?.description === 'string' ? req.body.description : undefined,
      createdBy: req.adminUser?.id || 'admin',
    });

    // A source that failed is still a 200: the record exists, carries the
    // reason, and is visible in the library. A 500 here would leave the admin
    // with an error toast and a row they cannot explain.
    return res.json({ success: source.status === 'ready', item: source });
  } catch (error) {
    if (error instanceof UnsupportedSourceError) {
      return res.status(400).json({ error: error.message, supported: SUPPORTED });
    }
    console.error('[Sources] ingestion failed:', error);
    return res.status(500).json({ error: 'The source could not be ingested.' });
  }
});

/**
 * The passages of one source: browsed in reading order, or searched.
 *
 * A search always answers with a `retrieval` outcome, including when it found
 * nothing. `status: 'no_match'` and an empty `hits` array are different things
 * from a caller's point of view, and only one of them is a claim about the
 * book.
 */
sourceRouter.get('/:id/chunks', async (req, res) => {
  try {
    const source = await sourceStore.get(req.params.id);
    if (!source) return notFound(res);
    if (source.status !== 'ready') {
      return res.status(409).json({
        error: `This source is "${source.status}", so it has nothing to search yet.`,
        status: source.status,
      });
    }

    const chunks = await sourceStore.getChunks(req.params.id);
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));

    if (!query.trim()) {
      const offset = Math.max(0, Number(req.query.offset) || 0);
      return res.json({
        mode: 'browse',
        total: chunks.length,
        offset,
        items: chunks.slice(offset, offset + limit),
      });
    }

    return res.json({ mode: 'search', total: chunks.length, retrieval: retrieve(chunks, query, { limit }) });
  } catch (error) {
    console.error('[Sources] chunk read failed:', error);
    return res.status(500).json({ error: 'Unable to read the passages.' });
  }
});

/**
 * The exact span a chunk was cut from, read back out of the stored extraction.
 *
 * This is what makes a citation checkable rather than decorative: the offsets
 * are resolved against the stored text, and a mismatch is reported instead of
 * being smoothed over.
 */
sourceRouter.get('/:id/chunks/:chunkId/source', async (req, res) => {
  try {
    const source = await sourceStore.get(req.params.id);
    if (!source) return notFound(res);

    const chunk = (await sourceStore.getChunks(req.params.id)).find(
      (item) => item.id === req.params.chunkId,
    );
    if (!chunk) return res.status(404).json({ error: 'Passage not found.' });
    if (!source.extractedTextAssetId) {
      return res.status(409).json({ error: 'This source has no stored extraction to quote from.' });
    }

    const asset = await assetStore.get(source.extractedTextAssetId);
    if (!asset) return res.status(409).json({ error: 'The stored extraction is no longer available.' });

    const text = (await assetStore.readContent(asset)).toString('utf8');
    const span = text.slice(chunk.location.charStart, chunk.location.charEnd);

    return res.json({
      chunk,
      span,
      matches: span === chunk.text,
      provenance: {
        sourceId: source.id,
        sourceTitle: source.title,
        filename: source.filename,
        sourceAssetId: source.sourceAssetId,
        extractorVersion: chunk.extractorVersion,
        chunkerVersion: chunk.chunkerVersion,
        location: chunk.location,
      },
    });
  } catch (error) {
    console.error('[Sources] source span read failed:', error);
    return res.status(500).json({ error: 'Unable to read the original span.' });
  }
});

sourceRouter.delete('/:id', async (req, res) => {
  try {
    const removed = await sourceStore.delete(req.params.id);
    if (!removed) return notFound(res);
    // The assets it held are released the same way a deleted material's are:
    // anything nothing else references goes back to staged and is reaped later.
    try {
      await assetStore.reconcile();
    } catch (error) {
      console.error('[Sources] reconcile after delete failed:', error);
    }
    return res.json({ success: true });
  } catch (error) {
    console.error('[Sources] delete failed:', error);
    return res.status(500).json({ error: 'Unable to delete the source.' });
  }
});
