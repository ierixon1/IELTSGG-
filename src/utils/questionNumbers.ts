/**
 * The first and last question numbers of a set of questions, the way an IELTS
 * paper heads them: Listening Part 2 is "Questions 11–20", not a second
 * "Questions 1–10". The numbers are the ones the material carries, so the
 * heading and the numbered questions under it always agree.
 *
 * Null for an empty set, which has no range to print.
 */
export function questionNumberRange(questions: ReadonlyArray<{ questionNumber: number }>): { first: number; last: number } | null {
  if (questions.length === 0) return null;
  const numbers = questions.map((question) => question.questionNumber);
  return { first: Math.min(...numbers), last: Math.max(...numbers) };
}
