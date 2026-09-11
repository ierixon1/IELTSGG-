import type { Question, QuestionProvenance } from '../../types';
import type { SourceChunk } from '../../types/source';
import { QuestionSchema, TRUE_FALSE_ANSWERS } from '../../schemas/question';
import { answerMatchesOptions } from '../../utils/answerMatching';
import type { PassageSection } from './passage';
import type { GeneratableType, GeneratedQuestionStatus } from './types';
import { GENERATOR_VERSION } from './version';
import { VerdictBuilder, worst, type Verdict } from './quality/reasons';
import { checkFamily, checkHeadingSet, type EvidenceItem, type HeadingInfo } from './quality/families';
import { normalizeForMatch, sentencesOf, stripOptionLabel } from './quality/text';

export { normalizeForMatch } from './quality/text';
export type { EvidenceItem } from './quality/families';

/**
 * Deciding what the model's output is worth.
 *
 *   generated question → provenance → schema → grounding → IELTS quality
 *   → valid | needs_review | rejected
 *
 * The model's `correctAnswer` is a claim. This module never changes it, never
 * picks a "better" option and never fills a missing field. It accepts, sends to
 * a human, or refuses — and says why, in machine-readable codes, separately for
 * whether the question is grounded in the source and whether it is a sound IELTS
 * question.
 *
 * Evidence comes in three kinds and they are not interchangeable: the sentence
 * a question is *about*, the text that establishes its *answer*, and the model's
 * account of why each *distractor* is wrong. An answer string appearing somewhere
 * in the passage is not answer evidence; a distractor rationale from the model is
 * recorded, never trusted.
 */

export class ModelOutputError extends Error {
  constructor(
    message: string,
    readonly kind: 'invalid_json' | 'invalid_shape' | 'empty',
  ) {
    super(message);
    this.name = 'ModelOutputError';
  }
}

/** Reads the model's response as the JSON the prompt required, and nothing more lenient. */
export function parseModelOutput(text: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    throw new ModelOutputError('The model did not return valid JSON.', 'invalid_json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ModelOutputError('The model returned JSON, but not an object with a "questions" list.', 'invalid_shape');
  }
  const list = (parsed as Record<string, unknown>).questions;
  if (!Array.isArray(list)) {
    throw new ModelOutputError('The model response has no "questions" list.', 'invalid_shape');
  }
  if (list.length === 0) {
    throw new ModelOutputError('The model returned no questions: the excerpts may not support this request.', 'empty');
  }
  return list;
}

export interface ValidationContext {
  questionType: GeneratableType;
  requestedCount: number;
  /** Exactly the chunks that were in the prompt — nothing else counts as source. */
  chunks: SourceChunk[];
  sections: PassageSection[];
  generationId: string;
  generatedAt: string;
  model: string;
  /** What the provider reported answering with; recorded on every question it wrote. */
  modelVersion?: string;
  promptVersion: string;
  sourceId: string;
}

export interface DistractorEvidence {
  option: string;
  chunkId?: string;
  quote?: string;
  reason?: string;
}

export interface ValidatedQuestion {
  generatedQuestionId: string;
  status: GeneratedQuestionStatus;
  groundingVerdict: Verdict;
  qualityVerdict: Verdict;
  /** Every reason as a sentence, grounding first. */
  reasons: string[];
  /** Present unless rejected: schema-valid, with provenance. */
  question?: Question;
  candidate: Record<string, unknown>;
  questionEvidence: EvidenceItem[];
  answerEvidence: EvidenceItem[];
  /** The model's own account of its distractors. Recorded, not trusted. */
  distractorEvidence: DistractorEvidence[];
  /** Answer evidence, or question evidence where there is none (NOT GIVEN). */
  evidence: EvidenceItem[];
  chunkIds: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const unique = <T>(values: T[]) => [...new Set(values)];

function readEvidence(value: unknown): EvidenceItem[] | 'malformed' {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return 'malformed';
  const items: EvidenceItem[] = [];
  for (const item of value) {
    if (!isRecord(item) || !text(item.chunkId) || !text(item.quote)) return 'malformed';
    items.push({ chunkId: text(item.chunkId), quote: text(item.quote) });
  }
  return items;
}

function readDistractors(value: unknown): DistractorEvidence[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .filter((item) => text(item.option))
    .slice(0, 10)
    .map((item) => ({
      option: text(item.option).slice(0, 1000),
      chunkId: text(item.chunkId) || undefined,
      quote: text(item.quote).slice(0, 2000) || undefined,
      reason: text(item.reason).slice(0, 1000) || undefined,
    }));
}

interface Pending {
  generatedQuestionId: string;
  candidate: Record<string, unknown>;
  grounding: VerdictBuilder;
  quality: VerdictBuilder;
  questionEvidence: EvidenceItem[];
  answerEvidence: EvidenceItem[];
  distractorEvidence: DistractorEvidence[];
  question?: Question;
  heading?: HeadingInfo;
}

function assess(
  entry: unknown,
  index: number,
  context: ValidationContext,
  chunkById: Map<string, SourceChunk>,
  seenPrompts: Set<string>,
  family: { sentences: ReturnType<typeof sentencesOf>; passageText: string },
): Pending {
  const pending: Pending = {
    generatedQuestionId: `${context.generationId}-q${index + 1}`,
    candidate: isRecord(entry) ? entry : { value: entry },
    grounding: new VerdictBuilder(),
    quality: new VerdictBuilder(),
    questionEvidence: [],
    answerEvidence: [],
    distractorEvidence: [],
  };
  const { grounding, quality } = pending;
  const stop = (code: Parameters<VerdictBuilder['reject']>[0], message: string) => {
    grounding.reject(code, message);
    quality.skip();
    return pending;
  };

  if (!isRecord(entry)) return stop('not_a_question_object', 'The model returned something that is not a question object.');
  if (index >= context.requestedCount) {
    return stop('over_requested_count', `More questions came back than the ${context.requestedCount} requested; extras are not kept.`);
  }
  if (entry.type !== context.questionType) {
    return stop('type_not_requested', `The model returned type "${String(entry.type)}", but only ${context.questionType} was requested.`);
  }

  const prompt = text(entry.prompt);
  if (!prompt) return stop('prompt_missing', 'The question has no prompt.');
  const promptKey = normalizeForMatch(prompt);
  if (seenPrompts.has(promptKey)) return stop('duplicate_question', 'This question duplicates an earlier one.');
  seenPrompts.add(promptKey);

  const answer = text(entry.correctAnswer);
  if (!answer) return stop('answer_missing', 'The question has no answer.');

  const type = context.questionType;
  let correctAnswer = answer;
  if (type === 'true_false_not_given') {
    const spelled = answer.toUpperCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    if (!(TRUE_FALSE_ANSWERS as readonly string[]).includes(spelled)) {
      return stop('answer_not_allowed', `true_false_not_given allows only TRUE, FALSE or NOT GIVEN — got "${answer}".`);
    }
    correctAnswer = spelled;
  }

  // Provenance: what the question is about, and what establishes its answer.
  const questionEvidence = readEvidence(entry.questionEvidence);
  const answerEvidence = readEvidence(entry.answerEvidence);
  if (questionEvidence === 'malformed' || answerEvidence === 'malformed') {
    return stop('evidence_malformed', 'An evidence entry is missing its chunk id or its quote.');
  }
  pending.questionEvidence = questionEvidence;
  pending.answerEvidence = answerEvidence;
  pending.distractorEvidence = readDistractors(entry.distractorEvidence);

  if (questionEvidence.length === 0) {
    return stop('question_evidence_missing', 'The question cites no question evidence, so what it is about cannot be traced to the source.');
  }
  if (answerEvidence.length === 0 && correctAnswer !== 'NOT GIVEN') {
    return stop('answer_evidence_missing', 'The question cites no answer evidence, so its answer cannot be traced to the source.');
  }
  for (const item of [...questionEvidence, ...answerEvidence]) {
    const chunk = chunkById.get(item.chunkId);
    if (!chunk) return stop('evidence_chunk_not_supplied', `Evidence cites chunk "${item.chunkId}", which was not supplied to the model.`);
    if (normalizeForMatch(item.quote).split(' ').length < 4) {
      return stop('evidence_too_short', `The evidence quote "${item.quote}" is too short to verify against the source.`);
    }
    if (!normalizeForMatch(chunk.text).includes(normalizeForMatch(item.quote))) {
      return stop('evidence_quote_not_in_source', `The evidence quote "${item.quote.slice(0, 90)}" does not appear in chunk ${item.chunkId}.`);
    }
  }

  let options: string[] | undefined;
  if (type === 'multiple_choice' || type === 'matching_headings') {
    if (!Array.isArray(entry.options) || entry.options.some((option) => !text(option))) {
      return stop('options_invalid', `${type} needs a list of non-empty options.`);
    }
    options = entry.options.map((option) => text(option));
    if (options.length < 2) return stop('options_invalid', `${type} needs at least two options.`);
    const keys = options.map((option) => normalizeForMatch(stripOptionLabel(option)));
    if (new Set(keys).size !== keys.length) {
      grounding.reject('options_invalid', 'Two or more options are identical.');
      quality.reject('duplicate_options', 'Two or more options are identical.');
      return pending;
    }
    if (!answerMatchesOptions(answer, options)) {
      return stop('answer_not_an_option', `The answer "${answer}" does not name one of the options.`);
    }
  }

  const acceptableAnswers = Array.isArray(entry.acceptableAnswers)
    ? unique(entry.acceptableAnswers.map((value) => text(value)).filter(Boolean)).filter(
        (value) => normalizeForMatch(value) !== normalizeForMatch(correctAnswer),
      )
    : [];
  const wordLimit = text(entry.wordLimit) || undefined;
  const chunkIds = unique([...answerEvidence, ...questionEvidence].map((item) => item.chunkId));
  const locations = chunkIds.map((chunkId) => {
    const chunk = chunkById.get(chunkId) as SourceChunk;
    return { chunkId, page: chunk.location.page, path: chunk.location.path };
  });

  const provenance: QuestionProvenance = {
    kind: 'generated',
    generationId: context.generationId,
    generatedQuestionId: pending.generatedQuestionId,
    generatorVersion: GENERATOR_VERSION,
    promptVersion: context.promptVersion,
    model: context.model,
    ...(context.modelVersion ? { modelVersion: context.modelVersion } : {}),
    generatedAt: context.generatedAt,
    sourceId: context.sourceId,
    chunkIds,
    pages: unique(
      locations.map((location) => location.page).filter((page): page is number => typeof page === 'number'),
    ).sort((a, b) => a - b),
    locations,
    evidence: answerEvidence.length > 0 ? answerEvidence : questionEvidence,
    questionEvidence,
    answerEvidence,
    distractorEvidence: pending.distractorEvidence,
    validation: 'needs_review',
  };

  const question: Question = {
    id: pending.generatedQuestionId,
    questionNumber: index + 1,
    type,
    prompt,
    options: type === 'true_false_not_given' ? undefined : options,
    wordLimit: type === 'short_answer' || type === 'sentence_completion' ? wordLimit : undefined,
    correctAnswer,
    acceptableAnswers: acceptableAnswers.length > 0 ? acceptableAnswers : undefined,
    provenance,
  };

  const parsed = QuestionSchema.safeParse(question);
  if (!parsed.success) {
    return stop('schema_invalid', `It is not a valid ${type} question: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
  }
  pending.question = question;

  pending.heading = checkFamily(
    {
      type,
      prompt,
      options,
      correctAnswer,
      acceptableAnswers,
      wordLimit,
      questionEvidence,
      answerEvidence,
    },
    { chunks: context.chunks, sections: context.sections, sentences: family.sentences, passageText: family.passageText },
    grounding,
    quality,
  );
  if (grounding.rejected) quality.skip();
  return pending;
}

/** Validates every returned question, then checks the heading set as a set. */
export function validateGeneratedQuestions(raw: unknown[], context: ValidationContext): ValidatedQuestion[] {
  const chunkById = new Map(context.chunks.map((chunk) => [chunk.id, chunk]));
  const seenPrompts = new Set<string>();
  const family = {
    sentences: sentencesOf(context.chunks),
    passageText: context.chunks.map((chunk) => chunk.text).join('\n\n'),
  };

  const pending = raw.map((entry, index) => assess(entry, index, context, chunkById, seenPrompts, family));

  checkHeadingSet(
    pending
      .filter((item) => item.heading && !item.grounding.rejected)
      .map((item) => ({ info: item.heading as HeadingInfo, quality: item.quality })),
    { chunks: context.chunks, sections: context.sections, sentences: family.sentences, passageText: family.passageText },
  );

  return pending.map((item) => {
    const groundingVerdict = item.grounding.build();
    const qualityVerdict = item.quality.build();
    const status = worst(groundingVerdict.status, qualityVerdict.status);
    const reasons = [...groundingVerdict.reasons, ...qualityVerdict.reasons].map((reason) => reason.message);

    let question: Question | undefined;
    if (item.question && status !== 'rejected' && item.question.provenance) {
      question = {
        ...item.question,
        provenance: {
          ...item.question.provenance,
          validation: status,
          groundingStatus: groundingVerdict.status === 'valid' ? 'valid' : 'needs_review',
          qualityStatus: qualityVerdict.status === 'valid' ? 'valid' : 'needs_review',
        },
      };
    }

    const evidence = item.answerEvidence.length > 0 ? item.answerEvidence : item.questionEvidence;
    return {
      generatedQuestionId: item.generatedQuestionId,
      status,
      groundingVerdict,
      qualityVerdict,
      reasons,
      question,
      candidate: item.candidate,
      questionEvidence: item.questionEvidence,
      answerEvidence: item.answerEvidence,
      distractorEvidence: item.distractorEvidence,
      evidence,
      chunkIds: unique([...item.answerEvidence, ...item.questionEvidence].map((entry) => entry.chunkId)),
    };
  });
}
