import type { AnswerValue, Question } from '../types';
import { answerMatchesOption, normaliseAnswer } from './answerMatching';

/**
 * Official IELTS Academic Band conversion and rounding rules.
 */

export function calculateOverallBand(scores: {
  listening?: number;
  reading?: number;
  writing?: number;
  speaking?: number;
}): number {
  const validScores: number[] = [];
  if (typeof scores.listening === 'number' && scores.listening > 0) validScores.push(scores.listening);
  if (typeof scores.reading === 'number' && scores.reading > 0) validScores.push(scores.reading);
  if (typeof scores.writing === 'number' && scores.writing > 0) validScores.push(scores.writing);
  if (typeof scores.speaking === 'number' && scores.speaking > 0) validScores.push(scores.speaking);

  if (validScores.length === 0) return 0;

  const average = validScores.reduce((acc, curr) => acc + curr, 0) / validScores.length;
  return roundIeltsBand(average);
}

/**
 * Official IELTS Rounding Algorithm:
 * - If average ends in .25 -> round UP to .5 (e.g. 6.25 -> 6.5)
 * - If average ends in .75 -> round UP to whole band (e.g. 6.75 -> 7.0)
 * - If average ends in .125 -> round DOWN to .0 (e.g. 6.125 -> 6.0)
 * - If average ends in .375 -> round UP to .5 (e.g. 6.375 -> 6.5)
 * - If average ends in .625 -> round UP to .5 (e.g. 6.625 -> 6.5)
 * - If average ends in .875 -> round UP to whole band (e.g. 6.875 -> 7.0)
 */
export function roundIeltsBand(rawAverage: number): number {
  const whole = Math.floor(rawAverage);
  const decimal = rawAverage - whole;

  if (decimal < 0.25) {
    return whole;
  } else if (decimal < 0.75) {
    return whole + 0.5;
  } else {
    return whole + 1.0;
  }
}

/**
 * Raw score (0-40) to IELTS Band for Academic Listening
 */
export function listeningRawToBand(raw: number): number {
  if (raw >= 39) return 9.0;
  if (raw >= 37) return 8.5;
  if (raw >= 35) return 8.0;
  if (raw >= 32) return 7.5;
  if (raw >= 30) return 7.0;
  if (raw >= 26) return 6.5;
  if (raw >= 23) return 6.0;
  if (raw >= 18) return 5.5;
  if (raw >= 16) return 5.0;
  if (raw >= 13) return 4.5;
  if (raw >= 10) return 4.0;
  if (raw >= 7) return 3.5;
  if (raw >= 4) return 3.0;
  return 2.5;
}

/**
 * Raw score (0-40) to IELTS Band for Academic Reading
 */
export function readingRawToBand(raw: number): number {
  if (raw >= 39) return 9.0;
  if (raw >= 37) return 8.5;
  if (raw >= 35) return 8.0;
  if (raw >= 33) return 7.5;
  if (raw >= 30) return 7.0;
  if (raw >= 27) return 6.5;
  if (raw >= 23) return 6.0;
  if (raw >= 19) return 5.5;
  if (raw >= 15) return 5.0;
  if (raw >= 13) return 4.5;
  if (raw >= 10) return 4.0;
  if (raw >= 7) return 3.5;
  if (raw >= 4) return 3.0;
  return 2.5;
}

/**
 * Normalizes answer string and compares with correct answers (single or array of variants).
 */
export function checkAnswer(userAnswer: string, correctAnswer: string | string[]): boolean {
  if (!userAnswer || !correctAnswer) return false;

  const clean = (str: string) =>
    str
      .toLowerCase()
      .trim()
      .replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, '')
      .replace(/\s+/g, ' ');

  const userClean = clean(userAnswer);

  if (Array.isArray(correctAnswer)) {
    return correctAnswer.some(ans => clean(ans) === userClean);
  }

  return clean(correctAnswer) === userClean;
}

/**
 * Marks one question against what the learner actually entered.
 *
 * `checkAnswer` compares two strings and is right for everything typed into a
 * box. It is not enough for the rest:
 *
 *   - a multiple choice is answered by picking an option, and the key may be
 *     written as the option's label (`"B"`) or as its full text. Two questions
 *     in the built-in test are keyed by label, and because the radio stored the
 *     full option text they could not be answered correctly at all.
 *   - a multi-select carries a set, which has to match as a set: every correct
 *     option chosen, and nothing else.
 *
 * `acceptableAnswers` is carried through but not yet consulted — widening
 * answer matching is phase 12's work, and quietly half-doing it here would
 * make that phase harder to reason about.
 */
export function checkQuestionAnswer(question: Question, value: AnswerValue | undefined): boolean {
  const key = ([] as string[]).concat(question.correctAnswer as string | string[]);

  if (question.type === 'multi_select') {
    const chosen = (Array.isArray(value) ? value : value ? [value] : [])
      .map(normaliseAnswer)
      .filter(Boolean);
    // A set, so order does not matter and a duplicate click is not a second
    // answer.
    const unique = [...new Set(chosen)];
    if (unique.length !== key.length) return false;
    return key.every((expected) =>
      unique.some(
        (given) =>
          given === normaliseAnswer(expected) ||
          (question.options ? answerMatchesOption(given, expected) : false),
      ),
    );
  }

  const given = Array.isArray(value) ? value[0] ?? '' : value ?? '';
  if (!given) return false;

  // Anything answered by choosing accepts the label or the full option text,
  // in either direction: the key may be written either way too.
  if (question.options?.length) {
    return key.some(
      (expected) =>
        normaliseAnswer(expected) === normaliseAnswer(given) ||
        answerMatchesOption(given, expected) ||
        answerMatchesOption(expected, given),
    );
  }

  return checkAnswer(given, question.correctAnswer);
}
