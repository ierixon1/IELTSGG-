import './env';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';
import type { AdminMaterial, AdminReadingMaterial } from '../src/types/admin';
import type { StoredGenerationReview } from '../src/schemas/material';

/**
 * H4: a published material must never hold content its publish gate has not passed.
 *
 * Learners read published rows directly, and a save used to keep whatever status
 * the row had. So an admin could publish a material and then save it with no
 * questions and no theme: the save answered 200, the material stayed published,
 * and learners were served a test with nothing in it (Phase 17, Probe 1 D1).
 *
 * The rule now: a save that changes a published material in any way writes it
 * back as a draft in the same write, and it reaches learners again only through
 * Check and Publish. Saves name the revision they were opened at, so one admin
 * cannot overwrite another's change, or a publish, without seeing it.
 *
 * After every write these tests read storage directly and require that every
 * material stored as published passes its gate — the invariant itself, not a
 * proxy for it.
 */
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-published-protection-'));
const originalCwd = process.cwd();
process.chdir(tempRoot);

const ADMIN_USER = 'protection_admin';
const ADMIN_PASSWORD = 'Str0ng-Passw0rd-For-Protection';
process.env.SEED_DEFAULT_ACCOUNTS = 'true';
process.env.ADMIN_USER = ADMIN_USER;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;

const express = (await import('express')).default;
const { adminRouter } = await import('../src/routes/adminRoutes');
const { learnerContentRouter } = await import('../src/routes/learnerContentRoutes');
const { authRouter } = await import('../src/routes/authRoutes');
const { authenticateRequest } = await import('../src/middleware/authMiddleware');
const { adminStore, MaterialConflictError, MaterialStateError } = await import('../src/services/adminStore');
const { assetStore } = await import('../src/services/assetStore');
const { publishBlockers } = await import('../src/services/publishGate');
const { describeQuestionIssue } = await import('../src/schemas/question');

let server: Server;
let origin = '';
let adminCookie = '';
let learnerCookie = '';

const request = (cookie: () => string) => (url: string, init: RequestInit = {}) =>
  fetch(`${origin}${url}`, { ...init, headers: { 'Content-Type': 'application/json', cookie: cookie(), ...(init.headers || {}) } });
const api = request(() => adminCookie);
const learner = request(() => learnerCookie);

/** A Reading material that passes every publish precondition. */
function readingMaterial() {
  return {
    title: 'Protected Reading',
    section: 'reading' as const,
    module: 'academic' as const,
    theme: 'Navigation',
    targetBand: '7.5',
    content: {
      passage: {
        passageNumber: 1,
        title: 'Dead reckoning',
        text: 'Animals navigate without landmarks.',
        questions: [
          { id: 'pr-1', questionNumber: 1, type: 'true_false_not_given', prompt: 'Path integration accumulates error.', correctAnswer: 'TRUE' },
          { id: 'pr-2', questionNumber: 2, type: 'sentence_completion', prompt: 'The error grows with every ___.', correctAnswer: 'step' },
        ],
      },
    } as Record<string, unknown>,
  };
}

async function stored(id: string): Promise<AdminReadingMaterial> {
  const material = await adminStore.getMaterial('reading', id);
  if (!material || material.section !== 'reading') throw new Error(`expected reading material ${id}`);
  return material;
}

async function createPublished(): Promise<AdminReadingMaterial> {
  const created = await api('/api/admin/materials', { method: 'POST', body: JSON.stringify(readingMaterial()) });
  expect(created.status).toBe(200);
  const { item } = await created.json();
  const published = await api(`/api/admin/materials/reading/${item.id}/publish`, { method: 'POST' });
  expect(published.status).toBe(200);
  return stored(item.id);
}

const save = (id: string, body: object, updatedAt?: string) =>
  api(`/api/admin/materials/reading/${id}`, { method: 'PUT', body: JSON.stringify({ ...body, id, ...(updatedAt === undefined ? {} : { updatedAt }) }) });
const publish = (id: string) => api(`/api/admin/materials/reading/${id}/publish`, { method: 'POST' });

async function learnerView(id: string) {
  const catalog = await (await learner('/api/learner/materials/reading')).json();
  const listed = (catalog.items as Array<{ id: string }>).some((item) => item.id === id);
  const opened = await learner(`/api/learner/materials/reading/${id}`);
  return { listed, status: opened.status, text: await opened.text() };
}

/** The invariant, read from storage: every material stored as published passes its publish gate. */
async function expectEveryPublishedMaterialPasses(label: string) {
  const assets = new Set((await assetStore.list()).map((asset) => asset.id));
  for (const section of ['reading', 'listening', 'writing', 'speaking'] as const) {
    for (const { material, needsReview } of await adminStore.reviewMaterials(section, 'published')) {
      const blockers = publishBlockers(material, { assetExists: (id) => assets.has(id), needsReview: needsReview.map(describeQuestionIssue) });
      expect([label, material.id, blockers.map((blocker) => blocker.code)]).toEqual([label, material.id, []]);
    }
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

before(async () => {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/auth', authRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api', authenticateRequest, learnerContentRouter);
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
    body: JSON.stringify({ username: 'protection_learner', email: 'protection@example.com', password: 'Str0ng-Passw0rd-For-Learner', name: 'Protection Learner' }),
  });
  learnerCookie = (registered.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  expect(learnerCookie).toContain('prep_auth=');
});

after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  process.chdir(originalCwd);
  removeTempRoot(tempRoot);
});

describe('H4: a published material cannot be edited into something its gate refuses', () => {
  it('the Phase 17 reproduction — publish, then save with no questions and no theme — withdraws the material instead of leaving it published', async () => {
    const published = await createPublished();
    expect((await learnerView(published.id)).status).toBe(200);

    const broken = readingMaterial();
    broken.theme = '';
    broken.content = { passage: { ...(broken.content.passage as Record<string, unknown>), questions: [] } };
    const response = await save(published.id, broken, published.updatedAt);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect([body.item.status, body.unpublished, body.publishedBundles]).toEqual(['draft', true, []]);

    expect((await stored(published.id)).status).toBe('draft');
    await expectEveryPublishedMaterialPasses('after the broken save');
    const seen = await learnerView(published.id);
    expect([seen.listed, seen.status]).toEqual([false, 404]);

    const check = await (await api(`/api/admin/materials/reading/${published.id}/publish-check`)).json();
    expect(check.blockers.map((blocker: { code: string }) => blocker.code)).toEqual(['classification_incomplete', 'no_questions']);
    expect((await publish(published.id)).status).toBe(409);
    expect((await stored(published.id)).status).toBe('draft');
    await expectEveryPublishedMaterialPasses('after the refused publish');
  });

  it('withdraws a published material even for an edit the gate would pass, and republishes it only when asked', async () => {
    const published = await createPublished();
    const edited = readingMaterial();
    (edited.content.passage as { questions: Array<{ prompt: string }> }).questions[0].prompt = 'Path integration accumulates error with every step taken.';
    const response = await save(published.id, edited, published.updatedAt);
    expect(response.status).toBe(200);
    expect((await response.json()).item.status).toBe('draft');

    // Valid or not, the new version has not been through the gate, so no learner gets it.
    const withdrawn = await learnerView(published.id);
    expect([withdrawn.listed, withdrawn.status]).toEqual([false, 404]);
    await expectEveryPublishedMaterialPasses('after the valid edit');

    const check = await (await api(`/api/admin/materials/reading/${published.id}/publish-check`)).json();
    expect(check.publishable).toBe(true);
    expect((await publish(published.id)).status).toBe(200);
    const republished = await learnerView(published.id);
    expect([republished.listed, republished.status, republished.text.includes('with every step taken')]).toEqual([true, 200, true]);
    await expectEveryPublishedMaterialPasses('after republishing');
  });

  it('withdraws it for question, classification and asset changes alike', async () => {
    const asset = await assetStore.create({
      originalName: 'passage-figure.png',
      content: Buffer.from('\x89PNG\r\n\x1a\nfigure'),
      mimeType: 'image/png',
      kind: 'image',
      createdBy: 'test',
      sourceType: 'upload',
    });
    const published = await createPublished();
    type Change = [string, (material: AdminReadingMaterial) => void];
    const changes: Change[] = [
      ['a question answer', (m) => { m.content.passage.questions[1].correctAnswer = 'stride'; }],
      ['a question added', (m) => { m.content.passage.questions.push({ ...m.content.passage.questions[0], id: 'pr-3', questionNumber: 3, prompt: 'A third claim.' }); }],
      ['a question removed', (m) => { m.content.passage.questions.pop(); }],
      ['the title', (m) => { m.title = 'Protected Reading, renamed'; }],
      ['the theme', (m) => { m.theme = 'Animal behaviour'; }],
      ['the target band', (m) => { m.targetBand = '8.0'; }],
      ['the module', (m) => { m.module = 'general'; }],
      ['an asset reference', (m) => { m.content.assetIds = [asset.id]; }],
    ];
    for (const [label, change] of changes) {
      const current = structuredClone(await stored(published.id));
      expect([label, current.status]).toEqual([label, 'published']);
      change(current);
      const response = await save(published.id, current, current.updatedAt);
      expect([label, response.status]).toEqual([label, 200]);
      const body = await response.json();
      expect([label, body.item.status, body.unpublished]).toEqual([label, 'draft', true]);
      expect([label, (await learnerView(published.id)).status]).toEqual([label, 404]);
      await expectEveryPublishedMaterialPasses(`after changing ${label}`);
      expect([label, (await publish(published.id)).status]).toEqual([label, 200]);
    }

    // An asset that is not in the store: withdrawn by the save, and refused at publish until it is removed.
    const current = structuredClone(await stored(published.id));
    current.content.assetIds = ['ast_notInTheStore01'];
    expect((await (await save(published.id, current, current.updatedAt)).json()).item.status).toBe('draft');
    const refused = await publish(published.id);
    expect(refused.status).toBe(409);
    expect((await refused.json()).blockers.map((blocker: { code: string }) => blocker.code)).toContain('asset_missing');
    await expectEveryPublishedMaterialPasses('after referencing a missing asset');
    const fixed = structuredClone(await stored(published.id));
    fixed.content.assetIds = [];
    expect((await save(published.id, fixed, fixed.updatedAt)).status).toBe(200);
    expect((await publish(published.id)).status).toBe(200);
    await expectEveryPublishedMaterialPasses('after removing the missing asset');
  });

  it('leaves a published material published when a save changes nothing, and writes nothing', async () => {
    const published = await createPublished();
    // Exactly what the editor sends for a material it did not change.
    const response = await save(published.id, readingMaterial(), published.updatedAt);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect([body.item.status, body.unchanged, body.unpublished]).toEqual(['published', true, undefined]);
    const after = await stored(published.id);
    expect([after.status, after.updatedAt]).toEqual(['published', published.updatedAt]);
    expect((await learnerView(published.id)).status).toBe(200);
  });
});

describe('two admins, a publish and a save cannot overwrite each other unseen', () => {
  it('refuses a save that does not say which revision it was opened at', async () => {
    const published = await createPublished();
    const edited = readingMaterial();
    edited.title = 'Saved without a revision';
    const response = await save(published.id, edited);
    expect(response.status).toBe(428);
    expect((await response.json()).code).toBe('material_revision_required');
    const after = await stored(published.id);
    expect([after.title, after.status, after.updatedAt]).toEqual(['Protected Reading', 'published', published.updatedAt]);
  });

  it('refuses the second of two edits made from the same revision, and keeps the first', async () => {
    const published = await createPublished();
    const first = readingMaterial();
    first.title = 'First admin';
    const second = readingMaterial();
    second.title = 'Second admin';

    expect((await save(published.id, first, published.updatedAt)).status).toBe(200);
    const stale = await save(published.id, second, published.updatedAt);
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe('material_stale');
    expect((await stored(published.id)).title).toBe('First admin');

    // Reloaded, the second admin's edit goes through.
    const reloaded = await stored(published.id);
    expect((await save(published.id, second, reloaded.updatedAt)).status).toBe(200);
    expect((await stored(published.id)).title).toBe('Second admin');
    await expectEveryPublishedMaterialPasses('after the edits');
  });

  it('lets exactly one of two simultaneous edits from the same revision through', async () => {
    const published = await createPublished();
    const edits = ['Concurrent A', 'Concurrent B'].map((title) => {
      const body = readingMaterial();
      body.title = title;
      return save(published.id, body, published.updatedAt);
    });
    const statuses = (await Promise.all(edits)).map((response) => response.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(['Concurrent A', 'Concurrent B']).toContain((await stored(published.id)).title);
    await expectEveryPublishedMaterialPasses('after the simultaneous edits');
  });

  it('refuses a save from an editor opened before a publish it did not see', async () => {
    const created = await api('/api/admin/materials', { method: 'POST', body: JSON.stringify(readingMaterial()) });
    const draft = (await created.json()).item as AdminMaterial;
    expect((await publish(draft.id)).status).toBe(200);

    const edited = readingMaterial();
    edited.content = { passage: { ...(edited.content.passage as Record<string, unknown>), questions: [] } };
    const response = await save(draft.id, edited, draft.updatedAt);
    expect(response.status).toBe(409);
    const after = await stored(draft.id);
    expect([after.status, after.content.passage.questions.length]).toEqual(['published', 2]);
    await expectEveryPublishedMaterialPasses('after the refused save');
  });

  it('does not publish when a save lands while the gate is reading the material', async () => {
    const asset = await assetStore.create({
      originalName: 'race.png',
      content: Buffer.from('\x89PNG\r\n\x1a\nrace'),
      mimeType: 'image/png',
      kind: 'image',
      createdBy: 'test',
      sourceType: 'upload',
    });
    const body = readingMaterial();
    body.content = { ...body.content, assetIds: [asset.id] };
    const created = await api('/api/admin/materials', { method: 'POST', body: JSON.stringify(body) });
    const draft = (await created.json()).item as AdminMaterial;

    const emptied = readingMaterial();
    emptied.content = { assetIds: [asset.id], passage: { ...(emptied.content.passage as Record<string, unknown>), questions: [] } };
    let raced = false;
    const outcome = await rejection(
      adminStore.setMaterialStatus('reading', draft.id, 'published', {
        // The gate asks about the asset part-way through; the local store's save
        // runs to completion synchronously, so this lands between gate and write.
        assetExists: (id) => {
          if (!raced) {
            raced = true;
            void adminStore.saveMaterial('reading', { ...emptied, id: draft.id });
          }
          return id === asset.id;
        },
      }),
    );
    expect(raced).toBe(true);
    expect(outcome instanceof MaterialConflictError).toBe(true);
    expect((outcome as InstanceType<typeof MaterialConflictError>).code).toBe('material_changed_during_publish');
    const after = await stored(draft.id);
    expect([after.status, after.content.passage.questions.length]).toEqual(['draft', 0]);
    await expectEveryPublishedMaterialPasses('after the raced publish');
  });

  it('refuses a reviewer decision and a delete on a published material inside the write', async () => {
    const published = await createPublished();
    const review: StoredGenerationReview = {
      reviewId: 'rev-late',
      generatedQuestionId: 'pr-1',
      decision: 'rejected',
      note: 'Arrived after the material was published.',
      reviewer: { id: 'usr_reviewer', username: 'reviewer', displayName: 'Reviewer' },
      reviewedAt: new Date().toISOString(),
      questionHash: 'a'.repeat(64),
      machineVerdict: { status: 'needs_review', groundingStatus: 'needs_review', qualityStatus: 'needs_review', reasonCodes: [] },
    };
    const refusedReview = await rejection(adminStore.appendGenerationReview('reading', published.id, review));
    expect([refusedReview instanceof MaterialStateError, (refusedReview as InstanceType<typeof MaterialStateError>).code]).toEqual([true, 'not_draft']);

    const refusedDelete = await rejection(adminStore.deleteMaterial('reading', published.id));
    expect([refusedDelete instanceof MaterialStateError, (refusedDelete as InstanceType<typeof MaterialStateError>).code]).toEqual([true, 'material_published']);
    expect((await api(`/api/admin/materials/reading/${published.id}`, { method: 'DELETE' })).status).toBe(409);

    const after = await stored(published.id);
    expect([after.status, after.updatedAt, after.content.generationReviews ?? []]).toEqual(['published', published.updatedAt, []]);
    await expectEveryPublishedMaterialPasses('after the refused review and delete');
  });
});
