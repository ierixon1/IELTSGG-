/**
 * The vocabulary of Book → Test, kept free of server dependencies so the write
 * schema and the admin screen can both import it.
 */

/**
 * The only question families this pipeline generates.
 *
 * Deliberately short. Each one has a deterministic check that can at least
 * partly establish its answer from source text; a family with no such check
 * would put every generated question straight into review, which is an honest
 * outcome but not a useful one.
 */
export const GENERATABLE_TYPES = [
  'multiple_choice',
  'true_false_not_given',
  'matching_headings',
  'short_answer',
  'sentence_completion',
] as const;

export type GeneratableType = (typeof GENERATABLE_TYPES)[number];

export function isGeneratableType(value: unknown): value is GeneratableType {
  return (GENERATABLE_TYPES as readonly string[]).includes(String(value));
}

/**
 * What validation concluded about one generated question.
 *
 * `valid` — schema-valid and its answer is established by the cited source text.
 * `needs_review` — schema-valid, but no deterministic check could establish the
 *   answer. It may enter a draft; it may not be published.
 * `rejected` — invalid, or contradicted by the source, or citing text that is
 *   not there. It never enters a material.
 */
export type GeneratedQuestionStatus = 'valid' | 'needs_review' | 'rejected';

export const MAX_GENERATED_QUESTIONS = 10;
