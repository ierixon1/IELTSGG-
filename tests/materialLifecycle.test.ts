import './env';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';

/**
 * The whole life of a material, driven through the API an admin and a learner
 * really use.
 *
 * The happy path is one test on purpose: `draft → edit → publish → learner
 * discovery → learner open` only means something as a sequence. Everything
 * after it is a negative case, because the failures this phase existed to fix
 * were all things that succeeded when they should not have — a save that
 * published, a bundle that substituted the built-in test for a component it
 * could not supply, an unpublished material a learner could still fetch.
 */
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-lifecycle-'));
const originalCwd = process.cwd();
process.chdir(tempRoot);

const ADMIN_USER = 'lifecycle_admin';
const ADMIN_PASSWORD = 'Str0ng-Passw0rd-For-Tests';
const LEARNER_USER = 'lifecycle_learner';
const LEARNER_PASSWORD = 'Str0ng-Passw0rd-For-Learners';
process.env.SEED_DEFAULT_ACCOUNTS = 'true';
process.env.ADMIN_USER = ADMIN_USER;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;

const express = (await import('express')).default;
const { adminRouter } = await import('../src/routes/adminRoutes');
const { learnerContentRouter } = await import('../src/routes/learnerContentRoutes');
const { authRouter } = await import('../src/routes/authRoutes');
const { authenticateRequest } = await import('../src/middleware/authMiddleware');
const { adminStore } = await import('../src/services/adminStore');

let server: Server;
let origin = '';
let adminCookie = '';
let learnerCookie = '';

const api = (url: string, init: RequestInit = {}) =>
  fetch(`${origin}${url}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', cookie: adminCookie, ...(init.headers || {}) },
  });

const learner = (url: string, init: RequestInit = {}) =>
  fetch(`${origin}${url}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', cookie: learnerCookie, ...(init.headers || {}) },
  });

/** A reading material that satisfies every publish precondition. */
const publishableReading = (over: Record<string, unknown> = {}) => ({
  title: 'Lifecycle Reading',
  section: 'reading',
  module: 'academic',
  theme: 'Navigation',
  targetBand: '7.5',
  content: {
    passage: {
      passageNumber: 1,
      title: 'Dead reckoning',
      text: 'Animals navigate without landmarks.',
      questions: [
        {
          id: 'lc-1',
          questionNumber: 1,
          type: 'true_false_not_given',
          prompt: 'Path integration accumulates error.',
          correctAnswer: 'TRUE',
        },
        {
          id: 'lc-2',
          questionNumber: 2,
          type: 'sentence_completion',
          prompt: 'The error grows with every ___.',
          correctAnswer: 'step',
        },
      ],
    },
  },
  ...over,
});

const createDraft = async (body: Record<string, unknown> = publishableReading()) => {
  const response = await api('/api/admin/materials', { method: 'POST', body: JSON.stringify(body) });
  expect(response.status).toBe(200);
  return (await response.json()).item;
};

before(async () => {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/auth', authRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api', authenticateRequest, learnerContentRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const address = server.address();
      origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
      resolve();
    });
  });

  const login = await fetch(`${origin}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASSWORD }),
  });
  expect(login.status).toBe(200);
  adminCookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

  const registered = await fetch(`${origin}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: LEARNER_USER,
      email: 'lifecycle@example.com',
      password: LEARNER_PASSWORD,
      name: 'Lifecycle Learner',
    }),
  });
  expect(registered.status).toBe(201);
  learnerCookie = (registered.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  expect(learnerCookie).toBeTruthy();
});

after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  process.chdir(originalCwd);
  removeTempRoot(tempRoot);
});

describe('draft to learner, the whole way', () => {
  it('walks a material from draft through publication to a learner sitting it', async () => {
    // 1. Authored. Nothing about saving publishes it.
    const draft = await createDraft();
    expect(draft.status).toBe('draft');

    // 2. It is in the admin catalog, and only in the draft filter.
    const drafts = await (await api('/api/admin/materials?status=draft')).json();
    expect(drafts.items.some((item: { id: string }) => item.id === draft.id)).toBe(true);
    const published = await (await api('/api/admin/materials?status=published')).json();
    expect(published.items.some((item: { id: string }) => item.id === draft.id)).toBe(false);

    // 3. A learner cannot reach it yet, by list or by id.
    const catalogBefore = await (await learner('/api/learner/materials/reading')).json();
    expect(catalogBefore.items.some((item: { id: string }) => item.id === draft.id)).toBe(false);
    expect((await learner(`/api/learner/materials/reading/${draft.id}`)).status).toBe(404);

    // 4. Edited. Still a draft.
    const edited = publishableReading({ id: draft.id, updatedAt: draft.updatedAt });
    (edited.content.passage.questions[0] as { prompt: string }).prompt =
      'Path integration accumulates error with distance.';
    const editedResponse = await api(`/api/admin/materials/reading/${draft.id}`, {
      method: 'PUT',
      body: JSON.stringify(edited),
    });
    expect(editedResponse.status).toBe(200);
    expect((await editedResponse.json()).item.status).toBe('draft');

    // 5. Published, deliberately, after the gate says it may be.
    const check = await (await api(`/api/admin/materials/reading/${draft.id}/publish-check`)).json();
    expect(check.publishable).toBe(true);
    const publishResponse = await api(`/api/admin/materials/reading/${draft.id}/publish`, {
      method: 'POST',
    });
    expect(publishResponse.status).toBe(200);
    expect((await publishResponse.json()).item.status).toBe('published');

    // 6. Learner discovery: it is in the catalog, under its own id.
    const catalog = await (await learner('/api/learner/materials/reading')).json();
    const listed = catalog.items.find((item: { id: string }) => item.id === draft.id);
    expect(listed === undefined).toBe(false);
    expect(listed.title).toBe('Lifecycle Reading');
    expect(listed.questionCount).toBe(2);
    // The catalog is a catalog, not a leak: no keys travel with the summary.
    expect(JSON.stringify(listed).includes('TRUE')).toBe(false);

    // 7. Learner opens exactly that id, and gets a sittable material.
    const openedResponse = await learner(`/api/learner/materials/reading/${listed.id}`);
    expect(openedResponse.status).toBe(200);
    const openedText = await openedResponse.text();
    const opened = JSON.parse(openedText).test;
    expect(opened.id).toBe(draft.id);
    expect(opened.reading.passages[0].questions).toHaveLength(2);
    expect(opened.reading.passages[0].questions[0].prompt).toBe(
      'Path integration accumulates error with distance.',
    );
    // The key stays on the server until the learner submits.
    expect(opened.reading.passages[0].questions[0].correctAnswer).toBe(undefined);
    expect(openedText.includes('correctAnswer')).toBe(false);

    // 8. Submitted, it is marked on the server against exactly this material.
    const marked = await learner('/api/learner/practice/mark', {
      method: 'POST',
      body: JSON.stringify({
        source: { kind: 'material', section: 'reading', materialId: draft.id },
        section: 'reading',
        answers: { 'lc-1': 'TRUE', 'lc-2': 'wrong' },
      }),
    });
    expect(marked.status).toBe(200);
    const marking = await marked.json();
    expect([marking.correct, marking.total]).toEqual([1, 2]);
    expect(marking.results['lc-1']).toEqual({ correct: true, answers: ['TRUE'] });
    expect(marking.results['lc-2'].correct).toBe(false);
    expect(marking.results['lc-2'].answers).toEqual(['step']);
  });
});

describe('publishing is refused until the material is fit for a learner', () => {
  it('refuses a material with no questions', async () => {
    const body = publishableReading();
    (body.content.passage as { questions: unknown[] }).questions = [];
    const draft = await createDraft(body);

    const response = await api(`/api/admin/materials/reading/${draft.id}/publish`, {
      method: 'POST',
    });
    expect(response.status).toBe(409);
    const failure = await response.json();
    expect(failure.blockers.some((b: { code: string }) => b.code === 'no_questions')).toBe(true);
    expect((await adminStore.getMaterial('reading', draft.id))?.status).toBe('draft');
  });

  it('refuses a material whose classification is incomplete', async () => {
    const body = publishableReading();
    delete (body as Record<string, unknown>).targetBand;
    delete (body as Record<string, unknown>).theme;
    const draft = await createDraft(body);

    const response = await api(`/api/admin/materials/reading/${draft.id}/publish`, {
      method: 'POST',
    });
    expect(response.status).toBe(409);
    const failure = await response.json();
    const blocker = failure.blockers.find(
      (b: { code: string }) => b.code === 'classification_incomplete',
    );
    expect(blocker === undefined).toBe(false);
    expect(blocker.message).toContain('theme');
    expect(blocker.message).toContain('target band');
  });

  it('refuses a material that still needs a human on one of its questions', async () => {
    // Written straight to storage, the way a row from an older build looks:
    // the write boundary would refuse this, so it cannot arrive through the API.
    const stored = await adminStore.saveMaterial('reading', publishableReading());
    const rows = await adminStore.listMaterials('reading');
    expect(rows.some((row) => row.id === stored.id)).toBe(true);

    const { readFileSync, writeFileSync } = await import('node:fs');
    const file = path.join(tempRoot, 'data', 'admin_content', 'reading.json');
    const items = JSON.parse(readFileSync(file, 'utf8'));
    const row = items.find((item: { id: string }) => item.id === stored.id);
    row.content.passage.questions[0].type = 'a_construct_nobody_supports';
    writeFileSync(file, JSON.stringify(items, null, 2));

    const response = await api(`/api/admin/materials/reading/${stored.id}/publish`, {
      method: 'POST',
    });
    expect(response.status).toBe(409);
    expect(
      (await response.json()).blockers.some((b: { code: string }) => b.code === 'needs_review'),
    ).toBe(true);
  });

  it('refuses a material that names a file the asset store does not have', async () => {
    const body = publishableReading();
    (body.content as Record<string, unknown>).assetIds = ['ast_notarealasset1'];
    const draft = await createDraft(body);

    const response = await api(`/api/admin/materials/reading/${draft.id}/publish`, {
      method: 'POST',
    });
    expect(response.status).toBe(409);
    expect(
      (await response.json()).blockers.some((b: { code: string }) => b.code === 'asset_missing'),
    ).toBe(true);
  });

  it('refuses an imported material whose answer key the parser never found', async () => {
    const body = publishableReading();
    (body.content as Record<string, unknown>).importRecord = {
      parserVersion: '1.0.0',
      diagnostics: [
        {
          code: 'answer_key_missing',
          message: 'No answer key was found for question 2.',
          questionNumber: 2,
        },
      ],
      unsupportedRegions: [],
      reviewedQuestions: [
        {
          questionNumber: 1,
          originalStatus: 'unsupported',
          originalAnswerStatus: 'missing',
          decision: 'include',
          edited: true,
          sourceRange: { start: 0, end: 10, excerpt: '' },
        },
      ],
    };
    const draft = await createDraft(body);

    const response = await api(`/api/admin/materials/reading/${draft.id}/publish`, {
      method: 'POST',
    });
    expect(response.status).toBe(409);
    const codes = (await response.json()).blockers.map((b: { code: string }) => b.code);
    expect(codes.includes('unsupported_question')).toBe(true);
    expect(codes.includes('import_unresolved')).toBe(true);
  });
});

describe('what a learner may not reach', () => {
  it('hides an unpublished material by list and by id', async () => {
    const draft = await createDraft(publishableReading({ title: 'Never Published' }));

    const catalog = await (await learner('/api/learner/materials/reading')).json();
    expect(catalog.items.some((item: { id: string }) => item.id === draft.id)).toBe(false);
    expect((await learner(`/api/learner/materials/reading/${draft.id}`)).status).toBe(404);
  });

  it('takes an archived material out of reach without destroying it', async () => {
    const draft = await createDraft(publishableReading({ title: 'To Be Archived' }));
    expect(
      (await api(`/api/admin/materials/reading/${draft.id}/publish`, { method: 'POST' })).status,
    ).toBe(200);
    expect((await learner(`/api/learner/materials/reading/${draft.id}`)).status).toBe(200);

    const archived = await api(`/api/admin/materials/reading/${draft.id}/archive`, {
      method: 'POST',
    });
    expect(archived.status).toBe(200);
    expect((await archived.json()).item.status).toBe('archived');

    // Out of reach for the learner…
    const catalog = await (await learner('/api/learner/materials/reading')).json();
    expect(catalog.items.some((item: { id: string }) => item.id === draft.id)).toBe(false);
    expect((await learner(`/api/learner/materials/reading/${draft.id}`)).status).toBe(404);

    // …but still there, which is the difference between archiving and deleting.
    expect((await adminStore.getMaterial('reading', draft.id))?.title).toBe('To Be Archived');
    const archivedList = await (await api('/api/admin/materials?status=archived')).json();
    expect(archivedList.items.some((item: { id: string }) => item.id === draft.id)).toBe(true);
  });

  it('restores an archived material as a draft, not straight back to learners', async () => {
    const draft = await createDraft(publishableReading({ title: 'Archived Then Restored' }));
    await api(`/api/admin/materials/reading/${draft.id}/publish`, { method: 'POST' });
    await api(`/api/admin/materials/reading/${draft.id}/archive`, { method: 'POST' });

    const restored = await api(`/api/admin/materials/reading/${draft.id}/restore`, {
      method: 'POST',
    });
    expect(restored.status).toBe(200);
    expect((await restored.json()).item.status).toBe('draft');
    expect((await learner(`/api/learner/materials/reading/${draft.id}`)).status).toBe(404);
  });
});

describe('a bundle component that is not there', () => {
  it('reports the gap instead of substituting the built-in test', async () => {
    const reading = await createDraft(publishableReading({ title: 'Bundled Reading' }));
    await api(`/api/admin/materials/reading/${reading.id}/publish`, { method: 'POST' });

    // The Listening material is named but never published, so the bundle cannot
    // supply it.
    const listening = await createDraft({
      title: 'Unpublished Listening',
      section: 'listening',
      module: 'academic',
      theme: 'Campus',
      targetBand: '7.0',
      content: {
        section: {
          sectionNumber: 1,
          title: 'Enquiry',
          contextDescription: 'A call.',
          questions: [
            {
              id: 'lc-l1',
              questionNumber: 1,
              type: 'form_completion',
              prompt: 'Desk opens at:',
              correctAnswer: '07:00',
            },
          ],
        },
      },
    });

    const candidates = (await (await api('/api/admin/bundles/candidates')).json()).candidates as Array<{ id: string; contentHash: string }>;
    const readingPin = candidates.find((candidate) => candidate.id === reading.id);
    expect(Boolean(readingPin)).toBe(true);
    // A draft material is not offered for pinning at all.
    expect(candidates.some((candidate) => candidate.id === listening.id)).toBe(false);

    const created = await api('/api/admin/bundles', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Half a Test',
        module: 'academic',
        status: 'published',
        components: [
          { section: 'reading', part: 1, materialId: reading.id, contentHash: readingPin?.contentHash },
          { section: 'listening', part: 1, materialId: listening.id, contentHash: 'a'.repeat(64) },
        ],
        timing: { listeningMinutes: 30, readingMinutes: 60, writingMinutes: 60, speakingMinutes: 14, basis: 'custom', allowEarlyFinish: true },
      }),
    });
    expect(created.status).toBe(201);
    const bundle = (await created.json()).bundle;
    // A status in the body is ignored: saving never publishes.
    expect(bundle.status).toBe('draft');

    const published = await api(`/api/admin/bundles/${bundle.id}/publish`, { method: 'POST' });
    expect(published.status).toBe(409);
    const codes = (await published.json()).blockers.map((blocker: { code: string }) => blocker.code);
    expect(codes).toContain('component_unpublished');
    expect(codes).toContain('writing_missing');
    expect(codes).toContain('part_missing');

    // The learner is given a reason, never half a test.
    const opened = await learner(`/api/learner/bundles/${bundle.id}`);
    expect(opened.status).toBe(409);
    const body = await opened.json();
    expect(body.code).toBe('bundle_unpublished');
    expect(body.components).toBe(undefined);
  });
});

describe('deletion tells the truth about what references a material', () => {
  it('refuses to delete a published material', async () => {
    const draft = await createDraft(publishableReading({ title: 'Live Material' }));
    await api(`/api/admin/materials/reading/${draft.id}/publish`, { method: 'POST' });

    const response = await api(`/api/admin/materials/reading/${draft.id}`, { method: 'DELETE' });
    expect(response.status).toBe(409);
    expect(String((await response.json()).error)).toContain('Unpublish or archive');
    expect((await adminStore.getMaterial('reading', draft.id))?.status).toBe('published');
  });

  it('refuses to delete a material a bundle still names, even as a draft', async () => {
    const draft = await createDraft(publishableReading({ title: 'Referenced Draft' }));
    await (
      await api('/api/admin/bundles', {
        method: 'POST',
        body: JSON.stringify({
          title: 'Referencing Bundle',
          module: 'academic',
          components: [{ section: 'reading', part: 1, materialId: draft.id, contentHash: 'a'.repeat(64) }],
          timing: { listeningMinutes: 30, readingMinutes: 60, writingMinutes: 60, speakingMinutes: 14, basis: 'custom', allowEarlyFinish: true },
        }),
      })
    ).json();

    const response = await api(`/api/admin/materials/reading/${draft.id}`, { method: 'DELETE' });
    expect(response.status).toBe(409);
    expect(String((await response.json()).error)).toContain('Referencing Bundle');
    expect((await adminStore.getMaterial('reading', draft.id)) === null).toBe(false);
  });

  it('deletes an unreferenced draft, and only then', async () => {
    const draft = await createDraft(publishableReading({ title: 'Disposable' }));
    const response = await api(`/api/admin/materials/reading/${draft.id}`, { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect(await adminStore.getMaterial('reading', draft.id)).toBe(null);
  });
});
