import { QuestionType, Question } from '../types';

/**
 * The single canonical representation of an authored question.
 *
 * Questions reach the learner from three different authors — the admin
 * editors, the Gemini generators, and (later) the CDI HTML importer — and each
 * of them used to invent its own field names. `questionText` vs `prompt` and
 * `instructions` vs `instruction` were not cosmetic: the learner adapter read
 * the canonical name, found nothing, and rendered an empty question while the
 * admin preview (reading the editor's own name) looked perfectly correct.
 *
 * Everything that produces questions now normalises through this module, and
 * the canonical names are the ones declared on `Question` in `src/types.ts`.
 * Legacy aliases are still accepted on read so material saved by older builds
 * keeps working, but nothing new should write them.
 */

/** Canonical field names. Anything else here is a legacy alias. */
const PROMPT_KEYS = ['prompt', 'questionText', 'question', 'text'] as const;
const INSTRUCTION_KEYS = ['instruction', 'instructions'] as const;
const ANSWER_KEYS = ['correctAnswer', 'answer'] as const;
const ACCEPTABLE_KEYS = ['acceptableAnswers', 'alternativeAnswers', 'acceptedAnswers'] as const;
const WORD_LIMIT_KEYS = ['wordLimit', 'wordLimitText'] as const;
const NUMBER_KEYS = ['questionNumber', 'number'] as const;

/**
 * Every spelling of a task type that has ever been written into this codebase,
 * mapped onto the one the engine renders.
 *
 * The four-way split between `diagram_label_completion` (taxonomy and the
 * reading generator), `diagram_label` (the engine), `map_diagram_labelling`
 * (taxonomy) and `map_label` (the engine) is the reason this table exists: the
 * adapter used to coerce anything it did not recognise to `fill_in_blank`,
 * which turned a map-labelling task into a bare text box without reporting
 * anything.
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

const CANONICAL_TYPES: readonly QuestionType[] = [
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
];

export function isCanonicalQuestionType(value: unknown): value is QuestionType {
  return typeof value === 'string' && CANONICAL_TYPES.includes(value as QuestionType);
}

/**
 * Resolves any written task type onto the canonical one, or `null` when it is
 * genuinely unrecognised. `null` is never silently replaced with a gap fill —
 * see `normalizeAuthoredQuestions`.
 */
export function canonicalQuestionType(value: unknown): QuestionType | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (isCanonicalQuestionType(key)) return key;
  return QUESTION_TYPE_ALIASES[key] ?? null;
}

/** Why one authored entry could not become a question. */
export type QuestionIssueReason =
  | 'not_an_object'
  | 'missing_prompt'
  | 'missing_answer'
  | 'unknown_type';

export interface QuestionIssue {
  /** Position in the authored array, so the admin can find it. */
  index: number;
  reason: QuestionIssueReason;
  /** The type as written, when that is what went wrong. */
  rawType?: string;
  /** The prompt as written, to identify the question in a report. */
  promptPreview?: string;
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

function readAcceptable(item: Record<string, unknown>): string[] | undefined {
  for (const key of ACCEPTABLE_KEYS) {
    const value = item[key];
    if (Array.isArray(value)) {
      const entries = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
      if (entries.length > 0) return entries;
    }
  }
  return undefined;
}

/**
 * Turns loosely authored JSON into canonical `Question`s, reporting every
 * entry it could not convert.
 *
 * Nothing is guessed. An unrecognised task type is an issue, not a gap fill; a
 * question with no answer key is an issue, not an unmarkable question shipped
 * to a learner. Callers decide what to do with `issues` — the learner path
 * excludes them, the import review screen shows them for correction.
 */
export function normalizeAuthoredQuestions(raw: unknown, idPrefix: string): NormalizedQuestions {
  if (!Array.isArray(raw)) return { questions: [], issues: [] };

  const questions: Question[] = [];
  const issues: QuestionIssue[] = [];

  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      issues.push({ index, reason: 'not_an_object' });
      return;
    }

    const item = entry as Record<string, unknown>;
    const prompt = firstString(item, PROMPT_KEYS);
    const promptPreview = prompt?.slice(0, 120);

    if (!prompt) {
      issues.push({ index, reason: 'missing_prompt' });
      return;
    }

    const type = canonicalQuestionType(item.type);
    if (!type) {
      issues.push({
        index,
        reason: 'unknown_type',
        rawType: typeof item.type === 'string' ? item.type : undefined,
        promptPreview,
      });
      return;
    }

    const correctAnswer = readAnswer(item);
    if (correctAnswer === undefined) {
      issues.push({ index, reason: 'missing_answer', promptPreview });
      return;
    }

    const options = Array.isArray(item.options)
      ? item.options.filter((o): o is string => typeof o === 'string')
      : undefined;

    const rawNumber = NUMBER_KEYS.map((key) => item[key]).find((v) => typeof v === 'number');

    questions.push({
      id: typeof item.id === 'string' && item.id ? item.id : `${idPrefix}-q${index + 1}`,
      questionNumber: typeof rawNumber === 'number' ? rawNumber : index + 1,
      type,
      instruction: firstString(item, INSTRUCTION_KEYS),
      prompt,
      options: options && options.length > 0 ? options : undefined,
      wordLimit: firstString(item, WORD_LIMIT_KEYS),
      correctAnswer,
      acceptableAnswers: readAcceptable(item),
      explanation: typeof item.explanation === 'string' ? item.explanation : undefined,
    });
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
  }
}
