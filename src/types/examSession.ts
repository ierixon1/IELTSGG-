import type {
  AnswerValue,
  ListeningData,
  MockAttempt,
  ReadingData,
  SittingQuestion,
  SpeakingData,
  WritingTaskData,
} from '../types';
import type { PlanShape, RunProgress, SectionStatus, SectionView } from '../services/examRun';
import type { BundleComponentRef, BundleSection, LearnerBundleErrorCode } from './bundle';

/**
 * A full exam sitting, held by the server.
 *
 * The browser used to hold the whole exam: the answer keys to mark it with, the
 * clock, and the attempt it reported at the end. A reload lost everything, the
 * keys were readable before a single answer was given, and the stored attempt
 * was whatever the browser said it was.
 *
 * An exam session moves all three to the server. It is created when a learner
 * opens a published bundle, it stores progress after every change, it marks
 * Listening and Reading against keys the browser never receives, it records
 * Writing and Speaking work when it is submitted and grades it against the exact
 * pinned prompts, it reads time from its own clock, and it records the attempt
 * itself — under the session id.
 */

/** The exam as the browser renders it: every section, no answer key anywhere. */
export interface ExamPaper {
  listening: ListeningData<SittingQuestion>;
  reading: ReadingData<SittingQuestion>;
  writing: { task1: WritingTaskData; task2: WritingTaskData };
  speaking: SpeakingData;
}

/**
 * `active` until the last section closes, then `finished`. `abandoned` when the
 * learner left the exam; `superseded` when the bundle was republished under a
 * different configuration while the session was open, so its content is gone.
 */
export type ExamSessionStatus = 'active' | 'finished' | 'abandoned' | 'superseded';

export interface ExamSessionRecord {
  /** Also the id of the attempt the session records. */
  id: string;
  userId: string;
  bundleId: string;
  bundlePublishedAt: string;
  /** Exactly what the bundle pinned when the session opened. */
  pins: BundleComponentRef[];
  status: ExamSessionStatus;
  /** Incremented on every stored change; a write carrying a stale revision is refused. */
  revision: number;
  createdAt: string;
  updatedAt: string;
  progress: RunProgress;
  /** When the attempt was last stored. Absent until then. */
  attemptSavedAt?: string;
}

/**
 * Where a submitted task's or part's grading stands, as the learner may know it:
 * whether a band is coming, came, or could not be produced — never the band.
 */
export interface LearnerGradingView {
  /** `pending`: submitted, no grading run claimed yet. The screen asks for one. */
  status: 'pending' | 'grading' | 'graded' | 'failed';
  /** Failed, and the learner may ask for it to be graded again. */
  retryable: boolean;
  /** Why the last run produced no band, in the terms the screen explains. */
  reason?: 'unavailable' | 'timeout' | 'quota' | 'failed';
}

/**
 * One section as a learner sees it: where it stands, and the learner's own work.
 *
 * Nothing here says whether any of that work was right. A mark shown while the
 * exam is still going is an answer oracle: answer a few questions, finish the
 * section, read the count, leave, open a fresh sitting and try other answers —
 * repeated, it gives up the multiple-choice key without ever touching practice.
 * Correct counts, raw scores, section and task bands and grading output stay on
 * the server until the exam is over, and then arrive only in `ExamResultView`.
 */
export interface LearnerSectionView {
  status: SectionStatus;
  startedAt?: number;
  deadline?: number;
  endedAt?: number;
  endedBy?: 'learner' | 'time';
  /** The learner's own answers. */
  answers: Record<string, AnswerValue>;
  /** Listening/Reading: when the answers were submitted — "answers submitted", not a mark. */
  submittedAt?: number;
  /** Writing: what the learner has typed so far. */
  drafts: Partial<Record<1 | 2, string>>;
  /** Writing tasks the session has accepted, with the essay accepted and where its grading stands. No band. */
  writing: Partial<Record<1 | 2, { essay: string; submittedAt?: number; grading: LearnerGradingView }>>;
  /** Speaking parts the session has accepted, with their transcript and where their grading stands. No band. */
  speaking: Partial<Record<1 | 2 | 3, { transcript: string; submittedAt?: number; grading: LearnerGradingView }>>;
  /** Listening: when each part's recording was started. */
  audioStarted?: Partial<Record<number, number>>;
}

/** The run as the learner sees it: the plan without questions or keys, and progress without marks. */
export interface LearnerRunView {
  attemptId: string;
  plan: PlanShape<SectionView>;
  sections: Record<BundleSection, LearnerSectionView>;
  currentIndex: number;
  startedAt?: number;
  finishedAt?: number;
}

/** The marks of a sitting, disclosed once the exam is over and not before. */
export interface ExamResultView {
  /** Every section closed with a band. */
  complete: boolean;
  /** Present only when complete. */
  overall?: number;
  bands: Partial<Record<BundleSection, number>>;
  /** Listening and Reading raw scores, for the sections that were marked. */
  raw: Partial<Record<'listening' | 'reading', { correct: number; total: number }>>;
  /** Sections whose work was all submitted and whose band has not arrived. */
  awaitingGrading: BundleSection[];
}

/**
 * The only shape a learner receives for a sitting, from every exam-session route.
 * Built by `toLearnerSessionView`; `result` and `attempt` exist only once the exam has finished.
 */
export interface ExamSessionView {
  sessionId: string;
  bundleId: string;
  status: ExamSessionStatus;
  /** The server's clock when this view was built, so the browser can correct its own. */
  serverNow: number;
  run: LearnerRunView;
  /** The sitting's marks. Present once the exam has finished; absent while it is in progress. */
  result?: ExamResultView;
  /** Present once the session is finished and its attempt is stored. */
  attempt?: MockAttempt;
  attemptSaved: boolean;
}

export interface ExamSessionOpened extends ExamSessionView {
  paper: ExamPaper;
  /** True when this reopened a session already in progress. */
  resumed: boolean;
}

/** A session in progress, as the exam catalog lists it. */
export interface ExamSessionSummary {
  sessionId: string;
  bundleId: string;
  status: ExamSessionStatus;
  startedAt?: number;
  attemptSaved: boolean;
}

/**
 * What the browser may ask of a session. There is no time on any of them — the
 * server stamps every event with its own clock — and no band: bands come from
 * grading on the server.
 */
export type ExamClientEvent =
  | { type: 'start' }
  | { type: 'answers'; answers: Record<string, AnswerValue> }
  | { type: 'submit_answers' }
  | { type: 'audio_started'; part: 1 | 2 | 3 | 4 }
  | { type: 'writing_draft'; task: 1 | 2; text: string }
  | { type: 'finish_section' }
  | { type: 'sync' };

export type ExamSessionErrorCode =
  | LearnerBundleErrorCode
  | 'session_not_found'
  | 'session_closed'
  | 'session_superseded'
  | 'section_closed'
  | 'already_submitted'
  | 'already_graded'
  | 'not_submitted'
  | 'grading_in_progress'
  | 'grading_retry_limit'
  | 'conflict';

export interface ExamSessionError {
  error: string;
  code: ExamSessionErrorCode;
}

/**
 * A Writing task or Speaking part submitted or graded again through the session.
 * The grading itself — band, criteria, annotations — stays on the server with the
 * attempt: during an exam the learner is told only that the work was accepted and
 * where its grading stands.
 */
export interface WritingGradedResponse {
  view: ExamSessionView;
}

export interface SpeakingGradedResponse {
  view: ExamSessionView;
}
