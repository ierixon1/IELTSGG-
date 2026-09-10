import { QuestionSchema } from '../../schemas/question';
import type { StoredGenerationRecord, StoredGenerationReview } from '../../schemas/material';
import type { MediaRef, Question, QuestionLayout, QuestionType } from '../../types';
import type {
  AnswerStatus,
  CdiImportResult,
  DetectedAsset,
  ImportDiagnostic,
  ParsedQuestion,
  ParseStatus,
  SourceRange,
} from './types';

/**
 * The state an import is reviewed in, and the rules that govern it.
 *
 * This is deliberately not inside the component. What may be corrected, what
 * blocks a save, and what must survive a correction are decisions about data
 * integrity, and they are worth testing without a DOM in the way.
 *
 * The governing rule of the whole screen: a correction changes the *question*,
 * never the evidence. `sourceHtml`, `sourceRange`, `parserVersion` and the
 * parser's own diagnostics are immutable — an admin fixing a prompt must not
 * quietly erase the record that the parser could not read it.
 */

export type ReviewPhase = 'parsing' | 'ready' | 'needs_review' | 'blocked' | 'saved';

/** What an admin chose to do with a question the parser could not convert. */
export type ReviewDecision =
  /** Keep it and make it valid by hand. */
  | 'include'
  /** Acknowledge it cannot be imported; it stays out of the material. */
  | 'mark_unsupported'
  /** Drop it from this import entirely. */
  | 'exclude';

export interface ReviewQuestion {
  /** Stable key for the row, independent of any editing. */
  key: string;
  questionNumber?: number;
  /** What the parser decided, kept even after a correction. */
  originalStatus: ParseStatus;
  /** What the parser decided about the key, kept even after one is supplied. */
  originalAnswerStatus: AnswerStatus;
  /** Immutable pointer into the original page. */
  sourceRange: SourceRange;
  /** The parser's own findings. Never removed by an edit. */
  diagnostics: ImportDiagnostic[];
  /** What the parser thought this was, when it could not be sure. */
  detectedAs?: string;
  /** The current question, as parsed or as corrected. */
  draft: Partial<Question>;
  /** True once an admin has changed something on this row. */
  edited: boolean;
  decision: ReviewDecision;
}

export interface Classification {
  section: 'reading' | 'listening' | null;
  module: 'academic' | 'general' | null;
  theme: string;
  targetBand: string;
  /** Passage number for reading, section number for listening. */
  part: number | null;
  title: string;
}

export interface ReviewState {
  phase: ReviewPhase;
  parserVersion: string;
  sourceAssetId?: string;
  /** Immutable. Corrections never touch it. */
  sourceHtml: string;
  normalizedHtml: string;
  transcript?: string;
  questions: ReviewQuestion[];
  assets: DetectedAsset[];
  /** Page-level findings. */
  diagnostics: ImportDiagnostic[];
  unsupportedRegions: CdiImportResult['unsupportedRegions'];
  classification: Classification;
  stats: CdiImportResult['stats'];
  /**
   * The stored material this review edits, when it edits one. A generated
   * draft already exists when review opens, so saving updates it rather than
   * creating a second copy.
   */
  materialId?: string;
  /**
   * Present when the questions came from Book → Test. Carried into the saved
   * material unchanged; nothing on this screen edits it.
   */
  generationRecord?: StoredGenerationRecord;
  /** Reviewer decisions about flagged generated questions, oldest first. Read-only here. */
  generationReviews?: ReviewConfirmation[];
}

/** A reviewer decision, with whether it still covers the question as it is stored now. */
export interface ReviewConfirmation extends StoredGenerationReview {
  /** False once the question was excluded from the draft; such a decision covers nothing. */
  inDraft: boolean;
  /** The question is in the draft and unchanged since the decision. */
  current: boolean;
}

/**
 * A question is ready when it validates as a canonical question and its
 * decision is to include it.
 */
export function isQuestionReady(question: ReviewQuestion): boolean {
  if (question.decision !== 'include') return false;
  return QuestionSchema.safeParse(question.draft).success;
}

/** Why a question is not ready, in words an admin can act on. */
export function questionProblems(question: ReviewQuestion): string[] {
  if (question.decision === 'exclude') return [];
  if (question.decision === 'mark_unsupported') {
    return ['Marked unsupported — it will not be part of the material.'];
  }
  const parsed = QuestionSchema.safeParse(question.draft);
  if (parsed.success) return [];
  return parsed.error.issues.map(
    (issue) => `${issue.path.join('.') || 'question'}: ${issue.message}`,
  );
}

/**
 * Assets a question depends on that are not stored, so cannot be shown.
 *
 * An external URL is never treated as an attachable asset: importing one would
 * mean a learner's browser fetching a destination someone else chose, and the
 * sanitiser blocks it anyway.
 */
export function unresolvedAssets(state: ReviewState): DetectedAsset[] {
  return state.assets.filter((asset) => !asset.assetId);
}

/** Everything standing between this import and a saved draft. */
export function blockingReasons(state: ReviewState): string[] {
  const reasons: string[] = [];

  if (!state.classification.section) reasons.push('Choose whether this is a Reading or a Listening material.');
  if (!state.classification.module) reasons.push('Choose the Academic or General Training module.');
  if (!state.classification.title.trim()) reasons.push('Give the material a title.');

  const included = state.questions.filter((question) => question.decision === 'include');
  if (included.length === 0) reasons.push('No questions are included in this import.');

  const invalid = included.filter((question) => !isQuestionReady(question));
  if (invalid.length > 0) {
    const numbers = invalid.map((question) => question.questionNumber ?? '?').join(', ');
    reasons.push(
      `${invalid.length} included question(s) are still incomplete: ${numbers}. Correct them, mark them unsupported, or exclude them.`,
    );
  }

  // A question that needs a picture it does not have is not answerable, however
  // well the rest of it parsed.
  const missingMedia = included.filter(
    (question) =>
      question.draft.mediaRef &&
      !state.assets.some((asset) => asset.assetId === question.draft.mediaRef?.assetId),
  );
  if (missingMedia.length > 0) {
    reasons.push(
      `${missingMedia.length} question(s) reference an image or audio file that has not been attached.`,
    );
  }

  // A generated question is only as good as its trail back to the book.
  const record = state.generationRecord;
  if (record) {
    const entries = new Map(record.questions.map((entry) => [entry.generatedQuestionId, entry]));
    const rejected = included.filter((question) => {
      const id = question.draft.provenance?.generatedQuestionId ?? question.draft.id;
      return id !== undefined && entries.get(id)?.status === 'rejected';
    });
    if (rejected.length > 0) {
      reasons.push(
        `${rejected.length} included question(s) were rejected by validation and cannot be part of the material. Exclude them.`,
      );
    }
    const unprovenanced = included.filter(
      (question) =>
        question.draft.id !== undefined &&
        entries.has(question.draft.id) &&
        !question.draft.provenance,
    );
    if (unprovenanced.length > 0) {
      reasons.push(`${unprovenanced.length} generated question(s) have lost their source provenance.`);
    }
  }

  return reasons;
}

/** The phase the review is in, derived rather than stored. */
export function phaseFor(state: ReviewState): ReviewPhase {
  if (state.phase === 'saved' || state.phase === 'parsing') return state.phase;
  if (blockingReasons(state).length > 0) return 'blocked';
  const undecided = state.questions.some(
    (question) => question.decision === 'include' && question.originalStatus !== 'parsed',
  );
  return undecided ? 'needs_review' : 'ready';
}

/**
 * Builds the review state from what the importer returned.
 *
 * Every question arrives with a decision already set from the parser's verdict:
 * what parsed cleanly is included, what the parser refused is marked
 * unsupported rather than silently included as a broken question. An admin can
 * change any of it — that is what the screen is for — but the default never
 * quietly promotes something the parser could not read.
 */
export function buildReviewState(
  result: CdiImportResult,
  options: {
    sourceHtml: string;
    sourceAssetId?: string;
    materialId?: string;
    generationRecord?: StoredGenerationRecord;
    generationReviews?: ReviewConfirmation[];
  } = { sourceHtml: '' },
): ReviewState {
  const questions: ReviewQuestion[] = result.questions.map((entry, index) => ({
    key: `q-${entry.questionNumber ?? `x${index}`}-${index}`,
    questionNumber: entry.questionNumber,
    originalStatus: entry.status,
    originalAnswerStatus: entry.answerStatus,
    sourceRange: entry.sourceRange,
    diagnostics: entry.diagnostics,
    detectedAs: entry.detectedAs,
    draft: entry.question ? { ...entry.question } : { ...(entry.draft ?? {}) },
    edited: false,
    decision: entry.status === 'unsupported' ? 'mark_unsupported' : 'include',
  }));

  const state: ReviewState = {
    phase: 'ready',
    parserVersion: result.parserVersion,
    sourceAssetId: options.sourceAssetId,
    sourceHtml: options.sourceHtml,
    normalizedHtml: result.normalizedHtml,
    transcript: result.transcript,
    questions,
    assets: result.assets,
    diagnostics: result.diagnostics,
    unsupportedRegions: result.unsupportedRegions,
    classification: {
      // Suggested, never decided: the parser proposes and the admin confirms.
      section: result.detectedSection,
      module: null,
      theme: '',
      targetBand: '',
      part: null,
      title: result.title,
    },
    stats: result.stats,
    materialId: options.materialId,
    generationRecord: options.generationRecord,
    generationReviews: options.generationReviews,
  };

  state.phase = phaseFor(state);
  return state;
}

/** The fields a review may change. Everything else is evidence. */
export interface QuestionCorrection {
  type?: QuestionType;
  prompt?: string;
  instruction?: string;
  options?: string[];
  correctAnswer?: string | string[];
  acceptableAnswers?: string[];
  wordLimit?: string;
  layout?: QuestionLayout;
  group?: string;
  mediaRef?: MediaRef | null;
  /** Changing a printed number is a deliberate act, never a side effect. */
  questionNumber?: number;
}

/**
 * Applies a correction to one question.
 *
 * What it may not do is the point: the source range, the parser's original
 * verdict, its answer verdict and its diagnostics all survive untouched. An
 * import that needed review still reads as one after it has been fixed, which
 * is what stops a corrected question being mistaken later for one the parser
 * got right on its own.
 */
export function applyCorrection(
  state: ReviewState,
  key: string,
  correction: QuestionCorrection,
): ReviewState {
  return {
    ...state,
    questions: state.questions.map((question) => {
      if (question.key !== key) return question;

      const draft: Partial<Question> = { ...question.draft };
      for (const [field, value] of Object.entries(correction)) {
        if (value === undefined) continue;
        if (field === 'mediaRef' && value === null) {
          delete draft.mediaRef;
          continue;
        }
        (draft as Record<string, unknown>)[field] = value;
      }

      // A corrected question still needs an id to be canonical.
      if (!draft.id) draft.id = `cdi-${question.key}`;

      return { ...question, draft, edited: true };
    }),
  };
}

/** Records what an admin decided about a question the parser could not convert. */
export function setDecision(state: ReviewState, key: string, decision: ReviewDecision): ReviewState {
  return {
    ...state,
    questions: state.questions.map((question) =>
      question.key === key ? { ...question, decision } : question,
    ),
  };
}

export function setClassification(
  state: ReviewState,
  patch: Partial<Classification>,
): ReviewState {
  return { ...state, classification: { ...state.classification, ...patch } };
}

/** Attaches a stored asset to a detected one, and to the questions using it. */
export function attachAsset(
  state: ReviewState,
  originalSrc: string,
  assetId: string,
): ReviewState {
  const previousIds = state.assets
    .filter((asset) => asset.originalSrc === originalSrc)
    .map((asset) => asset.assetId);

  return {
    ...state,
    assets: state.assets.map((asset) =>
      asset.originalSrc === originalSrc ? { ...asset, assetId } : asset,
    ),
    questions: state.questions.map((question) => {
      const current = question.draft.mediaRef;
      if (!current) return question;
      const wasThisAsset = previousIds.includes(current.assetId) || current.assetId === originalSrc;
      if (!wasThisAsset) return question;
      return { ...question, draft: { ...question.draft, mediaRef: { ...current, assetId } } };
    }),
  };
}

/** The questions that will go into the material. */
export function includedQuestions(state: ReviewState): Question[] {
  return state.questions
    .filter((question) => question.decision === 'include')
    .map((question) => QuestionSchema.safeParse(question.draft))
    .filter((parsed) => parsed.success)
    .map((parsed) => (parsed as { data: Question }).data);
}

export interface SavePayload {
  /** Set when the review edits a material that already exists. */
  id?: string;
  title: string;
  section: 'reading' | 'listening';
  module: 'academic' | 'general';
  status: 'draft';
  theme?: string;
  targetBand?: string;
  content: Record<string, unknown>;
}

/**
 * Turns a reviewed import into a material the CMS can store.
 *
 * Returns `null` while anything is blocking, so a caller cannot accidentally
 * save an import that is not finished — the screen refuses first, and this
 * refuses again.
 */
export function toSavePayload(state: ReviewState): SavePayload | null {
  if (blockingReasons(state).length > 0) return null;
  const { classification } = state;
  if (!classification.section || !classification.module) return null;

  const questions = includedQuestions(state);
  const assetIds = state.assets
    .map((asset) => asset.assetId)
    .filter((id): id is string => typeof id === 'string');
  if (state.sourceAssetId) assetIds.push(state.sourceAssetId);

  // Everything the parser found travels with the material, so a question that
  // needed a human is still identifiable as one months later.
  const importRecord = {
    parserVersion: state.parserVersion,
    sourceAssetId: state.sourceAssetId,
    diagnostics: state.diagnostics,
    unsupportedRegions: state.unsupportedRegions,
    reviewedQuestions: state.questions.map((question) => ({
      questionNumber: question.questionNumber,
      originalStatus: question.originalStatus,
      originalAnswerStatus: question.originalAnswerStatus,
      decision: question.decision,
      edited: question.edited,
      sourceRange: question.sourceRange,
    })),
  };

  const shared = {
    htmlContent: state.normalizedHtml,
    sourceAssetId: state.sourceAssetId,
    assetIds,
    importRecord,
    ...(state.generationRecord ? { generationRecord: state.generationRecord } : {}),
  };

  const content =
    classification.section === 'reading'
      ? {
          ...shared,
          passage: {
            passageNumber: classification.part ?? 1,
            title: classification.title,
            // A generated passage is the book's own text, and review ranges point
            // into it, so it is kept. An imported page's text lives in its HTML.
            text: state.generationRecord ? state.sourceHtml : '',
            htmlContent: state.normalizedHtml,
            questions,
          },
        }
      : {
          ...shared,
          section: {
            sectionNumber: classification.part ?? 1,
            title: classification.title,
            contextDescription: '',
            audioTranscript: state.transcript,
            htmlContent: state.normalizedHtml,
            questions,
          },
          transcript: state.transcript,
        };

  return {
    ...(state.materialId ? { id: state.materialId } : {}),
    title: classification.title,
    section: classification.section,
    module: classification.module,
    status: 'draft',
    theme: classification.theme || undefined,
    targetBand: classification.targetBand || undefined,
    content,
  };
}

/** The slice of original HTML a question was read from. */
export function sourceFragment(state: ReviewState, question: ReviewQuestion): string {
  const { start, end } = question.sourceRange;
  if (!state.sourceHtml) return question.sourceRange.excerpt;
  return state.sourceHtml.slice(start, Math.min(end, start + 4000));
}
