/**
 * What produced a generated question, recorded on every one of them.
 *
 * Bump `PROMPT_VERSION` when the prompt contract changes, and
 * `GENERATOR_VERSION` when the validation rules change: a question that was
 * accepted under an older rule is not wrong, but a reviewer looking at it next
 * year needs to know which rules it passed.
 */
export const GENERATOR_VERSION = 'book-to-test/reading/1.0.0';
export const PROMPT_VERSION = 'reading-grounded/1.0.0';

/**
 * The model the rest of the server already uses for structured generation, so
 * this pipeline is not quietly on a different model from the mock generator.
 */
export const GENERATION_MODEL = 'gemini-3.8-flash';

/** Never more chunks than this in one prompt, however many retrieval returns. */
export const MAX_CHUNKS_PER_GENERATION = 4;
/** And never more source text than this, so the passage stays a passage. */
export const MAX_PASSAGE_CHARACTERS = 6000;
