/**
 * A textbook, and the pieces of it that can be quoted back with a citation.
 *
 * This replaces `StoredTextbook` / `TextbookChunk` in `services/storage/types`,
 * which had no callers anywhere in the repository. Two things were wrong with
 * that model rather than merely missing from it: it was scoped per learner
 * (`userId`), where a source library is shared admin content, and a chunk could
 * record only a page number and a section title — which is not enough to point
 * at the passage a sentence came from, and not enough to re-run a better
 * extractor over the same book later and know what changed.
 *
 * Everything here exists to make one guarantee possible: any text this system
 * later builds a question from can be traced to the file it came from, the page
 * it was on, and the exact characters within the extraction.
 */

/** The formats the pipeline really extracts. Nothing else is accepted. */
export type SourceFileKind = 'pdf' | 'docx' | 'html' | 'text';

/**
 * Where a source is in its ingestion.
 *
 * `ready` is set once, at the end, and only when chunks were written. A job
 * that fails at any earlier step lands on `failed` with the reason — the state
 * a half-ingested book must never be able to reach is `ready`.
 */
export type IngestionStatus = 'uploaded' | 'extracting' | 'chunking' | 'ready' | 'failed';

/** Where a chunk came from, in the source's own terms. */
export interface SourceLocation {
  /**
   * The printed page, when the format carries one. PDFs do; DOCX, HTML and
   * plain text do not, and this is left undefined rather than guessed — an
   * invented page number is worse than none, because it looks checkable.
   */
  page?: number;
  /** The chapter heading this chunk sits under, if the document had one. */
  chapter?: string;
  /** The nearest heading, which may be the chapter itself. */
  section?: string;
  /** Every heading from the document root down to this chunk. */
  path: string[];
  /** Character offsets into the extracted text, so the exact span is recoverable. */
  charStart: number;
  charEnd: number;
}

export interface SourceChunk {
  id: string;
  sourceId: string;
  /** Position in the book, in reading order. Stable across re-ingestion. */
  ordinal: number;
  /** The heading this chunk belongs to, repeated here for display. */
  heading?: string;
  /** Depth of that heading: 1 for a chapter, 2 for a subsection, and so on. */
  level: number;
  location: SourceLocation;
  text: string;
  wordCount: number;
  /** Which extractor produced the text, and which chunker cut it. */
  extractorVersion: string;
  chunkerVersion: string;
  /** sha256 of the text, so an unchanged chunk is recognisable after a re-run. */
  contentHash: string;
}

export interface IngestionWarning {
  code:
    | 'no_headings_found'
    | 'empty_page'
    | 'unreadable_region'
    | 'oversized_block'
    | 'encoding_replaced'
    | 'no_text_extracted';
  message: string;
  page?: number;
}

export interface SourceStats {
  /** Pages the extractor saw, for formats that have pages. */
  pages?: number;
  characters: number;
  chunks: number;
  headings: number;
}

export interface StoredSource {
  id: string;
  title: string;
  author?: string;
  description?: string;
  /** The name of the uploaded file, as given. */
  filename: string;
  mimeType: string;
  fileKind: SourceFileKind;
  /**
   * The untouched original. Never rewritten, so a better extractor can be run
   * over the same bytes later and the result compared with this one.
   */
  sourceAssetId: string;
  /** The normalized text, stored so re-chunking does not need re-extraction. */
  extractedTextAssetId?: string;
  status: IngestionStatus;
  /** Why the job failed. Present only when `status` is `failed`. */
  error?: string;
  warnings: IngestionWarning[];
  stats: SourceStats;
  extractorVersion: string;
  chunkerVersion: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** The list view: everything but the parts that only matter when reading it. */
export type StoredSourceSummary = Omit<StoredSource, 'warnings'> & {
  warningCount: number;
};
