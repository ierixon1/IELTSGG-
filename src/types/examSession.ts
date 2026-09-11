import type {
  AnswerValue,
  ListeningData,
  MockAttempt,
  ReadingData,
  SittingQuestion,
  SpeakingData,
  SpeakingGradingResult,
  WritingGradingResult,
  WritingTaskData,
} from '../types';
import type { ExamRunView, RunProgress } from '../services/examRun';
import type { BundleComponentRef, LearnerBundleErrorCode } from './bundle';

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
 * Listening and Reading against keys the browser never receives, it grades
 * Writing and Speaking against the exact pinned prompts, it reads time from its
 * own clock, and it records the attempt itself — once, under the session id.
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
  /** When the attempt was confirmed stored. Absent until then. */
  attemptSavedAt?: string;
}

export interface ExamSessionView {
  sessionId: string;
  bundleId: string;
  status: ExamSessionStatus;
  /** The server's clock when this view was built, so the browser can correct its own. */
  serverNow: number;
  run: ExamRunView;
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
  | { type: 'writing_draft'; task: 1 | 2; text: string }
  | { type: 'finish_section' }
  | { type: 'sync' };

export type ExamSessionErrorCode =
  | LearnerBundleErrorCode
  | 'session_not_found'
  | 'session_closed'
  | 'session_superseded'
  | 'section_closed'
  | 'already_graded'
  | 'conflict';

export interface ExamSessionError {
  error: string;
  code: ExamSessionErrorCode;
}

export interface WritingGradedResponse {
  view: ExamSessionView;
  result: WritingGradingResult;
}

export interface SpeakingGradedResponse {
  view: ExamSessionView;
  result: SpeakingGradingResult;
}
