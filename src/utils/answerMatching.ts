/**
 * Reading an answer against a set of options.
 *
 * The paper prints options as `A. to give an example`, and material answers
 * them either way: the built-in test keys some multiple choices by the full
 * option text and others by the bare letter. Both are correct, so both have to
 * match — and the same rule has to hold in two places at once, or the schema
 * and the marker disagree about the same question. It lives here rather than in
 * `schemas/question.ts` so the browser bundle does not have to carry Zod to
 * mark an answer.
 */

/** Whitespace and case are not part of an answer. */
export function normaliseAnswer(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The label an option is answered by: `A` from `"A. to give an example"`, `ii`
 * from `"ii. An old explanation"`. Empty when the option carries no label.
 */
export function optionLabel(option: string): string {
  const match = /^\s*([A-Za-z]{1,4}|\d{1,3})\s*[.)\]:-]\s+/.exec(option);
  return match ? match[1] : '';
}

/** True when `answer` names `option`, by full text or by its printed label. */
export function answerMatchesOption(answer: string, option: string): boolean {
  const target = normaliseAnswer(answer);
  if (!target) return false;
  const label = optionLabel(option);
  return normaliseAnswer(option) === target || (label !== '' && normaliseAnswer(label) === target);
}

/** True when `answer` names one of `options`. */
export function answerMatchesOptions(answer: string, options: readonly string[]): boolean {
  return options.some((option) => answerMatchesOption(answer, option));
}

/**
 * The value a control should store for an option.
 *
 * The label when the option carries one, so that what the learner picked is
 * recorded the way the answer key is written; the whole option otherwise.
 */
export function optionValue(option: string): string {
  return optionLabel(option) || option;
}
