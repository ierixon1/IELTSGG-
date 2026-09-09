import { z } from 'zod';
import type { Question } from '../types';
import {
  QuestionIssue,
  describeQuestionIssue,
  normalizeAuthoredQuestions,
} from './question';

/**
 * What a stored material is, and how a loosely authored one becomes it.
 *
 * `questions: any[]` used to be the storage type for all four sections, which
 * is why the compiler never noticed that the editors wrote `questionText` and
 * the learner read `prompt`. The section content schemas below are now the
 * write contract: `parseMaterialForWrite` runs at the storage boundary, so a
 * material that cannot be validated is refused rather than persisted and
 * discovered later by a learner staring at a blank question.
 *
 * Legacy data is handled in exactly one place — `normalizeAuthoredQuestions`,
 * which reads the old field names and the old type spellings. Past that
 * boundary every question is canonical.
 */

const Trimmed = (max: number) => z.string().trim().max(max);
const RequiredText = (max: number) => z.string().trim().min(1).max(max);

/**
 * Questions arrive loose and leave canonical.
 *
 * This is a `transform`, not a plain array schema, because the conversion has
 * to happen *inside* validation: an authored question written by an older build
 * is legal input, and the same array must come out as `Question[]`.
 */
const QuestionsField = (idPrefix: string) =>
  z.unknown().transform((raw, ctx) => {
    const { questions, issues } = normalizeAuthoredQuestions(raw, idPrefix);
    for (const issue of issues) {
      ctx.addIssue({ code: 'custom', message: describeQuestionIssue(issue) });
    }
    return questions as Question[];
  });

const SpeakingPromptList = z.array(RequiredText(2000)).max(60).default([]);

const AssetRefs = {
  assetIds: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  sourceAssetId: z.string().trim().min(1).max(64).optional(),
};

export const ReadingContentSchema = z.object({
  ...AssetRefs,
  passage: z.object({
    passageNumber: z.number().int().min(1).max(3).default(1),
    title: RequiredText(500),
    text: Trimmed(200_000).default(''),
    htmlContent: Trimmed(1_000_000).optional(),
    questions: QuestionsField('rea'),
  }),
  htmlContent: Trimmed(1_000_000).optional(),
});

export const ListeningContentSchema = z.object({
  ...AssetRefs,
  section: z.object({
    sectionNumber: z.number().int().min(1).max(4).default(1),
    title: RequiredText(500),
    contextDescription: Trimmed(4000).default(''),
    audioTranscript: Trimmed(200_000).optional(),
    htmlContent: Trimmed(1_000_000).optional(),
    questions: QuestionsField('lis'),
  }),
  audioUrl: Trimmed(500).optional(),
  audioAssetId: z.string().trim().min(1).max(64).optional(),
  audioFileName: Trimmed(300).optional(),
  transcript: Trimmed(200_000).optional(),
  htmlContent: Trimmed(1_000_000).optional(),
});

const WritingTaskSchema = z.object({
  taskType: Trimmed(200).optional(),
  prompt: RequiredText(8000),
  htmlContent: Trimmed(1_000_000).optional(),
  minimumWords: z.number().int().min(0).max(2000).optional(),
  minWordCount: z.number().int().min(0).max(2000).optional(),
  timeMinutes: z.number().int().min(0).max(240).optional(),
  dataVisualizationDescription: Trimmed(8000).optional(),
  band8VocabularyHints: z.array(Trimmed(300)).max(60).optional(),
});

export const WritingContentSchema = z.object({
  ...AssetRefs,
  task: z.object({
    task1: WritingTaskSchema.optional(),
    task2: WritingTaskSchema.optional(),
  }),
  task1ImageUrl: Trimmed(500).optional(),
  htmlContent: Trimmed(1_000_000).optional(),
  customGradingCriteria: z
    .object({
      taskResponseGuide: Trimmed(8000).optional(),
      lexicalKeyTerms: z.array(Trimmed(300)).max(100).optional(),
    })
    .optional(),
});

export const SpeakingContentSchema = z.object({
  ...AssetRefs,
  speakingSession: z.object({
    // Speaking prompts are spoken to the candidate and never marked, so they
    // are strings rather than questions — a distinction the schema keeps
    // explicit instead of leaving to convention.
    part1: z.object({
      topic: RequiredText(1000),
      questions: SpeakingPromptList,
      htmlContent: Trimmed(1_000_000).optional(),
    }),
    part2: z.object({
      cueCardTopic: RequiredText(1000),
      bulletPoints: z.array(RequiredText(500)).max(10).default([]),
      htmlContent: Trimmed(1_000_000).optional(),
    }),
    part3: z.object({
      questions: SpeakingPromptList,
      htmlContent: Trimmed(1_000_000).optional(),
    }),
  }),
  htmlContent: Trimmed(1_000_000).optional(),
  audioModelAnswers: z
    .array(
      z.object({
        part: z.enum(['part1', 'part2', 'part3']),
        audioUrl: Trimmed(500).default(''),
        audioAssetId: z.string().trim().min(1).max(64).optional(),
        modelBand: z.number().min(0).max(9),
        transcript: Trimmed(20_000).optional(),
      }),
    )
    .max(20)
    .optional(),
});

const MaterialBase = {
  id: z.string().trim().max(160).optional(),
  title: RequiredText(500),
  module: z.enum(['academic', 'general']).default('academic'),
  status: z.enum(['draft', 'published']).default('draft'),
  theme: Trimmed(200).optional(),
  targetBand: Trimmed(32).optional(),
  author: Trimmed(200).optional(),
  createdAt: Trimmed(64).optional(),
  updatedAt: Trimmed(64).optional(),
};

export const ReadingMaterialSchema = z.object({
  ...MaterialBase,
  section: z.literal('reading'),
  content: ReadingContentSchema,
});
export const ListeningMaterialSchema = z.object({
  ...MaterialBase,
  section: z.literal('listening'),
  content: ListeningContentSchema,
});
export const WritingMaterialSchema = z.object({
  ...MaterialBase,
  section: z.literal('writing'),
  content: WritingContentSchema,
});
export const SpeakingMaterialSchema = z.object({
  ...MaterialBase,
  section: z.literal('speaking'),
  content: SpeakingContentSchema,
});

export const MaterialSchema = z.discriminatedUnion('section', [
  ReadingMaterialSchema,
  ListeningMaterialSchema,
  WritingMaterialSchema,
  SpeakingMaterialSchema,
]);

export type MaterialSection = 'reading' | 'listening' | 'writing' | 'speaking';
export type ValidatedMaterial = z.infer<typeof MaterialSchema>;

const SCHEMA_BY_SECTION = {
  reading: ReadingMaterialSchema,
  listening: ListeningMaterialSchema,
  writing: WritingMaterialSchema,
  speaking: SpeakingMaterialSchema,
} as const;

export interface MaterialValidationFailure {
  ok: false;
  /** One readable line per problem, in the order the schema found them. */
  issues: string[];
}
export interface MaterialValidationSuccess {
  ok: true;
  material: ValidatedMaterial;
}

/**
 * Validates a material on its way into storage.
 *
 * Anything that cannot be made canonical is a refusal, not a repair. A question
 * whose task type is unrecognised, whose answer key is missing, or whose answer
 * does not name one of its own options stops the save and is reported — the
 * alternative is a material that looks saved and is unusable.
 */
export function parseMaterialForWrite(
  section: MaterialSection,
  body: unknown,
): MaterialValidationSuccess | MaterialValidationFailure {
  const schema = SCHEMA_BY_SECTION[section];
  if (!schema) return { ok: false, issues: [`Unknown section "${section}".`] };

  const withSection =
    body && typeof body === 'object' && !Array.isArray(body)
      ? { ...(body as Record<string, unknown>), section }
      : body;

  const parsed = schema.safeParse(withSection);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => {
        const path = issue.path.join('.');
        return path ? `${path}: ${issue.message}` : issue.message;
      }),
    };
  }
  return { ok: true, material: parsed.data as ValidatedMaterial };
}

/** Where a stored material keeps its questions, by section. */
function questionsOf(material: any): unknown {
  return (
    material?.content?.passage?.questions ??
    material?.content?.section?.questions ??
    undefined
  );
}

export interface StoredMaterialReview {
  /** The material with its questions normalised to the canonical shape. */
  material: any;
  /**
   * Questions that could not be made canonical. A material with entries here
   * needs a human: nothing is invented to fill the gap, and the questions are
   * not shipped to a learner.
   */
  needsReview: QuestionIssue[];
}

/**
 * Reads a stored material, migrating any legacy questions it still carries.
 *
 * Rows written before the canonical schema existed hold `questionText` and
 * legacy type spellings. Those convert cleanly. Rows that are genuinely
 * incomplete — no answer key, an unrecognised task type — come back flagged
 * rather than silently repaired, because guessing an answer key is the one
 * mistake that would corrupt a learner's band.
 */
export function migrateStoredMaterial(raw: unknown): StoredMaterialReview {
  if (!raw || typeof raw !== 'object') return { material: raw, needsReview: [] };

  const material = raw as any;
  const stored = questionsOf(material);
  if (!Array.isArray(stored)) return { material, needsReview: [] };

  const prefix = String(material.section || 'q').slice(0, 3);
  const { questions, issues } = normalizeAuthoredQuestions(stored, `${prefix}-${material.id || 'x'}`);

  const migrated = structuredClone(material);
  if (migrated.content?.passage?.questions) migrated.content.passage.questions = questions;
  if (migrated.content?.section?.questions) migrated.content.section.questions = questions;

  return { material: migrated, needsReview: issues };
}
