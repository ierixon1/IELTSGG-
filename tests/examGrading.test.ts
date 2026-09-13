import './env';
import { after, before, describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import type { GenerateContentParameters } from '@google/genai';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';
import type { MockAttempt, SpeakingGradingResult, WritingGradingResult } from '../src/types';
import type { ExamSitting } from '../src/types/bundle';
import type { ExamSessionRecord, ExamSessionView } from '../src/types/examSession';
import type { GradeOutcome, GradingContext, SpeakingSubmission, WritingSubmission } from '../src/services/grading';
import type { ExamSessionDeps, SessionOutcome } from '../src/services/examSession';
import type { BundleSection } from '../src/types/bundle';
import type { GradingFailure } from '../src/services/examRun';
import { CUSTOM_TIMING, FULL_SLOTS, asMaterial, listeningPayload, readingPayload, speakingPayload, writingPayload } from './bundleFixtures';

/**
 * Deadline-safe grading (H6) in the exam session.
 *
 * A Writing task or Speaking part that reaches the server before its section's
 * deadline is stored then, grading pending, and nothing that happens to grading
 * afterwards — a slow model, an unavailable one, a request that dies, a second
 * request racing the first — loses it, grades it twice, or gives it a band no
 * grader returned.
 *
 * The store here keeps Firestore's compare-and-set semantics in memory, so a race
 * is a real race; the clock and the grader are the test's.
 */
const originalCwd = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-exam-grading-'));
process.chdir(tempRoot);

const express = (await import('express')).default;
const { createExamSessionService } = await import('../src/services/examSession');
const { createExamSessionRouter } = await import('../src/routes/examSessionRoutes');
const { speakingSectionBand, writingSectionBand } = await import('../src/utils/ieltsScoring');
const { gradeWritingSubmission, setGradingProvider } = await import('../src/services/grading');
const { aiRateLimitService } = await import('../src/services/aiRateLimitService');

const MINUTE = 60_000;
const USER = 'usr_gradingLearner01';
let clock = Date.parse('2026-09-12T10:00:00.000Z');
const advance = (ms: number) => {
  clock += ms;
};
const hashFor = (id: string) => id.replace(/[^a-z0-9]/g, '').padEnd(64, '0').slice(0, 64);

const ESSAY =
  'Energy use rose steadily across the period shown in the chart, with coal falling from almost half of all supply to under a fifth, while wind rose sharply after 2010 and overtook gas by the final year, so the overall mix became far cleaner than it had been at the start.';
const ESSAY_2 =
  'Cities should restrict private cars in their centres, because cleaner air benefits everyone who lives there. Opponents argue that shops lose trade, yet evidence from several European capitals shows footfall rising once streets are pedestrianised, and public transport can carry the workers who once drove in every morning.';
const SPOKEN = 'I live in a small flat near the river, and I like the quiet evenings there most of all, when the city goes still.';

function sitting(): ExamSitting {
  const components = FULL_SLOTS.map(({ section, part }) => {
    const id = section === 'listening' ? `lis-${part}` : section === 'reading' ? `rea-${part}` : section === 'writing' ? 'wri-1' : 'spk-1';
    const payload =
      section === 'listening' ? listeningPayload(part, `ast_audiopart${part}000000`) : section === 'reading' ? readingPayload(part) : section === 'writing' ? writingPayload() : speakingPayload();
    return { section, part, materialId: id, contentHash: hashFor(id), material: asMaterial(id, payload) };
  });
  return { bundle: { id: 'cdi-grading', title: 'Grading Bundle', module: 'academic', publishedAt: '2026-09-10T00:00:00.000Z', timing: CUSTOM_TIMING }, components };
}
const SITTING = sitting();

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Exam sessions with Firestore's compare-and-set: a write carrying a stale revision is refused. */
class MemoryStore {
  readonly sessions = new Map<string, ExamSessionRecord>();
  readonly attempts = new Map<string, MockAttempt>();
  attemptWrites = 0;
  private held: { count: number; waiting: Array<() => void> } | null = null;

  /** The next `count` session reads each return what they read only once all of them have read. */
  holdReads(count: number) {
    this.held = { count, waiting: [] };
  }

  async listExamSessions(userId: string) {
    return [...this.sessions.values()].filter((record) => record.userId === userId).map(copy);
  }

  async getExamSession(userId: string, id: string) {
    const record = this.sessions.get(id);
    const read = record && record.userId === userId ? copy(record) : null;
    const held = this.held;
    if (held) {
      await new Promise<void>((resolve) => {
        held.waiting.push(resolve);
        if (held.waiting.length >= held.count) {
          this.held = null;
          held.waiting.forEach((release) => release());
        }
      });
    }
    return read;
  }

  async saveExamSession(_userId: string, record: ExamSessionRecord, expectedRevision: number | null) {
    const current = this.sessions.get(record.id);
    if (expectedRevision === null ? current !== undefined : current?.revision !== expectedRevision) return false;
    this.sessions.set(record.id, copy(record));
    return true;
  }

  async saveUserAttempt(_userId: string, attempt: MockAttempt) {
    this.attempts.set(attempt.id, copy(attempt));
    this.attemptWrites += 1;
  }
}

class MemoryAudio {
  readonly files = new Map<string, Buffer>();
  readonly uploads: string[] = [];
  failDownloads = 0;

  async uploadFile(storagePath: string, content: Buffer | Uint8Array | string) {
    this.files.set(storagePath, typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content));
    this.uploads.push(storagePath);
    return { storagePath };
  }

  async downloadFile(storagePath: string) {
    if (this.failDownloads > 0) {
      this.failDownloads -= 1;
      throw new Error('storage is unavailable');
    }
    const file = this.files.get(storagePath);
    if (!file) throw new Error(`no file at ${storagePath}`);
    return file;
  }
}

const writingResult = (band: number): GradeOutcome<WritingGradingResult> => ({
  ok: true,
  model: 'fixture/gemini-3.8-flash',
  result: { band_overall: band, criteria: [], annotated_text: [], word_count: 0, meets_word_limit: true, general_commentary: 'Fixture.' },
});
const criterion = { name: 'Fixture', band: 7, justification: 'Fixture.', improvement_tips: [] };
const speakingResult = (band: number, transcript: string): GradeOutcome<SpeakingGradingResult> => ({
  ok: true,
  result: {
    band_overall: band,
    transcript,
    criteria: { fluency_coherence: criterion, lexical_resource: criterion, grammatical_range: criterion, pronunciation: criterion },
    objective_metrics: { durationSeconds: 0, wordsPerMinute: 0, pausesCount: 0, totalPauseDurationSeconds: 0, fillerWords: [] },
    actionable_drills: [],
  },
});
function refusal<T>(failure: GradingFailure, status: number, code: string): GradeOutcome<T> {
  return { ok: false, status, body: { error: code, code }, failure };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean) {
  for (let turn = 0; turn < 1_000 && !condition(); turn++) await new Promise<void>((resolve) => setImmediate(resolve));
  if (!condition()) throw new Error('the condition never held');
}

interface WritingGrader {
  calls: WritingSubmission[];
  contexts: GradingContext[];
  respond: (input: WritingSubmission, call: number) => Promise<GradeOutcome<WritingGradingResult>>;
}
interface SpeakingGrader {
  calls: SpeakingSubmission[];
  respond: (input: SpeakingSubmission, call: number) => Promise<GradeOutcome<SpeakingGradingResult>>;
}

function world(options: { leaseMs?: number; gradeWriting?: ExamSessionDeps['gradeWriting'] } = {}) {
  const store = new MemoryStore();
  const audio = new MemoryAudio();
  const writing: WritingGrader = { calls: [], contexts: [], respond: async (input) => writingResult(input.taskType === 'task1' ? 6.5 : 7) };
  const speaking: SpeakingGrader = { calls: [], respond: async (input) => speakingResult(7, typeof input.transcriptProvided === 'string' ? input.transcriptProvided : 'transcribed from audio') };
  let sequence = 0;
  const service = createExamSessionService({
    store,
    audio,
    resolveSitting: async () => ({ ok: true, sitting: SITTING }),
    verifyAttempt: async () => [],
    gradeWriting:
      options.gradeWriting ??
      ((input, context) => {
        writing.calls.push(input);
        writing.contexts.push(context);
        return writing.respond(input, writing.calls.length);
      }),
    gradeSpeaking: (input) => {
      speaking.calls.push(input);
      return speaking.respond(input, speaking.calls.length);
    },
    now: () => clock,
    newId: () => `00000000-0000-4000-a000-${String(++sequence).padStart(12, '0')}`,
    ...(options.leaseMs !== undefined ? { gradingLeaseMs: () => options.leaseMs ?? 0 } : {}),
  });
  return { store, audio, writing, speaking, service };
}
type World = ReturnType<typeof world>;

function must<T>(outcome: SessionOutcome<T>): T {
  if (!outcome.ok) throw new Error(`refused: ${outcome.status} ${outcome.code} ${outcome.error}`);
  return outcome.value;
}
const codeOf = <T>(outcome: SessionOutcome<T>) => (outcome.ok ? 'ok' : `${outcome.status} ${outcome.code}`);

function stored(w: World, id: string) {
  const record = w.store.sessions.get(id);
  if (!record) throw new Error(`session ${id} is not stored`);
  return record;
}
const deadlineOf = (w: World, id: string, section: BundleSection) => stored(w, id).progress.sections[section].deadline ?? 0;

/** Opens a sitting and runs it to the start of Writing, or through a graded Writing to the start of Speaking. */
async function sitUntil(w: World, section: 'writing' | 'speaking') {
  const id = must(await w.service.open(USER, SITTING.bundle.id)).sessionId;
  must(await w.service.apply(USER, id, [{ type: 'start' }, { type: 'submit_answers' }, { type: 'finish_section' }, { type: 'submit_answers' }, { type: 'finish_section' }]));
  if (section === 'speaking') {
    must(await w.service.submitWriting(USER, id, 1, ESSAY));
    must(await w.service.gradeWriting(USER, id, 1));
    must(await w.service.submitWriting(USER, id, 2, ESSAY_2));
    must(await w.service.gradeWriting(USER, id, 2));
    must(await w.service.apply(USER, id, [{ type: 'finish_section' }]));
  }
  return id;
}

after(() => {
  process.chdir(originalCwd);
  removeTempRoot(tempRoot);
});

describe('a submission that reaches the server before the deadline is never lost', () => {
  it('keeps Writing submitted in the last second, though its grading finishes after the deadline', async () => {
    const w = world();
    const id = await sitUntil(w, 'writing');
    const deadline = deadlineOf(w, id, 'writing');

    clock = deadline - 1_000;
    const task1 = must(await w.service.submitWriting(USER, id, 1, ESSAY));
    expect(task1.view.run.sections.writing.writing[1]?.grading).toEqual({ status: 'pending', retryable: false });
    advance(500);
    must(await w.service.submitWriting(USER, id, 2, ESSAY_2));
    // Accepting them asked no model anything.
    expect(w.writing.calls).toHaveLength(0);

    // The model is slow: each grading run comes back two minutes later, past the deadline.
    w.writing.respond = async (input) => {
      advance(2 * MINUTE);
      return writingResult(input.taskType === 'task1' ? 6.5 : 7);
    };
    const graded1 = must(await w.service.gradeWriting(USER, id, 1));
    expect(clock).toBeGreaterThan(deadline);
    expect(graded1.view.run.sections.writing.status).toBe('awaiting_grading');
    expect(graded1.view.run.plan.sections[graded1.view.run.currentIndex].section).toBe('speaking');
    const graded2 = must(await w.service.gradeWriting(USER, id, 2));
    expect(graded2.view.run.sections.writing.status).toBe('completed');

    const writing = stored(w, id).progress.sections.writing;
    expect([writing.writing[1]?.essay, writing.writing[2]?.essay]).toEqual([ESSAY, ESSAY_2]);
    expect([writing.writing[1]?.submittedAt, writing.writing[2]?.submittedAt]).toEqual([deadline - 1_000, deadline - 500]);
    expect([writing.writing[1]?.band, writing.writing[2]?.band]).toEqual([6.5, 7]);
    expect(writing.band).toBe(writingSectionBand(6.5, 7) ?? -1);
    expect(writing.writing[2]?.grading?.model).toBe('fixture/gemini-3.8-flash');
    expect(w.writing.contexts).toEqual([{ userId: USER }, { userId: USER }]);
  });

  it('refuses Writing that arrives at the deadline, on the server’s clock, and stores and grades nothing for it', async () => {
    const w = world();
    const id = await sitUntil(w, 'writing');
    must(await w.service.submitWriting(USER, id, 1, ESSAY));
    clock = deadlineOf(w, id, 'writing');

    const late = await w.service.submitWriting(USER, id, 2, ESSAY_2);
    expect(codeOf(late)).toBe('409 section_closed');
    const writing = stored(w, id).progress.sections.writing;
    expect(writing.writing[2]).toBe(undefined);
    expect(writing.status).toBe('expired');
    expect(w.writing.calls).toHaveLength(0);

    // Task 1 was in on time: it is graded after the deadline all the same, and the expired section still has no band.
    must(await w.service.gradeWriting(USER, id, 1));
    expect(stored(w, id).progress.sections.writing.writing[1]?.band).toBe(6.5);
    expect(stored(w, id).progress.sections.writing.band).toBe(undefined);
    expect(codeOf(await w.service.gradeWriting(USER, id, 2))).toBe('409 not_submitted');
  });

  it('stores a Speaking recording when it is submitted, before the deadline, and grades it from storage after', async () => {
    const w = world();
    const id = await sitUntil(w, 'speaking');
    const deadline = deadlineOf(w, id, 'speaking');
    const recording = Buffer.from('OggS a recorded answer for part three, as bytes');
    const sha = createHash('sha256').update(recording).digest('hex');

    clock = deadline - 3_000;
    must(await w.service.submitSpeaking(USER, id, 1, { transcriptProvided: SPOKEN }));
    must(await w.service.submitSpeaking(USER, id, 2, { transcriptProvided: SPOKEN }));
    advance(2_500);
    const part3 = must(await w.service.submitSpeaking(USER, id, 3, { audioBase64: recording.toString('base64'), mimeType: 'audio/ogg', clientMetrics: { durationSeconds: 42 } }));
    expect(part3.view.run.sections.speaking.speaking[3]?.grading.status).toBe('pending');
    expect(w.speaking.calls).toHaveLength(0);
    const ref = stored(w, id).progress.sections.speaking.speaking[3]?.audio;
    expect(ref).toEqual({ path: `exam_audio/${id}/part-3-${sha.slice(0, 16)}`, mimeType: 'audio/ogg', sha256: sha, durationSeconds: 42 });
    expect(w.audio.files.get(ref?.path ?? '')?.equals(recording)).toBe(true);

    clock = deadline + MINUTE;
    const graded3 = must(await w.service.gradeSpeaking(USER, id, 3));
    expect(w.speaking.calls[0].audioBase64).toBe(recording.toString('base64'));
    expect(w.speaking.calls[0].mimeType).toBe('audio/ogg');
    expect(w.speaking.calls[0].partNumber).toBe(3);
    // The sitting is over, but two parts are still pending: no overall band, and no attempt stored yet.
    expect(graded3.view.status).toBe('finished');
    expect(graded3.view.run.sections.speaking.status).toBe('awaiting_grading');
    expect(graded3.view.result?.awaitingGrading).toEqual(['speaking']);
    expect(graded3.view.result?.overall).toBe(undefined);
    expect(graded3.view.attemptSaved).toBe(false);
    expect(w.store.attempts.size).toBe(0);

    must(await w.service.gradeSpeaking(USER, id, 1));
    expect(w.store.attempts.size).toBe(0);
    const graded2 = must(await w.service.gradeSpeaking(USER, id, 2));
    expect(graded2.view.result?.complete).toBe(true);
    expect(graded2.view.result?.overall).toBe(w.store.attempts.get(id)?.scores.overall);
    expect(graded2.view.result?.overall === undefined).toBe(false);
    expect(graded2.view.attemptSaved).toBe(true);
    const attempt = w.store.attempts.get(id);
    expect(attempt?.scores.speaking?.band).toBe(speakingSectionBand([7, 7, 7]) ?? -1);
    expect(attempt?.speakingParts?.map((part) => part.transcript)).toEqual([SPOKEN, SPOKEN, 'transcribed from audio']);
  });

  it('fails a grading run whose recording cannot be read back, keeps the submission, and grades it on the next request', async () => {
    const w = world();
    const id = await sitUntil(w, 'speaking');
    must(await w.service.submitSpeaking(USER, id, 1, { audioBase64: Buffer.from('OggS part one').toString('base64'), mimeType: 'audio/ogg' }));
    w.audio.failDownloads = 1;

    const failed = must(await w.service.gradeSpeaking(USER, id, 1));
    expect(failed.view.run.sections.speaking.speaking[1]?.grading).toEqual({ status: 'failed', retryable: true, reason: 'unavailable' });
    expect(w.speaking.calls).toHaveLength(0);
    expect(stored(w, id).progress.sections.speaking.speaking[1]?.audio === undefined).toBe(false);

    const graded = must(await w.service.gradeSpeaking(USER, id, 1));
    expect(graded.view.run.sections.speaking.speaking[1]?.grading.status).toBe('graded');
    expect(w.speaking.calls).toHaveLength(1);
  });
});

describe('one submission, one grading at a time, never a second charge', () => {
  it('returns the stored submission for the same answer, refuses a different one, and uploads a recording once', async () => {
    const w = world();
    const id = await sitUntil(w, 'speaking');
    const answer = { audioBase64: Buffer.from('OggS the same bytes').toString('base64'), mimeType: 'audio/ogg' };
    must(await w.service.submitSpeaking(USER, id, 1, answer));
    must(await w.service.submitSpeaking(USER, id, 1, answer));
    expect(w.audio.uploads).toHaveLength(1);
    expect(codeOf(await w.service.submitSpeaking(USER, id, 1, { audioBase64: Buffer.from('OggS other bytes').toString('base64'), mimeType: 'audio/ogg' }))).toBe('409 already_submitted');
    expect(w.audio.uploads).toHaveLength(1);
    expect(w.speaking.calls).toHaveLength(0);
  });

  it('shows the run while it is out — after a reload too — and starts no second one', async () => {
    const w = world();
    const id = await sitUntil(w, 'writing');
    must(await w.service.submitWriting(USER, id, 1, ESSAY));
    const gate = deferred<GradeOutcome<WritingGradingResult>>();
    w.writing.respond = () => gate.promise;

    const running = w.service.gradeWriting(USER, id, 1);
    await waitFor(() => w.writing.calls.length === 1);
    expect(must(await w.service.get(USER, id)).run.sections.writing.writing[1]?.grading).toEqual({ status: 'grading', retryable: false });
    const reopened = must(await w.service.open(USER, SITTING.bundle.id));
    expect([reopened.sessionId, reopened.resumed]).toEqual([id, true]);
    expect(reopened.run.sections.writing.writing[1]?.grading.status).toBe('grading');
    expect(codeOf(await w.service.gradeWriting(USER, id, 1))).toBe('409 grading_in_progress');
    expect(w.writing.calls).toHaveLength(1);

    gate.resolve(writingResult(7));
    expect(must(await running).view.run.sections.writing.writing[1]?.grading).toEqual({ status: 'graded', retryable: false });
    expect(codeOf(await w.service.gradeWriting(USER, id, 1))).toBe('409 already_graded');
    expect(w.writing.calls).toHaveLength(1);
  });

  it('lets exactly one of two grade requests that read the same state claim the run', async () => {
    const w = world();
    const id = await sitUntil(w, 'writing');
    must(await w.service.submitWriting(USER, id, 1, ESSAY));
    const gate = deferred<GradeOutcome<WritingGradingResult>>();
    w.writing.respond = () => gate.promise;

    w.store.holdReads(2);
    const first = w.service.gradeWriting(USER, id, 1);
    const second = w.service.gradeWriting(USER, id, 1);
    const loser = await Promise.race([first, second]);
    expect(codeOf(loser)).toBe('409 grading_in_progress');
    gate.resolve(writingResult(6));
    const outcomes = await Promise.all([first, second]);
    expect(outcomes.map(codeOf).sort()).toEqual(['409 grading_in_progress', 'ok']);
    expect(w.writing.calls).toHaveLength(1);
    expect(stored(w, id).progress.sections.writing.writing[1]?.grading?.runs).toBe(1);
  });

  it('charges one allowance unit for a graded task, however often it is submitted, reloaded or sent for grading again', async () => {
    const operations: string[] = [];
    const providerModels: string[] = [];
    const originalCheck = aiRateLimitService.checkLimit.bind(aiRateLimitService);
    aiRateLimitService.checkLimit = async (userId, operation) => {
      operations.push(`${userId}:${operation}`);
      return originalCheck(userId, operation);
    };
    setGradingProvider({
      name: 'test',
      generate: async (request: GenerateContentParameters) => {
        providerModels.push(request.model);
        return { text: JSON.stringify({ band_overall: 6.5, criteria: [], annotated_text: [], general_commentary: 'Fixture.' }) };
      },
    });
    try {
      const w = world({ gradeWriting: gradeWritingSubmission });
      const id = await sitUntil(w, 'writing');
      must(await w.service.submitWriting(USER, id, 1, ESSAY));
      must(await w.service.submitWriting(USER, id, 1, ESSAY));
      must(await w.service.get(USER, id));
      expect(operations).toHaveLength(0);

      must(await w.service.gradeWriting(USER, id, 1));
      expect(codeOf(await w.service.gradeWriting(USER, id, 1))).toBe('409 already_graded');
      must(await w.service.open(USER, SITTING.bundle.id));
      must(await w.service.submitWriting(USER, id, 1, ESSAY));

      expect(operations).toEqual([`${USER}:writing_grade`]);
      expect(providerModels).toEqual(['gemini-3.8-flash']);
      const work = stored(w, id).progress.sections.writing.writing[1];
      expect([work?.band, work?.grading?.model]).toEqual([6.5, 'test/gemini-3.8-flash']);
    } finally {
      aiRateLimitService.checkLimit = originalCheck;
      setGradingProvider(null);
    }
  });
});

describe('grading state: pending, grading, graded, failed', () => {
  it('counts a run whose request died as interrupted once its lease passes, grades again, and ignores the dead run’s late band', async () => {
    const w = world({ leaseMs: 30_000 });
    const id = await sitUntil(w, 'writing');
    must(await w.service.submitWriting(USER, id, 1, ESSAY));
    const dead = deferred<GradeOutcome<WritingGradingResult>>();
    w.writing.respond = (_input, call) => (call === 1 ? dead.promise : Promise.resolve(writingResult(6)));

    const firstRun = w.service.gradeWriting(USER, id, 1);
    await waitFor(() => w.writing.calls.length === 1);
    expect(codeOf(await w.service.gradeWriting(USER, id, 1))).toBe('409 grading_in_progress');
    advance(30_000);
    expect(must(await w.service.get(USER, id)).run.sections.writing.writing[1]?.grading).toEqual({ status: 'failed', retryable: true, reason: 'unavailable' });

    expect(must(await w.service.gradeWriting(USER, id, 1)).view.run.sections.writing.writing[1]?.grading.status).toBe('graded');
    dead.resolve(writingResult(9));
    must(await firstRun);
    const work = stored(w, id).progress.sections.writing.writing[1];
    expect([work?.band, work?.grading?.runs, work?.essay]).toEqual([6, 2, ESSAY]);
  });

  it('keeps the essay, says why grading failed, allows three runs, and never makes up a band', async () => {
    const w = world();
    const id = await sitUntil(w, 'writing');
    must(await w.service.submitWriting(USER, id, 1, ESSAY));
    w.writing.respond = async () => refusal('timeout', 504, 'grading_timeout');

    for (let run = 1; run <= 3; run++) {
      const outcome = must(await w.service.gradeWriting(USER, id, 1));
      expect(outcome.view.run.sections.writing.writing[1]?.grading).toEqual({ status: 'failed', retryable: run < 3, reason: 'timeout' });
    }
    expect(codeOf(await w.service.gradeWriting(USER, id, 1))).toBe('409 grading_retry_limit');
    expect(w.writing.calls).toHaveLength(3);
    const work = stored(w, id).progress.sections.writing.writing[1];
    expect([work?.essay, work?.band, work?.grading?.status, work?.grading?.failure, work?.grading?.runs]).toEqual([ESSAY, undefined, 'failed', 'timeout', 3]);
  });

  it('says so when the allowance or the model’s rate limit refused grading, and gives no band', async () => {
    const w = world();
    const id = await sitUntil(w, 'writing');
    must(await w.service.submitWriting(USER, id, 1, ESSAY));
    w.writing.respond = async () => refusal('quota', 429, 'quota_exceeded');
    const outcome = must(await w.service.gradeWriting(USER, id, 1));
    expect(outcome.view.run.sections.writing.writing[1]?.grading).toEqual({ status: 'failed', retryable: true, reason: 'quota' });
    expect(stored(w, id).progress.sections.writing.writing[1]?.band).toBe(undefined);
  });

  it('stores no overall band while a band is out, stores the attempt when grading settles, and stores it again when a retried band completes it', async () => {
    const w = world();
    const id = await sitUntil(w, 'speaking');
    for (const part of [1, 2] as const) {
      must(await w.service.submitSpeaking(USER, id, part, { transcriptProvided: SPOKEN }));
      must(await w.service.gradeSpeaking(USER, id, part));
    }
    must(await w.service.submitSpeaking(USER, id, 3, { transcriptProvided: SPOKEN }));

    const finished: ExamSessionView = must(await w.service.apply(USER, id, [{ type: 'finish_section' }]));
    expect(finished.status).toBe('finished');
    expect(finished.result?.overall).toBe(undefined);
    expect(finished.result?.awaitingGrading).toEqual(['speaking']);
    expect(finished.attemptSaved).toBe(false);
    expect(w.store.attempts.size).toBe(0);

    w.speaking.respond = async () => refusal('unavailable', 503, 'ai_unavailable');
    const failed = must(await w.service.gradeSpeaking(USER, id, 3));
    // Grading has an outcome now, a failure: the attempt is stored, incomplete, with no band made up.
    expect(failed.view.attemptSaved).toBe(true);
    const incomplete = w.store.attempts.get(id);
    expect([incomplete?.status, incomplete?.scores.overall, incomplete?.scores.speaking]).toEqual(['incomplete', undefined, undefined]);
    expect(incomplete?.speakingParts?.[2]).toEqual({ materialId: 'spk-1', contentHash: hashFor('spk-1'), part: 3, transcript: SPOKEN });
    // A band may still come, so the learner can come back to it.
    expect((await w.service.list(USER)).map((session) => session.sessionId)).toEqual([id]);

    w.speaking.respond = async (input) => speakingResult(8, String(input.transcriptProvided));
    const graded = must(await w.service.gradeSpeaking(USER, id, 3));
    expect(graded.view.result?.complete).toBe(true);
    const complete = w.store.attempts.get(id);
    expect([w.store.attempts.size, w.store.attemptWrites, complete?.status]).toEqual([1, 2, 'completed']);
    expect(graded.view.result?.overall).toBe(complete?.scores.overall);
    expect(complete?.speakingParts?.[2]?.band).toBe(8);
    expect(await w.service.list(USER)).toEqual([]);
  });
});

describe('over HTTP, the browser names no time and no band', () => {
  const w = world();
  let server: Server;
  let origin = '';
  const call = async (url: string, body?: unknown) => {
    const response = await fetch(`${origin}/api${url}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, text };
  };

  before(async () => {
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use('/api', (req: Request, _res: Response, next: NextFunction) => {
      (req as Request & { userId?: string }).userId = USER;
      next();
    });
    app.use('/api', createExamSessionRouter(w.service));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it('accepts a submission without grading it, grades it on its own request, and refuses what a browser has no business sending', async () => {
    const id = await sitUntil(w, 'writing');
    expect((await call(`/learner/exams/${id}/writing/1`, { essay: ESSAY, submittedAt: 0 })).status).toBe(400);
    expect((await call(`/learner/exams/${id}/writing/1`, { essay: ESSAY, band: 9 })).status).toBe(400);
    expect((await call(`/learner/exams/${id}/speaking/1`, { transcriptProvided: SPOKEN, now: 0 })).status).toBe(400);

    const submitted = await call(`/learner/exams/${id}/writing/1`, { essay: ESSAY });
    expect(submitted.status).toBe(200);
    expect(JSON.parse(submitted.text).view.run.sections.writing.writing['1'].grading).toEqual({ status: 'pending', retryable: false });
    expect(w.writing.calls).toHaveLength(0);

    const graded = await call(`/learner/exams/${id}/writing/1/grade`, {});
    expect(graded.status).toBe(200);
    expect(JSON.parse(graded.text).view.run.sections.writing.writing['1'].grading).toEqual({ status: 'graded', retryable: false });
    expect(graded.text.includes('"band"')).toBe(false);

    const again = await call(`/learner/exams/${id}/writing/1/grade`, {});
    expect([again.status, JSON.parse(again.text).code]).toEqual([409, 'already_graded']);
    const notSubmitted = await call(`/learner/exams/${id}/writing/2/grade`, {});
    expect([notSubmitted.status, JSON.parse(notSubmitted.text).code]).toEqual([409, 'not_submitted']);
    expect((await call(`/learner/exams/${id}/writing/3/grade`, {})).status).toBe(404);
  });
});
