import { randomUUID } from 'node:crypto';
import type { AnswerValue, SpeakingGradingResult, WritingGradingResult } from '../types';
import type { BundleComponentRef, ExamSitting } from '../types/bundle';
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
import type { DataStore } from './storage';
import type { SittingOutcome } from './bundleService';
import {
  buildExamPlan,
  createExamRun,
  currentSection,
  examReducer,
  ExamPlanError,
  progressOf,
  toExamAttempt,
  toRunView,
  type ExamEvent,
  type ExamRunState,
} from './examRun';
import { sittingToAdaptedTest, toExamPaper } from './sittingAdapters';
import type { GradeOutcome, SpeakingSubmission, WritingSubmission } from './grading';

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
 */

type SessionStore = Pick<DataStore, 'listExamSessions' | 'getExamSession' | 'saveExamSession' | 'saveUserAttempt'>;

export interface ExamSessionDeps {
  store: SessionStore;
  resolveSitting: (bundleId: string) => Promise<SittingOutcome>;
  verifyAttempt: (attempt: ReturnType<typeof toExamAttempt>) => Promise<string[]>;
  gradeWriting: (input: WritingSubmission) => Promise<GradeOutcome<WritingGradingResult>>;
  gradeSpeaking: (input: SpeakingSubmission) => Promise<GradeOutcome<SpeakingGradingResult>>;
  now: () => number;
  newId: () => string;
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

const pinKey = (ref: BundleComponentRef) => `${ref.section}:${ref.part}:${ref.materialId}:${ref.contentHash}`;
const pinsOf = (sitting: ExamSitting): BundleComponentRef[] =>
  sitting.components.map(({ section, part, materialId, contentHash }) => ({ section, part, materialId, contentHash }));
const samePins = (a: BundleComponentRef[], b: BundleComponentRef[]) =>
  JSON.stringify(a.map(pinKey).sort()) === JSON.stringify(b.map(pinKey).sort());

/** A session that is over and can take no more events. */
const CLOSED: ExamSessionStatus[] = ['abandoned', 'superseded'];

/** How many times a write that lost a race is re-applied before the request is refused. */
const MAX_WRITE_ATTEMPTS = 5;

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

  function viewOf(record: ExamSessionRecord, state: ExamRunState): ExamSessionView {
    return {
      sessionId: record.id,
      bundleId: record.bundleId,
      status: record.status,
      serverNow: deps.now(),
      run: toRunView(state),
      attemptSaved: Boolean(record.attemptSavedAt),
      ...(record.attemptSavedAt ? { attempt: toExamAttempt(state) } : {}),
    };
  }

  /**
   * Loads a session, closes whatever its clock has closed, applies `change` and
   * stores the result — recording the attempt when the last section has closed.
   * A write that loses a race is retried from the fresh state.
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

      if (finished && !record.attemptSavedAt) {
        const attemptRecord = toExamAttempt(state);
        const problems = await deps.verifyAttempt(attemptRecord);
        if (problems.length > 0) {
          // A run the engine produced and the verifier refuses is a defect, not a
          // learner error. Nothing is recorded; the session stays unsaved so it can be retried.
          console.error(`[ExamSession] ${sessionId} produced an attempt that failed verification:`, problems);
        } else {
          // Stored under the session id, so a retry after a lost race overwrites rather than duplicates.
          await deps.store.saveUserAttempt(userId, attemptRecord);
          record = { ...record, attemptSavedAt: iso(now) };
        }
      }

      const unchanged =
        record.status === previous.status &&
        record.attemptSavedAt === previous.attemptSavedAt &&
        JSON.stringify(record.progress) === JSON.stringify(previous.progress);
      if (unchanged) return ok({ ...loaded.value, state, view: viewOf(previous, state) });

      if (await deps.store.saveExamSession(userId, record, previous.revision)) {
        return ok({ ...loaded.value, record, state, view: viewOf(record, state) });
      }
    }
    return fail(409, 'conflict', 'This exam session is being changed by another request. Try again.');
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
        const pending = session.status === 'active' || (session.status === 'finished' && !session.attemptSavedAt);
        if (!pending) continue;
        if (current) {
          const resumed = await commit(userId, session.id, (loaded) => ok({ state: loaded.state }));
          if (!resumed.ok) return resumed;
          if (resumed.value.record.status === 'active') return ok(opened(resumed.value, true));
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

    /** Grades one Writing task against the pinned prompt and records the band the model returned. */
    async gradeWriting(userId: string, sessionId: string, task: 1 | 2, essay: string): Promise<SessionOutcome<WritingGradedResponse>> {
      const before = await commit(userId, sessionId, (loaded) => ok({ state: loaded.state }));
      if (!before.ok) return before;
      const ready = writingOpen(before.value.state, task);
      if (!ready.ok) return ready;

      // The same prompt text the practice screen grades against: the pinned task's title and prompt.
      const pinnedTask = before.value.paper.writing[task === 1 ? 'task1' : 'task2'];
      const prompt = `${pinnedTask.title}\n${pinnedTask.prompt}`;
      // Graded as the module the bundle is: General Training Task 1 is a letter, Academic Task 1 is not.
      const graded = await deps.gradeWriting({ taskType: task === 1 ? 'task1' : 'task2', prompt, essay, module: before.value.sitting.bundle.module });
      if (!graded.ok) return { ok: false, status: graded.status, error: graded.body.error, code: graded.body.code ?? 'grading_failed', details: graded.body };

      const committed = await commit(userId, sessionId, (loaded) => {
        // The clock kept running while the model graded.
        const still = writingOpen(loaded.state, task);
        if (!still.ok) return still;
        return ok({ state: examReducer(loaded.state, { type: 'writing_graded', task, band: graded.result.band_overall, essay }) });
      });
      return committed.ok ? ok({ view: committed.value.view, result: graded.result }) : committed;
    },

    /** Grades one Speaking part against the pinned part and records the band the model returned. */
    async gradeSpeaking(
      userId: string,
      sessionId: string,
      part: 1 | 2 | 3,
      answer: Pick<SpeakingSubmission, 'audioBase64' | 'mimeType' | 'transcriptProvided' | 'clientMetrics'>,
    ): Promise<SessionOutcome<SpeakingGradedResponse>> {
      const before = await commit(userId, sessionId, (loaded) => ok({ state: loaded.state }));
      if (!before.ok) return before;
      const ready = speakingOpen(before.value.state, part);
      if (!ready.ok) return ready;

      const partData = before.value.paper.speaking.parts.find((entry) => entry.partNumber === part);
      if (!partData) return fail(409, 'invalid_bundle', `The exam has no Speaking Part ${part}.`);
      const graded = await deps.gradeSpeaking({
        ...answer,
        partNumber: part,
        topic: partData.topic,
        ...(partData.cueCard ? { cueCard: JSON.stringify(partData.cueCard) } : {}),
      });
      if (!graded.ok) return { ok: false, status: graded.status, error: graded.body.error, code: graded.body.code ?? 'grading_failed', details: graded.body };

      const transcript = graded.result.transcript || (typeof answer.transcriptProvided === 'string' ? answer.transcriptProvided : '');
      const committed = await commit(userId, sessionId, (loaded) => {
        const still = speakingOpen(loaded.state, part);
        if (!still.ok) return still;
        return ok({ state: examReducer(loaded.state, { type: 'speaking_graded', part, band: graded.result.band_overall, transcript }) });
      });
      return committed.ok ? ok({ view: committed.value.view, result: graded.result }) : committed;
    },

    /** Leaves the exam. Nothing is recorded for a sitting the learner walked away from. */
    async abandon(userId: string, sessionId: string): Promise<SessionOutcome<ExamSessionView>> {
      const committed = await commit(userId, sessionId, (loaded) =>
        loaded.record.status === 'active' ? ok({ state: loaded.state, status: 'abandoned' }) : fail(409, 'session_closed', 'This exam is over.'),
      );
      return committed.ok ? ok(committed.value.view) : committed;
    },

    /** Sessions this learner can return to: in progress, or finished with the attempt not yet stored. */
    async list(userId: string): Promise<ExamSessionSummary[]> {
      const sessions = await deps.store.listExamSessions(userId);
      return sessions
        .filter((session) => session.status === 'active' || (session.status === 'finished' && !session.attemptSavedAt))
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
  if (state.sections.writing.writing[task]) return fail(409, 'already_graded', `Writing Task ${task} has already been submitted.`);
  return ok(true);
}

function speakingOpen(state: ExamRunState, part: 1 | 2 | 3): SessionOutcome<true> {
  const section = currentSection(state);
  if (!section || section.section !== 'speaking' || !section.parts.includes(part)) {
    return fail(409, 'section_closed', 'Speaking is not the section in progress.');
  }
  if (state.sections.speaking.speaking[part]) return fail(409, 'already_graded', `Speaking Part ${part} has already been submitted.`);
  return ok(true);
}

/** The service as the running server uses it: real stores, real grading, the real clock. */
export async function createDefaultExamSessionService(): Promise<ExamSessionService> {
  const [{ dataStore }, { openSitting }, { verifyExamAttempt }, grading] = await Promise.all([
    import('./storage'),
    import('./bundleService'),
    import('./attemptVerification'),
    import('./grading'),
  ]);
  return createExamSessionService({
    store: dataStore,
    resolveSitting: openSitting,
    verifyAttempt: verifyExamAttempt,
    gradeWriting: grading.gradeWritingSubmission,
    gradeSpeaking: grading.gradeSpeakingSubmission,
    now: () => Date.now(),
    newId: () => randomUUID(),
  });
}
