import path from 'node:path';
import type { IngestionWarning, StoredSource } from '../../types/source';
import { assetStore } from '../assetStore';
import { sourceStore } from '../sourceStore';
import { ExtractionError, extractSource, fileKindFor } from './extract';
import { CHUNK_SEPARATOR, chunkDocument, extractedTextOf } from './chunk';
import { CHUNKER_VERSION, EXTRACTOR_VERSION } from './version';

/**
 * The ingestion job:
 *
 *   upload → preserve original → extract → normalize → structure → chunk →
 *   index → ready
 *
 * Two properties are load-bearing.
 *
 * The original bytes are stored *before* anything is attempted with them, and
 * are never rewritten. Every later step reads from that asset, so a better
 * extractor can be run over the same book next month and the two results
 * compared — which is impossible once the upload has been consumed.
 *
 * And `ready` is written exactly once, at the end, after the chunks are on
 * disk. Every failure path writes `failed` with the reason. There is no
 * ordering of steps here that leaves a source claiming to be ready with no
 * chunks behind it, because "ready" is the promise that a search over this book
 * will return the book.
 */

export interface IngestInput {
  filename: string;
  buffer: Buffer;
  mimeType: string;
  title?: string;
  author?: string;
  description?: string;
  createdBy: string;
}

export class UnsupportedSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedSourceError';
  }
}

const now = () => new Date().toISOString();

/**
 * Runs a source through the pipeline and returns the record it ended on.
 *
 * A caller does not need to check for a thrown error to know what happened:
 * a failed job comes back as a stored source with `status: 'failed'` and an
 * `error`, because a job that fails still has an original file worth keeping
 * and a reason worth showing. Only a rejected *upload* — a format this
 * pipeline does not read — throws, and nothing is stored for it.
 */
export async function ingestSource(input: IngestInput): Promise<StoredSource> {
  const extension = path.extname(input.filename).toLowerCase();
  const kind = fileKindFor(extension);
  if (!kind) {
    throw new UnsupportedSourceError(
      `${extension || 'This file type'} is not a format this pipeline can read. Supported: .pdf, .docx, .html, .htm, .txt, .md.`,
    );
  }
  if (!input.buffer?.length) throw new UnsupportedSourceError('The file is empty.');

  // Step 1 — the original, before anything else can go wrong with it.
  const original = await assetStore.create({
    originalName: input.filename,
    content: input.buffer,
    mimeType: input.mimeType,
    kind: kind === 'html' ? 'html' : 'document',
    createdBy: input.createdBy,
    sourceType: 'upload',
  });

  const id = sourceStore.newId();
  const base: StoredSource = {
    id,
    title: (input.title || '').trim() || input.filename.replace(/\.[^.]+$/, ''),
    author: input.author?.trim() || undefined,
    description: input.description?.trim() || undefined,
    filename: input.filename,
    mimeType: input.mimeType,
    fileKind: kind,
    sourceAssetId: original.id,
    status: 'uploaded',
    warnings: [],
    stats: { characters: 0, chunks: 0, headings: 0 },
    extractorVersion: EXTRACTOR_VERSION,
    chunkerVersion: CHUNKER_VERSION,
    createdBy: input.createdBy,
    createdAt: now(),
    updatedAt: now(),
  };
  await sourceStore.save(base);

  const fail = async (message: string, warnings: IngestionWarning[] = []): Promise<StoredSource> => {
    const failed: StoredSource = {
      ...base,
      status: 'failed',
      error: message,
      warnings,
      updatedAt: now(),
    };
    await sourceStore.save(failed);
    // Chunks are cleared rather than left from an earlier run: a failed source
    // must not be searchable through a stale index.
    await sourceStore.saveChunks(id, []);
    return failed;
  };

  // Step 2 — extract and normalize.
  await sourceStore.save({ ...base, status: 'extracting', updatedAt: now() });
  let document;
  try {
    document = await extractSource(kind, input.buffer);
  } catch (error) {
    if (error instanceof ExtractionError) return fail(error.message);
    console.error('[SourceIngest] extraction failed:', error);
    return fail('The file could not be read.');
  }

  // Step 3 — structure and chunk.
  await sourceStore.save({ ...base, status: 'chunking', updatedAt: now() });
  const warnings = [...document.warnings];
  let result;
  try {
    result = chunkDocument(id, document);
  } catch (error) {
    console.error('[SourceIngest] chunking failed:', error);
    return fail('The document could not be divided into passages.', warnings);
  }

  if (result.chunks.length === 0) {
    return fail(
      'The file was read but produced no passages, so there is nothing to search.',
      warnings,
    );
  }

  if (result.oversized > 0) {
    warnings.push({
      code: 'oversized_block',
      message: `${result.oversized} passage${result.oversized === 1 ? '' : 's'} exceeded the size limit and ${result.oversized === 1 ? 'was' : 'were'} kept whole rather than cut mid-paragraph.`,
    });
  }

  // Step 4 — store the chunks, and the extracted text the offsets refer to.
  const extractedText = extractedTextOf(result.chunks);
  const textAsset = await assetStore.create({
    originalName: `${input.filename}.extracted.txt`,
    content: Buffer.from(extractedText, 'utf8'),
    mimeType: 'text/plain',
    kind: 'document',
    createdBy: input.createdBy,
    sourceType: 'derived',
    derivedFromAssetId: original.id,
  });

  try {
    await sourceStore.saveChunks(id, result.chunks);
  } catch (error) {
    console.error('[SourceIngest] chunk write failed:', error);
    return fail('The passages could not be stored.', warnings);
  }

  // Step 5 — and only now is it ready.
  const ready: StoredSource = {
    ...base,
    extractedTextAssetId: textAsset.id,
    status: 'ready',
    warnings,
    stats: {
      pages: document.pageCount,
      characters: result.characters,
      chunks: result.chunks.length,
      headings: result.headings,
    },
    updatedAt: now(),
  };
  await sourceStore.save(ready);

  // Both assets are referenced by a stored source now, so they must not be
  // reaped as unreferenced staged uploads.
  try {
    await assetStore.promote([original.id, textAsset.id]);
  } catch (error) {
    console.error('[SourceIngest] asset promotion failed:', error);
  }

  return ready;
}

/** The separator the stored extracted text uses, for callers verifying offsets. */
export { CHUNK_SEPARATOR };
