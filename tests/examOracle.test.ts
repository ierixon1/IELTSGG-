import './env';
import { after, before, beforeEach, describe, it } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';
import type { SpeakingGradingResult, WritingGradingResult } from '../src/types';
import type { GradeOutcome, SpeakingSubmission, WritingSubmission } from '../src/services/grading';
import { CUSTOM_TIMING, FULL_SLOTS, listeningAnswer, listeningPayload, readingAnswer, readingPayload, speakingPayload, writingPayload } from './bundleFixtures';

/**
 * No answer oracle during an exam.
 *
 * The exam session marks Listening and Reading the moment each section closes,
 * and grades Writing and Speaking as they are submitted. Those marks used to
 * travel back in every response. So: answer some questions, finish the section,
 * read the correct count, abandon, open a fresh sitting, answer differently,
 * compare — and the count tells you which answers were right. Repeated, it gives
 * up a multiple-choice key.
 *
 * These drive that attack over the real routes and read every response as raw
 * text. While an exam is in progress no response may carry a mark, and — the
 * decisive check — what a learner receives must not depend on whether their
 * answers were right at all.
 */
const originalCwd = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-exam-oracle-'));
process.chdir(tempRoot);

const ADMIN_USER = 'oracle_admin';
const ADMIN_PASSWORD = 'Str0ng-Passw0rd-For-Oracle';
process.env.SEED_DEFAULT_ACCOUNTS = 'true';
process.env.ADMIN_USER = ADMIN_USER;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;

const express = (await import('express')).default;
const { adminRouter } = await import('../src/routes/adminRoutes');
const { userDataRouter } = await import('../src/routes/userDataRoutes');
const { authRouter } = await import('../src/routes/authRoutes');
const { authenticateRequest } = await import('../src/middleware/authMiddleware');
const { createExamSessionRouter } = await import('../src/routes/examSessionRoutes');
const { createExamSessionService } = await import('../src/services/examSession');
const { dataStore, storageProvider } = await import('../src/services/storage');
const { openSitting } = await import('../src/services/bundleService');
const { verifyExamAttempt } = await import('../src/services/attemptVerification');
const { assetStore } = await import('../src/services/assetStore');

let clock = Date.parse('2026-09-12T09:00:00.000Z');
const advance = (ms: number) => {
  clock += ms;
};

async function gradeWriting(input: WritingSubmission): Promise<GradeOutcome<WritingGradingResult>> {
  return { ok: true, result: { band_overall: input.taskType === 'task1' ? 6.5 : 7, criteria: [], annotated_text: [], word_count: 0, meets_word_limit: true, general_commentary: 'WRITING-FEEDBACK' } };
}
async function gradeSpeaking(input: SpeakingSubmission): Promise<GradeOutcome<SpeakingGradingResult>> {
  const criterion = { name: 'x', band: 7, justification: 'SPEAKING-FEEDBACK', improvement_tips: [] };
  return {
    ok: true,
    result: {
      band_overall: 7,
      transcript: String(input.transcriptProvided ?? ''),
      criteria: { fluency_coherence: criterion, lexical_resource: criterion, grammatical_range: criterion, pronunciation: criterion },
      objective_metrics: { durationSeconds: 0, wordsPerMinute: 0, pausesCount: 0, totalPauseDurationSeconds: 0, fillerWords: [] },
      actionable_drills: [],
    },
  };
}

/** Long enough to pass the checks a submission meets before it is stored. */
const ESSAY =
  'with enough words to be graded properly by the examiner, because a submission shorter than the grading floor is refused before it is stored, and this sentence keeps going so that it clears that floor with a comfortable margin to spare.';
const SPOKEN = 'A long enough spoken answer for this part, with detail and some examples of where I went and what I saw there.';

let sequence = 0;
const service = createExamSessionService({
  store: dataStore,
  audio: storageProvider,
  resolveSitting: openSitting,
  verifyAttempt: verifyExamAttempt,
  gradeWriting,
  gradeSpeaking,
  now: () => clock,
  newId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
});

let server: Server;
let origin = '';
let adminCookie = '';
const learners: Record<'ana' | 'ben', { cookie: string; id: string }> = { ana: { cookie: '', id: '' }, ben: { cookie: '', id: '' } };
const ids: Record<string, string> = {};
let bundleId = '';

type Reply = { status: number; text: string; json: Record<string, unknown> };
const call = (who: 'ana' | 'ben') => async (url: string, body?: unknown): Promise<Reply> => {
  const response = await fetch(`${origin}${url}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', cookie: learners[who].cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, text, json: JSON.parse(text) as Record<string, unknown> };
};
const ana = call('ana');
const ben = call('ben');
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

/** Every field a mark, a correctness verdict or grading output travels in. */
const MARK_FIELDS = ['"objective"', '"band"', '"bands"', '"overall"', '"correct"', '"total"', '"rawScore"', '"raw"', '"result"', '"results"', '"band_overall"', '"criteria"', '"general_commentary"', '"scores"', '"attempt"', '"explanation"', '"correctAnswer"'];
function expectNoMarks(label: string, text: string) {
  for (const field of MARK_FIELDS) expect([label, field, text.includes(field)]).toEqual([label, field, false]);
  for (const feedback of ['WRITING-FEEDBACK', 'SPEAKING-FEEDBACK']) expect([label, text.includes(feedback)]).toEqual([label, false]);
}

/** All the Listening or Reading answers, right or wrong. */
function answersFor(section: 'listening' | 'reading', right: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  if (section === 'listening') {
    for (const part of [1, 2, 3, 4]) for (let i = 1; i <= 10; i++) out[`lis-p${part}-q${i}`] = right ? listeningAnswer(part, i) : `wrong${part}x${i}`;
  } else {
    for (const part of [1, 2, 3]) for (let i = 1; i <= (part === 3 ? 14 : 13); i++) out[`rea-p${part}-q${i}`] = right ? readingAnswer(part, i) : `wrong${part}x${i}`;
  }
  return out;
}

/**
 * A response with what legitimately differs between two sittings taken out: the
 * learner's own answers, ids and times. What remains is everything the server
 * says about the sitting — and it must not depend on whether the answers were right.
 */
const VOLATILE = new Set(['sessionId', 'attemptId', 'serverNow', 'startedAt', 'deadline', 'endedAt', 'submittedAt', 'answers']);
function normalised(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalised);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !VOLATILE.has(key)).map(([key, child]) => [key, normalised(child)]));
  }
  return value;
}

async function createPublished(payload: object): Promise<string> {
  const saved = await (await fetch(`${origin}/api/admin/materials`, { ...post(payload), headers: { 'Content-Type': 'application/json', cookie: adminCookie } })).json();
  const published = await fetch(`${origin}/api/admin/materials/${saved.item.section}/${saved.item.id}/publish`, { method: 'POST', headers: { cookie: adminCookie } });
  if (published.status !== 200) throw new Error(`fixture did not publish: ${await published.text()}`);
  return saved.item.id as string;
}

before(async () => {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/auth', authRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api', authenticateRequest);
  app.use('/api', userDataRouter);
  app.use('/api', createExamSessionRouter(service));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  const login = await fetch(`${origin}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASSWORD }) });
  adminCookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  for (const who of ['ana', 'ben'] as const) {
    const registered = await fetch(`${origin}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `oracle_${who}`, email: `${who}@oracle.example`, password: 'Str0ng-Passw0rd-For-Learner', name: who }),
    });
    learners[who] = { cookie: (registered.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; '), id: (await registered.json()).user.id };
  }

  for (const part of [1, 2, 3, 4]) {
    const asset = await assetStore.create({ originalName: `p${part}.mp3`, content: Buffer.from(`ID3 ${part}`), mimeType: 'audio/mpeg', kind: 'audio', createdBy: 'test', sourceType: 'upload' });
    ids[`listening-${part}`] = await createPublished(listeningPayload(part, asset.id));
  }
  for (const part of [1, 2, 3]) ids[`reading-${part}`] = await createPublished(readingPayload(part));
  ids['writing-1'] = await createPublished(writingPayload());
  ids['speaking-1'] = await createPublished(speakingPayload());

  const { candidates } = await (await fetch(`${origin}/api/admin/bundles/candidates`, { headers: { cookie: adminCookie } })).json();
  const components = FULL_SLOTS.map(({ section, part }) => {
    const materialId = ids[`${section}-${part}`];
    return { section, part, materialId, contentHash: candidates.find((entry: { id: string }) => entry.id === materialId).contentHash };
  });
  const created = await (await fetch(`${origin}/api/admin/bundles`, { ...post({ title: 'Oracle CDI', module: 'academic', components, timing: CUSTOM_TIMING }), headers: { 'Content-Type': 'application/json', cookie: adminCookie } })).json();
  bundleId = created.bundle.id;
  await fetch(`${origin}/api/admin/bundles/${bundleId}/publish`, { method: 'POST', headers: { cookie: adminCookie } });
});

// Hundreds of requests from one address; the global per-IP limiter is not under test here.
beforeEach(() => {
  writeFileSync(path.join(tempRoot, 'data', 'request_rate_limits.json'), '{}', 'utf8');
});

after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  process.chdir(originalCwd);
  removeTempRoot(tempRoot);
});

const storedProgress = async (sessionId: string) => {
  const record = await dataStore.getExamSession(learners.ana.id, sessionId);
  if (!record) throw new Error('session not stored');
  return record.progress;
};

describe('the H11 attack: answer, finish the section, abandon, reopen, repeat', () => {
  it('learns nothing: every response is the same whether the answers were right or wrong', async () => {
    const replies: Record<'right' | 'wrong', Reply[]> = { right: [], wrong: [] };
    for (const round of [1, 2]) {
      for (const verdict of ['right', 'wrong'] as const) {
        const seen = replies[verdict];
        const opened = await ana('/api/learner/exams', { bundleId });
        const sessionId = String(opened.json.sessionId);
        seen.push(opened);
        seen.push(await ana(`/api/learner/exams/${sessionId}/events`, { events: [{ type: 'start' }] }));
        seen.push(await ana(`/api/learner/exams/${sessionId}/events`, { events: [{ type: 'answers', answers: answersFor('listening', verdict === 'right') }] }));
        seen.push(await ana(`/api/learner/exams/${sessionId}/events`, { events: [{ type: 'submit_answers' }] }));
        seen.push(await ana(`/api/learner/exams/${sessionId}/events`, { events: [{ type: 'finish_section' }] }));
        seen.push(await ana(`/api/learner/exams/${sessionId}/events`, { events: [{ type: 'answers', answers: answersFor('reading', verdict === 'right') }, { type: 'submit_answers' }, { type: 'finish_section' }] }));
        seen.push(await ana(`/api/learner/exams/${sessionId}`));
        seen.push(await ana('/api/learner/exams', { bundleId }));
        seen.push(await ana('/api/learner/exams'));
        seen.push(await ana(`/api/learner/exams/${sessionId}/events`, { events: [{ type: 'sync' }] }));
        seen.push(await ana(`/api/learner/exams/${sessionId}/abandon`, {}));
        seen.push(await ana('/api/data'));

        // The server did mark it — for the attempt it would have stored.
        const marked = await dataStore.getExamSession(learners.ana.id, sessionId);
        expect(marked?.progress.sections.listening.objective?.correct).toBe(verdict === 'right' ? 40 : 0);
        expect(marked?.progress.sections.reading.objective?.correct).toBe(verdict === 'right' ? 40 : 0);
        advance(1_000);
        void round;
      }
    }

    expect(replies.right.length).toBe(replies.wrong.length);
    replies.right.forEach((right, index) => {
      const wrong = replies.wrong[index];
      expectNoMarks(`step ${index} (right)`, right.text);
      expectNoMarks(`step ${index} (wrong)`, wrong.text);
      expect([index, right.status]).toEqual([index, wrong.status]);
      expect([index, JSON.stringify(normalised(right.json))]).toEqual([index, JSON.stringify(normalised(wrong.json))]);
    });
  });
});

describe('an active exam carries progress, never a mark', () => {
  let sessionId = '';

  it('opens and starts with no mark', async () => {
    const opened = await ana('/api/learner/exams', { bundleId });
    sessionId = String(opened.json.sessionId);
    expect(opened.status).toBe(200);
    expectNoMarks('open', opened.text);
    const started = await ana(`/api/learner/exams/${sessionId}/events`, { events: [{ type: 'start' }, { type: 'answers', answers: { 'lis-p1-q1': listeningAnswer(1, 1), 'lis-p1-q2': 'wrong' } }] });
    expectNoMarks('start', started.text);
  });

  it('closes Listening with "completed" and no correct count or band', async () => {
    const submitted = await ana(`/api/learner/exams/${sessionId}/events`, { events: [{ type: 'submit_answers' }, { type: 'finish_section' }] });
    expectNoMarks('listening submitted', submitted.text);
    const run = submitted.json.run as { sections: Record<string, Record<string, unknown>> };
    expect(run.sections.listening.status).toBe('completed');
    expect(typeof run.sections.listening.submittedAt).toBe('number');
    expect(Object.keys(run.sections.listening).sort()).toEqual(['answers', 'drafts', 'endedAt', 'endedBy', 'speaking', 'startedAt', 'status', 'submittedAt', 'writing', 'deadline'].sort());
    expect((await storedProgress(sessionId)).sections.listening.objective?.correct).toBe(1);
  });

  it('closes Reading the same way', async () => {
    const submitted = await ana(`/api/learner/exams/${sessionId}/events`, { events: [{ type: 'answers', answers: { 'rea-p1-q1': readingAnswer(1, 1) } }, { type: 'submit_answers' }, { type: 'finish_section' }] });
    expectNoMarks('reading submitted', submitted.text);
    expect((submitted.json.run as { sections: Record<string, { status: string }> }).sections.reading.status).toBe('completed');
    expect((await storedProgress(sessionId)).sections.reading.objective?.correct).toBe(1);
  });

  it('records Writing and Speaking without returning a band, the grader’s feedback or the model', async () => {
    for (const task of [1, 2] as const) {
      const submitted = await ana(`/api/learner/exams/${sessionId}/writing/${task}`, { essay: `Essay for task ${task} ${ESSAY}` });
      expect(submitted.status).toBe(200);
      expectNoMarks(`writing ${task} submitted`, submitted.text);
      const graded = await ana(`/api/learner/exams/${sessionId}/writing/${task}/grade`, {});
      expect(graded.status).toBe(200);
      expectNoMarks(`writing ${task} graded`, graded.text);
      expect(graded.text.includes('"model"')).toBe(false);
    }
    const finishedWriting = await ana(`/api/learner/exams/${sessionId}/events`, { events: [{ type: 'finish_section' }] });
    expectNoMarks('writing finished', finishedWriting.text);
    for (const part of [1, 2] as const) {
      const submitted = await ana(`/api/learner/exams/${sessionId}/speaking/${part}`, { transcriptProvided: SPOKEN });
      expect(submitted.status).toBe(200);
      expectNoMarks(`speaking ${part} submitted`, submitted.text);
      const graded = await ana(`/api/learner/exams/${sessionId}/speaking/${part}/grade`, {});
      expect(graded.status).toBe(200);
      expectNoMarks(`speaking ${part} graded`, graded.text);
    }
    const stored = await storedProgress(sessionId);
    expect([stored.sections.writing.band, stored.sections.speaking.speaking[1]?.band]).toEqual([7, 7]);
  });

  it('resumes after a reload with no mark, by reopening and by reading the session', async () => {
    for (const reply of [await ana('/api/learner/exams', { bundleId }), await ana(`/api/learner/exams/${sessionId}`), await ana('/api/learner/exams')]) {
      expect(reply.status).toBe(200);
      expectNoMarks('resume', reply.text);
    }
  });

  it('refuses forged and foreign requests for the hidden marks', async () => {
    const forged = [
      { type: 'reveal_score' },
      { type: 'finish_exam' },
      { type: 'sync', includeScores: true },
      { type: 'writing_graded', task: 1, band: 9, essay: 'x' },
      { type: 'tick', now: clock + 10_000_000 },
    ];
    for (const event of forged) {
      const reply = await ana(`/api/learner/exams/${sessionId}/events`, { events: [event] });
      expect([JSON.stringify(event), reply.status]).toEqual([JSON.stringify(event), 400]);
      expectNoMarks(JSON.stringify(event), reply.text);
    }
    const withQuery = await ana(`/api/learner/exams/${sessionId}?scores=1&include=result`);
    expectNoMarks('query', withQuery.text);
    for (const url of [`/api/learner/exams/${sessionId}`, `/api/learner/exams/${sessionId}/events`]) {
      const foreign = url.endsWith('events') ? await ben(url, { events: [{ type: 'sync' }] }) : await ben(url);
      expect(foreign.status).toBe(404);
      expectNoMarks('foreign', foreign.text);
    }
    // The attempts list holds no attempt for a sitting still in progress.
    const data = await ana('/api/data');
    expect(data.text.includes(sessionId)).toBe(false);
  });

  it('discloses the marks once the exam is over, and stores the same marks in the attempt', async () => {
    const submitted = await ana(`/api/learner/exams/${sessionId}/speaking/3`, { transcriptProvided: SPOKEN });
    expectNoMarks('speaking 3 submitted', submitted.text);
    const graded = await ana(`/api/learner/exams/${sessionId}/speaking/3/grade`, {});
    expectNoMarks('speaking 3 graded', graded.text);
    const finished = await ana(`/api/learner/exams/${sessionId}/events`, { events: [{ type: 'finish_section' }] });
    expect(finished.status).toBe(200);
    const view = finished.json as { status: string; attemptSaved: boolean; result?: { complete: boolean; overall?: number; bands: Record<string, number>; raw: Record<string, { correct: number; total: number }> }; attempt?: { scores: { overall?: number; listening?: { band: number; rawScore?: number } } } };
    expect(view.status).toBe('finished');
    expect(view.attemptSaved).toBe(true);
    expect(view.result?.complete).toBe(true);
    expect(view.result?.raw).toEqual({ listening: { correct: 1, total: 40 }, reading: { correct: 1, total: 40 } });
    expect(view.result?.overall).toBe(view.attempt?.scores.overall);
    expect(view.result?.bands.listening).toBe(view.attempt?.scores.listening?.band);

    const stored = (await dataStore.getUserAttempts(learners.ana.id)).find((attempt) => attempt.id === sessionId);
    expect(stored?.scores.listening?.rawScore).toBe(1);
    expect(stored?.scores.overall).toBe(view.result?.overall);
    expect(stored?.scores.writing?.band).toBe(7);
    // Reading it again after the end still shows the result.
    expect(((await ana(`/api/learner/exams/${sessionId}`)).json as { result?: unknown }).result !== undefined).toBe(true);
  });
});
