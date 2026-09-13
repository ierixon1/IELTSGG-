import { createHash, randomUUID } from 'node:crypto';
import type { AnswerValue, SpeakingGradingResult, WritingGradingResult } from '../types';
import { BUNDLE_SECTIONS, type BundleComponentRef, type ExamSitting } from '../types/bundle';
import type {
  ExamClientEvent,
  ExamPaper,
  ExamSessionErrorCode,
  ExamSessionOpened,
  ExamSessionRecord,
  ExamSessionStatus,
  ExamSessionSummary,
  ExamSessionView,
  SpeakingGradedResponse,
  WritingGradedResponse,
} from '../types/examSession';
import type { DataStore, StorageProvider } from './storage';
import type { SittingOutcome } from './bundleService';
import {
  buildExamPlan,
  createExamRun,
  currentSection,
  examReducer,
  ExamPlanError,
  gradingOf,
  gradingOutstanding,
  gradingUnsettled,
  MAX_GRADING_RUNS,
  progressOf,
  toExamAttempt,
  type ExamEvent,
  type ExamRunState,
  type GradingRecord,
  type RunProgress,
  type SpeakingAudioRef,
  type SpeakingWork,
} from './examRun';
import { sittingToAdaptedTest, toExamPaper } from './sittingAdapters';
import { toExamResultView, toLearnerRunView } from './examDisclosure';
import type { GradeOutcome, GradingContext } from './grading';
import { checkSpeakingSubmission, checkWritingSubmission, type InputRefusal, type SpeakingSubmission, type WritingSubmission } from './gradingInput';

/**
 * The exam session: one full sitting of a published bundle, held and decided
 * on the server.
 *
 * Every request re-resolves the bundle through the same gate a learner opens it
 * with, so a component that changed, was withdrawn or lost its audio mid-exam
 * stops the sitting with a configuration error instead of marking against
 * content the learner never saw. The run is the same `examRun` state machine the
 * tests drive, fed with the server's clock: the browser sends what the learner
 * did, never when, and never a band.
 *
 * Writes are compare-and-set on a revision, so two requests racing on one
 * session — an autosave and a submit — cannot silently overwrite each other;
 * the loser is re-applied on the fresh state.
 *
 * Writing and Speaking (H6, H7) are two requests, not one:
 *
 *   - **Submit** is accepted on the server's clock while its section runs. It
 *     stores the essay, the typed transcript, or a reference to the recording it
 *     stored first, with grading `pending` — and answers at once. No model is
 *     involved, so no model can make a valid submission miss its deadline.
 *   - **Grade** claims a run on pending, failed or interrupted work (compare-and-set,
 *     so two requests cannot both claim it), grades under the grading policy —
 *     bounded, and blind to the section clock — and records the band or the
 *     failure on the work, even if the section closed meanwhile. A section that
 *     closed while a band was out waits for it, then completes.
 *   - A run holds a lease. A run whose request died counts as interrupted once the
 *     lease passes, and may be claimed again. Every submitted task or part has at
 *     most `MAX_GRADING_RUNS` runs, and each run charges one unit of the learner's
 *     AI allowance — a repeated submit, a reload, or a grade request while a run is
 *     out charges nothing and starts nothing.
 */

type SessionStore = Pick<DataStore, 'listExamSessions' | 'getExamSession' | 'saveExamSession' | 'saveUserAttempt'>;

/** A lease comfortably longer than the grading policy's total timeout. */
export const DEFAULT_GRADING_LEASE_MS = 160_000;

export interface ExamSessionDeps {
  store: SessionStore;
  /** Where a recorded Speaking answer is stored when it is submitted, and read back when it is graded. */
  audio: Pick<StorageProvider, 'uploadFile' | 'downloadFile'>;
  resolveSitting: (bundleId: string) => Promise<SittingOutcome>;
  verifyAttempt: (attempt: ReturnType<typeof toExamAttempt>) => Promise<string[]>;
  gradeWriting: (input: WritingSubmission, context: GradingContext) => Promise<GradeOutcome<WritingGradingResult>>;
  gradeSpeaking: (input: SpeakingSubmission, context: GradingContext) => Promise<GradeOutcome<SpeakingGradingResult>>;
  now: () => number;
  newId: () => string;
  /** How long a claimed grading run is presumed alive. Must outlast the grading call. */
  gradingLeaseMs?: () => number;
}

export type SessionFailure = {
  ok: false;
  status: number;
  error: string;
  code: ExamSessionErrorCode | string;
  details?: Record<string, unknown>;
};
export type SessionOutcome<T> = { ok: true; value: T } | SessionFailure;

const fail = (status: number, code: ExamSessionErrorCode, error: string): SessionFailure => ({ ok: false, status, code, error });
const ok = <T>(value: T): SessionOutcome<T> => ({ ok: true, value });
const refused = (refusal: InputRefusal): SessionFailure => ({
  ok: false,
  status: refusal.status,
  error: refusal.body.error,
  code: refusal.body.code ?? 'invalid_submission',
  details: refusal.body,
});

const pinKey = (ref: BundleComponentRef) => `${ref.section}:${ref.part}:${ref.materialId}:${ref.contentHash}`;
const pinsOf = (sitting: ExamSitting): BundleComponentRef[] =>
  sitting.components.map(({ section, part, materialId, contentHash }) => ({ section, part, materialId, contentHash }));
const samePins = (a: BundleComponentRef[], b: BundleComponentRef[]) =>
  JSON.stringify(a.map(pinKey).sort()) === JSON.stringify(b.map(pinKey).sort());

/** How many times a write that lost a race is re-applied before the request is refused. */
const MAX_WRITE_ATTEMPTS = 5;

/** A session a learner still returns to: in progress, finished with its attempt not stored, or with a band still to come. */
const stillOpen = (session: Pick<ExamSessionRecord, 'status' | 'attemptSavedAt' | 'progress'>, now: number) =>
  session.status === 'active' || (session.status === 'finished' && (!session.attemptSavedAt || gradingOutstanding(session.progress, now)));

const awaitingGrading = (progress: RunProgress) => BUNDLE_SECTIONS.some((section) => progress.sections[section].status === 'awaiting_grading');

interface Loaded {
  record: ExamSessionRecord;
  sitting: ExamSitting;
  paper: ExamPaper;
  state: ExamRunState;
}

interface Change {
  state: ExamRunState;
  status?: ExamSessionStatus;
}

export function createExamSessionService(deps: ExamSessionDeps) {
  const iso = (ms: number) => new Date(ms).toISOString();
  const leaseMs = () => deps.gradingLeaseMs?.() ?? DEFAULT_GRADING_LEASE_MS;

  /** The plan and paper for a resolved sitting, or the reason there is none. */
  function prepare(sitting: ExamSitting, attemptId: string): SessionOutcome<{ state: ExamRunState; paper: ExamPaper }> {
    try {
      const plan = buildExamPlan(sitting);
      const paper = toExamPaper(sittingToAdaptedTest(sitting).test);
      if (!paper) return fail(409, 'invalid_bundle', 'This exam does not supply every section.');
      return ok({ state: createExamRun(plan, attemptId), paper });
    } catch (error) {
      if (error instanceof ExamPlanError) return fail(409, 'invalid_bundle', error.message);
      throw error;
    }
  }

  async function resolve(bundleId: string): Promise<SessionOutcome<ExamSitting>> {
    const outcome = await deps.resolveSitting(bundleId);
    return outcome.ok ? ok(outcome.sitting) : { ok: false, status: outcome.status, code: outcome.code, error: outcome.error };
  }

  async function load(userId: string, sessionId: string): Promise<SessionOutcome<Loaded>> {
    let record: ExamSessionRecord | null;
    try {
      record = await deps.store.getExamSession(userId, sessionId);
    } catch {
      record = null;
    }
    if (!record || record.userId !== userId) return fail(404, 'session_not_found', 'This exam session does not exist.');
    if (record.status === 'superseded') {
      return fail(409, 'session_superseded', 'This exam was republished while it was open, so this sitting cannot continue.');
    }
    if (record.status === 'abandoned') return fail(409, 'session_closed', 'This exam sitting was left and cannot be resumed.');

    const sitting = await resolve(record.bundleId);
    if (!sitting.ok) return sitting;
    if (sitting.value.bundle.publishedAt !== record.bundlePublishedAt || !samePins(pinsOf(sitting.value), record.pins)) {
      return fail(409, 'session_superseded', 'This exam was republished while it was open, so this sitting cannot continue.');
    }

    const prepared = prepare(sitting.value, record.id);
    if (!prepared.ok) return prepared;
    return ok({ record, sitting: sitting.value, paper: prepared.value.paper, state: { ...record.progress, plan: prepared.value.state.plan } });
  }

  /**
   * The learner's view of a session — the one shape every route here returns.
   * Marks are disclosed only once the exam has finished (`examDisclosure`).
   */
  function viewOf(record: ExamSessionRecord, state: ExamRunState): ExamSessionView {
    const result = toExamResultView(state);
    return {
      sessionId: record.id,
      bundleId: record.bundleId,
      status: record.status,
      serverNow: deps.now(),
      run: toLearnerRunView(state, deps.now()),
      ...(result ? { result } : {}),
      attemptSaved: Boolean(record.attemptSavedAt),
      ...(record.attemptSavedAt ? { attempt: toExamAttempt(state) } : {}),
    };
  }

  /**
   * Loads a session, closes whatever its clock has closed, applies `change` and
   * stores the result — recording the attempt once the last section has closed and
   * every submitted piece of work has a grading outcome, and recording it again
   * when a later band changes it. A write that loses a race is retried from the fresh state.
   */
  async function commit(
    userId: string,
    sessionId: string,
    change: (loaded: Loaded, now: number) => SessionOutcome<Change>,
  ): Promise<SessionOutcome<Loaded & { view: ExamSessionView }>> {
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const loaded = await load(userId, sessionId);
      if (!loaded.ok) return loaded;
      const now = deps.now();
      const ticked = examReducer(loaded.value.state, { type: 'tick', now });
      const changed = change({ ...loaded.value, state: ticked }, now);
      if (!changed.ok) return changed;

      const { state } = changed.value;
      const previous = loaded.value.record;
      const finished = state.finishedAt !== undefined;
      const status = changed.value.status ?? (finished ? 'finished' : previous.status);
      let record: ExamSessionRecord = {
        ...previous,
        status,
        progress: progressOf(state),
        revision: previous.revision + 1,
        updatedAt: iso(now),
      };
      const progressChanged = JSON.stringify(record.progress) !== JSON.stringify(previous.progress);

      if (status === 'finished' && !gradingUnsettled(record.progress, now) && (!record.attemptSavedAt || progressChanged)) {
        const attemptRecord = toExamAttempt(state);
        const problems = await deps.verifyAttempt(attemptRecord);
        if (problems.length > 0) {
          // A run the engine produced and the verifier refuses is a defect, not a
          // learner error. Nothing is recorded; the session stays unsaved so it can be retried.
          console.error(`[ExamSession] ${sessionId} produced an attempt that failed verification:`, problems);
        } else {
          // Stored under the session id, so a later store overwrites rather than duplicates.
          await deps.store.saveUserAttempt(userId, attemptRecord);
          record = { ...record, attemptSavedAt: iso(now) };
        }
      }

      const unchanged = record.status === previous.status && record.attemptSavedAt === previous.attemptSavedAt && !progressChanged;
      if (unchanged) return ok({ ...loaded.value, state, view: viewOf(previous, state) });

      if (await deps.store.saveExamSession(userId, record, previous.revision)) {
        return ok({ ...loaded.value, record, state, view: viewOf(record, state) });
      }
    }
    return fail(409, 'conflict', 'This exam session is being changed by another request. Try again.');
  }

  /** Records what a grading run produced, on whatever the session has become since the run was claimed. */
  async function recordGrading(userId: string, sessionId: string, eventAt: (now: number) => ExamEvent): Promise<SessionOutcome<ExamSessionView>> {
    const committed = await commit(userId, sessionId, (loaded, now) => ok({ state: examReducer(loaded.state, eventAt(now)) }));
    return committed.ok ? ok(committed.value.view) : committed;
  }

  function speakingInput(loaded: Loaded, part: 1 | 2 | 3, answer: Omit<SpeakingSubmission, 'partNumber' | 'topic' | 'cueCard'>): SpeakingSubmission | null {
    const partData = loaded.paper.speaking.parts.find((entry) => entry.partNumber === part);
    if (!partData) return null;
    return { ...answer, partNumber: part, topic: partData.topic, ...(partData.cueCard ? { cueCard: JSON.stringify(partData.cueCard) } : {}) };
  }

  const toEvents = (event: ExamClientEvent, now: number): ExamEvent[] => {
    switch (event.type) {
      case 'start':
        return [{ type: 'start', now }];
      case 'answers':
        return Object.entries(event.answers).map(([questionId, value]: [string, AnswerValue]) => ({ type: 'answer', questionId, value }));
      case 'submit_answers':
        return [{ type: 'submit_answers', now }];
      case 'audio_started':
        return [{ type: 'audio_started', part: event.part, now }];
      case 'writing_draft':
        return [{ type: 'writing_draft', task: event.task, text: event.text }];
      case 'finish_section':
        return [{ type: 'finish_section', now }];
      case 'sync':
        return [];
    }
  };

  const opened = (loaded: Loaded & { view: ExamSessionView }, resumed: boolean): ExamSessionOpened => ({
    ...loaded.view,
    paper: loaded.paper,
    resumed,
  });

  return {
    /** Opens a published bundle: resumes this learner's session for it, or starts one. */
    async open(userId: string, bundleId: string): Promise<SessionOutcome<ExamSessionOpened>> {
      const sitting = await resolve(bundleId);
      if (!sitting.ok) return sitting;

      const sessions = (await deps.store.listExamSessions(userId)).filter((session) => session.bundleId === bundleId);
      for (const session of sessions) {
        const current = session.bundlePublishedAt === sitting.value.bundle.publishedAt && samePins(session.pins, pinsOf(sitting.value));
        if (!stillOpen(session, deps.now())) continue;
        if (current) {
          const resumed = await commit(userId, session.id, (loaded) => ok({ state: loaded.state }));
          if (!resumed.ok) return resumed;
          const { record } = resumed.value;
          // A finished sitting whose bands are still to come is the learner's result, not a reason to start again.
          if (record.status === 'active' || (awaitingGrading(record.progress) && gradingOutstanding(record.progress, deps.now()))) {
            return ok(opened(resumed.value, true));
          }
          continue;
        }
        // Its bundle was republished: the content it was sitting no longer exists.
        await deps.store.saveExamSession(
          userId,
          { ...session, status: 'superseded', revision: session.revision + 1, updatedAt: iso(deps.now()) },
          session.revision,
        );
      }

      const id = `attempt-${deps.newId()}`;
      const prepared = prepare(sitting.value, id);
      if (!prepared.ok) return prepared;
      const now = deps.now();
      const record: ExamSessionRecord = {
        id,
        userId,
        bundleId,
        bundlePublishedAt: sitting.value.bundle.publishedAt,
        pins: pinsOf(sitting.value),
        status: 'active',
        revision: 0,
        createdAt: iso(now),
        updatedAt: iso(now),
        progress: progressOf(prepared.value.state),
      };
      if (!(await deps.store.saveExamSession(userId, record, null))) return fail(409, 'conflict', 'The exam session could not be created. Try again.');
      return ok({ ...viewOf(record, prepared.value.state), paper: prepared.value.paper, resumed: false });
    },

    /** The session as it stands now, with anything its clock has closed closed. */
    async get(userId: string, sessionId: string): Promise<SessionOutcome<ExamSessionOpened>> {
      const loaded = await commit(userId, sessionId, (current) => ok({ state: current.state }));
      return loaded.ok ? ok(opened(loaded.value, true)) : loaded;
    },

    /** Applies what the learner did, stamped with the server's clock. */
    async apply(userId: string, sessionId: string, events: ExamClientEvent[]): Promise<SessionOutcome<ExamSessionView>> {
      const committed = await commit(userId, sessionId, (loaded, now) => {
        const acting = events.some((event) => event.type !== 'sync');
        if (acting && loaded.record.status !== 'active') return fail(409, 'session_closed', 'This exam is over.');
        const state = events.flatMap((event) => toEvents(event, now)).reduce(examReducer, loaded.state);
        return ok({ state });
      });
      return committed.ok ? ok(committed.value.view) : committed;
    },

    /**
     * Submits one Writing task: stores the essay, grading pending, if the section is
     * running now. No model is called. The same essay submitted again returns what
     * is stored; a different one is refused.
     */
    async submitWriting(userId: string, sessionId: string, task: 1 | 2, essay: string): Promise<SessionOutcome<WritingGradedResponse>> {
      const before = await commit(userId, sessionId, (loaded) => ok({ state: loaded.state }));
      if (!before.ok) return before;
      const pinnedTask = before.value.paper.writing[task === 1 ? 'task1' : 'task2'];
      // Refused before anything is stored: what no model could grade is not a submission.
      const checked = checkWritingSubmission({ taskType: task === 1 ? 'task1' : 'task2', prompt: `${pinnedTask.title}\n${pinnedTask.prompt}`, essay, module: before.value.sitting.bundle.module });
      if (!checked.ok) return refused(checked);

      const accepted = await commit(userId, sessionId, (loaded, now) => {
        const existing = loaded.state.sections.writing.writing[task];
        if (existing) return existing.essay === essay ? ok({ state: loaded.state }) : fail(409, 'already_submitted', `Writing Task ${task} has already been submitted.`);
        const open = writingOpen(loaded.state, task);
        if (!open.ok) return open;
        return ok({ state: examReducer(loaded.state, { type: 'writing_submitted', task, essay, now }) });
      });
      return accepted.ok ? ok({ view: accepted.value.view }) : accepted;
    },

    /**
     * Grades one submitted Writing task: claims a run on pending, failed or
     * interrupted work, grades it against the pinned prompt, and records the band
     * or the failure — whatever the section clock has done since.
     */
    async gradeWriting(userId: string, sessionId: string, task: 1 | 2): Promise<SessionOutcome<WritingGradedResponse>> {
      const claimed: { run: number | null; essay: string } = { run: null, essay: '' };
      const accepted = await commit(userId, sessionId, (loaded, now) => {
        claimed.run = null;
        const work = loaded.state.sections.writing.writing[task];
        const refusal = gradeRefusal(work, now, `Writing Task ${task}`);
        if (refusal) return refusal;
        if (!work) return fail(409, 'not_submitted', `Writing Task ${task} has not been submitted.`);
        claimed.run = gradingOf(work, now).runs + 1;
        claimed.essay = work.essay;
        return ok({ state: examReducer(loaded.state, { type: 'writing_grading_started', task, now, leaseUntil: now + leaseMs() }) });
      });
      if (!accepted.ok) return accepted;
      const run = claimed.run;
      if (run === null) return ok({ view: accepted.value.view });

      const loaded = accepted.value;
      // The same prompt text the practice screen grades against: the pinned task's title and prompt.
      const pinnedTask = loaded.paper.writing[task === 1 ? 'task1' : 'task2'];
      const graded = await deps.gradeWriting(
        // Graded as the module the bundle is: General Training Task 1 is a letter, Academic Task 1 is not.
        { taskType: task === 1 ? 'task1' : 'task2', prompt: `${pinnedTask.title}\n${pinnedTask.prompt}`, essay: claimed.essay, module: loaded.sitting.bundle.module },
        { userId },
      );
      const recorded = await recordGrading(userId, sessionId, (now) =>
        graded.ok
          ? { type: 'writing_graded', task, run, band: graded.result.band_overall, now, ...(graded.model ? { model: graded.model } : {}) }
          : { type: 'writing_grading_failed', task, run, failure: graded.failure, now },
      );
      // The band stays with the session; the view says only where the grading stands.
      return recorded.ok ? ok({ view: recorded.value }) : recorded;
    },

    /**
     * Submits one Speaking part: stores the recording, then records it — with the
     * typed transcript, grading pending — if the section is running now.
     */
    async submitSpeaking(
      userId: string,
      sessionId: string,
      part: 1 | 2 | 3,
      answer: Pick<SpeakingSubmission, 'audioBase64' | 'mimeType' | 'transcriptProvided' | 'clientMetrics'>,
    ): Promise<SessionOutcome<SpeakingGradedResponse>> {
      const before = await commit(userId, sessionId, (loaded) => ok({ state: loaded.state }));
      if (!before.ok) return before;
      const input = speakingInput(before.value, part, answer);
      if (!input) return fail(409, 'invalid_bundle', `The exam has no Speaking Part ${part}.`);
      const checked = checkSpeakingSubmission(input);
      if (!checked.ok) return refused(checked);

      const audioBytes = checked.audioBase64 ? Buffer.from(checked.audioBase64, 'base64') : null;
      const sha256 = audioBytes ? createHash('sha256').update(audioBytes).digest('hex') : undefined;
      const typed = checked.transcriptProvided;
      const sameAnswer = (work: SpeakingWork) => work.transcriptProvided === typed && work.audio?.sha256 === sha256;

      // Refused before a recording is stored for work that will not be accepted.
      const existingBefore = before.value.state.sections.speaking.speaking[part];
      if (existingBefore) return sameAnswer(existingBefore) ? ok({ view: before.value.view }) : fail(409, 'already_submitted', `Speaking Part ${part} has already been submitted.`);
      const openBefore = speakingOpen(before.value.state, part);
      if (!openBefore.ok) return openBefore;

      let audio: SpeakingAudioRef | undefined;
      if (audioBytes && sha256) {
        const mimeType = checked.mimeType ?? 'audio/webm';
        const path = `exam_audio/${before.value.record.id}/part-${part}-${sha256.slice(0, 16)}`;
        await deps.audio.uploadFile(path, audioBytes, mimeType);
        audio = { path, mimeType, sha256, ...(checked.spokenSeconds > 0 ? { durationSeconds: checked.spokenSeconds } : {}) };
      }

      const accepted = await commit(userId, sessionId, (loaded, now) => {
        const existing = loaded.state.sections.speaking.speaking[part];
        if (existing) return sameAnswer(existing) ? ok({ state: loaded.state }) : fail(409, 'already_submitted', `Speaking Part ${part} has already been submitted.`);
        const open = speakingOpen(loaded.state, part);
        if (!open.ok) return open;
        return ok({
          state: examReducer(loaded.state, { type: 'speaking_submitted', part, now, ...(typed ? { transcriptProvided: typed } : {}), ...(audio ? { audio } : {}) }),
        });
      });
      return accepted.ok ? ok({ view: accepted.value.view }) : accepted;
    },

    /** Grades one submitted Speaking part from its stored recording or transcript, as `gradeWriting` does a task. */
    async gradeSpeaking(userId: string, sessionId: string, part: 1 | 2 | 3): Promise<SessionOutcome<SpeakingGradedResponse>> {
      const claimed: { run: number | null; work: SpeakingWork | null } = { run: null, work: null };
      const accepted = await commit(userId, sessionId, (loaded, now) => {
        claimed.run = null;
        const work = loaded.state.sections.speaking.speaking[part];
        const refusal = gradeRefusal(work, now, `Speaking Part ${part}`);
        if (refusal) return refusal;
        if (!work) return fail(409, 'not_submitted', `Speaking Part ${part} has not been submitted.`);
        claimed.run = gradingOf(work, now).runs + 1;
        claimed.work = work;
        return ok({ state: examReducer(loaded.state, { type: 'speaking_grading_started', part, now, leaseUntil: now + leaseMs() }) });
      });
      if (!accepted.ok) return accepted;
      const { run, work } = claimed;
      if (run === null || !work) return ok({ view: accepted.value.view });

      let audioBase64: string | undefined;
      if (work.audio) {
        try {
          audioBase64 = (await deps.audio.downloadFile(work.audio.path)).toString('base64');
        } catch (error) {
          console.error(`[ExamSession] the recording for ${sessionId} part ${part} could not be read:`, error instanceof Error ? error.message : error);
          const failed = await recordGrading(userId, sessionId, (now) => ({ type: 'speaking_grading_failed', part, run, failure: 'unavailable', now }));
          return failed.ok ? ok({ view: failed.value }) : failed;
        }
      }
      const input = speakingInput(accepted.value, part, {
        ...(audioBase64 ? { audioBase64, mimeType: work.audio?.mimeType } : {}),
        ...(work.transcriptProvided ? { transcriptProvided: work.transcriptProvided } : {}),
        ...(work.audio?.durationSeconds ? { clientMetrics: { durationSeconds: work.audio.durationSeconds } } : {}),
      });
      if (!input) return fail(409, 'invalid_bundle', `The exam has no Speaking Part ${part}.`);
      const graded = await deps.gradeSpeaking(input, { userId });
      const typed = work.transcriptProvided ?? '';
      const recorded = await recordGrading(userId, sessionId, (now) =>
        graded.ok
          ? { type: 'speaking_graded', part, run, band: graded.result.band_overall, transcript: graded.result.transcript || typed, now, ...(graded.model ? { model: graded.model } : {}) }
          : { type: 'speaking_grading_failed', part, run, failure: graded.failure, now },
      );
      return recorded.ok ? ok({ view: recorded.value }) : recorded;
    },

    /** Leaves the exam. Nothing is recorded for a sitting the learner walked away from. */
    async abandon(userId: string, sessionId: string): Promise<SessionOutcome<ExamSessionView>> {
      const committed = await commit(userId, sessionId, (loaded) =>
        loaded.record.status === 'active' ? ok({ state: loaded.state, status: 'abandoned' }) : fail(409, 'session_closed', 'This exam is over.'),
      );
      return committed.ok ? ok(committed.value.view) : committed;
    },

    /** Sessions this learner can return to: in progress, finished with the attempt not yet stored, or with bands still to come. */
    async list(userId: string): Promise<ExamSessionSummary[]> {
      const sessions = await deps.store.listExamSessions(userId);
      const now = deps.now();
      return sessions
        .filter((session) => stillOpen(session, now))
        .map((session) => ({
          sessionId: session.id,
          bundleId: session.bundleId,
          status: session.status,
          ...(session.progress.startedAt !== undefined ? { startedAt: session.progress.startedAt } : {}),
          attemptSaved: Boolean(session.attemptSavedAt),
        }));
    },
  };
}

export type ExamSessionService = ReturnType<typeof createExamSessionService>;

function writingOpen(state: ExamRunState, task: 1 | 2): SessionOutcome<true> {
  const section = currentSection(state);
  if (!section || section.section !== 'writing' || !section.tasks.includes(task)) {
    return fail(409, 'section_closed', 'Writing is not the section in progress.');
  }
  return ok(true);
}

function speakingOpen(state: ExamRunState, part: 1 | 2 | 3): SessionOutcome<true> {
  const section = currentSection(state);
  if (!section || section.section !== 'speaking' || !section.parts.includes(part)) {
    return fail(409, 'section_closed', 'Speaking is not the section in progress.');
  }
  return ok(true);
}

/** Why a task or part may not have a grading run claimed now, or null when it may. */
function gradeRefusal(work: { grading?: GradingRecord; band?: number } | undefined, now: number, label: string): SessionFailure | null {
  if (!work) return fail(409, 'not_submitted', `${label} has not been submitted.`);
  const grading = gradingOf(work, now);
  if (grading.status === 'graded') return fail(409, 'already_graded', `${label} has already been graded.`);
  if (grading.status === 'grading') return fail(409, 'grading_in_progress', `${label} is being graded now.`);
  if (grading.status === 'failed' && grading.runs >= MAX_GRADING_RUNS) {
    return fail(409, 'grading_retry_limit', `${label} has been sent for grading ${MAX_GRADING_RUNS} times, which is the limit.`);
  }
  return null;
}

/** The service as the running server uses it: real stores, real grading, the real clock. */
export async function createDefaultExamSessionService(): Promise<ExamSessionService> {
  const [{ dataStore, storageProvider }, { openSitting }, { verifyExamAttempt }, grading] = await Promise.all([
    import('./storage'),
    import('./bundleService'),
    import('./attemptVerification'),
    import('./grading'),
  ]);
  return createExamSessionService({
    store: dataStore,
    audio: storageProvider,
    resolveSitting: openSitting,
    verifyAttempt: verifyExamAttempt,
    gradeWriting: grading.gradeWritingSubmission,
    gradeSpeaking: grading.gradeSpeakingSubmission,
    now: () => Date.now(),
    newId: () => randomUUID(),
    gradingLeaseMs: grading.gradingLeaseMs,
  });
}
