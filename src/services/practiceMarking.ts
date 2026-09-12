import type { AnswerValue, Question } from '../types';
import type { LearnerBundleErrorCode } from '../types/bundle';
import type { PracticeMarking, PracticeSection, PracticeSource, PracticeTest } from '../types/practice';
import { checkQuestionAnswer, objectiveSectionScore } from '../utils/ieltsScoring';
import { adminStore } from './adminStore';
import { openSitting } from './bundleService';
import { builtInSittableTest } from './publishedTests';
import { materialToSittable, sittingToAdaptedTest, toPracticeTest, type AdaptedTest } from './sittingAdapters';
import { toLearnerMaterial } from './sittingView';
import { EXAM_CONTENT_REFUSAL, loadExamUse, practiceEligibility } from './practiceEligibility';

/**
 * The practice test a learner opens, and the marking of what they submit.
 *
 * Both are built from the same adapted test, so the questions the server marks
 * are exactly the questions the screen showed — same ids, same normalisation —
 * and the score is `objectiveSectionScore`, the function practice has always
 * used. Only the place it runs has moved.
 */

export type PracticeFailure = { ok: false; status: number; code: LearnerBundleErrorCode | 'material_not_found' | 'section_not_in_test' | 'exam_content'; error: string };
export type PracticeOutcome<T> = { ok: true; value: T } | PracticeFailure;

const notFound = (): PracticeFailure => ({ ok: false, status: 404, code: 'material_not_found', error: 'Published test not found.' });
const examContent = (): PracticeFailure => ({ ok: false, ...EXAM_CONTENT_REFUSAL });

/**
 * The adapted test, keys included, for a practice source. Server-side only.
 *
 * The one place practice content is resolved — for the practice screen and for
 * marking alike — so the exam/practice policy (`practiceEligibility`) decides
 * both before any content, let alone a key, is built.
 */
async function adaptedFor(source: PracticeSource): Promise<PracticeOutcome<AdaptedTest>> {
  if (source.kind === 'builtin') return { ok: true, value: { test: builtInSittableTest(), missingSections: [], issues: {} } };
  if (source.kind === 'bundle') {
    const outcome = await openSitting(source.bundleId);
    if (!outcome.ok) return { ok: false, status: outcome.status, code: outcome.code, error: outcome.error };
    // A bundle that opens is published, so every material it pins is exam content.
    const use = await loadExamUse();
    if (outcome.sitting.components.some((component) => !practiceEligibility(component.materialId, use).allowed)) return examContent();
    return { ok: true, value: sittingToAdaptedTest(outcome.sitting) };
  }
  const material = await adminStore.getMaterial(source.section, source.materialId);
  if (!material || material.status !== 'published') return notFound();
  if (!practiceEligibility(material.id, await loadExamUse()).allowed) return examContent();
  return { ok: true, value: materialToSittable(toLearnerMaterial(material, { keepTranscript: true })) };
}

/** A published practice test with every key removed, as the learner receives it. */
export async function practiceTestFor(source: Exclude<PracticeSource, { kind: 'builtin' }>): Promise<PracticeOutcome<PracticeTest>> {
  const adapted = await adaptedFor(source);
  if (!adapted.ok) return adapted;
  return { ok: true, value: { test: toPracticeTest(adapted.value.test), missingSections: adapted.value.missingSections } };
}

function questionsOf(adapted: AdaptedTest, section: PracticeSection): Question[] | null {
  if (section === 'listening') return adapted.test.listening ? adapted.test.listening.parts.flatMap((part) => part.questions) : null;
  return adapted.test.reading ? adapted.test.reading.passages.flatMap((passage) => passage.questions) : null;
}

/** Marks one submitted section and returns the feedback practice shows after submission. */
export async function markPractice(
  source: PracticeSource,
  section: PracticeSection,
  answers: Record<string, AnswerValue>,
): Promise<PracticeOutcome<PracticeMarking>> {
  const adapted = await adaptedFor(source);
  if (!adapted.ok) return adapted;
  const questions = questionsOf(adapted.value, section);
  if (!questions || questions.length === 0) {
    return { ok: false, status: 409, code: 'section_not_in_test', error: `This test has no ${section} section to mark.` };
  }

  const score = objectiveSectionScore(section, questions, answers, adapted.value.test.module);
  const results: PracticeMarking['results'] = {};
  for (const question of questions) {
    results[question.id] = {
      correct: checkQuestionAnswer(question, answers[question.id]),
      answers: Array.isArray(question.correctAnswer) ? question.correctAnswer : [question.correctAnswer],
      ...(question.explanation ? { explanation: question.explanation } : {}),
    };
  }
  return { ok: true, value: { section, correct: score.correct, total: score.total, band: score.band, results } };
}
