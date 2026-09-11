/**
 * Removes answer keys and everything that points at them from loosely shaped
 * test data before it is sent to a learner.
 *
 * Practice tests and exam papers are built through typed adapters that simply
 * never copy these fields. This is for the one learner response that is not: a
 * generated mock, whose shape is whatever the generator returned. The field
 * names are the ones the generators and stored materials use for a key, its
 * alternatives, its explanation, where the evidence sits, and how the content
 * was made.
 */
const WITHHELD = new Set([
  'correctAnswer',
  'acceptableAnswers',
  'alternativeAnswers',
  'acceptedAnswers',
  'explanation',
  'paragraphLocation',
  'evidence',
  'provenance',
  'importRecord',
  'generationRecord',
  'generationReviews',
  'sourceAssetId',
  'needsReview',
  'customGradingCriteria',
]);

export type LearnerJson = string | number | boolean | null | LearnerJson[] | { [key: string]: LearnerJson };

export function withoutAnswerKeys(value: unknown): LearnerJson {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(withoutAnswerKeys);
  if (typeof value === 'object') {
    const out: { [key: string]: LearnerJson } = {};
    for (const [key, entry] of Object.entries(value)) {
      if (WITHHELD.has(key) || entry === undefined || typeof entry === 'function') continue;
      out[key] = withoutAnswerKeys(entry);
    }
    return out;
  }
  return null;
}
