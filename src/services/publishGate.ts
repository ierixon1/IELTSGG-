import type { AdminMaterial } from '../types/admin';
import type { Question } from '../types';
import type { StoredGenerationRecord } from '../schemas/material';
import { QuestionSchema } from '../schemas/question';
import { extractAssetIds } from './assetStore';

/**
 * What has to be true before a material can reach a learner.
 *
 * Saving and publishing were the same act until now: `status` was an ordinary
 * field, so anything that could be written could be published, and a material
 * whose answer key the parser never found was one keystroke from a live test.
 * This module is the gate between the two. It answers with reasons, never with
 * a boolean, because "cannot publish" is not an actionable message when the
 * cause is question 14 having an answer that is not among its own options.
 *
 * Everything here is derived from the material itself. Nothing is repaired,
 * defaulted or inferred on the way through: a missing target band is a blocker
 * to be fixed by a human, not a field to be filled in with 7.5 so the publish
 * succeeds.
 */

export interface PublishBlocker {
  /** Machine-readable, so a UI can group blockers by what has to be fixed. */
  code:
    | 'classification_incomplete'
    | 'no_questions'
    | 'question_invalid'
    | 'needs_review'
    | 'unsupported_question'
    | 'import_unresolved'
    | 'asset_missing'
    | 'writing_task_missing'
    | 'speaking_incomplete'
    | 'generation_unverified'
    | 'generation_provenance_missing';
  message: string;
  /** The question this concerns, when it concerns one. */
  questionNumber?: number;
}

export interface PublishGateContext {
  /**
   * Whether an asset id names a file that exists and is usable. Passed in
   * rather than read here so the gate stays a pure function of its inputs and
   * can be tested without a store.
   */
  assetExists: (assetId: string) => boolean;
  /**
   * Questions the *stored* row still carries that cannot be made canonical.
   *
   * Supplied by the caller for the same reason as `assetExists`, and because
   * it cannot be recomputed here: every read migrates, so by the time a
   * material reaches this function the unconvertible questions are already
   * gone from it. Recomputing would always find nothing, and the gate would
   * wave through exactly the material it exists to stop.
   */
  needsReview?: string[];
}

/** The classification a published material must carry, and where it lives. */
const CLASSIFICATION_LABELS: Record<string, string> = {
  title: 'a title',
  section: 'a section',
  module: 'the Academic or General Training module',
  part: 'a passage or section number',
  theme: 'a theme',
  targetBand: 'a target band',
};

function classificationBlockers(material: AdminMaterial): PublishBlocker[] {
  const missing: string[] = [];
  if (!String(material.title || '').trim()) missing.push('title');
  if (!material.section) missing.push('section');
  if (material.module !== 'academic' && material.module !== 'general') missing.push('module');
  if (!String(material.theme || '').trim()) missing.push('theme');
  if (!String(material.targetBand || '').trim()) missing.push('targetBand');

  // A part number only means something for the two sections that are printed
  // with one. Writing and Speaking are whole papers.
  if (material.section === 'reading' || material.section === 'listening') {
    if (!partNumberOf(material)) missing.push('part');
  }

  if (missing.length === 0) return [];
  return [
    {
      code: 'classification_incomplete',
      message: `This material still needs ${missing
        .map((field) => CLASSIFICATION_LABELS[field] ?? field)
        .join(', ')}.`,
    },
  ];
}

/** The passage or section number, when the material carries a real one. */
export function partNumberOf(material: AdminMaterial): number | null {
  const content = material.content as Record<string, any>;
  const raw =
    material.section === 'reading'
      ? content?.passage?.passageNumber
      : material.section === 'listening'
        ? content?.section?.sectionNumber
        : null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

/** The canonical questions a material carries, in the section's own shape. */
export function questionsOf(material: AdminMaterial): Question[] {
  const content = material.content as Record<string, any>;
  const list =
    material.section === 'reading'
      ? content?.passage?.questions
      : material.section === 'listening'
        ? content?.section?.questions
        : null;
  return Array.isArray(list) ? (list as Question[]) : [];
}

function questionBlockers(material: AdminMaterial): PublishBlocker[] {
  if (material.section === 'writing') {
    const task = (material.content as Record<string, any>)?.task || {};
    const present = ['task1', 'task2'].filter((key) => task[key]?.prompt);
    if (present.length === 0) {
      return [
        {
          code: 'writing_task_missing',
          message: 'A published Writing material needs at least one task with a prompt.',
        },
      ];
    }
    return [];
  }

  if (material.section === 'speaking') {
    const session = (material.content as Record<string, any>)?.speakingSession || {};
    const missing: string[] = [];
    if (!session.part1?.topic || !(session.part1?.questions || []).length) missing.push('Part 1');
    if (!session.part2?.cueCardTopic) missing.push('Part 2');
    if (!(session.part3?.questions || []).length) missing.push('Part 3');
    if (missing.length === 0) return [];
    return [
      {
        code: 'speaking_incomplete',
        message: `A published Speaking material needs ${missing.join(', ')}.`,
      },
    ];
  }

  const questions = questionsOf(material);
  if (questions.length === 0) {
    return [
      {
        code: 'no_questions',
        message: 'This material carries no questions, so there is nothing for a learner to answer.',
      },
    ];
  }

  // The write schema already validated these once. Re-checking here is not
  // redundant: a row can predate the schema, and a material edited by hand or
  // migrated from an older build reaches this point without ever having been
  // through `parseMaterialForWrite`.
  const blockers: PublishBlocker[] = [];
  questions.forEach((question, index) => {
    const parsed = QuestionSchema.safeParse(question);
    if (parsed.success) return;
    const number = Number(question?.questionNumber) || index + 1;
    for (const issue of parsed.error.issues.slice(0, 3)) {
      blockers.push({
        code: 'question_invalid',
        questionNumber: number,
        message: `Question ${number}: ${issue.message}`,
      });
    }
  });
  return blockers;
}

/**
 * Questions the stored row still carries that cannot be made canonical.
 *
 * The admin catalog shows these as a badge; publishing over them would put a
 * question a learner cannot answer into a live test.
 */
function needsReviewBlockers(context: PublishGateContext): PublishBlocker[] {
  return (context.needsReview ?? []).slice(0, 10).map((message) => ({
    code: 'needs_review' as const,
    message,
  }));
}

/**
 * What the importer could not resolve, read back from the material's own
 * provenance.
 *
 * A reviewer may include a question the parser marked `unsupported`, or save a
 * draft while diagnostics are still outstanding. That is allowed — a draft is
 * meant to be a work in progress. Publishing is where it stops.
 */
function importBlockers(material: AdminMaterial): PublishBlocker[] {
  const record = (material.content as Record<string, any>)?.importRecord;
  if (!record) return [];

  const blockers: PublishBlocker[] = [];
  const included = new Set(questionsOf(material).map((q) => Number(q.questionNumber)));

  for (const reviewed of record.reviewedQuestions || []) {
    if (reviewed.decision !== 'include') continue;
    if (reviewed.originalStatus === 'unsupported') {
      blockers.push({
        code: 'unsupported_question',
        questionNumber: reviewed.questionNumber,
        message: `Question ${reviewed.questionNumber ?? '?'} was imported from a construct the parser does not support. Confirm it by hand or exclude it before publishing.`,
      });
    }
  }

  for (const diagnostic of record.diagnostics || []) {
    if (diagnostic.code !== 'answer_key_missing' && diagnostic.code !== 'answer_key_ambiguous') {
      continue;
    }
    // Only still a problem if the question it concerns actually made it in.
    if (diagnostic.questionNumber != null && !included.has(Number(diagnostic.questionNumber))) {
      continue;
    }
    blockers.push({
      code: 'import_unresolved',
      questionNumber: diagnostic.questionNumber,
      message: `Unresolved import warning: ${diagnostic.message}`,
    });
  }

  return blockers;
}

/**
 * What validation concluded about each generated question, read from the record.
 *
 * The verdict comes from the write-once generation record, never from the copy
 * on the question's own `provenance`: that copy travels through every editor
 * and request, the record does not. And correcting an answer by hand does not
 * make the source say something new, so a question that could not be verified
 * when it was generated still cannot be published — it can be excluded, or the
 * material regenerated.
 *
 * Additive: a material without a generation record gets nothing from here.
 */
function generationBlockers(material: AdminMaterial): PublishBlocker[] {
  const record = (material.content as { generationRecord?: StoredGenerationRecord })
    .generationRecord;
  if (!record) return [];

  const entries = new Map(record.questions.map((entry) => [entry.generatedQuestionId, entry]));
  const blockers: PublishBlocker[] = [];

  for (const question of questionsOf(material)) {
    const entry = entries.get(question.provenance?.generatedQuestionId ?? question.id);
    // Not a generated question: hand-authored questions are the ordinary rules’ business.
    if (!entry) continue;

    const number = question.questionNumber;
    if (!question.provenance || question.provenance.generationId !== record.generationId) {
      blockers.push({
        code: 'generation_provenance_missing',
        questionNumber: number,
        message: `Question ${number} was generated from a source but no longer carries its provenance.`,
      });
      continue;
    }
    if (entry.status !== 'valid') {
      const why = entry.reasons.length > 0 ? ` (${entry.reasons.join(' ')})` : '';
      blockers.push({
        code: 'generation_unverified',
        questionNumber: number,
        message: `Question ${number} was generated, but its answer could not be verified against the source${why}. Exclude it or regenerate.`,
      });
    }
  }

  return blockers;
}

function assetBlockers(material: AdminMaterial, context: PublishGateContext): PublishBlocker[] {
  const referenced = extractAssetIds(material);
  return referenced
    .filter((id) => !context.assetExists(id))
    .map((id) => ({
      code: 'asset_missing' as const,
      message: `This material references a file (${id}) that is no longer in the asset store.`,
    }));
}

/**
 * Every reason this material may not be published, in the order a human would
 * fix them: what it is, what it contains, then what it depends on.
 *
 * An empty array means publishable. Callers must not treat a non-empty array as
 * advisory — `setMaterialStatus` refuses the transition on any blocker.
 */
export function publishBlockers(
  material: AdminMaterial,
  context: PublishGateContext,
): PublishBlocker[] {
  return [
    ...classificationBlockers(material),
    ...questionBlockers(material),
    ...needsReviewBlockers(context),
    ...importBlockers(material),
    ...generationBlockers(material),
    ...assetBlockers(material, context),
  ];
}

/** The same reasons as plain lines, for an API response or an error message. */
export function describePublishBlockers(blockers: PublishBlocker[]): string[] {
  return blockers.map((blocker) => blocker.message);
}
