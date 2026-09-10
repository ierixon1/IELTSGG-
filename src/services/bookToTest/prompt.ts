import { Type, type Schema } from '@google/genai';
import type { GeneratableType } from './types';

/**
 * The prompt contract, version 2.
 *
 * The model is given a goal, one question family, a count, and the retrieved
 * excerpts — each with its chunk id and location — and nothing else. Every
 * question must now separate three kinds of evidence:
 *
 *   questionEvidence   the sentence(s) the question is about
 *   answerEvidence     the verbatim text that establishes the correct answer
 *   distractorEvidence why each wrong option is wrong
 *
 * The separation is what lets validation ask the right question of each: the
 * answer must be established by the answer evidence, not merely present
 * somewhere in the passage. The model's distractor account is recorded and
 * never trusted; validation measures distractor support itself.
 */

export interface PromptExcerpt {
  chunkId: string;
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
  '3. Every question must cite evidence, copied WORD FOR WORD from an excerpt, with that excerpt\'s chunkId:',
  '   - "questionEvidence": the sentence or sentences the question is about;',
  '   - "answerEvidence": the text that establishes the correct answer (leave it empty only for NOT GIVEN);',
  '   - "distractorEvidence": for each wrong option, why it is wrong.',
  '4. Quotes must be copied exactly, with no paraphrasing, no ellipses and no added words. A quote that is not in the excerpt will cause the question to be discarded.',
  '5. Each question must have exactly one defensible answer. If another answer from the excerpts would be equally correct, rewrite the question, or list those answers in "acceptableAnswers".',
  '6. If the excerpts cannot support the requested number of sound questions, return fewer. Returning fewer is correct; inventing is not.',
  '7. Return JSON only, matching the response schema. No commentary.',
].join('\n');

const FAMILY_RULES: Record<GeneratableType, string> = {
  multiple_choice: [
    'multiple_choice: "prompt" is a question about the excerpts that does not repeat the wording of its correct option.',
    '"options" is exactly four answers written "A. ...", "B. ...", "C. ...", "D. ...".',
    '"correctAnswer" is the single letter of the correct option.',
    'Exactly one option must be stated or directly supported by the excerpts. The other three must be plausible but NOT stated as true anywhere in the excerpts.',
    'Explain each wrong option in "distractorEvidence".',
  ].join(' '),
  true_false_not_given: [
    'true_false_not_given: "prompt" is a single statement that paraphrases rather than copies the excerpt. Omit "options".',
    '"correctAnswer" is exactly TRUE, FALSE or NOT GIVEN.',
    'TRUE: "answerEvidence" states the same fact.',
    'FALSE: "answerEvidence" is the sentence that explicitly contradicts the statement — a negation, an opposite term or a different figure.',
    'NOT GIVEN: the excerpts neither confirm nor contradict the statement. Leave "answerEvidence" empty and give the closest related sentence as "questionEvidence".',
    'Do not add words such as "always", "only" or "never" that the excerpt does not use, and do not drop its hedges such as "usually" or "about".',
  ].join(' '),
  matching_headings: [
    'matching_headings: write exactly one question per excerpt section.',
    '"prompt" is exactly "Section X", using the section label given for that excerpt.',
    '"options" is the SAME list in every question: headings written "i. ...", "ii. ...", "iii. ..." — one more heading than there are sections.',
    'Each heading is used as the answer for at most one section. Headings summarise a section in your own words and must not copy its title.',
    'The spare heading must be plausible for this passage but fit no section.',
    '"correctAnswer" is the numeral of the heading that fits that section. The answer evidence must come from that section.',
  ].join(' '),
  short_answer: [
    'short_answer: "prompt" is a question whose answer is a short phrase copied from the excerpt.',
    '"wordLimit" is "NO MORE THAN THREE WORDS".',
    '"correctAnswer" is copied word for word from the excerpt, and "answerEvidence" must contain it.',
    'Do not ask for one item of a list unless the question makes clear which item is meant.',
  ].join(' '),
  sentence_completion: [
    'sentence_completion: "prompt" is a sentence that keeps the excerpt\'s meaning, with the answer replaced by "______".',
    '"wordLimit" is "NO MORE THAN THREE WORDS".',
    '"correctAnswer" is the missing words, copied word for word from the excerpt, and "answerEvidence" must contain them.',
    'The completed sentence must not change what the excerpt says.',
  ].join(' '),
};

const EVIDENCE_ITEM: Schema = {
  type: Type.OBJECT,
  properties: {
    chunkId: { type: Type.STRING },
    quote: { type: Type.STRING },
  },
  required: ['chunkId', 'quote'],
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
          acceptableAnswers: { type: Type.ARRAY, items: { type: Type.STRING } },
          wordLimit: { type: Type.STRING },
          questionEvidence: { type: Type.ARRAY, items: EVIDENCE_ITEM },
          answerEvidence: { type: Type.ARRAY, items: EVIDENCE_ITEM },
          distractorEvidence: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                option: { type: Type.STRING },
                chunkId: { type: Type.STRING },
                quote: { type: Type.STRING },
                reason: { type: Type.STRING },
              },
              required: ['option', 'reason'],
            },
          },
        },
        required: ['type', 'prompt', 'correctAnswer', 'questionEvidence', 'answerEvidence'],
      },
    },
  },
  required: ['questions'],
};

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
