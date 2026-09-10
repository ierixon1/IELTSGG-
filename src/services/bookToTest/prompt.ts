import { Type, type Schema } from '@google/genai';
import type { GeneratableType } from './types';

/**
 * The prompt contract.
 *
 * The model is given a goal, one question family, a count, and the retrieved
 * excerpts — each with its chunk id and location — and nothing else. It is told
 * in as many ways as it will listen that it may not use anything outside those
 * excerpts, and it is required to cite, for every question, the chunk and the
 * verbatim sentence its answer rests on.
 *
 * The citation requirement is not politeness. It is what makes validation
 * possible: a quote either appears in the chunk it names or it does not, and
 * that is checked in code rather than taken on trust.
 */

export interface PromptExcerpt {
  chunkId: string;
  /** "A", "B", … — the passage section this excerpt becomes. */
  label: string;
  text: string;
  page?: number;
  path: string[];
}

export interface GenerationPromptInput {
  topic: string;
  questionType: GeneratableType;
  count: number;
  excerpts: PromptExcerpt[];
}

export interface GenerationPrompt {
  systemInstruction: string;
  prompt: string;
  responseSchema: Schema;
}

const SYSTEM_INSTRUCTION = [
  'You write IELTS Academic Reading questions from source excerpts supplied in the request.',
  '',
  'Absolute rules:',
  '1. Use ONLY the text inside the SOURCE EXCERPTS. You have no other knowledge of this book or subject.',
  '2. Never state, imply or test a fact that the excerpts do not contain. Do not use outside knowledge, even if you are sure it is true.',
  '3. Every question must include "evidence": the chunkId of the excerpt it is based on and a quote copied WORD FOR WORD from that excerpt which supports the correct answer.',
  '4. Quotes must be copied exactly, with no paraphrasing, no ellipses and no added words. A quote that is not in the excerpt will cause the question to be discarded.',
  '5. If the excerpts cannot support the requested number of distinct, answerable questions, return fewer. Returning fewer is correct; inventing is not.',
  '6. Return JSON only, matching the response schema. No commentary.',
].join('\n');

const FAMILY_RULES: Record<GeneratableType, string> = {
  multiple_choice: [
    'multiple_choice: "prompt" is a question about the excerpts.',
    '"options" is exactly four answers, written "A. ...", "B. ...", "C. ...", "D. ...".',
    '"correctAnswer" is the single letter of the correct option.',
    'Exactly one option must be supported by the evidence; the other three must be plausible but not supported.',
  ].join(' '),
  true_false_not_given: [
    'true_false_not_given: "prompt" is a single statement.',
    'Omit "options".',
    '"correctAnswer" is exactly TRUE, FALSE or NOT GIVEN.',
    'TRUE: the evidence quote confirms the statement. FALSE: the evidence quote contradicts it.',
    'NOT GIVEN: the excerpts do not say; quote the closest related sentence as evidence.',
  ].join(' '),
  matching_headings: [
    'matching_headings: write one question per excerpt section.',
    '"prompt" is exactly "Section X", using the section label given for that excerpt.',
    '"options" is the SAME list in every question: headings written "i. ...", "ii. ...", "iii. ..." — one more heading than there are sections.',
    'Headings must summarise the section in your own words and must not copy the section\'s title.',
    '"correctAnswer" is the numeral of the heading that fits that section.',
    'The evidence chunkId must be that section\'s own chunkId.',
  ].join(' '),
  short_answer: [
    'short_answer: "prompt" is a question whose answer is a short phrase in the excerpt.',
    '"wordLimit" is "NO MORE THAN THREE WORDS".',
    '"correctAnswer" is copied word for word from the excerpt, and the evidence quote must contain it.',
  ].join(' '),
  sentence_completion: [
    'sentence_completion: "prompt" is a sentence based on the excerpt with the answer replaced by "______".',
    '"wordLimit" is "NO MORE THAN THREE WORDS".',
    '"correctAnswer" is the missing words, copied word for word from the excerpt, and the evidence quote must contain them.',
  ].join(' '),
};

const RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    questions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          type: { type: Type.STRING },
          prompt: { type: Type.STRING },
          options: { type: Type.ARRAY, items: { type: Type.STRING } },
          correctAnswer: { type: Type.STRING },
          wordLimit: { type: Type.STRING },
          evidence: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                chunkId: { type: Type.STRING },
                quote: { type: Type.STRING },
              },
              required: ['chunkId', 'quote'],
            },
          },
        },
        required: ['type', 'prompt', 'correctAnswer', 'evidence'],
      },
    },
  },
  required: ['questions'],
};

/** "Chapter 2 › Scanning · p. 4" */
function locationOf(excerpt: PromptExcerpt): string {
  const trail = excerpt.path.join(' › ') || 'untitled section';
  return excerpt.page ? `${trail} · page ${excerpt.page}` : trail;
}

export function buildGenerationPrompt(input: GenerationPromptInput): GenerationPrompt {
  const excerpts = input.excerpts
    .map((excerpt) =>
      [
        `<<<EXCERPT chunkId="${excerpt.chunkId}" section="${excerpt.label}" location="${locationOf(excerpt)}">`,
        excerpt.text,
        '>>>',
      ].join('\n'),
    )
    .join('\n\n');

  const prompt = [
    `GOAL: Write IELTS Academic Reading questions about: ${input.topic}`,
    `QUESTION FAMILY: ${input.questionType}`,
    `FAMILY RULES: ${FAMILY_RULES[input.questionType]}`,
    `NUMBER OF QUESTIONS: at most ${input.count}.`,
    'Every question must set "type" to exactly the question family above.',
    'Do not add any fact that is not in the excerpts below. If a detail is not in them, it does not exist.',
    '',
    'SOURCE EXCERPTS — the only material you may use:',
    '',
    excerpts,
  ].join('\n');

  return { systemInstruction: SYSTEM_INSTRUCTION, prompt, responseSchema: RESPONSE_SCHEMA };
}
