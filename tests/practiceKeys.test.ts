import './env';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';
import type { PracticeMarking, PracticeTest } from '../src/types/practice';
import { CUSTOM_TIMING, FULL_SLOTS, listeningAnswer, listeningPayload, readingAnswer, readingPayload, speakingPayload, writingPayload } from './bundleFixtures';

/**
 * Practice never sends an answer key before the learner submits.
 *
 * Every learner-facing practice response is read as the raw text the browser
 * receives, not as parsed fields a screen might choose to ignore: no key field,
 * no key value the learner has not typed, no explanation, no provenance or
 * evidence, no import record or source document, and no printed answer-key
 * section inside an imported page's markup or text. Marking still works — on
 * the server, with the same scoring function — and returns the feedback
 * practice shows after submission.
 */
const originalCwd = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-practice-keys-'));
process.chdir(tempRoot);

const ADMIN_USER = 'practice_admin';
const ADMIN_PASSWORD = 'Str0ng-Passw0rd-For-Practice';
process.env.SEED_DEFAULT_ACCOUNTS = 'true';
process.env.ADMIN_USER = ADMIN_USER;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;

const express = (await import('express')).default;
const { adminRouter } = await import('../src/routes/adminRoutes');
const { learnerContentRouter } = await import('../src/routes/learnerContentRoutes');
const { authRouter } = await import('../src/routes/authRoutes');
const { authenticateRequest } = await import('../src/middleware/authMiddleware');
const { assetStore } = await import('../src/services/assetStore');
const { adminStore } = await import('../src/services/adminStore');
const { questionsOf } = await import('../src/services/publishGate');
const { builtInSittableTest } = await import('../src/services/publishedTests');
const { withoutAnswerKeys } = await import('../src/services/learnerRedaction');
const { objectiveSectionScore } = await import('../src/utils/ieltsScoring');

let server: Server;
let origin = '';
let adminCookie = '';
let learnerCookie = '';

const call = (cookie: string) => (url: string, init: RequestInit = {}) =>
  fetch(`${origin}${url}`, { ...init, headers: { 'Content-Type': 'application/json', cookie, ...(init.headers || {}) } });
const admin = (url: string, init: RequestInit = {}) => call(adminCookie)(url, init);
const learner = (url: string, init: RequestInit = {}) => call(learnerCookie)(url, init);
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

const ids: Record<string, string> = {};
let bundleId = '';
let importedId = '';

/** An imported page as the importer stores it: display markup and text with the printed key still in them. */
const IMPORTED_KEYS = ['zebrafinch', 'quokkapouch'];
const importedPage = `<div class="cdi-page"><h1>Passage</h1><p>Birds and marsupials were observed across two seasons in the reserve.</p>
<p><strong>1.</strong> Which bird was ringed first?</p><p><strong>2.</strong> What did the keepers measure?</p>
<h2>Answer Key</h2><ul><li>1. ${IMPORTED_KEYS[0]}</li><li>2. ${IMPORTED_KEYS[1]}</li></ul></div>`;
const importedText = `Passage Birds and marsupials were observed across two seasons in the reserve. 1. Which bird was ringed first? 2. What did the keepers measure? Answer Key 1. ${IMPORTED_KEYS[0]} 2. ${IMPORTED_KEYS[1]}`;

async function createPublished(payload: object): Promise<string> {
  const saved = await (await admin('/api/admin/materials', post(payload))).json();
  const published = await admin(`/api/admin/materials/${saved.item.section}/${saved.item.id}/publish`, { method: 'POST' });
  if (published.status !== 200) throw new Error(`fixture did not publish: ${JSON.stringify(await published.json())}`);
  return saved.item.id as string;
}

before(async () => {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/auth', authRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api', authenticateRequest);
  app.use('/api', learnerContentRouter);
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
  const registered = await fetch(`${origin}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'practice_learner', email: 'practice@example.com', password: 'Str0ng-Passw0rd-For-Learner', name: 'Practice' }),
  });
  learnerCookie = (registered.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

  for (const part of [1, 2, 3, 4]) {
    const asset = await assetStore.create({ originalName: `p${part}.mp3`, content: Buffer.from(`ID3 ${part}`), mimeType: 'audio/mpeg', kind: 'audio', createdBy: 'test', sourceType: 'upload' });
    ids[`listening-${part}`] = await createPublished(listeningPayload(part, asset.id));
  }
  for (const part of [1, 2, 3]) {
    const payload = readingPayload(part);
    // Explanations are part of the key: they must not travel before submission either.
    payload.content.passage.questions = payload.content.passage.questions.map((question) => ({ ...question, explanation: `Because the passage says ${question.correctAnswer}.` }));
    ids[`reading-${part}`] = await createPublished(payload);
  }
  ids['writing-1'] = await createPublished(writingPayload());
  ids['speaking-1'] = await createPublished(speakingPayload());

  const pins = await Promise.all(
    FULL_SLOTS.map(async ({ section, part }) => {
      const { candidates } = await (await admin('/api/admin/bundles/candidates')).json();
      const materialId = ids[`${section}-${part}`];
      return { section, part, materialId, contentHash: candidates.find((entry: { id: string }) => entry.id === materialId).contentHash };
    }),
  );
  const created = await (await admin('/api/admin/bundles', post({ title: 'Practice CDI', module: 'academic', components: pins, timing: CUSTOM_TIMING }))).json();
  bundleId = created.bundle.id;
  await admin(`/api/admin/bundles/${bundleId}/publish`, { method: 'POST' });

  importedId = await createPublished({
    title: 'Imported page with its key printed',
    section: 'reading',
    module: 'academic',
    theme: 'Wildlife',
    targetBand: '6.5',
    content: {
      htmlContent: importedPage,
      passage: {
        passageNumber: 1,
        title: 'Imported passage',
        text: importedText,
        htmlContent: importedPage,
        questions: [
          { id: 'imp-q1', questionNumber: 1, type: 'short_answer', prompt: 'Which bird was ringed first?', correctAnswer: IMPORTED_KEYS[0] },
          { id: 'imp-q2', questionNumber: 2, type: 'short_answer', prompt: 'What did the keepers measure?', correctAnswer: IMPORTED_KEYS[1] },
        ],
      },
    },
  });
});

after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  process.chdir(originalCwd);
  removeTempRoot(tempRoot);
});

const KEY_FIELDS = ['correctAnswer', 'acceptableAnswers', 'alternativeAnswers', 'explanation', 'provenance', 'evidence', 'paragraphLocation', 'importRecord', 'generationRecord', 'generationReviews', 'sourceAssetId', 'needsReview', 'customGradingCriteria'];
const ALL_FIXTURE_KEYS = [1, 2, 3, 4].flatMap((part) => [listeningAnswer(part, 1), listeningAnswer(part, 2)]).concat([1, 2, 3].flatMap((part) => [readingAnswer(part, 1), readingAnswer(part, 2)]));

function expectKeyFree(text: string, keys: string[] = ALL_FIXTURE_KEYS) {
  for (const field of KEY_FIELDS) expect(text.includes(`"${field}"`)).toBe(false);
  for (const key of keys) expect(text.includes(key)).toBe(false);
}

describe('practice responses before submission', () => {
  it('refuses anonymous callers every practice route', async () => {
    for (const url of [`/api/learner/bundles/${bundleId}`, `/api/learner/materials/reading/${ids['reading-1']}`, '/api/learner/materials/reading']) {
      expect((await fetch(`${origin}${url}`)).status).toBe(401);
    }
    const mark = await fetch(`${origin}/api/learner/practice/mark`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: { kind: 'builtin' }, section: 'reading', answers: {} }),
    });
    expect(mark.status).toBe(401);
  });

  it('sends a published Reading material with its questions but no key, explanation or provenance', async () => {
    const response = await learner(`/api/learner/materials/reading/${ids['reading-1']}`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expectKeyFree(text);
    const practice = JSON.parse(text) as PracticeTest;
    expect(practice.test.reading?.passages[0].questions.slice(0, 2).map((question) => [question.id, question.prompt, question.answerCount])).toEqual([
      ['rea-p1-q1', 'Reading passage 1, question 1', 1],
      ['rea-p1-q2', 'Reading passage 1, question 2', 1],
    ]);
    expect(practice.test.reading?.passages[0].questions).toHaveLength(13);
  });

  it('sends a published Listening material with its audio and transcript but no key', async () => {
    const response = await learner(`/api/learner/materials/listening/${ids['listening-2']}`);
    const text = await response.text();
    expectKeyFree(text);
    const practice = JSON.parse(text) as PracticeTest;
    expect(practice.test.listening?.parts[0].questions.map((question) => question.id)).toEqual(Array.from({ length: 10 }, (_, index) => `lis-p2-q${index + 1}`));
    expect(practice.test.listening?.parts[0].audioUrl?.startsWith('/api/assets/ast_')).toBe(true);
  });

  it('sends a published bundle for practice with every section and no key anywhere', async () => {
    const response = await learner(`/api/learner/bundles/${bundleId}`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expectKeyFree(text);
    const practice = JSON.parse(text) as PracticeTest;
    expect(practice.test.listening?.parts).toHaveLength(4);
    expect(practice.test.reading?.passages).toHaveLength(3);
    expect(Boolean(practice.test.writing.task1 && practice.test.writing.task2 && practice.test.speaking)).toBe(true);
  });

  it('cuts an imported page’s printed answer key out of its markup and text', async () => {
    const stored = await adminStore.getMaterial('reading', importedId);
    // The stored material keeps the page as imported; only the learner's copy loses the key.
    expect(stored?.section === 'reading' && stored.content.passage.text.includes(IMPORTED_KEYS[0])).toBe(true);

    const text = await (await learner(`/api/learner/materials/reading/${importedId}`)).text();
    expectKeyFree(text, IMPORTED_KEYS);
    expect(text.includes('Answer Key')).toBe(false);
    const practice = JSON.parse(text) as PracticeTest;
    const passage = practice.test.reading?.passages[0];
    expect(passage?.content.includes('Birds and marsupials were observed')).toBe(true);
    expect(passage?.htmlContent?.includes('What did the keepers measure?')).toBe(true);
  });

  it('cuts the key out of a real importer result, markup and text alike', async () => {
    const { importCdiHtml } = await import('../src/services/cdiImport');
    const { cutAnswerKeySection, withoutKeyText } = await import('../src/services/answerKeySection');
    const result = importCdiHtml(readFileSync(path.join(originalCwd, 'tests/fixtures/cdi/reading-markers.html'), 'utf8'));
    const cut = cutAnswerKeySection(result.normalizedHtml);
    expect(cut === null).toBe(false);
    if (!cut) return;
    // Every key row the page printed, gone from both; the questions stay.
    expect(cut.removedLines.length).toBeGreaterThanOrEqual(13);
    for (const line of cut.removedLines) {
      expect(cut.html.includes(`<li>${line}</li>`)).toBe(false);
    }
    const text = withoutKeyText(result.normalizedText, cut) ?? '';
    expect(/answer key/i.test(text)).toBe(false);
    expect(text.includes('10. displacement')).toBe(false);
    expect(cut.html.includes('What does the writer suggest about the internal representation?')).toBe(true);
    // A heading called "Key" with no numbered key under it is a legend, and is left alone.
    expect(cutAnswerKeySection('<p>Map</p><h2>Key</h2><p>Blue lines are rivers.</p>')).toBe(null);
  });

  it('keeps the catalog free of keys too', async () => {
    const text = await (await learner('/api/learner/materials/reading')).text();
    expectKeyFree(text, [...ALL_FIXTURE_KEYS, ...IMPORTED_KEYS]);
    const publicText = await (await fetch(`${origin}/api/admin/public/materials/reading`)).text();
    expectKeyFree(publicText, [...ALL_FIXTURE_KEYS, ...IMPORTED_KEYS]);
  });
});

describe('practice marking after submission', () => {
  const mark = async (body: unknown) => {
    const response = await learner('/api/learner/practice/mark', post(body));
    return { status: response.status, body: (await response.json()) as PracticeMarking & { code?: string } };
  };

  it('marks a submitted material with the practice scoring and returns the feedback practice shows', async () => {
    const answers = { 'rea-p2-q1': readingAnswer(2, 1), 'rea-p2-q2': 'not it' };
    const { status, body } = await mark({ source: { kind: 'material', section: 'reading', materialId: ids['reading-2'] }, section: 'reading', answers });
    expect(status).toBe(200);

    const material = await adminStore.getMaterial('reading', ids['reading-2']);
    const expected = objectiveSectionScore('reading', material ? questionsOf(material) : [], answers, 'academic');
    expect([body.correct, body.total, body.band]).toEqual([expected.correct, expected.total, expected.band]);
    expect(body.results['rea-p2-q1']).toEqual({ correct: true, answers: [readingAnswer(2, 1)], explanation: `Because the passage says ${readingAnswer(2, 1)}.` });
    expect(body.results['rea-p2-q2'].correct).toBe(false);
    expect(body.results['rea-p2-q2'].answers).toEqual([readingAnswer(2, 2)]);
  });

  it('marks a bundle section across all of its parts', async () => {
    const answers = Object.fromEntries([1, 2, 3, 4].map((part) => [`lis-p${part}-q1`, listeningAnswer(part, 1)]));
    const { status, body } = await mark({ source: { kind: 'bundle', bundleId }, section: 'listening', answers });
    expect(status).toBe(200);
    expect([body.correct, body.total]).toEqual([4, 40]);
    expect(Object.keys(body.results).sort()).toEqual([1, 2, 3, 4].flatMap((part) => Array.from({ length: 10 }, (_, index) => `lis-p${part}-q${index + 1}`)).sort());
  });

  it('marks a General Training Reading material with the General Training table', async () => {
    const generalId = await createPublished({ ...readingPayload(1, 'general'), title: 'General Training Reading Section 1' });
    // 10 of 13 correct: a single passage, so the raw score is scaled to 31/40 —
    // band 6 on the General Training table, where Academic would give 7.
    const answers = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`rea-p1-q${index + 1}`, readingAnswer(1, index + 1)]));
    const { status, body } = await mark({ source: { kind: 'material', section: 'reading', materialId: generalId }, section: 'reading', answers });
    expect(status).toBe(200);
    expect([body.correct, body.total, body.band]).toEqual([10, 13, 6]);
    const material = await adminStore.getMaterial('reading', generalId);
    expect(body.band).toBe(objectiveSectionScore('reading', material ? questionsOf(material) : [], answers, 'general').band);
    expect(objectiveSectionScore('reading', material ? questionsOf(material) : [], answers, 'academic').band).toBe(7);
  });

  it('marks the built-in test on the server with the same scoring as before', async () => {
    const test = builtInSittableTest();
    const questions = test.reading?.passages.flatMap((passage) => passage.questions) ?? [];
    const first = questions[0];
    const answers = { [first.id]: Array.isArray(first.correctAnswer) ? first.correctAnswer[0] : first.correctAnswer };
    const { status, body } = await mark({ source: { kind: 'builtin' }, section: 'reading', answers });
    expect(status).toBe(200);
    const expected = objectiveSectionScore('reading', questions, answers, 'academic');
    expect([body.correct, body.total, body.band]).toEqual([expected.correct, expected.total, expected.band]);
    expect(body.results[first.id].correct).toBe(true);
  });

  it('refuses to mark what the learner cannot open', async () => {
    const draft = await (await admin('/api/admin/materials', post({ ...readingPayload(3), title: 'Draft only' }))).json();
    expect((await mark({ source: { kind: 'material', section: 'reading', materialId: draft.item.id }, section: 'reading', answers: {} })).status).toBe(404);
    const noSection = await mark({ source: { kind: 'material', section: 'writing', materialId: ids['writing-1'] }, section: 'reading', answers: {} });
    expect(noSection.status).toBe(409);
    expect(noSection.body.code).toBe('section_not_in_test');
    expect((await mark({ source: { kind: 'bundle', bundleId: 'cdi-bundle-missing' }, section: 'reading', answers: {} })).status).toBe(404);
    expect((await mark({ source: { kind: 'builtin' }, section: 'reading', answers: {}, extra: true })).status).toBe(400);
  });
});

describe('generated mocks', () => {
  it('are sent without keys, explanations, evidence or provenance', () => {
    const generated = {
      id: 'mock_1',
      testData: {
        passages: [
          {
            content: 'A passage.',
            questions: [{ id: 'q1', prompt: 'Why?', correctAnswer: 'because', acceptableAnswers: ['cause'], explanation: 'Line 3.', paragraphLocation: 'B' }],
          },
        ],
        importRecord: { parserVersion: 1 },
        sourceAssetId: 'ast_0123456789abcdef',
      },
    };
    const text = JSON.stringify(withoutAnswerKeys(generated));
    expectKeyFree(text, ['because', 'Line 3.', 'ast_0123456789abcdef']);
    expect(text.includes('Why?')).toBe(true);
  });

  it('are redacted on both routes that return one', () => {
    const server = readFileSync(path.join(originalCwd, 'server.ts'), 'utf8');
    expect(server).toContain('test:withoutAnswerKeys(result)');
    expect(server).toContain('return res.json(withoutAnswerKeys(test));');
  });
});
