/**
 * The vocabulary of a verdict.
 *
 * Two dimensions are judged separately and recorded separately, because they
 * fail for different reasons and are fixed by different people:
 *
 *   grounding — is every claim the question makes, including its answer,
 *               established by the source text the model was given?
 *   quality   — is it a sound IELTS question: one defensible answer, plausible
 *               but wrong distractors, a statement that paraphrases rather than
 *               copies, a heading that fits its own section and no other?
 *
 * A question can be perfectly grounded and still be a bad question — "Drones
 * take no part in regulating temperature. TRUE." is both.
 *
 * The three statuses are the existing ones. There is deliberately no fourth:
 * "valid but poor" is `needs_review`, "grounded but broken" is `rejected`, and
 * a status a publish gate does not know about is a status a publish gate ignores.
 */

export type VerdictStatus = 'valid' | 'needs_review' | 'rejected';

export const REASON_CODES = [
  // grounding — structure and provenance
  'not_a_question_object',
  'over_requested_count',
  'type_not_requested',
  'prompt_missing',
  'duplicate_question',
  'question_evidence_missing',
  'answer_evidence_missing',
  'evidence_malformed',
  'evidence_chunk_not_supplied',
  'evidence_quote_not_in_source',
  'evidence_too_short',
  'answer_missing',
  'answer_not_an_option',
  'answer_not_allowed',
  'options_invalid',
  'schema_invalid',
  'section_not_named',
  'evidence_from_wrong_section',
  // grounding — does the evidence establish the answer
  'answer_not_in_evidence',
  'answer_not_in_source',
  'acceptable_answer_not_in_source',
  'answer_not_extractable',
  'evidence_weak',
  'answer_conflicts_with_evidence',
  'false_not_provable',
  'not_given_not_provable',
  // quality
  'answer_not_exclusive',
  'multiple_correct_options',
  'distractor_also_supported',
  'duplicate_options',
  'near_duplicate_options',
  'option_leaked_in_prompt',
  'answer_copied_verbatim',
  'question_not_answerable',
  'statement_unrelated_to_passage',
  'ambiguous_question',
  'word_limit_exceeded',
  'completion_missing_gap',
  'completion_changes_meaning',
  'heading_not_appropriate',
  'headings_ambiguous_between_sections',
  'heading_leaks_source_heading',
  'heading_used_twice',
  'section_answered_twice',
  'inconsistent_heading_list',
  'unused_heading_implausible',
  'semantic_review_required',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

export interface Reason {
  code: ReasonCode;
  message: string;
}

export interface Verdict {
  status: VerdictStatus;
  /**
   * False when this dimension was never looked at — quality is not judged for a
   * question that already failed grounding. Recorded rather than implied, so a
   * reviewer does not read "rejected" as "the quality checks failed".
   */
  evaluated: boolean;
  reasons: Reason[];
}

const RANK: Record<VerdictStatus, number> = { valid: 0, needs_review: 1, rejected: 2 };

/** The worse of two statuses: a question is only as good as its weakest dimension. */
export function worst(a: VerdictStatus, b: VerdictStatus): VerdictStatus {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * Accumulates findings for one dimension.
 *
 * Findings only ever lower a status. Nothing here can raise one: once a check
 * has said "needs review", no later check can say "fine after all".
 */
export class VerdictBuilder {
  private current: VerdictStatus = 'valid';
  private looked = true;
  private readonly found: Reason[] = [];

  private add(code: ReasonCode, message: string) {
    if (!this.found.some((reason) => reason.code === code && reason.message === message)) {
      this.found.push({ code, message });
    }
  }

  review(code: ReasonCode, message: string): void {
    this.current = worst(this.current, 'needs_review');
    this.add(code, message);
  }

  reject(code: ReasonCode, message: string): void {
    this.current = 'rejected';
    this.add(code, message);
  }

  /** Marks this dimension as not evaluated, because an earlier one ruled the question out. */
  skip(): void {
    this.looked = false;
  }

  get status(): VerdictStatus {
    return this.current;
  }

  get rejected(): boolean {
    return this.current === 'rejected';
  }

  build(): Verdict {
    return {
      // A dimension that was never evaluated cannot vouch for the question.
      status: this.looked ? this.current : 'rejected',
      evaluated: this.looked,
      reasons: [...this.found],
    };
  }
}
