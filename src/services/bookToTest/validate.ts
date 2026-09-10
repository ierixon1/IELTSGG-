import type { Question, QuestionProvenance } from '../../types';
import type { SourceChunk } from '../../types/source';
import { QuestionSchema, TRUE_FALSE_ANSWERS } from '../../schemas/question';
import { answerMatchesOption, answerMatchesOptions } from '../../utils/answerMatching';
import { queryTerms } from '../sourceIngest/retrieve';
import type { PassageSection } from './passage';
import type { GeneratableType, GeneratedQuestionStatus } from './types';
import { GENERATOR_VERSION } from './version';

/**
 * Deciding what the model's output is worth.
 *
 *   generated question → provenance check → schema validation → evidence check
 *   → valid | needs_review | rejected
 *
 * The model's `correctAnswer` is a claim, not a fact. This module never changes
 * an answer, never picks a "better" option, and never fills in a missing field.
 * It can do three things with a question: accept it, send it to a human, or
 * refuse it — and every one of those comes with the reason.
 *
 * What is mechanically checkable is checked. What is not — whether a paraphrased
 * option really means what the source means, whether a statement is FALSE rather
 * than merely absent — is marked `needs_review`, because a heuristic that
 * "usually agrees" would quietly promote exactly the answers that are wrong.
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

/**
 * Reads the model's response as the JSON shape the prompt required.
 *
 * Strict on purpose: no stripping of code fences, no hunting for the first `{`.
 * The request asked for JSON; a response that is not JSON is a failed
 * generation, and treating it as one is more honest than repairing it.
 */
export function parseModelOutput(text: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    throw new ModelOutputError('The model did not return valid JSON.', 'invalid_json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ModelOutputError(
      'The model returned JSON, but not an object with a "questions" list.',
      'invalid_shape',
    );
  }
  const list = (parsed as Record<string, unknown>).questions;
  if (!Array.isArray(list)) {
    throw new ModelOutputError('The model response has no "questions" list.', 'invalid_shape');
  }
  if (list.length === 0) {
    throw new ModelOutputError(
      'The model returned no questions: the excerpts may not support this request.',
      'empty',
    );
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
  sourceId: string;
}

export interface ValidatedQuestion {
  generatedQuestionId: string;
  status: GeneratedQuestionStatus;
  reasons: string[];
  /** Present for `valid` and `needs_review`: schema-valid, with provenance. */
  question?: Question;
  /** What the model returned, verbatim, for display and the record. */
  candidate: Record<string, unknown>;
  evidence: Array<{ chunkId: string; quote: string }>;
  chunkIds: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** Case, curly quotes, dashes and whitespace do not make a quote a different quote. */
export function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

const contentWords = (value: string) => queryTerms(value).filter((term) => term.length > 2);

/** Share of `words` that occur in `haystack`, using the retrieval tokenizer for both. */
function coverage(words: string[], haystack: string): number {
  if (words.length === 0) return 0;
  const available = new Set(queryTerms(haystack));
  return words.filter((word) => available.has(word)).length / words.length;
}

const stripOptionLabel = (option: string) =>
  option.replace(/^\s*([A-Za-z]{1,4}|\d{1,3})\s*[.)\]:-]\s+/, '').trim();

const WORD_NUMBERS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

function wordLimitOf(limit: string): number | null {
  const match = /NO MORE THAN\s+(ONE|TWO|THREE|FOUR|FIVE|\d+)\s+WORDS?/i.exec(limit);
  if (!match) return null;
  const token = match[1].toUpperCase();
  return WORD_NUMBERS[token] ?? Number(token);
}

const percent = (value: number) => `${Math.round(value * 100)}%`;
const unique = <T>(values: T[]) => [...new Set(values)];

function validateOne(
  entry: unknown,
  index: number,
  context: ValidationContext,
  chunkById: Map<string, SourceChunk>,
  seenPrompts: Set<string>,
): ValidatedQuestion {
  const generatedQuestionId = `${context.generationId}-q${index + 1}`;
  const candidate = isRecord(entry) ? entry : { value: entry };
  let evidence: Array<{ chunkId: string; quote: string }> = [];
  let chunkIds: string[] = [];

  const reject = (reason: string): ValidatedQuestion => ({
    generatedQuestionId,
    status: 'rejected',
    reasons: [reason],
    candidate,
    evidence,
    chunkIds,
  });

  if (!isRecord(entry)) return reject('The model returned something that is not a question object.');
  if (index >= context.requestedCount) {
    return reject(`More questions came back than the ${context.requestedCount} requested; extras are not kept.`);
  }

  // 1. The family asked for, and nothing else.
  if (entry.type !== context.questionType) {
    return reject(
      `The model returned type "${String(entry.type)}", but only ${context.questionType} was requested.`,
    );
  }

  const prompt = text(entry.prompt);
  if (!prompt) return reject('The question has no prompt.');
  const promptKey = normalizeForMatch(prompt);
  if (seenPrompts.has(promptKey)) return reject('This question duplicates an earlier one.');
  seenPrompts.add(promptKey);

  // 2. Provenance: every citation must point at a supplied chunk and quote it exactly.
  if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
    return reject('The question carries no evidence, so its provenance cannot be established.');
  }
  for (const item of entry.evidence) {
    if (!isRecord(item) || !text(item.chunkId) || !text(item.quote)) {
      return reject('An evidence entry is missing its chunk id or its quote.');
    }
  }
  evidence = entry.evidence.map((item) => ({
    chunkId: text((item as Record<string, unknown>).chunkId),
    quote: text((item as Record<string, unknown>).quote),
  }));
  chunkIds = unique(evidence.map((item) => item.chunkId));

  for (const item of evidence) {
    const chunk = chunkById.get(item.chunkId);
    if (!chunk) {
      return reject(`Evidence cites chunk "${item.chunkId}", which was not supplied to the model.`);
    }
    if (normalizeForMatch(item.quote).split(' ').length < 4) {
      return reject(`The evidence quote "${item.quote}" is too short to verify against the source.`);
    }
    if (!normalizeForMatch(chunk.text).includes(normalizeForMatch(item.quote))) {
      return reject(
        `The evidence quote "${item.quote.slice(0, 90)}" does not appear in chunk ${item.chunkId}.`,
      );
    }
  }

  // 3. The answer, as the family defines it. Never corrected — only accepted or refused.
  const answer = text(entry.correctAnswer);
  if (!answer) return reject('The question has no answer.');

  const type = context.questionType;
  let options: string[] | undefined;
  let correctAnswer = answer;
  let wordLimit: string | undefined;

  if (type === 'multiple_choice' || type === 'matching_headings') {
    if (!Array.isArray(entry.options) || entry.options.some((option) => !text(option))) {
      return reject(`${type} needs a list of non-empty options.`);
    }
    options = entry.options.map((option) => text(option));
    if (options.length < 2) return reject(`${type} needs at least two options.`);
    const keys = options.map((option) => normalizeForMatch(stripOptionLabel(option)));
    if (new Set(keys).size !== keys.length) return reject('Two or more options are identical.');
    if (!answerMatchesOptions(answer, options)) {
      return reject(`The answer "${answer}" does not name one of the options.`);
    }
  } else if (type === 'true_false_not_given') {
    // Spelling only — "Not Given" and "NOT_GIVEN" are the same answer. A value
    // that is not one of the three is refused, not mapped to the nearest one.
    const spelled = answer.toUpperCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    if (!(TRUE_FALSE_ANSWERS as readonly string[]).includes(spelled)) {
      return reject(`true_false_not_given allows only TRUE, FALSE or NOT GIVEN — got "${answer}".`);
    }
    correctAnswer = spelled;
  } else {
    wordLimit = text(entry.wordLimit) || undefined;
    const limit = wordLimit ? wordLimitOf(wordLimit) : null;
    if (limit !== null && answer.split(/\s+/).length > limit) {
      return reject(`The answer "${answer}" is longer than its own word limit (${wordLimit}).`);
    }
    if (type === 'sentence_completion' && !/_{3,}|…|\.{3}/.test(prompt)) {
      return reject('The sentence has no gap for the answer to fill.');
    }
  }

  const locations = chunkIds.map((chunkId) => {
    const chunk = chunkById.get(chunkId) as SourceChunk;
    return { chunkId, page: chunk.location.page, path: chunk.location.path };
  });

  const provenance: QuestionProvenance = {
    kind: 'generated',
    generationId: context.generationId,
    generatedQuestionId,
    generatorVersion: GENERATOR_VERSION,
    model: context.model,
    generatedAt: context.generatedAt,
    sourceId: context.sourceId,
    chunkIds,
    pages: unique(
      locations.map((location) => location.page).filter((page): page is number => typeof page === 'number'),
    ).sort((a, b) => a - b),
    locations,
    evidence,
    validation: 'needs_review',
  };

  const question: Question = {
    id: generatedQuestionId,
    questionNumber: index + 1,
    type,
    prompt,
    options,
    wordLimit,
    correctAnswer,
    provenance,
  };

  // 4. The canonical schema, exactly as a hand-authored question would face it.
  const parsed = QuestionSchema.safeParse(question);
  if (!parsed.success) {
    return reject(
      `It is not a valid ${type} question: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
    );
  }

  // 5. Does the cited source actually establish the answer?
  const quotes = evidence.map((item) => item.quote).join(' ');
  const suppliedText = context.chunks.map((chunk) => chunk.text).join(' ');
  let status: 'valid' | 'needs_review' = 'needs_review';
  const reasons: string[] = [];

  if (type === 'short_answer' || type === 'sentence_completion') {
    if (normalizeForMatch(quotes).includes(normalizeForMatch(correctAnswer))) {
      status = 'valid';
    } else if (normalizeForMatch(suppliedText).includes(normalizeForMatch(correctAnswer))) {
      reasons.push('The answer is in the source, but not in the sentence cited as evidence.');
    } else {
      return reject(`The answer "${correctAnswer}" does not appear anywhere in the source text supplied to the model.`);
    }
  } else if (type === 'multiple_choice') {
    const list = options as string[];
    const keyed = list.find((option) => answerMatchesOption(correctAnswer, option)) as string;
    const keyedWords = contentWords(stripOptionLabel(keyed));
    const keyedCoverage = coverage(keyedWords, quotes);
    const bestRival = Math.max(
      0,
      ...list
        .filter((option) => option !== keyed)
        .map((option) => coverage(contentWords(stripOptionLabel(option)), quotes)),
    );

    if (keyedWords.length === 0) {
      reasons.push('The keyed option has no content words that could be checked against the evidence.');
    } else if (bestRival >= keyedCoverage && bestRival >= 0.6) {
      reasons.push('Another option is supported by the evidence at least as well as the keyed answer.');
    } else if (keyedCoverage >= 0.6) {
      status = 'valid';
    } else {
      reasons.push(
        `Only ${percent(keyedCoverage)} of the keyed option's words appear in the evidence; it may be a paraphrase that cannot be checked mechanically.`,
      );
    }
  } else if (type === 'true_false_not_given') {
    if (correctAnswer === 'TRUE') {
      const statementCoverage = coverage(contentWords(prompt), quotes);
      if (statementCoverage >= 0.8) status = 'valid';
      else {
        reasons.push(
          `Only ${percent(statementCoverage)} of the statement's words appear in the evidence, which is not enough to confirm TRUE mechanically.`,
        );
      }
    } else {
      reasons.push(
        `A ${correctAnswer} answer rests on contradiction or absence, which matching text cannot establish.`,
      );
    }
  } else {
    // matching_headings
    const label = /section\s+([A-Z])\b/i.exec(prompt)?.[1]?.toUpperCase();
    const section = context.sections.find((item) => item.label === label);
    if (!section) return reject('The prompt does not name one of the passage sections.');
    if (!chunkIds.includes(section.chunkId)) {
      return reject(`The evidence does not come from Section ${section.label}, which the question is about.`);
    }
    const sectionChunk = chunkById.get(section.chunkId) as SourceChunk;
    const sectionText = `${sectionChunk.heading ?? ''} ${sectionChunk.text}`;
    const list = options as string[];
    const keyed = list.find((option) => answerMatchesOption(correctAnswer, option)) as string;
    const keyedCoverage = coverage(contentWords(stripOptionLabel(keyed)), sectionText);
    const bestRival = Math.max(
      0,
      ...list
        .filter((option) => option !== keyed)
        .map((option) => coverage(contentWords(stripOptionLabel(option)), sectionText)),
    );
    if (keyedCoverage >= 0.5 && bestRival < keyedCoverage) status = 'valid';
    else {
      reasons.push(
        `The keyed heading shares ${percent(keyedCoverage)} of its words with Section ${section.label}; a closer or equal match exists or the heading is too abstract to check mechanically.`,
      );
    }
  }

  provenance.validation = status;
  return {
    generatedQuestionId,
    status,
    reasons,
    question: { ...question, provenance },
    candidate,
    evidence,
    chunkIds,
  };
}

/** Validates every returned question independently, in the order the model gave them. */
export function validateGeneratedQuestions(raw: unknown[], context: ValidationContext): ValidatedQuestion[] {
  const chunkById = new Map(context.chunks.map((chunk) => [chunk.id, chunk]));
  const seenPrompts = new Set<string>();
  return raw.map((entry, index) => validateOne(entry, index, context, chunkById, seenPrompts));
}
