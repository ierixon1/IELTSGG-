import './env';
import { after, before, beforeEach, describe, it } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';
import { CUSTOM_TIMING, FULL_SLOTS, listeningAnswer, listeningPayload, readingAnswer, readingPayload, speakingPayload, writingPayload } from './bundleFixtures';

/**
 * Exam content is not practice content.
 *
 * Practice returns the answer key once a learner submits — and a learner can
 * submit nothing. The Phase 17 audit reproduced exactly that against a published
 * exam bundle: an empty practice submission returned every Listening and Reading
 * key, and those answers then scored 40/40 in the exam.
 *
 * The policy (`practiceEligibility`): a material any published bundle pins is
 * not practice content while that bundle is published, and a published bundle
 * never is. These drive the learner API the way a browser — or a forged request —
 * would, and read every refusal as raw text: no key, no question, no transcript.
 */
const originalCwd = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-practice-eligibility-'));
process.chdir(tempRoot);

const ADMIN_USER = 'eligibility_admin';
const ADMIN_PASSWORD = 'Str0ng-Passw0rd-For-Eligibility';
process.env.SEED_DEFAULT_ACCOUNTS = 'true';
process.env.ADMIN_USER = ADMIN_USER;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
delete process.env.GEMINI_API_KEY;

const express = (await import('express')).default;
const { adminRouter } = await import('../src/routes/adminRoutes');
const { learnerContentRouter } = await import('../src/routes/learnerContentRoutes');
const { examSessionRouter } = await import('../src/routes/examSessionRoutes');
const { mockRouter } = await import('../src/routes/mockRoutes');
const { authRouter } = await import('../src/routes/authRoutes');
const { authenticateRequest } = await import('../src/middleware/authMiddleware');
const { assetStore } = await import('../src/services/assetStore');
const { dataStore } = await import('../src/services/storage');

let server: Server;
let origin = '';
let adminCookie = '';
let learnerCookie = '';
let learnerId = '';

const call = (cookie: string) => (url: string, init: RequestInit = {}) =>
  fetch(`${origin}${url}`, { ...init, headers: { 'Content-Type': 'application/json', cookie, ...(init.headers || {}) } });
const admin = (url: string, init: RequestInit = {}) => call(adminCookie)(url, init);
const learner = (url: string, init: RequestInit = {}) => call(learnerCookie)(url, init);
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

/** The nine exam components, by slot. */
const exam: Record<string, string> = {};
/** Ordinary published materials no bundle names. */
const practice: Record<string, string> = {};
let bundleA = '';
let bundleB = '';

type Section = 'listening' | 'reading' | 'writing' | 'speaking';
const sectionOf = (slot: string) => slot.split('-')[0] as Section;
const LISTENING_SLOTS = ['listening-1', 'listening-2', 'listening-3', 'listening-4'];
const READING_SLOTS = ['reading-1', 'reading-2', 'reading-3'];
const ALL_SLOTS = FULL_SLOTS.map(({ section, part }) => `${section}-${part}`);

/** Every key value and prompt the fixtures carry, and every field a key or its evidence travels in. */
const EVERY_ANSWER = [
  ...[1, 2, 3, 4].flatMap((part) => Array.from({ length: 10 }, (_, index) => listeningAnswer(part, index + 1))),
  ...[1, 2, 3].flatMap((part) => Array.from({ length: part === 3 ? 14 : 13 }, (_, index) => readingAnswer(part, index + 1))),
];
const ANSWER_FIELDS = ['"results"', '"answers"', '"correctAnswer"', '"acceptableAnswers"', '"explanation"', '"transcript"', '"audioTranscript"', '"questions"', '"test"'];

function expectNoAnswerData(text: string) {
  for (const field of ANSWER_FIELDS) expect(text.includes(field)).toBe(false);
  for (const value of EVERY_ANSWER) expect(text.includes(value)).toBe(false);
  expect(/Listening part \d, gap|Reading passage \d, question/.test(text)).toBe(false);
}

/** Every correct answer of one component, as a learner who already knew them would forge the request. */
function fullAnswers(slot: string): Record<string, string> {
  const [section, partText] = slot.split('-');
  const part = Number(partText);
  if (section === 'listening') return Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`lis-p${part}-q${i + 1}`, listeningAnswer(part, i + 1)]));
  const count = part === 3 ? 14 : 13;
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`rea-p${part}-q${i + 1}`, readingAnswer(part, i + 1)]));
}

async function createPublished(payload: object): Promise<string> {
  const saved = await (await admin('/api/admin/materials', post(payload))).json();
  const published = await admin(`/api/admin/materials/${saved.item.section}/${saved.item.id}/publish`, { method: 'POST' });
  if (published.status !== 200) throw new Error(`fixture did not publish: ${JSON.stringify(await published.json())}`);
  return saved.item.id as string;
}

async function createBundle(title: string): Promise<string> {
  const { candidates } = await (await admin('/api/admin/bundles/candidates')).json();
  const components = FULL_SLOTS.map(({ section, part }) => {
    const materialId = exam[`${section}-${part}`];
    return { section, part, materialId, contentHash: candidates.find((entry: { id: string }) => entry.id === materialId).contentHash };
  });
  const created = await (await admin('/api/admin/bundles', post({ title, module: 'academic', components, timing: CUSTOM_TIMING }))).json();
  return created.bundle.id as string;
}

const bundleAction = async (id: string, action: 'publish' | 'unpublish' | 'archive' | 'restore') => {
  const response = await admin(`/api/admin/bundles/${id}/${action}`, { method: 'POST' });
  if (response.status !== 200) throw new Error(`${action} ${id}: ${response.status} ${await response.text()}`);
};

const mark = async (source: unknown, section: 'listening' | 'reading', answers: Record<string, string> = {}) => {
  const response = await learner('/api/learner/practice/mark', post({ source, section, answers }));
  return { status: response.status, text: await response.text() };
};
const materialSource = (slot: string, map: Record<string, string> = exam) => ({ kind: 'material', section: sectionOf(slot), materialId: map[slot] });
const markSectionFor = (slot: string): 'listening' | 'reading' => (sectionOf(slot) === 'listening' ? 'listening' : 'reading');
const catalog = async () => {
  const items: Array<{ id: string; practiceAvailable: boolean }> = [];
  for (const section of ['listening', 'reading', 'writing', 'speaking']) {
    items.push(...(await (await learner(`/api/learner/materials/${section}`)).json()).items);
  }
  return new Map(items.map((item) => [item.id, item.practiceAvailable]));
};

before(async () => {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/auth', authRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api', authenticateRequest);
  app.use('/api', learnerContentRouter);
  app.use('/api', examSessionRouter);
  app.use('/api', mockRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  const login = await fetch(`${origin}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASSWORD }) });
  adminCookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const registered = await fetch(`${origin}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'eligibility_learner', email: 'eligibility@example.com', password: 'Str0ng-Passw0rd-For-Learner', name: 'Learner' }),
  });
  learnerCookie = (registered.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  learnerId = (await registered.json()).user.id;

  const audio: Record<number, string> = {};
  for (const part of [1, 2, 3, 4]) {
    audio[part] = (await assetStore.create({ originalName: `p${part}.mp3`, content: Buffer.from(`ID3 ${part}`), mimeType: 'audio/mpeg', kind: 'audio', createdBy: 'test', sourceType: 'upload' })).id;
    exam[`listening-${part}`] = await createPublished(listeningPayload(part, audio[part]));
  }
  for (const part of [1, 2, 3]) exam[`reading-${part}`] = await createPublished(readingPayload(part));
  exam['writing-1'] = await createPublished(writingPayload());
  exam['speaking-1'] = await createPublished(speakingPayload());

  // The same content under its own id, published on its own: the rule is about
  // what a published bundle names, not about what a material contains.
  practice['listening-2'] = await createPublished({ ...listeningPayload(2, audio[2]), title: 'Practice Listening' });
  practice['reading-1'] = await createPublished({ ...readingPayload(1), title: 'Practice Reading' });

  bundleA = await createBundle('Exam A');
  bundleB = await createBundle('Exam B');
  await bundleAction(bundleA, 'publish');
});

// These tests send several hundred learner requests from one address, and the
// global API limiter (120 a minute per IP) would refuse them part-way through.
// Its local store is reset before each test; the limiter itself is not under test here.
beforeEach(() => {
  writeFileSync(path.join(tempRoot, 'data', 'request_rate_limits.json'), '{}', 'utf8');
});

after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  process.chdir(originalCwd);
  removeTempRoot(tempRoot);
});

describe('ordinary published content stays practice content', () => {
  it('opens and marks a published Reading and Listening material no exam uses', async () => {
    for (const slot of ['reading-1', 'listening-2']) {
      const opened = await learner(`/api/learner/materials/${sectionOf(slot)}/${practice[slot]}`);
      expect(opened.status).toBe(200);
      const marked = await mark(materialSource(slot, practice), markSectionFor(slot), fullAnswers(slot));
      expect(marked.status).toBe(200);
      const body = JSON.parse(marked.text);
      expect(body.correct).toBe(body.total);
      expect(body.total).toBe(Object.keys(fullAnswers(slot)).length);
    }
    const listed = await catalog();
    expect([listed.get(practice['reading-1']), listed.get(practice['listening-2'])]).toEqual([true, true]);
  });
});

describe('a material a published bundle pins is not practice content', () => {
  it('refuses practice marking for every Listening and Reading component, and returns no answer data', async () => {
    for (const slot of [...LISTENING_SLOTS, ...READING_SLOTS]) {
      for (const answers of [{}, fullAnswers(slot)]) {
        const { status, text } = await mark(materialSource(slot), markSectionFor(slot), answers);
        expect([slot, status]).toEqual([slot, 403]);
        expect(JSON.parse(text).code).toBe('exam_content');
        expectNoAnswerData(text);
      }
    }
  });

  it('refuses to open any of the nine components for practice, and marks none of them', async () => {
    for (const slot of ALL_SLOTS) {
      const opened = await learner(`/api/learner/materials/${sectionOf(slot)}/${exam[slot]}`);
      const text = await opened.text();
      expect([slot, opened.status]).toEqual([slot, 403]);
      expect(JSON.parse(text).code).toBe('exam_content');
      expectNoAnswerData(text);
      // Writing and Speaking have no key, but are exam content all the same: refused before anything else is considered.
      for (const section of ['listening', 'reading'] as const) {
        const marked = await mark(materialSource(slot), section);
        expect([slot, section, marked.status]).toEqual([slot, section, 403]);
        expectNoAnswerData(marked.text);
      }
    }
  });

  it('refuses the published bundle itself, for opening and for marking either section', async () => {
    const opened = await learner(`/api/learner/bundles/${bundleA}`);
    const openedText = await opened.text();
    expect(opened.status).toBe(403);
    expect(JSON.parse(openedText).code).toBe('exam_content');
    expectNoAnswerData(openedText);
    for (const section of ['listening', 'reading'] as const) {
      for (const answers of [{}, fullAnswers(section === 'listening' ? 'listening-1' : 'reading-1')]) {
        const marked = await mark({ kind: 'bundle', bundleId: bundleA }, section, answers);
        expect(marked.status).toBe(403);
        expectNoAnswerData(marked.text);
      }
    }
  });

  it('rejects forged and malformed requests without answer data', async () => {
    const forged: Array<[unknown, 'listening' | 'reading', number]> = [
      // The Reading component named as a Listening material, and as Writing.
      [{ kind: 'material', section: 'listening', materialId: exam['reading-1'] }, 'reading', 404],
      [{ kind: 'material', section: 'writing', materialId: exam['reading-1'] }, 'reading', 404],
      // An exam Reading component under its real section, marked as Listening.
      [{ kind: 'material', section: 'reading', materialId: exam['reading-2'] }, 'listening', 403],
    ];
    for (const [source, section, status] of forged) {
      const marked = await mark(source, section, fullAnswers('reading-2'));
      expect([JSON.stringify(source), marked.status]).toEqual([JSON.stringify(source), status]);
      expectNoAnswerData(marked.text);
    }
    const malformed = [
      { source: { kind: 'material', section: 'reading', materialId: exam['reading-1'], bundleId: bundleA }, section: 'reading', answers: {} },
      { source: { kind: 'material', materialId: exam['reading-1'] }, section: 'reading', answers: {} },
      { source: { kind: 'exam', bundleId: bundleA }, section: 'reading', answers: {} },
      { source: { kind: 'bundle', bundleId: bundleA }, section: 'writing', answers: {} },
      { source: { kind: 'builtin' }, section: 'reading', answers: {}, materialId: exam['reading-1'] },
    ];
    for (const body of malformed) {
      const response = await learner('/api/learner/practice/mark', post(body));
      const text = await response.text();
      expect([JSON.stringify(body), response.status]).toEqual([JSON.stringify(body), 400]);
      expectNoAnswerData(text);
    }
    // A material id is not a section endpoint either.
    const wrongSection = await learner(`/api/learner/materials/listening/${exam['reading-1']}`);
    expect(wrongSection.status).toBe(404);
    expectNoAnswerData(await wrongSection.text());
  });

  it('shows exam content in the catalog as not practisable, and the catalog carries no key', async () => {
    const listed = await catalog();
    for (const slot of ALL_SLOTS) expect([slot, listed.get(exam[slot])]).toEqual([slot, false]);
    for (const section of ['listening', 'reading']) {
      const text = await (await learner(`/api/learner/materials/${section}`)).text();
      for (const value of EVERY_ANSWER) expect(text.includes(value)).toBe(false);
    }
  });
});

describe('when no published bundle names a material any more', () => {
  it('follows the bundles: refused while any names it, practice again once none does, refused again on republication', async () => {
    const refused = async () => {
      for (const slot of [...LISTENING_SLOTS, ...READING_SLOTS]) expect([slot, (await mark(materialSource(slot), markSectionFor(slot))).status]).toEqual([slot, 403]);
    };
    const available = async () => {
      for (const slot of [...LISTENING_SLOTS, ...READING_SLOTS]) {
        const marked = await mark(materialSource(slot), markSectionFor(slot), fullAnswers(slot));
        expect([slot, marked.status]).toEqual([slot, 200]);
      }
      expect((await learner(`/api/learner/materials/writing/${exam['writing-1']}`)).status).toBe(200);
    };

    // Two published bundles share all nine materials; withdrawing one is not enough.
    await bundleAction(bundleB, 'publish');
    await bundleAction(bundleA, 'unpublish');
    await refused();

    // No published bundle names them: ordinary published content again.
    await bundleAction(bundleB, 'unpublish');
    await available();
    const listed = await catalog();
    for (const slot of ALL_SLOTS) expect([slot, listed.get(exam[slot])]).toEqual([slot, true]);

    // Published again, exam content again — the check is made on every request.
    await bundleAction(bundleA, 'publish');
    await refused();

    // An archived bundle is not published either.
    await bundleAction(bundleA, 'archive');
    await available();
    await bundleAction(bundleA, 'restore');
    await bundleAction(bundleA, 'publish');
    await refused();
  });

  it('keeps a material that is itself withdrawn or archived out of reach, exam component or not', async () => {
    const targets: Array<[string, Record<string, string>]> = [['reading-1', practice], ['reading-3', exam]];
    for (const [slot, map] of targets) {
      for (const action of ['unpublish', 'archive'] as const) {
        expect((await admin(`/api/admin/materials/reading/${map[slot]}/${action}`, { method: 'POST' })).status).toBe(200);
        const opened = await learner(`/api/learner/materials/reading/${map[slot]}`);
        expect([slot, action, opened.status]).toEqual([slot, action, 404]);
        const marked = await mark(materialSource(slot, map), 'reading');
        expect([slot, action, marked.status]).toEqual([slot, action, 404]);
        expectNoAnswerData(marked.text);
        expect((await catalog()).has(map[slot])).toBe(false);
      }
      await admin(`/api/admin/materials/reading/${map[slot]}/restore`, { method: 'POST' });
      await admin(`/api/admin/materials/reading/${map[slot]}/publish`, { method: 'POST' });
    }
  });
});

describe('no other learner route gives the key back', () => {
  it('mocks: history and a stored mock are sent without keys, and an exam material is not a mock', async () => {
    await dataStore.recordGeneratedTest(learnerId, {
      id: 'mock_eligibility_1',
      userId: learnerId,
      timestamp: new Date().toISOString(),
      module: 'academic',
      section: 'reading',
      targetBand: '7',
      theme: 'Energy',
      contentHash: 'x',
      title: 'Generated reading',
      questionTypes: ['short_answer'],
      data: { passages: [{ content: 'A passage.', questions: [{ id: 'g1', prompt: 'Which fuel?', correctAnswer: 'GENERATED-KEY', explanation: 'Line 2.' }] }] },
    });
    const history = await (await learner('/api/mocks/history')).text();
    expect(history.includes('mock_eligibility_1')).toBe(true);
    expect(history.includes('GENERATED-KEY')).toBe(false);
    const stored = await (await learner('/api/mocks/mock_eligibility_1')).text();
    expect(stored.includes('Which fuel?')).toBe(true);
    for (const leaked of ['GENERATED-KEY', 'Line 2.', '"correctAnswer"', '"explanation"']) expect(stored.includes(leaked)).toBe(false);

    for (const slot of ALL_SLOTS) {
      const response = await learner(`/api/mocks/${exam[slot]}`);
      expect([slot, response.status]).toEqual([slot, 404]);
      expectNoAnswerData(await response.text());
    }
    // Generating needs the model; without it nothing is generated and nothing is sent.
    const generated = await learner('/api/mocks/generate', post({ module: 'academic', section: 'reading', targetBand: '7', theme: 'Energy' }));
    expect(generated.status >= 400).toBe(true);
    expectNoAnswerData(await generated.text());
  });

  it('the exam itself: opening the published bundle sends the paper without a key, transcript or bundle list key', async () => {
    const opened = await learner('/api/learner/exams', post({ bundleId: bundleA }));
    const text = await opened.text();
    expect(opened.status).toBe(200);
    for (const value of EVERY_ANSWER) expect(text.includes(value)).toBe(false);
    for (const field of ['"correctAnswer"', '"explanation"', '"audioTranscript"', '"results"']) expect(text.includes(field)).toBe(false);
    // The paper's Listening parts carry the transcript field empty, by design.
    expect(/"transcript":"[^"]/.test(text)).toBe(false);
    const list = await (await learner('/api/learner/bundles')).text();
    for (const value of EVERY_ANSWER) expect(list.includes(value)).toBe(false);
    await learner(`/api/learner/exams/${JSON.parse(text).sessionId}/abandon`, post({}));
  });
});
