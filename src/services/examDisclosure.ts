import { BUNDLE_SECTIONS, type BundleSection } from '../types/bundle';
import type { ExamResultView, LearnerGradingView, LearnerRunView, LearnerSectionView } from '../types/examSession';
import { examResult, gradingOf, MAX_GRADING_RUNS, type ExamRunState, type GradingFailure, type GradingRecord, type SectionRun } from './examRun';

/**
 * What a learner may learn about their own sitting, and when.
 *
 * The server marks every section as it closes and keeps the marks for the
 * attempt. None of that may reach the learner while the exam is still going:
 * a correct count shown after Listening is an oracle — answer a few questions,
 * finish the section, read the count, abandon, open a fresh sitting, try other
 * answers — and repeated it gives up a multiple-choice key.
 *
 * So every exam-session response is built here, by listing what goes out rather
 * than removing what should not: a field added to the stored run later is
 * withheld until someone decides here that a learner may see it.
 *
 *   - `toLearnerRunView`: progress and the learner's own work, with where each
 *     submitted task's grading stands (grading, graded, failed) and never its band
 *     or the model that produced it. Always sent.
 *   - `toExamResultView`: the marks. Only once the exam has finished.
 */

const REASONS: Record<GradingFailure, NonNullable<LearnerGradingView['reason']>> = {
  unavailable: 'unavailable',
  interrupted: 'unavailable',
  timeout: 'timeout',
  quota: 'quota',
  invalid_response: 'failed',
  rejected: 'failed',
};

function learnerGrading(work: { grading?: GradingRecord; band?: number }, now: number): LearnerGradingView {
  const grading = gradingOf(work, now);
  if (grading.status !== 'failed') return { status: grading.status, retryable: false };
  return { status: 'failed', retryable: grading.runs < MAX_GRADING_RUNS, reason: REASONS[grading.failure ?? 'interrupted'] };
}

function toLearnerSection(run: SectionRun, now: number): LearnerSectionView {
  const writing: LearnerSectionView['writing'] = {};
  for (const task of [1, 2] as const) {
    const work = run.writing[task];
    if (work) {
      writing[task] = { essay: work.essay, ...(work.submittedAt !== undefined ? { submittedAt: work.submittedAt } : {}), grading: learnerGrading(work, now) };
    }
  }
  const speaking: LearnerSectionView['speaking'] = {};
  for (const part of [1, 2, 3] as const) {
    const work = run.speaking[part];
    if (work) {
      speaking[part] = { transcript: work.transcript, ...(work.submittedAt !== undefined ? { submittedAt: work.submittedAt } : {}), grading: learnerGrading(work, now) };
    }
  }
  return {
    status: run.status,
    ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
    ...(run.deadline !== undefined ? { deadline: run.deadline } : {}),
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
    ...(run.endedBy !== undefined ? { endedBy: run.endedBy } : {}),
    answers: { ...run.answers },
    ...(run.submittedAt !== undefined ? { submittedAt: run.submittedAt } : {}),
    drafts: { ...run.drafts },
    writing,
    speaking,
    ...(run.audioStarted ? { audioStarted: { ...run.audioStarted } } : {}),
  };
}

/** The run as the learner holds it at server time `now`: every question id and no question, progress and no mark. */
export function toLearnerRunView(state: ExamRunState, now: number): LearnerRunView {
  const sections = Object.fromEntries(BUNDLE_SECTIONS.map((section) => [section, toLearnerSection(state.sections[section], now)])) as Record<BundleSection, LearnerSectionView>;
  return {
    attemptId: state.attemptId,
    plan: {
      ...state.plan,
      sections: state.plan.sections.map(({ questions, ...section }) => ({
        ...section,
        questionIds: questions.map((entry) => entry.question.id),
      })),
    },
    sections,
    currentIndex: state.currentIndex,
    ...(state.startedAt !== undefined ? { startedAt: state.startedAt } : {}),
    ...(state.finishedAt !== undefined ? { finishedAt: state.finishedAt } : {}),
  };
}

/** The marks, once the last section has closed. Undefined while the exam is in progress. */
export function toExamResultView(state: ExamRunState): ExamResultView | undefined {
  if (state.finishedAt === undefined) return undefined;
  const result = examResult(state);
  const raw: ExamResultView['raw'] = {};
  for (const section of ['listening', 'reading'] as const) {
    const objective = state.sections[section].objective;
    if (objective) raw[section] = { correct: objective.correct, total: objective.total };
  }
  return {
    complete: result.complete,
    ...(result.overall !== undefined ? { overall: result.overall } : {}),
    bands: result.bands,
    raw,
    awaitingGrading: result.awaitingGrading,
  };
}
