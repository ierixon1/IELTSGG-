import type { Question } from '../../types';

/**
 * What the importer reports, alongside what it managed to parse.
 *
 * The shape is deliberately not "a material, or an error". A real CDI export is
 * partly understood: some questions convert cleanly, some are recognisable but
 * missing their answer key, and some are constructs this parser will never
 * support. All three have to survive to the review screen, because the
 * alternative — dropping what is hard and shipping what is easy — is how a test
 * goes out with fourteen of its forty questions quietly missing.
 */

/** How sure the parser is about one question. */
export type ParseStatus =
  /** Structure and answer key both read cleanly. */
  | 'parsed'
  /** Recognised, but something a human has to confirm. */
  | 'needs_review'
  /** A construct this parser does not handle. Never converted to a guess. */
  | 'unsupported';

/** Whether the answer key came from the source, and how certainly. */
export type AnswerStatus =
  /** Found in the source: a data attribute, a marked option, an answer key. */
  | 'extracted'
  /** The source carries nothing that could be an answer. */
  | 'missing'
  /** Something was found but could mean more than one thing. */
  | 'uncertain';

/** Where in the original HTML a parsed thing came from. */
export interface SourceRange {
  /** Byte offsets into the *original* HTML, so the admin can be shown it. */
  start: number;
  end: number;
  /** A short excerpt, for a report that does not want to load the whole file. */
  excerpt: string;
}

export interface ImportDiagnostic {
  /** Machine-readable, so the review screen can group and filter. */
  code:
    | 'answer_key_missing'
    | 'answer_key_ambiguous'
    | 'question_type_ambiguous'
    | 'numbering_gap'
    | 'numbering_duplicate'
    | 'option_bank_missing'
    | 'unsupported_construct'
    | 'asset_external'
    | 'asset_missing'
    | 'script_removed'
    | 'schema_rejected'
    | 'no_questions_found';
  message: string;
  /** The question this concerns, when it concerns one. */
  questionNumber?: number;
  sourceRange?: SourceRange;
}

/** An asset the page needs, found during normalisation. */
export interface DetectedAsset {
  /** As written in the source. */
  originalSrc: string;
  kind: 'image' | 'audio';
  /** Inline data that could be stored as an asset directly. */
  inlineData?: { mimeType: string; base64: string };
  /**
   * `local` — a relative path that has to be supplied separately.
   * `external` — an absolute URL; not fetched, because importing a page must
   * not make the server issue requests a stranger chose.
   * `inline` — carried in the page as a data: URI.
   */
  origin: 'local' | 'external' | 'inline';
  /** Set once the asset has been stored; the question references this. */
  assetId?: string;
  sourceRange?: SourceRange;
}

/** One question the parser produced, with everything a reviewer needs. */
export interface ParsedQuestion {
  /**
   * The canonical question. Present unless the construct is unsupported — the
   * importer's output is the phase 4 model, not a parallel one.
   */
  question?: Question;
  status: ParseStatus;
  answerStatus: AnswerStatus;
  /** The number as printed on the page, even when the question failed. */
  questionNumber?: number;
  sourceRange: SourceRange;
  diagnostics: ImportDiagnostic[];
  /** What the parser thought this was, when it could not be sure. */
  detectedAs?: string;
  /**
   * What the parser could read, when it could not produce a complete question —
   * a gap with no answer key, most often. Carried so the review screen shows the
   * prompt and options the page really had, instead of an empty row.
   */
  draft?: Partial<Question>;
}

/** A region the parser recognised as something it does not support. */
export interface UnsupportedRegion {
  construct: string;
  reason: string;
  sourceRange: SourceRange;
}

export interface CdiImportResult {
  parserVersion: string;
  /** Detected from the page: which skill this material belongs to. */
  detectedSection: 'listening' | 'reading' | null;
  title: string;
  /** The passage or note text, as sanitised display HTML. */
  normalizedHtml: string;
  /** Plain text of the content, for a passage field. */
  normalizedText: string;
  /** Everything the parser produced, in page order. */
  questions: ParsedQuestion[];
  unsupportedRegions: UnsupportedRegion[];
  assets: DetectedAsset[];
  diagnostics: ImportDiagnostic[];
  /** The transcript, when the page carries one. */
  transcript?: string;
  stats: {
    /** Question numbers the page appears to contain. */
    detected: number;
    parsed: number;
    needsReview: number;
    unsupported: number;
    /** parsed / detected, 0–1. */
    coverage: number;
  };
}
