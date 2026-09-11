import type { AnswerValue, SittingQuestion, SkillType } from '../types';
import type { SittableTest } from '../services/sittingAdapters';

/**
 * Practice marking, done on the server.
 *
 * A practice screen receives questions without their keys. When the learner
 * submits a Listening or Reading section, the answers go to the server, which
 * marks them against the same material the screen was built from and returns
 * what the practice screen has always shown after submission: each question's
 * verdict, its correct answer and its explanation, and the section score.
 * Before that request, the browser holds nothing that marks.
 */

/** What the practice screen is showing, so the server marks against exactly that. */
export type PracticeSource =
  | { kind: 'builtin' }
  | { kind: 'bundle'; bundleId: string }
  | { kind: 'material'; section: 'listening' | 'reading' | 'writing' | 'speaking'; materialId: string };

export type PracticeSection = 'listening' | 'reading';

export interface PracticeMarkRequest {
  source: PracticeSource;
  section: PracticeSection;
  answers: Record<string, AnswerValue>;
}

export interface PracticeQuestionFeedback {
  correct: boolean;
  /** The accepted answer as the paper prints it, one entry per alternative. */
  answers: string[];
  explanation?: string;
}

export interface PracticeMarking {
  section: PracticeSection;
  correct: number;
  total: number;
  band: number;
  results: Record<string, PracticeQuestionFeedback>;
}

/** A published test as practice receives it: no key anywhere, plus the sections it could not supply. */
export interface PracticeTest {
  test: SittableTest<SittingQuestion>;
  missingSections: SkillType[];
}
