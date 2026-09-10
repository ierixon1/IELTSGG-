import { z } from 'zod';
import { GENERATABLE_TYPES } from '../services/bookToTest/types';
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

const SourceRangeSchema = z.object({
  start: z.number().int().min(0),
  end: z.number().int().min(0),
  excerpt: Trimmed(8000).default(''),
});

const ImportDiagnosticSchema = z.object({
  code: Trimmed(64),
  message: Trimmed(4000),
  questionNumber: z.number().int().min(0).max(5000).optional(),
  sourceRange: SourceRangeSchema.optional(),
});

/**
 * The provenance of an imported material.
 *
 * This belongs in the storage contract rather than riding along as an extra
 * key, because Zod strips what it does not know: without it the review screen
 * would assemble a complete import record and the saved material would contain
 * none of it. What the parser could not read, and what a human decided about
 * it, has to stay recoverable from the material months later. The source bytes
 * themselves are not copied here — they stay in the asset named by
 * `sourceAssetId`, which nothing in the editor rewrites.
 */
export const ImportRecordSchema = z.object({
  parserVersion: Trimmed(64),
  sourceAssetId: z.string().trim().min(1).max(64).optional(),
  diagnostics: z.array(ImportDiagnosticSchema).max(1000).default([]),
  unsupportedRegions: z
    .array(
      z.object({
        construct: Trimmed(200),
        reason: Trimmed(4000),
        sourceRange: SourceRangeSchema,
      }),
    )
    .max(500)
    .default([]),
  reviewedQuestions: z
    .array(
      z.object({
        questionNumber: z.number().int().min(0).max(5000).optional(),
        originalStatus: z.enum(['parsed', 'needs_review', 'unsupported']),
        originalAnswerStatus: z.enum(['extracted', 'missing', 'uncertain']),
        decision: z.enum(['include', 'mark_unsupported', 'exclude']),
        edited: z.boolean().default(false),
        sourceRange: SourceRangeSchema,
      }),
    )
    .max(1000)
    .default([]),
});

export type StoredImportRecord = z.infer<typeof ImportRecordSchema>;

const ChunkRef = z.string().trim().min(1).max(200);

/**
 * How a generated material was produced, precisely enough to reproduce the
 * question the model was asked and check every answer it gave.
 *
 * It records the exact chunks the model was given — not the chunks retrieval
 * could have returned — because "grounded in the book" is only a checkable claim
 * about the text that was actually in the prompt. It records every question
 * validation saw, including the rejected ones, because a generation that
 * produced five questions and kept three has to be able to say which two it
 * dropped and why.
 *
 * Write-once. `adminStore.finalise` carries it forward over every later edit.
 */
export const GenerationRecordSchema = z.object({
  generationId: z.string().trim().min(1).max(80),
  generatorVersion: Trimmed(64),
  promptVersion: Trimmed(64),
  model: Trimmed(120),
  modelVersion: Trimmed(120).optional(),
  generatedAt: Trimmed(40),
  source: z.object({
    sourceId: z.string().trim().min(1).max(160),
    title: Trimmed(500),
    filename: Trimmed(500),
    // Deliberately not `*AssetId`. `extractAssetIds` treats any such key as a
    // reference, and the learner asset route serves whatever a published
    // material references — which would hand the whole book to any learner.
    originalAsset: z.string().trim().min(1).max(64),
    extractionAsset: z.string().trim().min(1).max(64).optional(),
    extractorVersion: Trimmed(64),
    chunkerVersion: Trimmed(64),
  }),
  request: z.object({
    topic: Trimmed(500),
    questionType: z.enum(GENERATABLE_TYPES),
    requestedCount: z.number().int().min(1).max(20),
  }),
  retrieval: z.object({
    query: Trimmed(500),
    terms: z.array(Trimmed(80)).max(60),
    hits: z
      .array(
        z.object({
          chunkId: ChunkRef,
          score: z.number(),
          confidence: z.number().min(0).max(1),
          matchedTerms: z.array(Trimmed(80)).max(60),
        }),
      )
      .min(1)
      .max(20),
  }),
  /** The chunks that were in the prompt, and where each sits in the passage. */
  chunks: z
    .array(
      z.object({
        chunkId: ChunkRef,
        ordinal: z.number().int().min(0),
        label: Trimmed(20).optional(),
        page: z.number().int().min(1).optional(),
        path: z.array(Trimmed(500)).max(12),
        charStart: z.number().int().min(0),
        charEnd: z.number().int().min(0),
        contentHash: Trimmed(64),
        passageStart: z.number().int().min(0),
        passageEnd: z.number().int().min(0),
      }),
    )
    .min(1)
    .max(20),
  questions: z
    .array(
      z.object({
        generatedQuestionId: z.string().trim().min(1).max(128),
        questionNumber: z.number().int().min(1).max(200).optional(),
        status: z.enum(['valid', 'needs_review', 'rejected']),
        reasons: z.array(Trimmed(1000)).max(20).default([]),
        chunkIds: z.array(ChunkRef).max(20).default([]),
        evidence: z
          .array(z.object({ chunkId: ChunkRef, quote: Trimmed(2000) }))
          .max(10)
          .default([]),
        /** What the model returned for a rejected question, kept for review only. */
        candidate: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .max(50),
  summary: z.object({
    requested: z.number().int().min(0),
    returned: z.number().int().min(0),
    valid: z.number().int().min(0),
    needsReview: z.number().int().min(0),
    rejected: z.number().int().min(0),
    /** False when fewer usable questions came back than were asked for. */
    complete: z.boolean(),
  }),
});

export type StoredGenerationRecord = z.infer<typeof GenerationRecordSchema>;

/**
 * Keeps a generated material honest about its questions.
 *
 * A question the record lists must keep its provenance, a question claiming
 * provenance must be one the record lists, and a question validation rejected
 * must never be in the material at all. Hand-authored questions — no provenance,
 * an id the record does not know — are left to the ordinary rules.
 */
function checkGeneratedQuestions(
  content: { generationRecord?: StoredGenerationRecord; passage: { questions: Question[] } },
  addIssue: (message: string) => void,
) {
  const record = content.generationRecord;
  if (!record) return;
  const entries = new Map(record.questions.map((entry) => [entry.generatedQuestionId, entry]));

  for (const question of content.passage.questions) {
    const label = `Question ${question.questionNumber}`;
    const provenance = question.provenance;

    if (!provenance) {
      if (entries.has(question.id)) {
        addIssue(`${label} was generated from a source and its provenance cannot be removed.`);
      }
      continue;
    }

    if (provenance.generationId !== record.generationId) {
      addIssue(`${label} cites generation "${provenance.generationId}", but this material came from "${record.generationId}".`);
      continue;
    }
    const entry = entries.get(provenance.generatedQuestionId);
    if (!entry) {
      addIssue(`${label} claims to be generated question "${provenance.generatedQuestionId}", which the generation record does not contain.`);
      continue;
    }
    if (entry.status === 'rejected') {
      addIssue(`${label} was rejected by validation and cannot be saved into the material.`);
    }
  }
}

const AssetRefs = {
  assetIds: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  sourceAssetId: z.string().trim().min(1).max(64).optional(),
  importRecord: ImportRecordSchema.optional(),
};

export const ReadingContentSchema = z.object({
  ...AssetRefs,
  // Reading is the only section Book → Test generates.
  generationRecord: GenerationRecordSchema.optional(),
  passage: z.object({
    passageNumber: z.number().int().min(1).max(3).default(1),
    title: RequiredText(500),
    text: Trimmed(200_000).default(''),
    htmlContent: Trimmed(1_000_000).optional(),
    questions: QuestionsField('rea'),
  }),
  htmlContent: Trimmed(1_000_000).optional(),
}).superRefine((content, ctx) =>
  checkGeneratedQuestions(content, (message) =>
    ctx.addIssue({ code: 'custom', path: ['passage', 'questions'], message }),
  ),
);

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
  // Publishing is a deliberate act, so the default here is the state that
  // reaches nobody. The transition itself lives in `adminStore.setMaterialStatus`,
  // behind the publish gate; this field only records where it ended up.
  status: z.enum(['draft', 'published', 'archived']).default('draft'),
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
