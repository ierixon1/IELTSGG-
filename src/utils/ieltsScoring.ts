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
