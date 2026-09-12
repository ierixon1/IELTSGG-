import './env';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';
import type { MockAttempt, SpeakingGradingResult, WritingGradingResult } from '../src/types';
import type { FullCdiBundle } from '../src/types/bundle';
import type { ExamSessionOpened, ExamSessionView, SpeakingGradedResponse, WritingGradedResponse } from '../src/types/examSession';
import type { GradeOutcome, SpeakingSubmission, WritingSubmission } from '../src/services/grading';
import {
  CUSTOM_TIMING,
  FULL_SLOTS,
  listeningAnswer,
  listeningPayload,
  readingAnswer,
  readingPayload,
  speakingPayload,
  writingPayload,
} from './bundleFixtures';

/**
 * A full exam sat through the exam session, over the real routes and stores.
 *
 * The browser holds nothing that decides the exam, so everything that matters
 * is asserted here, where it is decided: the paper carries no key, the clock is
 * the server's and the bundle's, a section closes only when its content is done
 * or its time is up, Writing and Speaking bands come only from grading, a
 * reload resumes the same session, and the stored attempt reconstructs exactly
 * what was sat.
 *
 * The clock and the grader are injected: time moves when a test moves it, and
 * the grading model is available or not when a test says so.
 */
const originalCwd = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-exam-session-'));
process.chdir(tempRoot);

const ADMIN_USER = 'session_admin';
const ADMIN_PASSWORD = 'Str0ng-Passw0rd-For-Sessions';
process.env.SEED_DEFAULT_ACCOUNTS = 'true';
process.env.ADMIN_USER = ADMIN_USER;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;

const express = (await import('express')).default;
const { adminRouter } = await import('../src/routes/adminRoutes');
const { learnerContentRouter } = await import('../src/routes/learnerContentRoutes');
const { userDataRouter } = await import('../src/routes/userDataRoutes');
const { authRouter } = await import('../src/routes/authRoutes');
const { authenticateRequest } = await import('../src/middleware/authMiddleware');
const { createExamSessionRouter } = await import('../src/routes/examSessionRoutes');
const { createExamSessionService } = await import('../src/services/examSession');
const { dataStore } = await import('../src/services/storage');
const { openSitting } = await import('../src/services/bundleService');
const { verifyExamAttempt } = await import('../src/services/attemptVerification');
const { assetStore } = await import('../src/services/assetStore');
const { adminStore } = await import('../src/services/adminStore');
const { bundleStore } = await import('../src/services/bundleStore');
const { materialContentHash } = await import('../src/services/materialVersion');
const { questionsOf } = await import('../src/services/publishGate');
const { sectionReadiness } = await import('../src/services/examRun');
const { calculateOverallBand, objectiveSectionScore, speakingSectionBand, writingSectionBand } = await import('../src/utils/ieltsScoring');

/* ------------------------------------------------------------ injected world */

const START = Date.parse('2026-09-11T09:00:00.000Z');
let clock = START;
const advance = (ms: number) => {
  clock += ms;
};

const grader = {
  writing: 'available' as 'available' | 'unavailable',
  speaking: 'available' as 'available' | 'unavailable',
  writingCalls: [] as WritingSubmission[],
  speakingCalls: [] as SpeakingSubmission[],
};
const WRITING_BANDS = { task1: 6.5, task2: 7 } as const;
const SPEAKING_BANDS: Record<number, number> = { 1: 7, 2: 6.5, 3: 7 };

const busy = { ok: false as const, status: 503, body: { error: 'The grading model is busy right now.', code: 'ai_unavailable' } };
const criterion = (name: string, band: number) => ({ name, band, justification: 'Fixture.', improvement_tips: [] });

async function fakeWriting(input: WritingSubmission): Promise<GradeOutcome<WritingGradingResult>> {
  grader.writingCalls.push(input);
  if (grader.writing === 'unavailable') return busy;
  const band = input.taskType === 'task1' ? WRITING_BANDS.task1 : WRITING_BANDS.task2;
  return {
    ok: true,
    result: { band_overall: band, criteria: [], annotated_text: [], word_count: 0, meets_word_limit: false, general_commentary: 'Fixture.' },
  };
}

async function fakeSpeaking(input: SpeakingSubmission): Promise<GradeOutcome<SpeakingGradingResult>> {
  grader.speakingCalls.push(input);
  if (grader.speaking === 'unavailable') return busy;
  const band = SPEAKING_BANDS[Number(input.partNumber)];
  return {
    ok: true,
    result: {
      band_overall: band,
      transcript: String(input.transcriptProvided ?? ''),
      criteria: {
        fluency_coherence: criterion('Fluency', band),
        lexical_resource: criterion('Lexis', band),
        grammatical_range: criterion('Grammar', band),
        pronunciation: criterion('Pronunciation', band),
      },
      objective_metrics: { durationSeconds: 0, wordsPerMinute: 0, pausesCount: 0, totalPauseDurationSeconds: 0, fillerWords: [] },
      actionable_drills: [],
    },
  };
}

let sequence = 0;
const service = createExamSessionService({
  store: dataStore,
  resolveSitting: openSitting,
  verifyAttempt: verifyExamAttempt,
  gradeWriting: fakeWriting,
  gradeSpeaking: fakeSpeaking,
  now: () => clock,
  newId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
});

/* --------------------------------------------------------------------- HTTP */

let server: Server;
let origin = '';
let adminCookie = '';
const learners: Record<'ana' | 'ben', { cookie: string; id: string }> = { ana: { cookie: '', id: '' }, ben: { cookie: '', id: '' } };

const request = (cookie: string) => (url: string, init: RequestInit = {}) =>
  fetch(`${origin}${url}`, { ...init, headers: { 'Content-Type': 'application/json', cookie, ...(init.headers || {}) } });
const admin = (url: string, init: RequestInit = {}) => request(adminCookie)(url, init);
const as = (who: 'ana' | 'ben') => request(learners[who].cookie);
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

const ids: Record<string, string> = {};
const audio: Record<number, string> = {};
let bundleId = '';

const openExam = async (who: 'ana' | 'ben' = 'ana') => {
  const response = await as(who)('/api/learner/exams', post({ bundleId }));
  return { status: response.status, body: (await response.json()) as ExamSessionOpened & { code?: string } };
};
const events = async (sessionId: string, list: unknown[], who: 'ana' | 'ben' = 'ana') => {
  const response = await as(who)(`/api/learner/exams/${sessionId}/events`, post({ events: list }));
  return { status: response.status, body: (await response.json()) as ExamSessionView & { code?: string } };
};
const getSession = async (sessionId: string, who: 'ana' | 'ben' = 'ana') => {
  const response = await as(who)(`/api/learner/exams/${sessionId}`);
  return { status: response.status, body: (await response.json()) as ExamSessionOpened & { code?: string } };
};
const writeTask = async (sessionId: string, task: 1 | 2, essay: string) => {
  const response = await as('ana')(`/api/learner/exams/${sessionId}/writing/${task}`, post({ essay }));
  return { status: response.status, body: (await response.json()) as WritingGradedResponse & { code?: string } };
};
const speakPart = async (sessionId: string, part: 1 | 2 | 3, transcriptProvided: string) => {
  const response = await as('ana')(`/api/learner/exams/${sessionId}/speaking/${part}`, post({ transcriptProvided }));
  return { status: response.status, body: (await response.json()) as SpeakingGradedResponse & { code?: string } };
};
const storedAttempts = async (who: 'ana' | 'ben' = 'ana') => ((await (await as(who)('/api/data')).json()).attempts ?? []) as MockAttempt[];

async function createPublished(payload: object): Promise<string> {
  const saved = await (await admin('/api/admin/materials', post(payload))).json();
  const published = await admin(`/api/admin/materials/${saved.item.section}/${saved.item.id}/publish`, { method: 'POST' });
  if (published.status !== 200) throw new Error(`fixture did not publish: ${JSON.stringify(await published.json())}`);
  return saved.item.id as string;
}

async function currentPins(slots: Record<string, string> = ids) {
  const { candidates } = await (await admin('/api/admin/bundles/candidates')).json();
  const hashes = new Map((candidates as Array<{ id: string; contentHash: string }>).map((entry) => [entry.id, entry.contentHash]));
  return FULL_SLOTS.map(({ section, part }) => {
    const materialId = slots[`${section}-${part}`];
    return { section, part, materialId, contentHash: hashes.get(materialId) ?? '' };
  });
}

const draftBody = async () => JSON.stringify({ title: 'Session CDI', module: 'academic', components: await currentPins(), timing: CUSTOM_TIMING });

before(async () => {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/auth', authRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api', authenticateRequest);
  app.use('/api', userDataRouter);
  app.use('/api', learnerContentRouter);
  app.use('/api', createExamSessionRouter(service));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  const login = await fetch(`${origin}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASSWORD }),
  });
  adminCookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  for (const who of ['ana', 'ben'] as const) {
    const registered = await fetch(`${origin}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `session_${who}`, email: `${who}@example.com`, password: 'Str0ng-Passw0rd-For-Learner', name: who }),
    });
    learners[who] = {
      cookie: (registered.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; '),
      id: (await registered.json()).user.id,
    };
  }

  for (const part of [1, 2, 3, 4]) {
    const asset = await assetStore.create({
      originalName: `part-${part}.mp3`,
      content: Buffer.from(`ID3 recording ${part}`),
      mimeType: 'audio/mpeg',
      kind: 'audio',
      createdBy: 'test',
      sourceType: 'upload',
    });
    audio[part] = asset.id;
    ids[`listening-${part}`] = await createPublished(listeningPayload(part, asset.id));
  }
  for (const part of [1, 2, 3]) ids[`reading-${part}`] = await createPublished(readingPayload(part));
  ids['writing-1'] = await createPublished(writingPayload());
  ids['speaking-1'] = await createPublished(speakingPayload());

  const created = await (await admin('/api/admin/bundles', { method: 'POST', body: await draftBody() })).json();
  bundleId = created.bundle.id;
  const published = await admin(`/api/admin/bundles/${bundleId}/publish`, { method: 'POST' });
  if (published.status !== 200) throw new Error(`bundle did not publish: ${JSON.stringify(await published.json())}`);
});

after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  process.chdir(originalCwd);
  removeTempRoot(tempRoot);
});

const ALL_KEYS = [1, 2, 3, 4].flatMap((part) => [listeningAnswer(part, 1), listeningAnswer(part, 2)]).concat([1, 2, 3].flatMap((part) => [readingAnswer(part, 1), readingAnswer(part, 2)]));
const WITHHELD = ['correctAnswer', 'acceptableAnswers', 'explanation', 'provenance', 'audioTranscript', 'importRecord', 'generationRecord', 'sourceAssetId'];

function expectNoKey(text: string, given: string[] = []) {
  // A learner's own answers come back to them; no key they did not type does.
  for (const key of ALL_KEYS.filter((entry) => !given.includes(entry))) expect(text.includes(key)).toBe(false);
  for (const field of WITHHELD) expect(text.includes(field)).toBe(false);
}

/** Fields a mark travels in. None may reach the learner while the exam is in progress. */
const MARK_FIELDS = ['"objective"', '"band"', '"bands"', '"overall"', '"correct"', '"rawScore"', '"raw"', '"result"', '"band_overall"', '"criteria"', '"scores"', '"attempt"'];
function expectNoMarks(text: string) {
  for (const field of MARK_FIELDS) expect([field, text.includes(field)]).toEqual([field, false]);
}
/** What the server holds for a session: the marks it keeps for the attempt. Never sent as it is. */
async function storedProgress(id: string) {
  const record = await dataStore.getExamSession(learners.ana.id, id);
  if (!record) throw new Error(`session ${id} is not stored`);
  return record.progress;
}

const ESSAY_1 = 'Energy use rose steadily across the period, with coal falling and wind rising sharply after 2010.';
const ESSAY_2 = 'Cities should restrict private cars in their centres, because cleaner air benefits everyone who lives there.';

/* -------------------------------------------------------------------------- */

let sessionId = '';

describe('an exam paper carries no answer key', () => {
  it('opens a session whose paper and state hold no key, explanation, transcript or provenance', async () => {
    const response = await as('ana')('/api/learner/exams', post({ bundleId }));
    expect(response.status).toBe(200);
    const text = await response.text();
    const opened = JSON.parse(text) as ExamSessionOpened;
    sessionId = opened.sessionId;

    expect(/^attempt-[0-9a-f-]+$/.test(sessionId)).toBe(true);
    expect(opened.resumed).toBe(false);
    expect(opened.status).toBe('active');
    expectNoKey(text);

    const firstQuestion = opened.paper.listening.parts[0].questions[0];
    expect(firstQuestion.id).toBe('lis-p1-q1');
    expect(firstQuestion.answerCount).toBe(1);
    expect(opened.paper.listening.parts.map((part) => part.audioUrl)).toEqual([1, 2, 3, 4].map((part) => `/api/assets/${audio[part]}`));
    expect(opened.paper.reading.passages).toHaveLength(3);
    expect(opened.paper.writing.task1.prompt).toBe('Summarise the chart of energy use.');
    expect(opened.paper.speaking.parts.map((part) => part.partNumber)).toEqual([1, 2, 3]);
    expect(opened.run.plan.sections.map((section) => section.questionIds.length)).toEqual([40, 40, 0, 0]);
  });
});

describe('the server runs the exam, in order and on its own clock', () => {
  it('starts Listening with exactly the minutes the bundle configured', async () => {
    const { status, body } = await events(sessionId, [{ type: 'start' }]);
    expect(status).toBe(200);
    expect(body.run.startedAt).toBe(START);
    expect(body.run.plan.sections.map((section) => [section.section, section.durationSeconds])).toEqual([
      ['listening', CUSTOM_TIMING.listeningMinutes * 60],
      ['reading', CUSTOM_TIMING.readingMinutes * 60],
      ['writing', CUSTOM_TIMING.writingMinutes * 60],
      ['speaking', CUSTOM_TIMING.speakingMinutes * 60],
    ]);
    expect(body.run.sections.listening.status).toBe('in_progress');
    expect(body.run.sections.listening.deadline).toBe(START + CUSTOM_TIMING.listeningMinutes * 60_000);
    expect(body.serverNow).toBe(START);
  });

  it('keeps saved answers through a reload, in the same session, with the clock still running', async () => {
    await events(sessionId, [{ type: 'answers', answers: { 'lis-p1-q1': listeningAnswer(1, 1), 'lis-p4-q2': listeningAnswer(4, 2) } }]);
    advance(90_000);

    const reopened = await openExam();
    expect(reopened.status).toBe(200);
    expect(reopened.body.sessionId).toBe(sessionId);
    expect(reopened.body.resumed).toBe(true);
    expect(reopened.body.run.sections.listening.answers).toEqual({ 'lis-p1-q1': listeningAnswer(1, 1), 'lis-p4-q2': listeningAnswer(4, 2) });
    expect(reopened.body.run.sections.listening.deadline).toBe(START + CUSTOM_TIMING.listeningMinutes * 60_000);

    const sessions = await dataStore.listExamSessions(learners.ana.id);
    expect(sessions).toHaveLength(1);
    const listed = await (await as('ana')('/api/learner/exams')).json();
    expect(listed.sessions.map((entry: { sessionId: string }) => entry.sessionId)).toEqual([sessionId]);
  });

  it('records each Listening recording as started once, on the server clock, so a reload cannot replay it', async () => {
    const firstStart = clock;
    const started = await events(sessionId, [{ type: 'audio_started', part: 1 }]);
    expect(started.status).toBe(200);
    advance(5_000);
    await events(sessionId, [{ type: 'audio_started', part: 1 }]);
    const reopened = await openExam();
    expect(reopened.body.sessionId).toBe(sessionId);
    expect(reopened.body.run.sections.listening.audioStarted).toEqual({ 1: firstStart });
    // The browser names a part; it cannot name a time.
    const forged = await as('ana')(`/api/learner/exams/${sessionId}/events`, post({ events: [{ type: 'audio_started', part: 2, now: 0 }] }));
    expect(forged.status).toBe(400);
  });

  it('refuses a write carrying a stale revision', async () => {
    const current = await dataStore.getExamSession(learners.ana.id, sessionId);
    if (!current) throw new Error('session missing');
    expect(await dataStore.saveExamSession(learners.ana.id, { ...current, revision: current.revision + 1 }, current.revision - 1)).toBe(false);
    expect(await dataStore.saveExamSession(learners.ana.id, current, null)).toBe(false);
    expect((await dataStore.getExamSession(learners.ana.id, sessionId))?.revision).toBe(current.revision);
  });

  it('keeps two autosaves that race, instead of letting one overwrite the other', async () => {
    // Both requests are held until both have read the same revision, so their writes
    // really do collide: without the revision check the second would erase the first.
    let loads = 0;
    let release: () => void = () => undefined;
    const bothLoaded = new Promise<void>((resolve) => {
      release = resolve;
    });
    const racing = createExamSessionService({
      store: {
        ...dataStore,
        listExamSessions: (userId) => dataStore.listExamSessions(userId),
        saveUserAttempt: (userId, attempt) => dataStore.saveUserAttempt(userId, attempt),
        saveExamSession: (userId, record, expected) => dataStore.saveExamSession(userId, record, expected),
        getExamSession: async (userId, id) => {
          const record = await dataStore.getExamSession(userId, id);
          loads += 1;
          if (loads === 2) release();
          if (loads <= 2) await bothLoaded;
          return record;
        },
      },
      resolveSitting: openSitting,
      verifyAttempt: verifyExamAttempt,
      gradeWriting: fakeWriting,
      gradeSpeaking: fakeSpeaking,
      now: () => clock,
      newId: () => 'unused-in-this-test',
    });

    const [first, second] = await Promise.all([
      racing.apply(learners.ana.id, sessionId, [{ type: 'answers', answers: { 'lis-p2-q1': 'not-it' } }]),
      racing.apply(learners.ana.id, sessionId, [{ type: 'answers', answers: { 'lis-p3-q1': 'not-it-either' } }]),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(loads).toBeGreaterThan(2);
    const { body } = await getSession(sessionId);
    expect(Object.keys(body.run.sections.listening.answers).sort()).toEqual(['lis-p1-q1', 'lis-p2-q1', 'lis-p3-q1', 'lis-p4-q2']);
  });

  it('does not end Listening before its answers are submitted, and marks every part when they are', async () => {
    const early = await events(sessionId, [{ type: 'finish_section' }]);
    expect(early.body.run.currentIndex).toBe(0);
    expect(early.body.run.sections.listening.status).toBe('in_progress');

    const submitted = await events(sessionId, [{ type: 'submit_answers' }, { type: 'finish_section' }]);
    const listening = submitted.body.run.sections.listening;
    expect(listening.status).toBe('completed');
    expect(listening.endedBy).toBe('learner');
    // Marked on the server, for the attempt; the learner is told only that the section is done.
    expect((await storedProgress(sessionId)).sections.listening.objective).toEqual({ correct: 2, total: 40, band: (await storedProgress(sessionId)).sections.listening.band ?? -1 });
    expectNoMarks(JSON.stringify(submitted.body));
    expect(submitted.body.run.sections.reading.status).toBe('in_progress');

    // A submitted section is closed to further answers.
    const late = await events(sessionId, [{ type: 'answers', answers: { 'lis-p1-q2': listeningAnswer(1, 2) } }]);
    expect(late.body.run.sections.listening.answers['lis-p1-q2']).toBe(undefined);
  });

  it('keeps Reading open while a passage is unanswered, and marks all three passages', async () => {
    await events(sessionId, [{ type: 'answers', answers: { 'rea-p1-q1': readingAnswer(1, 1), 'rea-p2-q1': readingAnswer(2, 1) } }, { type: 'finish_section' }]);
    const partial = await getSession(sessionId);
    expect(partial.body.run.plan.sections[partial.body.run.currentIndex].section).toBe('reading');
    expect(partial.body.run.sections.reading.status).toBe('in_progress');
    expect(sectionReadiness(partial.body.run, 'reading').ready).toBe(false);

    const done = await events(sessionId, [
      { type: 'answers', answers: { 'rea-p3-q1': readingAnswer(3, 1), 'rea-p3-q2': readingAnswer(3, 2) } },
      { type: 'submit_answers' },
      { type: 'finish_section' },
    ]);
    expect(done.body.run.sections.reading.status).toBe('completed');
    const reading = (await storedProgress(sessionId)).sections.reading;
    expect(reading.objective).toEqual({ correct: 4, total: 40, band: reading.band ?? -1 });
    expectNoMarks(JSON.stringify(done.body));
    expect(done.body.run.sections.writing.status).toBe('in_progress');
    expectNoKey(JSON.stringify(done.body), [
      listeningAnswer(1, 1),
      listeningAnswer(4, 2),
      readingAnswer(1, 1),
      readingAnswer(2, 1),
      readingAnswer(3, 1),
      readingAnswer(3, 2),
    ]);
  });

  it('keeps a Writing draft through a reload', async () => {
    await events(sessionId, [{ type: 'writing_draft', task: 2, text: 'A first thought about cars' }]);
    const reloaded = await openExam();
    expect(reloaded.body.sessionId).toBe(sessionId);
    expect(reloaded.body.run.sections.writing.drafts).toEqual({ 2: 'A first thought about cars' });
  });

  it('grades Writing against the pinned prompts and needs both tasks before it can end', async () => {
    const task1 = await writeTask(sessionId, 1, ESSAY_1);
    expect(task1.status).toBe(200);
    // Recorded with its band; the band and the model's feedback are not returned during the exam.
    expect((await storedProgress(sessionId)).sections.writing.writing[1]?.band).toBe(WRITING_BANDS.task1);
    expectNoMarks(JSON.stringify(task1.body));
    // The pinned task exactly as the paper shows it: the same prompt text practice grades against.
    const { paper } = (await getSession(sessionId)).body;
    expect(paper.writing.task1.prompt).toBe('Summarise the chart of energy use.');
    expect(grader.writingCalls[0]).toEqual({ taskType: 'task1', prompt: `${paper.writing.task1.title}\n${paper.writing.task1.prompt}`, essay: ESSAY_1, module: 'academic' });
    expect(task1.body.view.run.sections.writing.writing).toEqual({ 1: { essay: ESSAY_1 } });

    const early = await events(sessionId, [{ type: 'finish_section' }]);
    expect(early.body.run.sections.writing.status).toBe('in_progress');
    expect(sectionReadiness(early.body.run, 'writing').missing).toEqual([{ kind: 'writing_task', task: 2 }]);

    const again = await writeTask(sessionId, 1, `${ESSAY_1} Resubmitted.`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('already_graded');
  });

  it('records no Writing band when the grading model is unavailable', async () => {
    grader.writing = 'unavailable';
    const refused = await writeTask(sessionId, 2, ESSAY_2);
    expect(refused.status).toBe(503);
    expect(refused.body.code).toBe('ai_unavailable');
    const { body } = await getSession(sessionId);
    expect(body.run.sections.writing.writing[2]).toBe(undefined);
    expect((await storedProgress(sessionId)).sections.writing.band).toBe(undefined);
    expect(body.run.sections.writing.status).toBe('in_progress');

    grader.writing = 'available';
    const graded = await writeTask(sessionId, 2, ESSAY_2);
    expect(graded.status).toBe(200);
    const finished = await events(sessionId, [{ type: 'finish_section' }]);
    expect(finished.body.run.sections.writing.status).toBe('completed');
    expect((await storedProgress(sessionId)).sections.writing.band).toBe(writingSectionBand(WRITING_BANDS.task1, WRITING_BANDS.task2) ?? -1);
    expectNoMarks(JSON.stringify(finished.body));
    expect(finished.body.run.sections.speaking.status).toBe('in_progress');
  });

  it('needs all three Speaking parts, and records no band for a part the model could not grade', async () => {
    const part1 = await speakPart(sessionId, 1, 'I live in a small flat near the river, and I like the quiet evenings there most.');
    expect(part1.status).toBe(200);
    expect(grader.speakingCalls[0].topic).toBe('Home');
    const early = await events(sessionId, [{ type: 'finish_section' }]);
    expect(early.body.status).toBe('active');
    expect(sectionReadiness(early.body.run, 'speaking').missing).toEqual([
      { kind: 'speaking_part', part: 2 },
      { kind: 'speaking_part', part: 3 },
    ]);

    await speakPart(sessionId, 2, 'Last spring I visited Bukhara, and the old madrasas surprised me with their colour and scale.');
    grader.speaking = 'unavailable';
    const refused = await speakPart(sessionId, 3, 'People travel to understand how others live, and to see their own lives differently afterwards.');
    expect(refused.status).toBe(503);
    expect((await getSession(sessionId)).body.run.sections.speaking.speaking[3]).toBe(undefined);
    expect(await storedAttempts()).toHaveLength(0);

    grader.speaking = 'available';
    await speakPart(sessionId, 3, 'People travel to understand how others live, and to see their own lives differently afterwards.');
    advance(60_000);
    const finished = await events(sessionId, [{ type: 'finish_section' }]);
    expect(finished.body.status).toBe('finished');
    expect(finished.body.attemptSaved).toBe(true);
    expect(finished.body.attempt?.id).toBe(sessionId);
    // Once the exam is over, the marks are disclosed: the same ones the attempt stores.
    expect(finished.body.result?.complete).toBe(true);
    expect(finished.body.result?.overall).toBe(finished.body.attempt?.scores.overall);
    expect(finished.body.result?.bands.listening).toBe(finished.body.attempt?.scores.listening?.band);
    expect(finished.body.result?.raw.reading).toEqual({ correct: 4, total: 40 });
  });

  it('stores one attempt that reconstructs exactly what was sat', async () => {
    const attempts = await storedAttempts();
    expect(attempts).toHaveLength(1);
    const attempt = attempts[0];
    const bundle = (await bundleStore.get(bundleId)) as FullCdiBundle;

    expect(attempt.id).toBe(sessionId);
    expect(attempt.testId).toBe(bundleId);
    expect(attempt.bundleId).toBe(bundleId);
    expect(attempt.bundlePublishedAt).toBe(bundle.publishedAt);
    expect(attempt.timing).toEqual(CUSTOM_TIMING);
    expect(attempt.mode).toBe('exam');
    expect(attempt.status).toBe('completed');
    expect(attempt.startedAt).toBe(new Date(START).toISOString());
    expect(attempt.completedAt).toBe(new Date(clock).toISOString());
    expect(JSON.stringify(attempt).includes('test-1')).toBe(false);

    const pinKey = (section: string, ref: { part: number; materialId: string; contentHash: string }) => `${section}:${ref.part}:${ref.materialId}:${ref.contentHash}`;
    const pinned = new Set(bundle.components.map((ref) => pinKey(ref.section, ref)));
    for (const section of ['listening', 'reading', 'writing', 'speaking'] as const) {
      const expected = bundle.components.filter((ref) => ref.section === section).map((ref) => pinKey(section, ref)).sort();
      expect((attempt.sections?.[section]?.components ?? []).map((ref) => pinKey(section, ref)).sort()).toEqual(expected);
      expect(attempt.sections?.[section]?.status).toBe('completed');
    }

    const sent: Record<string, string> = {
      'lis-p1-q1': listeningAnswer(1, 1),
      'lis-p4-q2': listeningAnswer(4, 2),
      'lis-p2-q1': 'not-it',
      'lis-p3-q1': 'not-it-either',
      'rea-p1-q1': readingAnswer(1, 1),
      'rea-p2-q1': readingAnswer(2, 1),
      'rea-p3-q1': readingAnswer(3, 1),
      'rea-p3-q2': readingAnswer(3, 2),
    };
    expect((attempt.responses ?? []).map((response) => response.questionId).sort()).toEqual(Object.keys(sent).sort());
    for (const response of attempt.responses ?? []) {
      expect(pinned.has(pinKey(response.section, response))).toBe(true);
      const material = await adminStore.getMaterial(response.section, response.materialId);
      expect(material ? materialContentHash(material) : '').toBe(response.contentHash);
      expect(material ? questionsOf(material).map((question) => question.id) : []).toContain(response.questionId);
      expect(response.answer).toBe(sent[response.questionId]);
    }

    expect((attempt.writingTasks ?? []).map((task) => [task.task, task.essay, task.band, task.materialId])).toEqual([
      [1, ESSAY_1, WRITING_BANDS.task1, ids['writing-1']],
      [2, ESSAY_2, WRITING_BANDS.task2, ids['writing-1']],
    ]);
    expect((attempt.speakingParts ?? []).map((part) => [part.part, part.band])).toEqual([
      [1, SPEAKING_BANDS[1]],
      [2, SPEAKING_BANDS[2]],
      [3, SPEAKING_BANDS[3]],
    ]);

    const bands = {
      listening: attempt.scores.listening?.band ?? -1,
      reading: attempt.scores.reading?.band ?? -1,
      writing: attempt.scores.writing?.band ?? -1,
      speaking: attempt.scores.speaking?.band ?? -1,
    };
    const listeningQuestions = (await Promise.all([1, 2, 3, 4].map((part) => adminStore.getMaterial('listening', ids[`listening-${part}`])))).flatMap((material) => (material ? questionsOf(material) : []));
    expect(bands.listening).toBe(objectiveSectionScore('listening', listeningQuestions, sent, 'academic').band);
    expect(bands.speaking).toBe(speakingSectionBand([SPEAKING_BANDS[1], SPEAKING_BANDS[2], SPEAKING_BANDS[3]]) ?? -1);
    expect(attempt.scores.overall).toBe(calculateOverallBand(bands));
    expect(await verifyExamAttempt(attempt)).toEqual([]);
  });

  it('takes no more events once finished, and opens a new sitting rather than reusing it', async () => {
    const late = await events(sessionId, [{ type: 'start' }]);
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('session_closed');

    const next = await openExam();
    expect(next.status).toBe(200);
    expect(next.body.sessionId === sessionId).toBe(false);
    expect(next.body.resumed).toBe(false);
    expect(await storedAttempts()).toHaveLength(1);
    await as('ana')(`/api/learner/exams/${next.body.sessionId}/abandon`, post({}));
  });
});

describe('time is the server’s, and the bundle’s', () => {
  let timedId = '';

  it('closes a section at its deadline without the browser finishing it, and starts the next on the server clock', async () => {
    const opened = await openExam();
    timedId = opened.body.sessionId;
    const startedAt = clock;
    await events(timedId, [{ type: 'start' }, { type: 'answers', answers: { 'lis-p1-q1': listeningAnswer(1, 1) } }]);

    advance(CUSTOM_TIMING.listeningMinutes * 60_000 + 5_000);
    const { body } = await getSession(timedId);
    const listening = body.run.sections.listening;
    expect(listening.status).toBe('completed');
    expect(listening.endedBy).toBe('time');
    expect(listening.endedAt).toBe(startedAt + CUSTOM_TIMING.listeningMinutes * 60_000);
    expect((await storedProgress(timedId)).sections.listening.objective?.correct).toBe(1);
    expectNoMarks(JSON.stringify(body));
    expect(body.run.sections.reading.startedAt).toBe(clock);
    expect(body.run.sections.reading.deadline).toBe(clock + CUSTOM_TIMING.readingMinutes * 60_000);
  });

  it('records a sitting whose Writing ran out of time as incomplete, with no overall band', async () => {
    await events(timedId, [{ type: 'submit_answers' }, { type: 'finish_section' }]);
    expect((await writeTask(timedId, 1, ESSAY_1)).status).toBe(200);
    advance(CUSTOM_TIMING.writingMinutes * 60_000 + 1_000);

    const afterWriting = await getSession(timedId);
    expect(afterWriting.body.run.sections.writing.status).toBe('expired');
    expect((await storedProgress(timedId)).sections.writing.band).toBe(undefined);
    const tooLate = await writeTask(timedId, 2, ESSAY_2);
    expect(tooLate.status).toBe(409);
    expect(tooLate.body.code).toBe('section_closed');

    for (const part of [1, 2, 3] as const) {
      expect((await speakPart(timedId, part, 'A long enough answer for this part, spoken clearly and with some detail.')).status).toBe(200);
    }
    const finished = await events(timedId, [{ type: 'finish_section' }]);
    expect(finished.body.status).toBe('finished');
    expect(finished.body.result?.complete).toBe(false);
    expect(finished.body.result?.overall).toBe(undefined);

    const attempt = (await storedAttempts()).find((entry) => entry.id === timedId);
    expect(attempt?.status).toBe('incomplete');
    expect(attempt?.scores.overall).toBe(undefined);
    expect(attempt?.scores.writing).toBe(undefined);
    expect(attempt?.sections?.writing?.status).toBe('expired');
    expect(await storedAttempts()).toHaveLength(2);
  });
});

describe('a sitting that cannot go on is stopped, never patched', () => {
  let benSession = '';

  it('refuses a session to anyone but the learner who sat it', async () => {
    const opened = await openExam('ben');
    benSession = opened.body.sessionId;
    expect((await getSession(benSession, 'ana')).status).toBe(404);
    expect((await events(benSession, [{ type: 'start' }], 'ana')).status).toBe(404);
    await events(benSession, [{ type: 'start' }], 'ben');
  });

  it('stops when a component changes mid-exam, and continues only once the pinned content is back', async () => {
    const edited = readingPayload(2);
    edited.content.passage.questions[0].prompt = 'Changed while a learner was sitting it';
    expect((await admin(`/api/admin/materials/reading/${ids['reading-2']}`, { method: 'PUT', body: JSON.stringify(edited) })).status).toBe(200);

    const stopped = await events(benSession, [{ type: 'answers', answers: { 'lis-p1-q1': 'x' } }], 'ben');
    expect(stopped.status).toBe(409);
    expect(stopped.body.code).toBe('component_changed');
    expect((await getSession(benSession, 'ben')).body.code).toBe('component_changed');

    expect((await admin(`/api/admin/materials/reading/${ids['reading-2']}`, { method: 'PUT', body: JSON.stringify(readingPayload(2)) })).status).toBe(200);
    const resumed = await events(benSession, [{ type: 'answers', answers: { 'lis-p1-q1': 'x' } }], 'ben');
    expect(resumed.status).toBe(200);
    expect(resumed.body.run.sections.listening.answers).toEqual({ 'lis-p1-q1': 'x' });
  });

  it('supersedes an open sitting when its bundle is republished', async () => {
    await admin(`/api/admin/bundles/${bundleId}/unpublish`, { method: 'POST' });
    const closed = await getSession(benSession, 'ben');
    expect(closed.status).toBe(409);
    expect(closed.body.code).toBe('bundle_unpublished');

    advance(1_000);
    expect((await admin(`/api/admin/bundles/${bundleId}/publish`, { method: 'POST' })).status).toBe(200);
    const superseded = await getSession(benSession, 'ben');
    expect(superseded.status).toBe(409);
    expect(superseded.body.code).toBe('session_superseded');

    const fresh = await openExam('ben');
    expect(fresh.status).toBe(200);
    expect(fresh.body.sessionId === benSession).toBe(false);
    const stale = await dataStore.getExamSession(learners.ben.id, benSession);
    expect(stale?.status).toBe('superseded');
    benSession = fresh.body.sessionId;
  });

  it('ends a sitting the learner leaves, and records nothing for it', async () => {
    const left = await as('ben')(`/api/learner/exams/${benSession}/abandon`, post({}));
    expect(left.status).toBe(200);
    expect((await left.json()).status).toBe('abandoned');
    const after = await events(benSession, [{ type: 'start' }], 'ben');
    expect(after.status).toBe(409);
    expect(after.body.code).toBe('session_closed');
    expect(await storedAttempts('ben')).toHaveLength(0);
  });

  it('refuses events the browser has no business sending', async () => {
    const opened = await openExam('ben');
    for (const forged of [
      { type: 'writing_graded', task: 1, band: 9, essay: 'x' },
      { type: 'tick', now: 0 },
      { type: 'start', now: 0 },
    ]) {
      const response = await as('ben')(`/api/learner/exams/${opened.body.sessionId}/events`, post({ events: [forged] }));
      expect(response.status).toBe(400);
    }
    expect((await as('ben')(`/api/learner/exams/${opened.body.sessionId}/events`, { method: 'POST', body: JSON.stringify({ events: [{ type: 'start' }] }), headers: { cookie: '' } })).status).toBe(401);
  });
});

describe('a General Training sitting', () => {
  it('has its Writing graded as General Training, where Task 1 is a letter', async () => {
    const general: Record<string, string> = {};
    for (const part of [1, 2, 3, 4]) general[`listening-${part}`] = await createPublished({ ...listeningPayload(part, audio[part], 'general'), title: `GT Listening ${part}` });
    for (const part of [1, 2, 3]) general[`reading-${part}`] = await createPublished({ ...readingPayload(part, 'general'), title: `GT Reading ${part}` });
    general['writing-1'] = await createPublished({ ...writingPayload('general'), title: 'GT Writing' });
    general['speaking-1'] = await createPublished({ ...speakingPayload('general'), title: 'GT Speaking' });
    const body = JSON.stringify({ title: 'General Training CDI', module: 'general', components: await currentPins(general), timing: CUSTOM_TIMING });
    const created = await (await admin('/api/admin/bundles', { method: 'POST', body })).json();
    expect((await admin(`/api/admin/bundles/${created.bundle.id}/publish`, { method: 'POST' })).status).toBe(200);

    const opened = (await (await as('ana')('/api/learner/exams', post({ bundleId: created.bundle.id }))).json()) as ExamSessionOpened;
    await events(opened.sessionId, [{ type: 'start' }, { type: 'submit_answers' }, { type: 'finish_section' }, { type: 'submit_answers' }, { type: 'finish_section' }]);
    grader.writingCalls.length = 0;
    expect((await writeTask(opened.sessionId, 1, ESSAY_1)).status).toBe(200);
    expect(grader.writingCalls.map((call) => [call.taskType, call.module])).toEqual([['task1', 'general']]);
    await as('ana')(`/api/learner/exams/${opened.sessionId}/abandon`, post({}));
  });
});
