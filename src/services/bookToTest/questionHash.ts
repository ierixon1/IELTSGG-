import { createHash } from 'node:crypto';
import type { Question } from '../../types';

/**
 * A fingerprint of what a reviewer actually looked at.
 *
 * A human confirmation of a flagged question is a statement about one version
 * of it. If the prompt, the options or the answer change afterwards, the
 * confirmation no longer covers what would be published, so the gate compares
 * this hash with the one recorded at confirmation time.
 *
 * The number and id are left out on purpose: renumbering a question does not
 * change what it asks or what it accepts.
 */
export function questionContentHash(question: Question): string {
  const canonical = {
    type: question.type,
    prompt: question.prompt,
    instruction: question.instruction ?? null,
    options: question.options ?? null,
    wordLimit: question.wordLimit ?? null,
    correctAnswer: question.correctAnswer,
    acceptableAnswers: question.acceptableAnswers ?? null,
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}
