import { BUNDLE_SECTIONS, type BundleSection } from '../types/bundle';
import type { ExamResultView, LearnerRunView, LearnerSectionView } from '../types/examSession';
import { examResult, type ExamRunState, type SectionRun } from './examRun';

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
 *   - `toLearnerRunView`: progress and the learner's own work. Always sent.
 *   - `toExamResultView`: the marks. Only once the exam has finished.
 */

function toLearnerSection(run: SectionRun): LearnerSectionView {
  const writing: LearnerSectionView['writing'] = {};
  for (const task of [1, 2] as const) {
    const graded = run.writing[task];
    if (graded) writing[task] = { essay: graded.essay };
  }
  const speaking: LearnerSectionView['speaking'] = {};
  for (const part of [1, 2, 3] as const) {
    const graded = run.speaking[part];
    if (graded) speaking[part] = { transcript: graded.transcript };
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

/** The run as the learner holds it: every question id and no question, progress and no mark. */
export function toLearnerRunView(state: ExamRunState): LearnerRunView {
  const sections = Object.fromEntries(BUNDLE_SECTIONS.map((section) => [section, toLearnerSection(state.sections[section])])) as Record<BundleSection, LearnerSectionView>;
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
  };
}
