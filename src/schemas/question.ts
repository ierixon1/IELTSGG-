import { z } from 'zod';
import { BANK_ANSWER_TYPES, MediaRef, Question, QuestionLayout, QuestionType } from '../types';
import { answerMatchesOptions, normaliseAnswer as normalise } from '../utils/answerMatching';

/**
 * The one definition of what a question is.
 *
 * Questions reach the learner from three authors — the admin editors, the
 * Gemini generators, and (next) the CDI HTML importer — and each of them used
 * to invent its own field names and its own spellings for the same task type.
 * `questionText` vs `prompt` was not cosmetic: the learner adapter read the
 * canonical name, found nothing, and rendered an empty question while the admin
 * preview looked perfectly correct.
 *
 * Two layers live here, and the distinction matters:
 *
 *   - `QuestionSchema` is the *canonical* shape. It is strict, it is what gets
 *     stored, and it is the only thing the rest of the app works with.
 *   - `normalizeAuthoredQuestions` is the *boundary*. It reads legacy field
 *     names and legacy type spellings, converts them, and then runs the strict
 *     schema. Anything it cannot convert is reported as an issue — never
 *     guessed at, never coerced into a gap fill, never dropped silently.
 *
 * Legacy handling lives at that boundary and nowhere else. Past it, a question
 * is a `Question`.
 */

/* -------------------------------------------------------------------------- */
/* Canonical vocabulary                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Every task type the engine renders. This array is the single source of the
 * vocabulary — the taxonomy, the generators and the editors all resolve onto
 * it rather than declaring their own list.
 */
export const CANONICAL_QUESTION_TYPES = [
  'multiple_choice',
  'multi_select',
  'fill_in_blank',
  'sentence_completion',
  'summary_completion',
  'note_completion',
  'table_completion',
  'form_completion',
  'short_answer',
  'true_false_not_given',
  'yes_no_not_given',
  'matching',
  'matching_headings',
  'matching_information',
  'matching_features',
  'matching_sentence_endings',
  'diagram_label',
  'map_label',
] as const satisfies readonly QuestionType[];

export const QuestionTypeSchema = z.enum(CANONICAL_QUESTION_TYPES);

export const QUESTION_LAYOUTS = [
  'standalone',
  'table_row',
  'note_line',
  'form_row',
  'summary_gap',
  'inline_gap',
  'diagram_label',
] as const satisfies readonly QuestionLayout[];

export const QuestionLayoutSchema = z.enum(QUESTION_LAYOUTS);

/**
 * Every spelling of a task type that has ever been written into this codebase,
 * mapped onto the one the engine renders.
 *
 * The four-way split between `diagram_label_completion` (taxonomy and the
 * reading generator), `diagram_label` (the engine), `map_diagram_labelling`
 * (taxonomy) and `map_label` (the engine) is why this table exists: the adapter
 * used to coerce anything it did not recognise to `fill_in_blank`, turning a
 * map-labelling task into a bare text box with no sign anything was wrong.
 */
export const QUESTION_TYPE_ALIASES: Record<string, QuestionType> = {
  // gap fills
  fill_in_the_blank: 'fill_in_blank',
  fill_in_blanks: 'fill_in_blank',
  gap_fill: 'fill_in_blank',
  gap_filling: 'fill_in_blank',
  // choice
  multiple_choice_single: 'multiple_choice',
  mcq: 'multiple_choice',
  multiple_answer: 'multi_select',
  multiple_select: 'multi_select',
  multiple_choice_multi: 'multi_select',
  // statements
  true_false_notgiven: 'true_false_not_given',
  tfng: 'true_false_not_given',
  yes_no_notgiven: 'yes_no_not_given',
  ynng: 'yes_no_not_given',
  // matching
  matching_options: 'matching',
  matching_paragraphs: 'matching_information',
  sentence_endings: 'matching_sentence_endings',
  // labelling
  diagram_label_completion: 'diagram_label',
  diagram_labelling: 'diagram_label',
  flow_chart_completion: 'diagram_label',
  map_diagram_labelling: 'map_label',
  plan_map_diagram_labelling: 'map_label',
  map_labelling: 'map_label',
  plan_labelling: 'map_label',
  // completion families
  short_answer_questions: 'short_answer',
  note_taking: 'note_completion',
};

export function isCanonicalQuestionType(value: unknown): value is QuestionType {
  return (
    typeof value === 'string' &&
    (CANONICAL_QUESTION_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Resolves any written task type onto the canonical one, or `null` when it is
 * genuinely unrecognised. `null` is never silently replaced with a gap fill.
 */
export function canonicalQuestionType(value: unknown): QuestionType | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (isCanonicalQuestionType(key)) return key;
  return QUESTION_TYPE_ALIASES[key] ?? null;
}

/** The only answers these two task types may carry, as the paper prints them. */
export const TRUE_FALSE_ANSWERS = ['TRUE', 'FALSE', 'NOT GIVEN'] as const;
export const YES_NO_ANSWERS = ['YES', 'NO', 'NOT GIVEN'] as const;

export function legalStatementAnswers(type: QuestionType): readonly string[] | null {
  if (type === 'true_false_not_given') return TRUE_FALSE_ANSWERS;
  if (type === 'yes_no_not_given') return YES_NO_ANSWERS;
  return null;
}

/** Types that cannot be answered without a set of choices to answer from. */
const TYPES_REQUIRING_OPTIONS: readonly QuestionType[] = [
  'multiple_choice',
  'multi_select',
  ...BANK_ANSWER_TYPES,
];

// Option matching is shared with the learner engine, which must not pull Zod
// into the browser bundle in order to mark an answer.
export { answerMatchesOption, answerMatchesOptions, optionLabel, optionValue } from '../utils/answerMatching';

/* -------------------------------------------------------------------------- */
/* The canonical schema                                                        */
/* -------------------------------------------------------------------------- */

const NonEmptyString = z.string().trim().min(1);

export const MediaRefSchema = z.object({
  assetId: z.string().regex(/^ast_[A-Za-z0-9_-]{10,32}$/, 'Not an asset id.'),
  kind: z.enum(['image', 'audio']),
  alt: z.string().max(500).optional(),
});

const AnswerSchema = z.union([NonEmptyString.max(500), z.array(NonEmptyString.max(500)).min(1)]);

/**
 * Where a generated question came from, precisely enough to check it.
 *
 * Declared in the canonical schema rather than riding along as an extra key,
 * because Zod strips what it does not know: a question generated from a book
 * would otherwise lose every trace of that book the first time it was saved.
 *
 * `validation` is a copy for display. The authoritative verdict lives in the
 * material's write-once generation record, which is what the publish gate
 * reads — this copy travels through editors and requests, so it is not trusted.
 */
export const QuestionProvenanceSchema = z
  .object({
    kind: z.literal('generated'),
    generationId: NonEmptyString.max(80),
    /** Equal to the question's own `id`, so the record entry is findable. */
    generatedQuestionId: NonEmptyString.max(128),
    generatorVersion: NonEmptyString.max(64),
    promptVersion: NonEmptyString.max(64).optional(),
    model: NonEmptyString.max(120),
    modelVersion: NonEmptyString.max(120).optional(),
    generatedAt: NonEmptyString.max(40),
    sourceId: NonEmptyString.max(160),
    /** The retrieved chunks this question was written from. */
    chunkIds: z.array(NonEmptyString.max(200)).min(1).max(20),
    /** Printed pages, where the source format records them. */
    pages: z.array(z.number().int().min(1)).max(50).default([]),
    locations: z
      .array(
        z.object({
          chunkId: NonEmptyString.max(200),
          page: z.number().int().min(1).optional(),
          path: z.array(z.string().max(500)).max(12),
        }),
      )
      .min(1)
      .max(20),
    /** Verbatim text from those chunks that the answer rests on. */
    evidence: z
      .array(z.object({ chunkId: NonEmptyString.max(200), quote: NonEmptyString.max(2000) }))
      .min(1)
      .max(10),
    questionEvidence: z
      .array(z.object({ chunkId: NonEmptyString.max(200), quote: NonEmptyString.max(2000) }))
      .max(10)
      .optional(),
    answerEvidence: z
      .array(z.object({ chunkId: NonEmptyString.max(200), quote: NonEmptyString.max(2000) }))
      .max(10)
      .optional(),
    distractorEvidence: z
      .array(
        z.object({
          option: NonEmptyString.max(1000),
          chunkId: NonEmptyString.max(200).optional(),
          quote: NonEmptyString.max(2000).optional(),
          reason: NonEmptyString.max(1000).optional(),
        }),
      )
      .max(10)
      .optional(),
    groundingStatus: z.enum(['valid', 'needs_review']).optional(),
    qualityStatus: z.enum(['valid', 'needs_review']).optional(),
    validation: z.enum(['valid', 'needs_review']),
  })
  .superRefine((provenance, ctx) => {
    // Evidence and locations may only cite chunks this question was built from:
    // a citation to a chunk outside that set is a citation nobody can check.
    const cited = new Set(provenance.chunkIds);
    const allEvidence = [
      ...provenance.evidence,
      ...(provenance.questionEvidence ?? []),
      ...(provenance.answerEvidence ?? []),
    ];
    for (const [index, item] of allEvidence.entries()) {
      if (!cited.has(item.chunkId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['evidence', index, 'chunkId'],
          message: `Evidence cites chunk "${item.chunkId}", which is not one of this question's chunks.`,
        });
      }
    }
    for (const [index, location] of provenance.locations.entries()) {
      if (!cited.has(location.chunkId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['locations', index, 'chunkId'],
          message: `Location cites chunk "${location.chunkId}", which is not one of this question's chunks.`,
        });
      }
    }
  });

/**
 * A canonical question, with the cross-field rules that make it answerable and
 * markable. Unknown keys are dropped rather than stored: the generators emit
 * `paragraphLocation` and `targetSkill`, which nothing renders.
 */
export const QuestionSchema = z
  .object({
    provenance: QuestionProvenanceSchema.optional(),
    id: NonEmptyString.max(128),
    questionNumber: z.number().int().min(1).max(200),
    type: QuestionTypeSchema,
    instruction: z.string().trim().min(1).max(4000).optional(),
    prompt: NonEmptyString.max(4000),
    options: z.array(NonEmptyString.max(1000)).max(30).optional(),
    wordLimit: z.string().trim().min(1).max(200).optional(),
    correctAnswer: AnswerSchema,
    acceptableAnswers: z.array(NonEmptyString.max(500)).max(30).optional(),
    explanation: z.string().trim().min(1).max(8000).optional(),
    layout: QuestionLayoutSchema.optional(),
    mediaRef: MediaRefSchema.optional(),
    group: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9_.:-]+$/, 'Group keys are identifiers, not prose.')
      .optional(),
  })
  .superRefine((question, ctx) => {
    const answers = Array.isArray(question.correctAnswer)
      ? question.correctAnswer
      : [question.correctAnswer];

    // A choice with nothing to choose from cannot be answered.
    if (TYPES_REQUIRING_OPTIONS.includes(question.type)) {
      if (!question.options || question.options.length < 2) {
        ctx.addIssue({
          code: 'custom',
          path: ['options'],
          message: `${question.type} needs at least two options.`,
        });
      } else {
        for (const answer of answers) {
          if (!answerMatchesOptions(answer, question.options)) {
            ctx.addIssue({
              code: 'custom',
              path: ['correctAnswer'],
              message: `Answer "${answer}" is not one of the options.`,
            });
          }
        }
      }
    }

    // A single choice has exactly one answer; a multi-select needs more than
    // one, or it is a single choice wearing the wrong type.
    if (question.type === 'multiple_choice' && answers.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['correctAnswer'],
        message: 'multiple_choice takes exactly one answer; use multi_select for more.',
      });
    }
    if (question.type === 'multi_select' && answers.length < 2) {
      ctx.addIssue({
        code: 'custom',
        path: ['correctAnswer'],
        message: 'multi_select needs at least two answers.',
      });
    }

    // TRUE/FALSE/NOT GIVEN and YES/NO/NOT GIVEN have three legal answers each.
    const legal = legalStatementAnswers(question.type);
    if (legal) {
      for (const answer of answers) {
        if (!(legal as readonly string[]).includes(answer)) {
          ctx.addIssue({
            code: 'custom',
            path: ['correctAnswer'],
            message: `${question.type} allows only ${legal.join(', ')} — got "${answer}".`,
          });
        }
      }
      if (question.options) {
        for (const option of question.options) {
          if (!(legal as readonly string[]).includes(option)) {
            ctx.addIssue({
              code: 'custom',
              path: ['options'],
              message: `${question.type} options must be ${legal.join(', ')}.`,
            });
          }
        }
      }
    }

    // A labelling task without its diagram is unanswerable. Warned about, not
    // rejected: the media may be attached in a later edit.
    if (
      (question.type === 'map_label' || question.type === 'diagram_label') &&
      question.mediaRef &&
      question.mediaRef.kind !== 'image'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['mediaRef'],
        message: 'A labelling task references an image, not audio.',
      });
    }

    // An acceptable spelling that repeats the key is noise, not a variant.
    if (question.acceptableAnswers) {
      for (const variant of question.acceptableAnswers) {
        if (answers.some((answer) => normalise(answer) === normalise(variant))) {
          ctx.addIssue({
            code: 'custom',
            path: ['acceptableAnswers'],
            message: `"${variant}" already appears in correctAnswer.`,
          });
        }
      }
    }
  });

export const QuestionArraySchema = z.array(QuestionSchema);

/**
 * Compile-time proof that the schema and the hand-written `Question` interface
 * cannot drift apart. `src/types.ts` stays free of Zod so the browser bundle
 * does not have to carry it, which is exactly the arrangement that lets two
 * definitions of the same thing diverge — unless something checks.
 */
type SchemaQuestion = z.infer<typeof QuestionSchema>;
const _schemaSatisfiesInterface: (q: SchemaQuestion) => Question = (q) => q;
const _interfaceSatisfiesSchema: (q: Question) => SchemaQuestion = (q) => q;
const _mediaRefMatches: (m: z.infer<typeof MediaRefSchema>) => MediaRef = (m) => m;
void _schemaSatisfiesInterface;
void _interfaceSatisfiesSchema;
void _mediaRefMatches;

/* -------------------------------------------------------------------------- */
/* The legacy boundary                                                         */
/* -------------------------------------------------------------------------- */

/** Canonical field names first; everything after is a legacy alias. */
const PROMPT_KEYS = ['prompt', 'questionText', 'question', 'text'] as const;
const INSTRUCTION_KEYS = ['instruction', 'instructions'] as const;
const ANSWER_KEYS = ['correctAnswer', 'answer'] as const;
const ACCEPTABLE_KEYS = ['acceptableAnswers', 'alternativeAnswers', 'acceptedAnswers'] as const;
const WORD_LIMIT_KEYS = ['wordLimit', 'wordLimitText'] as const;
const NUMBER_KEYS = ['questionNumber', 'number'] as const;

export type QuestionIssueReason =
  | 'not_an_object'
  | 'missing_prompt'
  | 'missing_answer'
  | 'unknown_type'
  | 'invalid';

export interface QuestionIssue {
  /** Position in the authored array, so the admin can find it. */
  index: number;
  reason: QuestionIssueReason;
  /** The type as written, when that is what went wrong. */
  rawType?: string;
  /** The prompt as written, to identify the question in a report. */
  promptPreview?: string;
  /** Field-level detail from the schema, for `invalid`. */
  details?: string[];
}

export interface NormalizedQuestions {
  questions: Question[];
  issues: QuestionIssue[];
}

function firstString(item: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

function readAnswer(item: Record<string, unknown>): string | string[] | undefined {
  for (const key of ANSWER_KEYS) {
    const value = item[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
    if (Array.isArray(value)) {
      const entries = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
      if (entries.length > 0) return entries;
    }
  }
  return undefined;
}

function readStringArray(
  item: Record<string, unknown>,
  keys: readonly string[],
): string[] | undefined {
  for (const key of keys) {
    const value = item[key];
    if (Array.isArray(value)) {
      const entries = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
      if (entries.length > 0) return entries;
    }
  }
  return undefined;
}

/**
 * Canonicalises the case of a TRUE/FALSE/NOT GIVEN answer.
 *
 * This is the one place a value is rewritten rather than reported, and it is
 * deliberate: `true` and `TRUE` are the same answer written two ways, so
 * matching them is reading the data, not inventing it. Anything outside the
 * three legal values is left exactly as written, so the schema rejects it.
 */
function canonicalStatementAnswer(value: string, legal: readonly string[]): string {
  const target = normalise(value);
  return legal.find((legalValue) => normalise(legalValue) === target) ?? value;
}

/**
 * Turns one loosely authored entry into a canonical question.
 *
 * Nothing is guessed. An unrecognised task type is an issue, not a gap fill; a
 * question with no answer key is an issue, not an unmarkable question shipped
 * to a learner; a question that fails a cross-field rule is an issue carrying
 * the reason.
 */
export function normalizeAuthoredQuestion(
  entry: unknown,
  fallbackId: string,
  fallbackNumber: number,
  index = 0,
): { ok: true; question: Question } | { ok: false; issue: QuestionIssue } {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { ok: false, issue: { index, reason: 'not_an_object' } };
  }

  const item = entry as Record<string, unknown>;
  const prompt = firstString(item, PROMPT_KEYS);
  const promptPreview = prompt?.slice(0, 120);

  if (!prompt) return { ok: false, issue: { index, reason: 'missing_prompt' } };

  const type = canonicalQuestionType(item.type);
  if (!type) {
    return {
      ok: false,
      issue: {
        index,
        reason: 'unknown_type',
        rawType: typeof item.type === 'string' ? item.type : undefined,
        promptPreview,
      },
    };
  }

  const rawAnswer = readAnswer(item);
  if (rawAnswer === undefined) {
    return { ok: false, issue: { index, reason: 'missing_answer', promptPreview } };
  }

  const legal = legalStatementAnswers(type);
  const correctAnswer = legal
    ? Array.isArray(rawAnswer)
      ? rawAnswer.map((a) => canonicalStatementAnswer(a, legal))
      : canonicalStatementAnswer(rawAnswer, legal)
    : rawAnswer;

  const rawNumber = NUMBER_KEYS.map((key) => item[key]).find((v) => typeof v === 'number');

  const candidate = {
    // A numeric editor id is a row counter, not a question id, so it is
    // replaced rather than coerced into a string that looks meaningful.
    id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : fallbackId,
    questionNumber: typeof rawNumber === 'number' ? rawNumber : fallbackNumber,
    type,
    instruction: firstString(item, INSTRUCTION_KEYS),
    prompt,
    options: readStringArray(item, ['options']),
    wordLimit: firstString(item, WORD_LIMIT_KEYS),
    correctAnswer,
    acceptableAnswers: readStringArray(item, ACCEPTABLE_KEYS),
    explanation: firstString(item, ['explanation']),
    layout: item.layout,
    mediaRef: item.mediaRef,
    group: firstString(item, ['group', 'groupId']),
    // Every stored question passes through here on write and again on read, so
    // a field not copied onto the candidate is a field that silently vanishes.
    // Provenance is the one that must never vanish: a generated question that
    // loses it can no longer be checked against the book it came from.
    provenance: item.provenance,
  };

  const parsed = QuestionSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      issue: {
        index,
        reason: 'invalid',
        promptPreview,
        details: parsed.error.issues.map(
          (issue) => `${issue.path.join('.') || 'question'}: ${issue.message}`,
        ),
      },
    };
  }

  return { ok: true, question: parsed.data };
}

/**
 * Normalises a whole authored array, reporting every entry it could not
 * convert. Callers decide what to do with `issues`: the learner path excludes
 * them, the admin path refuses the save, the import review shows them.
 */
export function normalizeAuthoredQuestions(raw: unknown, idPrefix: string): NormalizedQuestions {
  if (!Array.isArray(raw)) return { questions: [], issues: [] };

  const questions: Question[] = [];
  const issues: QuestionIssue[] = [];

  raw.forEach((entry, index) => {
    const result = normalizeAuthoredQuestion(entry, `${idPrefix}-q${index + 1}`, index + 1, index);
    if (result.ok) questions.push(result.question);
    else issues.push(result.issue);
  });

  return { questions, issues };
}

/** A one-line description of an issue, for admin-facing messages. */
export function describeQuestionIssue(issue: QuestionIssue): string {
  const at = `Question ${issue.index + 1}`;
  switch (issue.reason) {
    case 'not_an_object':
      return `${at}: not a question object.`;
    case 'missing_prompt':
      return `${at}: has no question text.`;
    case 'missing_answer':
      return `${at}: has no answer key, so it cannot be marked.`;
    case 'unknown_type':
      return `${at}: unrecognised task type${issue.rawType ? ` "${issue.rawType}"` : ''}.`;
    case 'invalid':
      return `${at}: ${issue.details?.join('; ') || 'failed validation.'}`;
  }
}
