import type {
  AnswerValue,
  AttemptComponentRef,
  AttemptResponse,
  AttemptSectionRecord,
  AttemptSpeakingPart,
  AttemptWritingTask,
  MockAttempt,
  Question,
} from '../types';
import { BUNDLE_SECTIONS, minutesKey, type BundleSection, type BundleTiming, type ExamSitting } from '../types/bundle';
import {
  calculateOverallBand,
  objectiveSectionScore,
  speakingSectionBand,
  writingSectionBand,
} from '../utils/ieltsScoring';

/**
 * One full exam sitting, as a deterministic state machine.
 *
 * The exam screen renders this state and sends it events; it holds no rule of
 * its own. That is what makes the rules testable without a browser, and what
 * keeps the timer and the completion logic reading the same numbers:
 *
 *   - Sections run in order: Listening → Reading → Writing → Speaking.
 *   - Each section's clock is the bundle's configured minutes for it. Nothing
 *     here knows what an IELTS section "usually" takes.
 *   - A section is complete when its configured content is done: every
 *     Listening or Reading part submitted; both Writing tasks graded; all three
 *     Speaking parts graded. One graded task is not a Writing section.
 *   - When time runs out, Listening and Reading are marked on the answers given
 *     so far (an unanswered question is wrong); a Writing or Speaking section
 *     with ungraded content ends `expired` and carries no band.
 *   - The overall band exists only when all four sections are complete. An
 *     incomplete sitting is reported as incomplete, not averaged over whatever
 *     happened to finish.
 */

export interface PlanComponent {
  section: BundleSection;
  part: number;
  materialId: string;
  contentHash: string;
}

export interface SectionPlan {
  section: BundleSection;
  durationSeconds: number;
  components: PlanComponent[];
  /** Listening and Reading: every question, with the component it belongs to. */
  questions: Array<{ question: Question; component: PlanComponent }>;
  /** Writing: the tasks the section requires. */
  tasks: Array<1 | 2>;
  /** Speaking: the parts the section requires. */
  parts: Array<1 | 2 | 3>;
}

export interface ExamPlan {
  bundleId: string;
  bundleTitle: string;
  bundlePublishedAt: string;
  timing: BundleTiming;
  sections: SectionPlan[];
}

export class ExamPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExamPlanError';
  }
}

const hasPrompt = (task: unknown) =>
  typeof task === 'object' && task !== null && typeof (task as { prompt?: unknown }).prompt === 'string' && Boolean((task as { prompt: string }).prompt.trim());

/** Turns a resolved sitting into the plan the run follows. Refuses a sitting that does not supply a full exam. */
export function buildExamPlan(sitting: ExamSitting): ExamPlan {
  const sections = BUNDLE_SECTIONS.map((section): SectionPlan => {
    const minutes = sitting.bundle.timing[minutesKey(section)];
    if (!Number.isInteger(minutes) || minutes < 1) {
      throw new ExamPlanError(`${section} has no valid duration in the bundle configuration.`);
    }
    const entries = sitting.components.filter((entry) => entry.section === section).sort((a, b) => a.part - b.part);
    if (entries.length === 0) throw new ExamPlanError(`The bundle supplies no ${section} component.`);

    const components = entries.map(({ section: s, part, materialId, contentHash }) => ({ section: s, part, materialId, contentHash }));
    const plan: SectionPlan = { section, durationSeconds: minutes * 60, components, questions: [], tasks: [], parts: [] };

    entries.forEach((entry, index) => {
      const material = entry.material;
      const component = components[index];
      if (material.section !== section || material.id !== entry.materialId) {
        throw new ExamPlanError(`${section} part ${entry.part} does not resolve to the material it names.`);
      }
      if (material.section === 'listening') {
        plan.questions.push(...material.content.section.questions.map((question) => ({ question, component })));
      } else if (material.section === 'reading') {
        plan.questions.push(...material.content.passage.questions.map((question) => ({ question, component })));
      } else if (material.section === 'writing') {
        const task = (material.content.task ?? {}) as Record<string, unknown>;
        if (!hasPrompt(task.task1) || !hasPrompt(task.task2)) {
          throw new ExamPlanError('The Writing component does not carry both Task 1 and Task 2.');
        }
        plan.tasks = [1, 2];
      } else if (material.section === 'speaking') {
        const session = material.content.speakingSession;
        if (!session?.part1?.questions?.length || !session.part2?.cueCardTopic || !session.part3?.questions?.length) {
          throw new ExamPlanError('The Speaking component does not carry Parts 1, 2 and 3.');
        }
        plan.parts = [1, 2, 3];
      }
    });

    if ((section === 'listening' || section === 'reading') && plan.questions.length === 0) {
      throw new ExamPlanError(`The ${section} components carry no questions.`);
    }
    return plan;
  });

  return {
    bundleId: sitting.bundle.id,
    bundleTitle: sitting.bundle.title,
    bundlePublishedAt: sitting.bundle.publishedAt,
    timing: sitting.bundle.timing,
    sections,
  };
}

export type SectionStatus = 'pending' | 'in_progress' | 'completed' | 'expired';

export interface SectionRun {
  status: SectionStatus;
  startedAt?: number;
  deadline?: number;
  endedAt?: number;
  endedBy?: 'learner' | 'time';
  answers: Record<string, AnswerValue>;
  submittedAt?: number;
  objective?: { correct: number; total: number; band: number };
  writing: Partial<Record<1 | 2, { band: number; essay: string }>>;
  speaking: Partial<Record<1 | 2 | 3, { band: number; transcript: string }>>;
  band?: number;
}

export interface ExamRunState {
  attemptId: string;
  plan: ExamPlan;
  sections: Record<BundleSection, SectionRun>;
  currentIndex: number;
  startedAt?: number;
  finishedAt?: number;
}

export type ExamEvent =
  | { type: 'start'; now: number }
  | { type: 'answer'; questionId: string; value: AnswerValue }
  | { type: 'submit_answers'; now: number }
  | { type: 'writing_graded'; task: 1 | 2; band: number; essay: string }
  | { type: 'speaking_graded'; part: 1 | 2 | 3; band: number; transcript: string }
  | { type: 'finish_section'; now: number }
  | { type: 'tick'; now: number };

const emptyRun = (): SectionRun => ({ status: 'pending', answers: {}, writing: {}, speaking: {} });

export function createExamRun(plan: ExamPlan, attemptId: string): ExamRunState {
  return {
    attemptId,
    plan,
    sections: { listening: emptyRun(), reading: emptyRun(), writing: emptyRun(), speaking: emptyRun() },
    currentIndex: 0,
  };
}

export function currentSection(state: ExamRunState): SectionPlan | null {
  if (state.startedAt === undefined || state.finishedAt !== undefined) return null;
  return state.plan.sections[state.currentIndex] ?? null;
}

const isBand = (value: number) => Number.isFinite(value) && value >= 0 && value <= 9;

export type MissingItem = { kind: 'answers' } | { kind: 'writing_task'; task: 1 | 2 } | { kind: 'speaking_part'; part: 1 | 2 | 3 };

/** Whether a section's configured content is done, and what is not. */
export function sectionReadiness(state: ExamRunState, section: BundleSection): { ready: boolean; missing: MissingItem[] } {
  const plan = state.plan.sections.find((entry) => entry.section === section);
  const run = state.sections[section];
  if (!plan) return { ready: false, missing: [] };
  const missing: MissingItem[] = [];
  if (section === 'listening' || section === 'reading') {
    if (run.submittedAt === undefined) missing.push({ kind: 'answers' });
  } else if (section === 'writing') {
    for (const task of plan.tasks) if (!run.writing[task]) missing.push({ kind: 'writing_task', task });
  } else {
    for (const part of plan.parts) if (!run.speaking[part]) missing.push({ kind: 'speaking_part', part });
  }
  return { ready: missing.length === 0, missing };
}

/** Whether the learner may end the current section now, and if not, why. */
export function canFinishSection(
  state: ExamRunState,
  now: number,
): { allowed: true } | { allowed: false; reason: 'not_running' | 'not_ready' | 'early_finish_disabled' } {
  const plan = currentSection(state);
  if (!plan) return { allowed: false, reason: 'not_running' };
  if (!sectionReadiness(state, plan.section).ready) return { allowed: false, reason: 'not_ready' };
  const deadline = state.sections[plan.section].deadline ?? 0;
  if (!state.plan.timing.allowEarlyFinish && now < deadline) return { allowed: false, reason: 'early_finish_disabled' };
  return { allowed: true };
}

export function remainingSeconds(state: ExamRunState, now: number): number {
  const plan = currentSection(state);
  if (!plan) return 0;
  const deadline = state.sections[plan.section].deadline ?? now;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

function startSection(state: ExamRunState, index: number, now: number): ExamRunState {
  const plan = state.plan.sections[index];
  if (!plan) return { ...state, currentIndex: index, finishedAt: now };
  return {
    ...state,
    currentIndex: index,
    sections: {
      ...state.sections,
      [plan.section]: { ...state.sections[plan.section], status: 'in_progress', startedAt: now, deadline: now + plan.durationSeconds * 1000 },
    },
  };
}

function closeCurrent(state: ExamRunState, endedAt: number, by: 'learner' | 'time', nextStartsAt: number): ExamRunState {
  const plan = currentSection(state);
  if (!plan) return state;
  const run = state.sections[plan.section];
  let closed: SectionRun = { ...run, endedAt, endedBy: by };

  if (plan.section === 'listening' || plan.section === 'reading') {
    const objective =
      run.objective ??
      objectiveSectionScore(plan.section, plan.questions.map((entry) => entry.question), run.answers);
    closed = { ...closed, objective, submittedAt: run.submittedAt ?? endedAt, band: objective.band, status: 'completed' };
  } else if (plan.section === 'writing') {
    const band = writingSectionBand(run.writing[1]?.band, run.writing[2]?.band);
    closed = band === null ? { ...closed, status: 'expired' } : { ...closed, band, status: 'completed' };
  } else {
    const band = speakingSectionBand([run.speaking[1]?.band, run.speaking[2]?.band, run.speaking[3]?.band]);
    closed = band === null ? { ...closed, status: 'expired' } : { ...closed, band, status: 'completed' };
  }

  // The next section starts when this one is closed, not at the old deadline: a tick that
  // arrives late (a backgrounded tab) must not eat into the next section's time.
  return startSection({ ...state, sections: { ...state.sections, [plan.section]: closed } }, state.currentIndex + 1, nextStartsAt);
}

function updateCurrent(state: ExamRunState, section: BundleSection, update: (run: SectionRun) => SectionRun): ExamRunState {
  const plan = currentSection(state);
  if (!plan || plan.section !== section || state.sections[section].status !== 'in_progress') return state;
  return { ...state, sections: { ...state.sections, [section]: update(state.sections[section]) } };
}

export function examReducer(state: ExamRunState, event: ExamEvent): ExamRunState {
  switch (event.type) {
    case 'start':
      if (state.startedAt !== undefined) return state;
      return startSection({ ...state, startedAt: event.now }, 0, event.now);

    case 'answer': {
      const plan = currentSection(state);
      if (!plan || (plan.section !== 'listening' && plan.section !== 'reading')) return state;
      if (!plan.questions.some((entry) => entry.question.id === event.questionId)) return state;
      return updateCurrent(state, plan.section, (run) =>
        run.submittedAt !== undefined ? run : { ...run, answers: { ...run.answers, [event.questionId]: event.value } },
      );
    }

    case 'submit_answers': {
      const plan = currentSection(state);
      if (!plan || (plan.section !== 'listening' && plan.section !== 'reading')) return state;
      const section = plan.section;
      return updateCurrent(state, section, (run) =>
        run.submittedAt !== undefined
          ? run
          : {
              ...run,
              submittedAt: event.now,
              objective: objectiveSectionScore(section, plan.questions.map((entry) => entry.question), run.answers),
            },
      );
    }

    case 'writing_graded': {
      const plan = currentSection(state);
      if (!plan || plan.section !== 'writing' || !plan.tasks.includes(event.task) || !isBand(event.band)) return state;
      return updateCurrent(state, 'writing', (run) => ({ ...run, writing: { ...run.writing, [event.task]: { band: event.band, essay: event.essay } } }));
    }

    case 'speaking_graded': {
      const plan = currentSection(state);
      if (!plan || plan.section !== 'speaking' || !plan.parts.includes(event.part) || !isBand(event.band)) return state;
      return updateCurrent(state, 'speaking', (run) => ({ ...run, speaking: { ...run.speaking, [event.part]: { band: event.band, transcript: event.transcript } } }));
    }

    case 'finish_section':
      if (!canFinishSection(state, event.now).allowed) return state;
      return closeCurrent(state, event.now, 'learner', event.now);

    case 'tick': {
      const plan = currentSection(state);
      if (!plan) return state;
      const deadline = state.sections[plan.section].deadline;
      if (deadline === undefined || event.now < deadline) return state;
      return closeCurrent(state, deadline, 'time', event.now);
    }
  }
}

export interface ExamResult {
  complete: boolean;
  /** Present only when every section is complete. */
  overall?: number;
  bands: Partial<Record<BundleSection, number>>;
  incomplete: BundleSection[];
}

export function examResult(state: ExamRunState): ExamResult {
  const bands: Partial<Record<BundleSection, number>> = {};
  const incomplete: BundleSection[] = [];
  for (const section of BUNDLE_SECTIONS) {
    const run = state.sections[section];
    if (run.status === 'completed' && typeof run.band === 'number') bands[section] = run.band;
    else incomplete.push(section);
  }
  const complete = incomplete.length === 0;
  return { complete, bands, incomplete, ...(complete ? { overall: calculateOverallBand(bands) } : {}) };
}

const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());
const refOf = (component: PlanComponent): AttemptComponentRef => ({
  materialId: component.materialId,
  contentHash: component.contentHash,
  part: component.part,
});
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/**
 * The attempt to store: every answer, essay and transcript against the bundle,
 * the exact material version and the question, task or part it belongs to.
 */
export function toExamAttempt(state: ExamRunState): MockAttempt {
  const result = examResult(state);
  const sectionPlan = (section: BundleSection) => state.plan.sections.find((entry) => entry.section === section);

  const sections: NonNullable<MockAttempt['sections']> = {};
  for (const plan of state.plan.sections) {
    const run = state.sections[plan.section];
    const record: AttemptSectionRecord = {
      status: run.status,
      startedAt: iso(run.startedAt),
      endedAt: iso(run.endedAt),
      endedBy: run.endedBy,
      components: plan.components.map(refOf),
      ...(typeof run.band === 'number' && run.status === 'completed' ? { band: run.band } : {}),
      ...(run.objective ? { rawScore: run.objective.correct, total: run.objective.total } : {}),
    };
    sections[plan.section] = record;
  }

  const responses: AttemptResponse[] = [];
  for (const section of ['listening', 'reading'] as const) {
    const plan = sectionPlan(section);
    if (!plan) continue;
    const run = state.sections[section];
    for (const { question, component } of plan.questions) {
      const answer = run.answers[question.id];
      if (answer === undefined) continue;
      responses.push({ section, ...refOf(component), questionId: question.id, answer });
    }
  }

  const writingPlan = sectionPlan('writing');
  const writingTasks: AttemptWritingTask[] = writingPlan
    ? writingPlan.tasks.map((task) => {
        const graded = state.sections.writing.writing[task];
        const component = writingPlan.components[0];
        return {
          materialId: component.materialId,
          contentHash: component.contentHash,
          task,
          ...(graded ? { band: graded.band } : {}),
          essay: graded?.essay ?? '',
          wordCount: graded ? words(graded.essay) : 0,
        };
      })
    : [];

  const speakingPlan = sectionPlan('speaking');
  const speakingParts: AttemptSpeakingPart[] = speakingPlan
    ? speakingPlan.parts.map((part) => {
        const graded = state.sections.speaking.speaking[part];
        const component = speakingPlan.components[0];
        return {
          materialId: component.materialId,
          contentHash: component.contentHash,
          part,
          ...(graded ? { band: graded.band } : {}),
          transcript: graded?.transcript ?? '',
        };
      })
    : [];

  const listening = state.sections.listening;
  const reading = state.sections.reading;
  const startedAt = state.startedAt ?? Date.now();
  const finishedAt = state.finishedAt ?? Date.now();

  return {
    id: state.attemptId,
    testId: state.plan.bundleId,
    testTitle: state.plan.bundleTitle,
    bundleId: state.plan.bundleId,
    bundlePublishedAt: state.plan.bundlePublishedAt,
    mode: 'exam',
    isFullMock: true,
    status: result.complete ? 'completed' : 'incomplete',
    date: new Date(startedAt).toISOString().slice(0, 10),
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(finishedAt).toISOString(),
    durationMinutes: Math.round((finishedAt - startedAt) / 60000),
    scores: {
      ...(result.overall !== undefined ? { overall: result.overall } : {}),
      ...(result.bands.listening !== undefined && listening.objective
        ? { listening: { band: result.bands.listening, rawScore: listening.objective.correct, total: listening.objective.total } }
        : {}),
      ...(result.bands.reading !== undefined && reading.objective
        ? { reading: { band: result.bands.reading, rawScore: reading.objective.correct, total: reading.objective.total } }
        : {}),
      ...(result.bands.writing !== undefined
        ? {
            writing: {
              band: result.bands.writing,
              task1Band: state.sections.writing.writing[1]?.band,
              task2Band: state.sections.writing.writing[2]?.band,
            },
          }
        : {}),
      ...(result.bands.speaking !== undefined ? { speaking: { band: result.bands.speaking } } : {}),
    },
    sections,
    responses,
    writingTasks,
    speakingParts,
  };
}
