import './env';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';
import type { MockAttempt, SpeakingGradingResult, WritingGradingResult } from '../src/types';
import type { ExamSitting } from '../src/types/bundle';
import type { ExamSessionOpened, ExamSessionRecord, ExamSessionView } from '../src/types/examSession';
import type { GradeOutcome } from '../src/services/grading';
import { CUSTOM_TIMING, FULL_SLOTS, asMaterial, listeningPayload, readingPayload, speakingPayload, writingPayload } from './bundleFixtures';

/**
 * H8: an exam Listening recording counts as heard only once it has really started.
 *
 * The exam screen used to tell the session a part had started before calling
 * `play()`, so a play the browser refused, a decode error or a dropped connection
 * spent the learner's one hearing. The session now holds each part's state:
 * not started → starting (a tab's claim, with a lease) → played (that tab's
 * confirmation). These drive it over the real exam-session routes, with an
 * in-memory store that keeps Firestore's compare-and-set, so two tabs racing for a
 * part really race.
 */
const originalCwd = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-exam-audio-'));
process.chdir(tempRoot);

const express = (await import('express')).default;
const { createExamSessionService } = await import('../src/services/examSession');
const { createExamSessionRouter } = await import('../src/routes/examSessionRoutes');
const { AUDIO_START_LEASE_MS } = await import('../src/services/examRun');

const USER = 'usr_audioLearner001';
const TAB_A = 'tab-a-claim-0001';
const TAB_B = 'tab-b-claim-0002';
let clock = Date.parse('2026-09-13T09:00:00.000Z');
const advance = (ms: number) => {
  clock += ms;
};
const hashFor = (id: string) => id.replace(/[^a-z0-9]/g, '').padEnd(64, '0').slice(0, 64);

function sitting(): ExamSitting {
  const components = FULL_SLOTS.map(({ section, part }) => {
    const id = section === 'listening' ? `lis-${part}` : section === 'reading' ? `rea-${part}` : section === 'writing' ? 'wri-1' : 'spk-1';
    const payload =
      section === 'listening' ? listeningPayload(part, `ast_audiopart${part}000000`) : section === 'reading' ? readingPayload(part) : section === 'writing' ? writingPayload() : speakingPayload();
    return { section, part, materialId: id, contentHash: hashFor(id), material: asMaterial(id, payload) };
  });
  return { bundle: { id: 'cdi-audio', title: 'Audio Bundle', module: 'academic', publishedAt: '2026-09-10T00:00:00.000Z', timing: CUSTOM_TIMING }, components };
}
const SITTING = sitting();

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Exam sessions with Firestore's compare-and-set: a write carrying a stale revision is refused. */
class MemoryStore {
  readonly sessions = new Map<string, ExamSessionRecord>();
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

  async saveUserAttempt(_userId: string, _attempt: MockAttempt) {}
}

const notGradedWriting = async (): Promise<GradeOutcome<WritingGradingResult>> => ({ ok: false, status: 503, body: { error: 'Not graded here.' }, failure: 'unavailable' });
const notGradedSpeaking = async (): Promise<GradeOutcome<SpeakingGradingResult>> => ({ ok: false, status: 503, body: { error: 'Not graded here.' }, failure: 'unavailable' });

const store = new MemoryStore();
let sequence = 0;
const service = createExamSessionService({
  store,
  audio: { uploadFile: async (storagePath: string) => ({ storagePath }), downloadFile: async () => Buffer.alloc(0) },
  resolveSitting: async () => ({ ok: true, sitting: SITTING }),
  verifyAttempt: async () => [],
  gradeWriting: notGradedWriting,
  gradeSpeaking: notGradedSpeaking,
  now: () => clock,
  newId: () => `00000000-0000-4000-b000-${String(++sequence).padStart(12, '0')}`,
});

let server: Server;
let origin = '';

async function call<T>(url: string, body?: unknown): Promise<{ status: number; body: T & { code?: string } }> {
  const response = await fetch(`${origin}/api${url}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as T & { code?: string } };
}
const events = (id: string, list: unknown[]) => call<ExamSessionView>(`/learner/exams/${id}/events`, { events: list });
const listeningOf = (view: ExamSessionView) => view.run.sections.listening;
const stored = (id: string) => {
  const record = store.sessions.get(id);
  if (!record) throw new Error(`session ${id} is not stored`);
  return record.progress.sections.listening;
};

let currentId = '';
/** A fresh sitting, started, in Listening. */
async function sitListening(): Promise<string> {
  if (currentId) await call(`/learner/exams/${currentId}/abandon`, {});
  const opened = await call<ExamSessionOpened>('/learner/exams', { bundleId: SITTING.bundle.id });
  currentId = opened.body.sessionId;
  expect((await events(currentId, [{ type: 'start' }])).status).toBe(200);
  return currentId;
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { userId?: string }).userId = USER;
    next();
  });
  app.use('/api', createExamSessionRouter(service));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  process.chdir(originalCwd);
  removeTempRoot(tempRoot);
});

describe('a recording is heard only once it has started', () => {
  it('holds a claim while the recording starts, and records the part as heard only when the claiming tab confirms playback began', async () => {
    const id = await sitListening();
    const claimed = await events(id, [{ type: 'audio_starting', part: 1, claim: TAB_A }]);
    expect(claimed.status).toBe(200);
    expect([listeningOf(claimed.body).audioStarted, listeningOf(claimed.body).audioClaims]).toEqual([undefined, { 1: { claim: TAB_A, leaseUntil: clock + AUDIO_START_LEASE_MS } }]);

    advance(1_500);
    const heardAt = clock;
    const playing = await events(id, [{ type: 'audio_playing', part: 1, claim: TAB_A }]);
    expect([listeningOf(playing.body).audioStarted, listeningOf(playing.body).audioClaims]).toEqual([{ 1: heardAt }, undefined]);
    expect(stored(id).audioStarted).toEqual({ 1: heardAt });
  });

  it('spends nothing on a start that failed, and plays the part on a retry', async () => {
    const id = await sitListening();
    await events(id, [{ type: 'audio_starting', part: 2, claim: TAB_A }]);
    const failed = await events(id, [{ type: 'audio_failed', part: 2, claim: TAB_A }]);
    expect([listeningOf(failed.body).audioStarted, listeningOf(failed.body).audioClaims]).toEqual([undefined, undefined]);

    // Released at once: another tab could take it now, and this one retries.
    const retried = await events(id, [{ type: 'audio_starting', part: 2, claim: TAB_A }]);
    expect(listeningOf(retried.body).audioClaims?.[2]?.claim).toBe(TAB_A);
    const heard = await events(id, [{ type: 'audio_playing', part: 2, claim: TAB_A }]);
    expect(listeningOf(heard.body).audioStarted).toEqual({ 2: clock });
  });

  it('refuses to play a part again once its recording has started — in the same tab or another', async () => {
    const id = await sitListening();
    await events(id, [{ type: 'audio_starting', part: 3, claim: TAB_A }, { type: 'audio_playing', part: 3, claim: TAB_A }]);
    const heardAt = stored(id).audioStarted?.[3];
    advance(10_000);
    for (const tab of [TAB_A, TAB_B]) {
      const again = await events(id, [{ type: 'audio_starting', part: 3, claim: tab }, { type: 'audio_playing', part: 3, claim: tab }]);
      expect([tab, again.status, listeningOf(again.body).audioStarted, listeningOf(again.body).audioClaims]).toEqual([tab, 200, { 3: heardAt }, undefined]);
    }
  });

  it('treats a double click as one claim, and ignores a confirmation or release from a tab that holds no claim', async () => {
    const id = await sitListening();
    await events(id, [{ type: 'audio_starting', part: 1, claim: TAB_A }]);
    await events(id, [{ type: 'audio_starting', part: 1, claim: TAB_A }]);
    expect(Object.keys(stored(id).audioClaims ?? {})).toEqual(['1']);
    const foreign = await events(id, [{ type: 'audio_playing', part: 1, claim: TAB_B }, { type: 'audio_failed', part: 1, claim: TAB_B }]);
    expect([listeningOf(foreign.body).audioStarted, listeningOf(foreign.body).audioClaims?.[1]?.claim]).toEqual([undefined, TAB_A]);
    const unclaimed = await events(id, [{ type: 'audio_playing', part: 4, claim: TAB_A }]);
    expect(listeningOf(unclaimed.body).audioStarted).toBe(undefined);
  });
});

describe('two tabs, a reload, and the server as the authority', () => {
  it('lets exactly one of two tabs that claim a part at the same moment hold it, and only that tab confirm it', async () => {
    const id = await sitListening();
    store.holdReads(2);
    const [first, second] = await Promise.all([
      events(id, [{ type: 'audio_starting', part: 1, claim: TAB_A }]),
      events(id, [{ type: 'audio_starting', part: 1, claim: TAB_B }]),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    const holder = stored(id).audioClaims?.[1]?.claim;
    expect([TAB_A, TAB_B].includes(holder ?? '')).toBe(true);
    // Both tabs are told the same holder, so the other one stops.
    expect([listeningOf(first.body).audioClaims?.[1]?.claim, listeningOf(second.body).audioClaims?.[1]?.claim]).toEqual([holder, holder]);

    const loser = holder === TAB_A ? TAB_B : TAB_A;
    await events(id, [{ type: 'audio_playing', part: 1, claim: loser }]);
    expect(stored(id).audioStarted).toBe(undefined);
    await events(id, [{ type: 'audio_playing', part: 1, claim: holder }]);
    expect(stored(id).audioStarted).toEqual({ 1: clock });
  });

  it('keeps a claim through a reload straight after Play: the same tab picks it up, another tab waits out the lease', async () => {
    const id = await sitListening();
    await events(id, [{ type: 'audio_starting', part: 2, claim: TAB_A }]);
    advance(3_000);
    const reloaded = await call<ExamSessionOpened>(`/learner/exams/${id}`);
    expect([listeningOf(reloaded.body).audioStarted, listeningOf(reloaded.body).audioClaims?.[2]?.claim]).toEqual([undefined, TAB_A]);

    const reclaimed = await events(id, [{ type: 'audio_starting', part: 2, claim: TAB_A }]);
    expect(listeningOf(reclaimed.body).audioClaims?.[2]).toEqual({ claim: TAB_A, leaseUntil: clock + AUDIO_START_LEASE_MS });
    const waiting = await events(id, [{ type: 'audio_starting', part: 2, claim: TAB_B }]);
    expect(listeningOf(waiting.body).audioClaims?.[2]?.claim).toBe(TAB_A);

    // The reloaded tab never started its recording: once the lease passes the part is another tab's to play.
    advance(AUDIO_START_LEASE_MS);
    const taken = await events(id, [{ type: 'audio_starting', part: 2, claim: TAB_B }, { type: 'audio_playing', part: 2, claim: TAB_B }]);
    expect(listeningOf(taken.body).audioStarted).toEqual({ 2: clock });
    const late = await events(id, [{ type: 'audio_playing', part: 2, claim: TAB_A }]);
    expect(listeningOf(late.body).audioStarted).toEqual({ 2: clock });
  });

  it('still refuses a replay after a reload once the recording had started', async () => {
    const id = await sitListening();
    await events(id, [{ type: 'audio_starting', part: 4, claim: TAB_A }, { type: 'audio_playing', part: 4, claim: TAB_A }]);
    const heardAt = clock;
    advance(60_000);
    const reopened = await call<ExamSessionOpened>('/learner/exams', { bundleId: SITTING.bundle.id });
    expect([reopened.body.sessionId, reopened.body.resumed, listeningOf(reopened.body).audioStarted]).toEqual([id, true, { 4: heardAt }]);
    const replay = await events(id, [{ type: 'audio_starting', part: 4, claim: 'tab-new-after-reload' }]);
    expect([listeningOf(replay.body).audioStarted, listeningOf(replay.body).audioClaims]).toEqual([{ 4: heardAt }, undefined]);
  });

  it('claims nothing outside Listening, and refuses events that name a time, a lease or no claim', async () => {
    const id = await sitListening();
    for (const forged of [
      { type: 'audio_started', part: 1 },
      { type: 'audio_starting', part: 1 },
      { type: 'audio_starting', part: 1, claim: TAB_A, now: 0 },
      { type: 'audio_starting', part: 1, claim: TAB_A, leaseUntil: clock + 3_600_000 },
      { type: 'audio_playing', part: 1, claim: 'x' },
      { type: 'audio_starting', part: 5, claim: TAB_A },
    ]) {
      const refused = await events(id, [forged]);
      expect([JSON.stringify(forged), refused.status]).toEqual([JSON.stringify(forged), 400]);
    }
    expect([stored(id).audioStarted, stored(id).audioClaims]).toEqual([undefined, undefined]);

    await events(id, [{ type: 'submit_answers' }, { type: 'finish_section' }]);
    const afterListening = await events(id, [{ type: 'audio_starting', part: 1, claim: TAB_A }, { type: 'audio_playing', part: 1, claim: TAB_A }]);
    expect([listeningOf(afterListening.body).audioStarted, listeningOf(afterListening.body).audioClaims]).toEqual([undefined, undefined]);
  });
});
