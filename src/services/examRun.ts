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
  type IeltsModule,
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
 *   - A Writing task or Speaking part is *submitted* when the server accepts it
 *     while its section is running, and it is stored then, with its grading
 *     `pending`. Grading is a separate, later fact about submitted work: a run is
 *     claimed, and its band or failure is recorded on the work the section already
 *     accepted — including after the section closed. The clock can refuse a
 *     submission; it can never take one back.
 *   - A section's content is done when every Listening or Reading part is
 *     submitted, both Writing tasks are submitted, or all three Speaking parts are.
 *   - When a section closes, Listening and Reading are marked on the answers
 *     given so far (an unanswered question is wrong). A Writing or Speaking
 *     section is `completed` when every required band is in, `awaiting_grading`
 *     when everything was submitted but a band is still out, and `expired` when
 *     something was never submitted. An awaiting section completes the moment its
 *     last band is recorded.
 *   - The overall band exists only when all four sections are complete. An
 *     incomplete sitting is reported as incomplete, not averaged over whatever
 *     happened to finish, and no band is ever made up for work whose grading failed.
 */

export interface PlanComponent {
  section: BundleSection;
  part: number;
  materialId: string;
  contentHash: string;
}

/** What every reader of a section needs: its clock, its components and what completing it takes. */
export interface SectionShape {
  section: BundleSection;
  durationSeconds: number;
  components: PlanComponent[];
  /** Writing: the tasks the section requires. */
  tasks: Array<1 | 2>;
  /** Speaking: the parts the section requires. */
  parts: Array<1 | 2 | 3>;
}

export interface SectionPlan extends SectionShape {
  /** Listening and Reading: every question, with its answer key and the component it belongs to. */
  questions: Array<{ question: Question; component: PlanComponent }>;
}

/** A section as the browser holds it during an exam: the question ids, never the questions' keys. */
export interface SectionView extends SectionShape {
  questionIds: string[];
}

export interface PlanShape<S extends SectionShape = SectionShape> {
  bundleId: string;
  bundleTitle: string;
  bundlePublishedAt: string;
  /** Academic or General Training: decides which Reading conversion table applies. */
  module: IeltsModule;
  timing: BundleTiming;
  sections: S[];
}

export type ExamPlan = PlanShape<SectionPlan>;

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

    const components: PlanComponent[] = entries.map(({ section: s, part, materialId, contentHash }) => ({ section: s, part, materialId, contentHash }));
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
    module: sitting.bundle.module,
    timing: sitting.bundle.timing,
    sections,
  };
}

export type SectionStatus = 'pending' | 'in_progress' | 'completed' | 'expired' | 'awaiting_grading';

/**
 * Where the grading of one submitted Writing task or Speaking part stands:
 * `pending` until a run is claimed, `grading` while one is out, then `graded`
 * with a band or `failed` without one.
 */
export type GradingStatus = 'pending' | 'grading' | 'graded' | 'failed';

/**
 * Why a grading run produced no band. `rejected`: the grader refused the work
 * itself. `interrupted`: the run's lease ran out with no result recorded — the
 * request running it is gone.
 */
export type GradingFailure = 'unavailable' | 'timeout' | 'quota' | 'invalid_response' | 'rejected' | 'interrupted';

/** How many grading runs one submitted task or part may have, the first included. */
export const MAX_GRADING_RUNS = 3;

export interface GradingRecord {
  status: GradingStatus;
  /** Grading runs claimed for this work so far. */
  runs: number;
  /** When the current run was claimed (server time). */
  startedAt?: number;
  /** A run still `grading` at this server time has been interrupted. */
  leaseUntil?: number;
  finishedAt?: number;
  failure?: GradingFailure;
  /** The model that produced the band. Kept on the server. */
  model?: string;
}

interface SubmittedWork {
  /** When the server accepted the work. Absent on sessions stored before submission and grading were recorded apart. */
  submittedAt?: number;
  /** Absent on those older sessions, which stored work only once it was graded. */
  grading?: GradingRecord;
  /** Present once a grading run has returned a band, and only then. */
  band?: number;
}

export interface WritingWork extends SubmittedWork {
  essay: string;
}

/** A recorded Speaking answer, stored when it is submitted, so grading can read it later. */
export interface SpeakingAudioRef {
  path: string;
  mimeType: string;
  sha256: string;
  durationSeconds?: number;
}

export interface SpeakingWork extends SubmittedWork {
  /** What the learner typed, or the model's transcription once graded. Empty for a recording not yet graded. */
  transcript: string;
  /** The learner's own typed transcript, when they gave one. */
  transcriptProvided?: string;
  audio?: SpeakingAudioRef;
}

export interface SectionRun {
  status: SectionStatus;
  startedAt?: number;
  deadline?: number;
  endedAt?: number;
  endedBy?: 'learner' | 'time';
  answers: Record<string, AnswerValue>;
  submittedAt?: number;
  objective?: { correct: number; total: number; band: number };
  writing: Partial<Record<1 | 2, WritingWork>>;
  /** Writing: what the learner has typed so far, per task, so a reload does not lose it. */
  drafts: Partial<Record<1 | 2, string>>;
  speaking: Partial<Record<1 | 2 | 3, SpeakingWork>>;
  /**
   * Listening: when each part's recording was started. IELTS recordings are heard
   * once only, so a part that has a start time is never played again — not after a
   * reload, not after switching parts. Absent on sessions stored before it existed.
   */
  audioStarted?: Partial<Record<number, number>>;
  band?: number;
}

/** The progress of a sitting without its plan: what the exam session stores. */
export interface RunProgress {
  attemptId: string;
  sections: Record<BundleSection, SectionRun>;
  currentIndex: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface RunShape<S extends SectionShape = SectionShape> extends RunProgress {
  plan: PlanShape<S>;
}

/** The server's full state: the plan carries the answer keys marking needs. */
export type ExamRunState = RunShape<SectionPlan>;

/**
 * What the progress helpers below read of a run: the plan, the clock and whether
 * each section's content is in — never a mark. The server's full state and the
 * learner's view (`LearnerRunView`, built by `examDisclosure`) both satisfy it.
 */
export interface ProgressShape<S extends SectionShape = SectionShape> {
  plan: PlanShape<S>;
  sections: Record<BundleSection, { deadline?: number; submittedAt?: number; writing: Partial<Record<1 | 2, object>>; speaking: Partial<Record<1 | 2 | 3, object>> }>;
  currentIndex: number;
  startedAt?: number;
  finishedAt?: number;
}

export type ExamEvent =
  | { type: 'start'; now: number }
  | { type: 'answer'; questionId: string; value: AnswerValue }
  | { type: 'submit_answers'; now: number }
  | { type: 'audio_started'; part: number; now: number }
  | { type: 'writing_draft'; task: 1 | 2; text: string }
  /** The server accepted a Writing task. Its grading is pending. */
  | { type: 'writing_submitted'; task: 1 | 2; essay: string; now: number }
  /** A grading run is claimed for a pending, failed or interrupted task. */
  | { type: 'writing_grading_started'; task: 1 | 2; now: number; leaseUntil: number }
  | { type: 'writing_graded'; task: 1 | 2; run: number; band: number; model?: string; now: number }
  | { type: 'writing_grading_failed'; task: 1 | 2; run: number; failure: GradingFailure; now: number }
  | { type: 'speaking_submitted'; part: 1 | 2 | 3; transcriptProvided?: string; audio?: SpeakingAudioRef; now: number }
  | { type: 'speaking_grading_started'; part: 1 | 2 | 3; now: number; leaseUntil: number }
  | { type: 'speaking_graded'; part: 1 | 2 | 3; run: number; band: number; transcript: string; model?: string; now: number }
  | { type: 'speaking_grading_failed'; part: 1 | 2 | 3; run: number; failure: GradingFailure; now: number }
  | { type: 'finish_section'; now: number }
  | { type: 'tick'; now: number };

const emptyRun = (): SectionRun => ({ status: 'pending', answers: {}, writing: {}, drafts: {}, speaking: {} });

export function createExamRun(plan: ExamPlan, attemptId: string): ExamRunState {
  return {
    attemptId,
    plan,
    sections: { listening: emptyRun(), reading: emptyRun(), writing: emptyRun(), speaking: emptyRun() },
    currentIndex: 0,
  };
}

/** The stored progress of a run, without the plan it was built from. */
export function progressOf(state: RunShape): RunProgress {
  const { plan: _plan, ...progress } = state;
  return progress;
}

export function currentSection<S extends SectionShape>(state: ProgressShape<S>): S | null {
  if (state.startedAt === undefined || state.finishedAt !== undefined) return null;
  return state.plan.sections[state.currentIndex] ?? null;
}

const isBand = (value: number) => Number.isFinite(value) && value >= 0 && value <= 9;

/** Where a submitted task's or part's grading stands at `now`. */
export interface GradingView {
  status: GradingStatus;
  runs: number;
  failure?: GradingFailure;
}

export function gradingOf(work: { grading?: GradingRecord; band?: number }, now: number): GradingView {
  const grading = work.grading;
  // Work stored before grading was recorded apart from submission was stored with its band.
  if (!grading) return typeof work.band === 'number' ? { status: 'graded', runs: 1 } : { status: 'failed', runs: MAX_GRADING_RUNS, failure: 'interrupted' };
  if (grading.status === 'grading' && grading.leaseUntil !== undefined && now >= grading.leaseUntil) {
    return { status: 'failed', runs: grading.runs, failure: 'interrupted' };
  }
  return { status: grading.status, runs: grading.runs, ...(grading.failure ? { failure: grading.failure } : {}) };
}

/** The band a grading run recorded on the work, if one has. */
export function gradedBand(work: { grading?: GradingRecord; band?: number } | undefined): number | undefined {
  if (!work || typeof work.band !== 'number') return undefined;
  return !work.grading || work.grading.status === 'graded' ? work.band : undefined;
}

function submittedWork(progress: RunProgress): Array<WritingWork | SpeakingWork> {
  const writing = Object.values(progress.sections.writing.writing);
  const speaking = Object.values(progress.sections.speaking.speaking);
  return [...writing, ...speaking].filter((work): work is WritingWork | SpeakingWork => work !== undefined);
}

/** Whether any submitted work has no grading outcome yet: pending, or a run still out. */
export function gradingUnsettled(progress: RunProgress, now: number): boolean {
  return submittedWork(progress).some((work) => {
    const status = gradingOf(work, now).status;
    return status === 'pending' || status === 'grading';
  });
}

/** Whether any submitted work may still receive a band: unsettled, or failed with a run left. */
export function gradingOutstanding(progress: RunProgress, now: number): boolean {
  return submittedWork(progress).some((work) => {
    const grading = gradingOf(work, now);
    return grading.status === 'pending' || grading.status === 'grading' || (grading.status === 'failed' && grading.runs < MAX_GRADING_RUNS);
  });
}

export type MissingItem = { kind: 'answers' } | { kind: 'writing_task'; task: 1 | 2 } | { kind: 'speaking_part'; part: 1 | 2 | 3 };

/** Whether a section's configured content is submitted, and what is not. Grading is not content: the clock waits for no model. */
export function sectionReadiness(state: ProgressShape, section: BundleSection): { ready: boolean; missing: MissingItem[] } {
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
  state: ProgressShape,
  now: number,
): { allowed: true } | { allowed: false; reason: 'not_running' | 'not_ready' | 'early_finish_disabled' } {
  const plan = currentSection(state);
  if (!plan) return { allowed: false, reason: 'not_running' };
  if (!sectionReadiness(state, plan.section).ready) return { allowed: false, reason: 'not_ready' };
  const deadline = state.sections[plan.section].deadline ?? 0;
  if (!state.plan.timing.allowEarlyFinish && now < deadline) return { allowed: false, reason: 'early_finish_disabled' };
  return { allowed: true };
}

export function remainingSeconds(state: ProgressShape, now: number): number {
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

const writingBand = (run: SectionRun) => writingSectionBand(gradedBand(run.writing[1]), gradedBand(run.writing[2]));
const speakingBand = (run: SectionRun) => speakingSectionBand([gradedBand(run.speaking[1]), gradedBand(run.speaking[2]), gradedBand(run.speaking[3])]);

/** A closing Writing or Speaking section: complete with its band, waiting for a band, or missing work. */
function closeGraded(run: SectionRun, submitted: boolean, band: number | null): SectionRun {
  if (band !== null) return { ...run, band, status: 'completed' };
  return { ...run, status: submitted ? 'awaiting_grading' : 'expired' };
}

function closeCurrent(state: ExamRunState, endedAt: number, by: 'learner' | 'time', nextStartsAt: number): ExamRunState {
  const plan = currentSection(state);
  if (!plan) return state;
  const run = state.sections[plan.section];
  let closed: SectionRun = { ...run, endedAt, endedBy: by };

  if (plan.section === 'listening' || plan.section === 'reading') {
    const objective =
      run.objective ??
      objectiveSectionScore(plan.section, plan.questions.map((entry) => entry.question), run.answers, state.plan.module);
    closed = { ...closed, objective, submittedAt: run.submittedAt ?? endedAt, band: objective.band, status: 'completed' };
  } else if (plan.section === 'writing') {
    closed = closeGraded(closed, plan.tasks.every((task) => run.writing[task]), writingBand(run));
  } else {
    closed = closeGraded(closed, plan.parts.every((part) => run.speaking[part]), speakingBand(run));
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

/** Changes a section whatever its status: grading lands on work already accepted, including after the section closed. */
function updateSection(state: ExamRunState, section: BundleSection, update: (run: SectionRun) => SectionRun): ExamRunState {
  return { ...state, sections: { ...state.sections, [section]: update(state.sections[section]) } };
}

/** A section that closed while a band was still out completes once every required band is in. */
function settle(state: ExamRunState, section: 'writing' | 'speaking'): ExamRunState {
  const run = state.sections[section];
  if (run.status !== 'awaiting_grading') return state;
  const band = section === 'writing' ? writingBand(run) : speakingBand(run);
  return band === null ? state : updateSection(state, section, (current) => ({ ...current, status: 'completed', band }));
}

const PENDING: GradingRecord = { status: 'pending', runs: 0 };

/** Whether a grading result belongs to the run currently claimed on this work. A late result from an abandoned run does not. */
const isCurrentRun = <W extends SubmittedWork>(work: W | undefined, run: number): work is W & { grading: GradingRecord } =>
  Boolean(work?.grading && work.grading.status === 'grading' && work.grading.runs === run);

/** The work with a new grading run claimed, or null when it may not be graded now: already graded, being graded, or out of runs. */
export function claimGrading<W extends SubmittedWork>(work: W | undefined, now: number, leaseUntil: number): W | null {
  if (!work) return null;
  const current = gradingOf(work, now);
  const claimable = current.status === 'pending' || (current.status === 'failed' && current.runs < MAX_GRADING_RUNS);
  if (!claimable) return null;
  return { ...work, grading: { status: 'grading', runs: current.runs + 1, startedAt: now, leaseUntil } };
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

    case 'audio_started': {
      const plan = currentSection(state);
      if (!plan || plan.section !== 'listening') return state;
      if (!plan.components.some((component) => component.part === event.part)) return state;
      // The first start is the only one: a recording is heard once.
      return updateCurrent(state, 'listening', (run) =>
        run.audioStarted?.[event.part] !== undefined ? run : { ...run, audioStarted: { ...run.audioStarted, [event.part]: event.now } },
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
              objective: objectiveSectionScore(section, plan.questions.map((entry) => entry.question), run.answers, state.plan.module),
            },
      );
    }

    case 'writing_draft': {
      const plan = currentSection(state);
      if (!plan || plan.section !== 'writing' || !plan.tasks.includes(event.task)) return state;
      // A submitted task is final: its draft no longer changes what is recorded.
      return updateCurrent(state, 'writing', (run) =>
        run.writing[event.task] ? run : { ...run, drafts: { ...run.drafts, [event.task]: event.text } },
      );
    }

    case 'writing_submitted': {
      const plan = currentSection(state);
      if (!plan || plan.section !== 'writing' || !plan.tasks.includes(event.task)) return state;
      return updateCurrent(state, 'writing', (run) =>
        run.writing[event.task] ? run : { ...run, writing: { ...run.writing, [event.task]: { essay: event.essay, submittedAt: event.now, grading: PENDING } } },
      );
    }

    case 'writing_grading_started': {
      const next = claimGrading(state.sections.writing.writing[event.task], event.now, event.leaseUntil);
      return next ? updateSection(state, 'writing', (run) => ({ ...run, writing: { ...run.writing, [event.task]: next } })) : state;
    }

    case 'writing_graded': {
      const work = state.sections.writing.writing[event.task];
      if (!isCurrentRun(work, event.run) || !isBand(event.band)) return state;
      const grading: GradingRecord = { ...work.grading, status: 'graded', finishedAt: event.now, ...(event.model ? { model: event.model } : {}) };
      return settle(updateSection(state, 'writing', (run) => ({ ...run, writing: { ...run.writing, [event.task]: { ...work, band: event.band, grading } } })), 'writing');
    }

    case 'writing_grading_failed': {
      const work = state.sections.writing.writing[event.task];
      if (!isCurrentRun(work, event.run)) return state;
      const grading: GradingRecord = { ...work.grading, status: 'failed', finishedAt: event.now, failure: event.failure };
      return updateSection(state, 'writing', (run) => ({ ...run, writing: { ...run.writing, [event.task]: { ...work, grading } } }));
    }

    case 'speaking_submitted': {
      const plan = currentSection(state);
      if (!plan || plan.section !== 'speaking' || !plan.parts.includes(event.part)) return state;
      if (!event.transcriptProvided && !event.audio) return state;
      const work: SpeakingWork = {
        transcript: event.transcriptProvided ?? '',
        ...(event.transcriptProvided ? { transcriptProvided: event.transcriptProvided } : {}),
        ...(event.audio ? { audio: event.audio } : {}),
        submittedAt: event.now,
        grading: PENDING,
      };
      return updateCurrent(state, 'speaking', (run) => (run.speaking[event.part] ? run : { ...run, speaking: { ...run.speaking, [event.part]: work } }));
    }

    case 'speaking_grading_started': {
      const next = claimGrading(state.sections.speaking.speaking[event.part], event.now, event.leaseUntil);
      return next ? updateSection(state, 'speaking', (run) => ({ ...run, speaking: { ...run.speaking, [event.part]: next } })) : state;
    }

    case 'speaking_graded': {
      const work = state.sections.speaking.speaking[event.part];
      if (!isCurrentRun(work, event.run) || !isBand(event.band)) return state;
      const grading: GradingRecord = { ...work.grading, status: 'graded', finishedAt: event.now, ...(event.model ? { model: event.model } : {}) };
      const graded: SpeakingWork = { ...work, band: event.band, transcript: event.transcript || work.transcript, grading };
      return settle(updateSection(state, 'speaking', (run) => ({ ...run, speaking: { ...run.speaking, [event.part]: graded } })), 'speaking');
    }

    case 'speaking_grading_failed': {
      const work = state.sections.speaking.speaking[event.part];
      if (!isCurrentRun(work, event.run)) return state;
      const grading: GradingRecord = { ...work.grading, status: 'failed', finishedAt: event.now, failure: event.failure };
      return updateSection(state, 'speaking', (run) => ({ ...run, speaking: { ...run.speaking, [event.part]: { ...work, grading } } }));
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
  /** Sections whose work was all submitted and whose band is still out. */
  awaitingGrading: BundleSection[];
}

export function examResult(state: RunShape): ExamResult {
  const bands: Partial<Record<BundleSection, number>> = {};
  const incomplete: BundleSection[] = [];
  const awaitingGrading: BundleSection[] = [];
  for (const section of BUNDLE_SECTIONS) {
    const run = state.sections[section];
    if (run.status === 'completed' && typeof run.band === 'number') bands[section] = run.band;
    else incomplete.push(section);
    if (run.status === 'awaiting_grading') awaitingGrading.push(section);
  }
  const complete = incomplete.length === 0;
  return { complete, bands, incomplete, awaitingGrading, ...(complete ? { overall: calculateOverallBand(bands) } : {}) };
}

/** An optional timestamp as an optional field: absent, never `undefined` — Firestore refuses `undefined` values. */
const isoField = <K extends string>(key: K, ms: number | undefined): Partial<Record<K, string>> =>
  ms === undefined ? {} : ({ [key]: new Date(ms).toISOString() } as Record<K, string>);
const refOf = (component: PlanComponent): AttemptComponentRef => ({
  materialId: component.materialId,
  contentHash: component.contentHash,
  part: component.part,
});
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/**
 * The attempt to store: every answer, essay and transcript against the bundle,
 * the exact material version and the question, task or part it belongs to.
 * Submitted work is recorded whether or not it has a band yet.
 */
export function toExamAttempt(state: ExamRunState): MockAttempt {
  const result = examResult(state);
  const sectionPlan = (section: BundleSection) => state.plan.sections.find((entry) => entry.section === section);

  const sections: NonNullable<MockAttempt['sections']> = {};
  for (const plan of state.plan.sections) {
    const run = state.sections[plan.section];
    const record: AttemptSectionRecord = {
      status: run.status,
      ...isoField('startedAt', run.startedAt),
      ...isoField('endedAt', run.endedAt),
      ...(run.endedBy ? { endedBy: run.endedBy } : {}),
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
        const work = state.sections.writing.writing[task];
        const band = gradedBand(work);
        const component = writingPlan.components[0];
        return {
          materialId: component.materialId,
          contentHash: component.contentHash,
          task,
          ...(band !== undefined ? { band } : {}),
          essay: work?.essay ?? '',
          wordCount: work ? words(work.essay) : 0,
        };
      })
    : [];

  const speakingPlan = sectionPlan('speaking');
  const speakingParts: AttemptSpeakingPart[] = speakingPlan
    ? speakingPlan.parts.map((part) => {
        const work = state.sections.speaking.speaking[part];
        const band = gradedBand(work);
        const component = speakingPlan.components[0];
        return {
          materialId: component.materialId,
          contentHash: component.contentHash,
          part,
          ...(band !== undefined ? { band } : {}),
          transcript: work?.transcript ?? '',
        };
      })
    : [];

  const listening = state.sections.listening;
  const reading = state.sections.reading;
  const startedAt = state.startedAt ?? Date.now();
  const finishedAt = state.finishedAt ?? Date.now();
  const task1Band = gradedBand(state.sections.writing.writing[1]);
  const task2Band = gradedBand(state.sections.writing.writing[2]);

  return {
    id: state.attemptId,
    testId: state.plan.bundleId,
    testTitle: state.plan.bundleTitle,
    bundleId: state.plan.bundleId,
    bundlePublishedAt: state.plan.bundlePublishedAt,
    timing: { ...state.plan.timing },
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
            // Both tasks carry a band whenever the section has one: `writingSectionBand` requires them.
            writing: {
              band: result.bands.writing,
              ...(task1Band !== undefined ? { task1Band } : {}),
              ...(task2Band !== undefined ? { task2Band } : {}),
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
