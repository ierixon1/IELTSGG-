import type { Question } from '../../types';
import type { StoredGenerationRecord } from '../../schemas/material';
import type { CdiImportResult, ImportDiagnostic, ParsedQuestion, SourceRange } from '../cdiImport/types';

/**
 * Presents a generated material to the existing import review screen.
 *
 * There is one review system, and this is how generated questions enter it:
 * `valid` arrives as a cleanly parsed question, `needs_review` as a question the
 * importer was unsure of, and `rejected` as an unsupported construct — which the
 * review screen already refuses to include by default. The same corrections, the
 * same blocking rules and the same learner preview apply to all of them.
 *
 * Built from the *current* material rather than from the original generation
 * output, so reopening a draft that was edited since shows the edits, not a
 * stale copy that a save would then overwrite.
 */

export interface GeneratedReviewInput {
  result: CdiImportResult;
  /** The passage as plain text; source ranges point into it. */
  sourceHtml: string;
  generationRecord: StoredGenerationRecord;
}

export interface ReviewInputArgs {
  title: string;
  passageText: string;
  passageHtml: string;
  record: StoredGenerationRecord;
  /** The questions the material currently holds. */
  questions: Question[];
}

/** Where the evidence sits in the passage, so review shows the sentence itself. */
function evidenceRange(
  passageText: string,
  record: StoredGenerationRecord,
  evidence: Array<{ chunkId: string; quote: string }>,
): SourceRange {
  const first = evidence[0];
  if (first) {
    const exact = passageText.indexOf(first.quote);
    const at = exact >= 0 ? exact : passageText.toLowerCase().indexOf(first.quote.toLowerCase());
    if (at >= 0) return { start: at, end: at + first.quote.length, excerpt: first.quote.slice(0, 400) };

    const chunk = record.chunks.find((item) => item.chunkId === first.chunkId);
    if (chunk) {
      return {
        start: chunk.passageStart,
        end: chunk.passageEnd,
        excerpt: first.quote.slice(0, 400),
      };
    }
  }
  return { start: 0, end: 0, excerpt: '' };
}

/** A rejected question's model output, as far as it can be shown without trusting it. */
function draftFromCandidate(candidate: Record<string, unknown> | undefined, id: string): Partial<Question> {
  // The id is kept so the row can be matched to its record entry; without
  // provenance it still cannot become an includable question.
  const draft: Partial<Question> = { id };
  if (!candidate) return draft;
  if (typeof candidate.prompt === 'string') draft.prompt = candidate.prompt;
  if (typeof candidate.correctAnswer === 'string') draft.correctAnswer = candidate.correctAnswer;
  if (Array.isArray(candidate.options)) {
    draft.options = candidate.options.filter((option): option is string => typeof option === 'string');
  }
  // Deliberately no `provenance`: a rejected question cannot become an includable one.
  return draft;
}

export function reviewInputFor(args: ReviewInputArgs): GeneratedReviewInput {
  const { record, passageText } = args;
  const byId = new Map(args.questions.map((question) => [question.id, question]));
  const recordIds = new Set(record.questions.map((entry) => entry.generatedQuestionId));
  const parsed: ParsedQuestion[] = [];

  for (const entry of record.questions) {
    const question = byId.get(entry.generatedQuestionId);
    const sourceRange = evidenceRange(passageText, record, entry.evidence);

    if (entry.status === 'rejected') {
      parsed.push({
        status: 'unsupported',
        answerStatus: 'uncertain',
        questionNumber: entry.questionNumber,
        sourceRange,
        detectedAs: 'rejected by validation',
        draft: draftFromCandidate(entry.candidate, entry.generatedQuestionId),
        diagnostics: [
          {
            code: 'generation_rejected',
            message: entry.reasons.join(' ') || 'Rejected by validation.',
            questionNumber: entry.questionNumber,
          },
        ],
      });
      continue;
    }

    if (!question) {
      // Generated and usable, but no longer in the material: a reviewer took it
      // out. It comes back marked unsupported so reopening does not quietly put
      // it back in.
      parsed.push({
        status: 'unsupported',
        answerStatus: entry.status === 'valid' ? 'extracted' : 'uncertain',
        questionNumber: entry.questionNumber,
        sourceRange,
        detectedAs: 'excluded from the material',
        draft: { id: entry.generatedQuestionId },
        diagnostics: [],
      });
      continue;
    }

    const diagnostics: ImportDiagnostic[] =
      entry.status === 'needs_review'
        ? [
            {
              // Display only. Per-question diagnostics are not persisted into the
              // import record, so this never reached the publish gate (an earlier
              // comment here said otherwise). The gate reads the generation record,
              // which is also what lets a reviewer's confirmation promote the question.
              code: 'generation_needs_review',
              message: entry.reasons.join(' ') || 'The question could not be verified against the source.',
              questionNumber: question.questionNumber,
            },
          ]
        : [];

    parsed.push({
      question,
      status: entry.status === 'valid' ? 'parsed' : 'needs_review',
      answerStatus: entry.status === 'valid' ? 'extracted' : 'uncertain',
      questionNumber: question.questionNumber,
      sourceRange,
      diagnostics,
    });
  }

  // Questions added by hand after generation are the material's too.
  for (const question of args.questions) {
    if (recordIds.has(question.id)) continue;
    parsed.push({
      question,
      status: 'parsed',
      answerStatus: 'extracted',
      questionNumber: question.questionNumber,
      sourceRange: { start: 0, end: 0, excerpt: '' },
      diagnostics: [],
    });
  }

  const diagnostics: ImportDiagnostic[] = record.summary.complete
    ? []
    : [
        {
          code: 'generation_incomplete',
          message: `${record.summary.valid + record.summary.needsReview} usable question(s) came back of the ${record.summary.requested} requested (${record.summary.rejected} rejected).`,
        },
      ];

  const result: CdiImportResult = {
    parserVersion: record.generatorVersion,
    detectedSection: 'reading',
    title: args.title,
    normalizedHtml: args.passageHtml,
    normalizedText: passageText,
    questions: parsed,
    unsupportedRegions: [],
    assets: [],
    diagnostics,
    stats: {
      detected: record.summary.returned,
      parsed: record.summary.valid,
      needsReview: record.summary.needsReview,
      unsupported: record.summary.rejected,
      coverage:
        record.summary.requested > 0 ? Math.min(1, record.summary.valid / record.summary.requested) : 0,
    },
  };

  return { result, sourceHtml: passageText, generationRecord: record };
}
