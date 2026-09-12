import './env';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';
import type { ExamSitting } from '../src/types/bundle';
import {
  CUSTOM_TIMING,
  FULL_SLOTS,
  listeningAnswer,
  listeningPayload,
  readingPayload,
  speakingPayload,
  writingPayload,
} from './bundleFixtures';

/**
 * Full CDI bundles end to end, over the real routes and stores:
 *
 *   published materials → pinned bundle draft → gate → publish → learner list
 *   → exact resolution → exam plan
 *
 * (Sitting the exam and storing its attempt: tests/examSession.test.ts.)
 *
 * and the ways a published bundle goes bad afterwards — a component edited,
 * withdrawn, its audio lost, its material gone — each of which must reach the
 * learner as a configuration error, never as substituted content.
 */
const originalCwd = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-bundle-exam-'));
process.chdir(tempRoot);

const ADMIN_USER = 'bundle_admin';
const ADMIN_PASSWORD = 'Str0ng-Passw0rd-For-Bundles';
process.env.SEED_DEFAULT_ACCOUNTS = 'true';
process.env.ADMIN_USER = ADMIN_USER;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;

const express = (await import('express')).default;
const { adminRouter } = await import('../src/routes/adminRoutes');
const { learnerContentRouter } = await import('../src/routes/learnerContentRoutes');
const { userDataRouter } = await import('../src/routes/userDataRoutes');
const { authRouter } = await import('../src/routes/authRoutes');
const { authenticateRequest } = await import('../src/middleware/authMiddleware');
const { assetStore } = await import('../src/services/assetStore');
const { bundleStore } = await import('../src/services/bundleStore');
const { buildExamPlan } = await import('../src/services/examRun');
const { openSitting } = await import('../src/services/bundleService');
const { sittingToAdaptedTest } = await import('../src/services/sittingAdapters');

let server: Server;
let origin = '';
let adminCookie = '';
let learnerCookie = '';

const call = (cookie: string) => (url: string, init: RequestInit = {}) =>
  fetch(`${origin}${url}`, { ...init, headers: { 'Content-Type': 'application/json', cookie, ...(init.headers || {}) } });
const admin = (url: string, init: RequestInit = {}) => call(adminCookie)(url, init);
const learner = (url: string, init: RequestInit = {}) => call(learnerCookie)(url, init);
const anonymous = (url: string) => fetch(`${origin}${url}`);

const ids: Record<string, string> = {};
const audio: Record<number, string> = {};
let sourceDocumentId = '';
let draftReadingId = '';
let bundleId = '';

const slotKey = (section: string, part: number) => `${section}-${part}`;

async function createPublished(payload: object): Promise<string> {
  const saved = await admin('/api/admin/materials', { method: 'POST', body: JSON.stringify(payload) });
  const body = await saved.json();
  if (saved.status !== 200) throw new Error(`fixture did not save: ${JSON.stringify(body)}`);
  const published = await admin(`/api/admin/materials/${body.item.section}/${body.item.id}/publish`, { method: 'POST' });
  if (published.status !== 200) throw new Error(`fixture did not publish: ${JSON.stringify(await published.json())}`);
  return body.item.id as string;
}

async function currentPins(overrides: Record<string, string> = {}) {
  const { candidates } = await (await admin('/api/admin/bundles/candidates')).json();
  const hashes = new Map((candidates as Array<{ id: string; contentHash: string }>).map((entry) => [entry.id, entry.contentHash]));
  return FULL_SLOTS.map(({ section, part }) => {
    const materialId = overrides[slotKey(section, part)] ?? ids[slotKey(section, part)];
    return { section, part, materialId, contentHash: hashes.get(materialId) ?? 'f'.repeat(64) };
  });
}

const draftBody = (components: unknown[], over: Record<string, unknown> = {}) =>
  JSON.stringify({ title: 'Integrity CDI', module: 'academic', description: 'A full test.', components, timing: CUSTOM_TIMING, ...over });

before(async () => {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/auth', authRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api', authenticateRequest);
  app.use('/api', userDataRouter);
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
    body: JSON.stringify({ username: 'bundle_learner', email: 'bundle-learner@example.com', password: 'Str0ng-Passw0rd-For-Learner', name: 'Bundle Learner' }),
  });
  learnerCookie = (registered.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

  for (const part of [1, 2, 3, 4]) {
    const asset = await assetStore.create({
      originalName: `part-${part}.mp3`,
      content: Buffer.from(`ID3 recording of part ${part}`),
      mimeType: 'audio/mpeg',
      kind: 'audio',
      createdBy: 'test',
      sourceType: 'upload',
    });
    audio[part] = asset.id;
    ids[slotKey('listening', part)] = await createPublished(listeningPayload(part, asset.id));
  }
  for (const part of [1, 2, 3]) ids[slotKey('reading', part)] = await createPublished(readingPayload(part));
  ids[slotKey('writing', 1)] = await createPublished(writingPayload());
  ids[slotKey('speaking', 1)] = await createPublished(speakingPayload());

  // An imported material whose untouched original is stored as an asset.
  const original = await assetStore.create({
    originalName: 'original.html',
    content: Buffer.from('<html><body>The original imported document.</body></html>'),
    mimeType: 'text/html',
    kind: 'html',
    createdBy: 'test',
    sourceType: 'upload',
  });
  sourceDocumentId = original.id;
  const imported = readingPayload(1);
  await createPublished({ ...imported, title: 'Imported Reading', content: { ...imported.content, sourceAssetId: original.id } });

  const draft = await admin('/api/admin/materials', { method: 'POST', body: JSON.stringify({ ...readingPayload(2), title: 'Draft Reading' }) });
  draftReadingId = (await draft.json()).item.id;
});

after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  process.chdir(originalCwd);
  removeTempRoot(tempRoot);
});

const codes = (blockers: Array<{ code: string }>) => blockers.map((blocker) => blocker.code);

/* -------------------------------------------------------------------------- */

describe('a bundle is assembled from published materials and published through the gate', () => {
  it('offers only published materials for pinning, each with the fingerprint a pin takes', async () => {
    const response = await admin('/api/admin/bundles/candidates');
    expect(response.status).toBe(200);
    const { candidates } = await response.json();
    const offered = candidates.map((entry: { id: string }) => entry.id);
    for (const id of Object.values(ids)) expect(offered).toContain(id);
    expect(offered.includes(draftReadingId)).toBe(false);
    for (const entry of candidates) expect(/^[a-f0-9]{64}$/.test(entry.contentHash)).toBe(true);
    const listening1 = candidates.find((entry: { id: string }) => entry.id === ids['listening-1']);
    expect(listening1.audio).toEqual({ assetId: audio[1], exists: true, kind: 'audio' });
    expect(listening1.questionCount).toBe(10);
  });

  it('saves a draft, and a status in the request does not publish it', async () => {
    const response = await admin('/api/admin/bundles', { method: 'POST', body: draftBody(await currentPins(), { status: 'published' }) });
    expect(response.status).toBe(201);
    const body = await response.json();
    bundleId = body.bundle.id;
    expect(body.bundle.status).toBe('draft');
    expect(body.bundle.publishedAt).toBe(undefined);
    expect(body.components.every((entry: { pinnedIsCurrent: boolean }) => entry.pinnedIsCurrent)).toBe(true);
  });

  it('keeps a draft away from learners', async () => {
    const list = await (await learner('/api/learner/bundles')).json();
    expect(list.bundles.some((bundle: { id: string }) => bundle.id === bundleId)).toBe(false);
    const opened = await learner(`/api/learner/bundles/${bundleId}`);
    expect(opened.status).toBe(409);
    expect((await opened.json()).code).toBe('bundle_unpublished');
  });

  it('refuses to publish an incomplete bundle, and says why', async () => {
    const pins = (await currentPins()).filter((pin) => pin.section === 'reading');
    const created = await (await admin('/api/admin/bundles', { method: 'POST', body: draftBody(pins, { title: 'Reading Only' }) })).json();
    const published = await admin(`/api/admin/bundles/${created.bundle.id}/publish`, { method: 'POST' });
    expect(published.status).toBe(409);
    const blockerCodes = codes((await published.json()).blockers);
    expect(blockerCodes).toContain('listening_missing');
    expect(blockerCodes).toContain('writing_missing');
    expect(blockerCodes).toContain('speaking_missing');
    expect((await (await admin(`/api/admin/bundles/${created.bundle.id}`)).json()).bundle.status).toBe('draft');

    // Never published, so it can be deleted outright.
    expect((await admin(`/api/admin/bundles/${created.bundle.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await admin(`/api/admin/bundles/${created.bundle.id}`)).status).toBe(404);
  });

  it('publishes a complete bundle once its check passes', async () => {
    const check = await (await admin(`/api/admin/bundles/${bundleId}/check`)).json();
    expect(check.blockers).toEqual([]);
    expect(check.publishable).toBe(true);

    const published = await admin(`/api/admin/bundles/${bundleId}/publish`, { method: 'POST' });
    expect(published.status).toBe(200);
    const body = await published.json();
    expect(body.bundle.status).toBe('published');
    expect(typeof body.bundle.publishedAt).toBe('string');
  });

  it('does not let a published bundle be edited or deleted', async () => {
    const edited = await admin(`/api/admin/bundles/${bundleId}`, { method: 'PUT', body: draftBody(await currentPins(), { title: 'Renamed' }) });
    expect(edited.status).toBe(409);
    expect((await edited.json()).code).toBe('bundle_not_draft');
    const deleted = await admin(`/api/admin/bundles/${bundleId}`, { method: 'DELETE' });
    expect(deleted.status).toBe(409);
    expect((await deleted.json()).code).toBe('bundle_published');
  });

  it('withdraws, retires and restores it, and never deletes it once published', async () => {
    expect((await (await admin(`/api/admin/bundles/${bundleId}/unpublish`, { method: 'POST' })).json()).bundle.status).toBe('draft');
    expect((await (await learner(`/api/learner/bundles/${bundleId}`)).json()).code).toBe('bundle_unpublished');

    expect((await (await admin(`/api/admin/bundles/${bundleId}/archive`, { method: 'POST' })).json()).bundle.status).toBe('archived');
    const retired = await learner(`/api/learner/bundles/${bundleId}`);
    expect(retired.status).toBe(410);
    expect((await retired.json()).code).toBe('bundle_archived');

    const deleted = await admin(`/api/admin/bundles/${bundleId}`, { method: 'DELETE' });
    expect(deleted.status).toBe(409);
    expect((await deleted.json()).code).toBe('bundle_was_published');

    expect((await admin(`/api/admin/bundles/${bundleId}/publish`, { method: 'POST' })).status).toBe(409);
    expect((await (await admin(`/api/admin/bundles/${bundleId}/restore`, { method: 'POST' })).json()).bundle.status).toBe('draft');
    expect((await admin(`/api/admin/bundles/${bundleId}/publish`, { method: 'POST' })).status).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */

let sitting: ExamSitting;

describe('a learner opens exactly what was published', () => {
  it('lists only published bundles, each saying whether it can be opened', async () => {
    const { bundles } = await (await learner('/api/learner/bundles')).json();
    expect(bundles.map((bundle: { id: string }) => bundle.id)).toEqual([bundleId]);
    expect(bundles[0].available).toBe(true);
    expect(bundles[0].parts).toEqual({ listening: 4, reading: 3, writing: 1, speaking: 1 });
    expect(bundles[0].totalMinutes).toBe(7 + 11 + 13 + 5);
  });

  it('resolves the bundle to the exact components it pinned, in exam order', async () => {
    const outcome = await openSitting(bundleId);
    if (!outcome.ok) throw new Error(`the bundle did not resolve: ${outcome.code}`);
    sitting = outcome.sitting;
    const text = JSON.stringify(sitting);

    expect(sitting.components.map((entry) => [entry.section, entry.part, entry.materialId])).toEqual(
      FULL_SLOTS.map(({ section, part }) => [section, part, ids[slotKey(section, part)]]),
    );
    const pinned = (await (await admin(`/api/admin/bundles/${bundleId}`)).json()).bundle.components;
    for (const entry of sitting.components) {
      const pin = pinned.find((ref: { materialId: string }) => ref.materialId === entry.materialId);
      expect(entry.contentHash).toBe(pin.contentHash);
      expect(entry.material.id).toBe(entry.materialId);
    }
    expect(sitting.bundle.timing).toEqual(CUSTOM_TIMING);

    const listening1 = sitting.components[0].material;
    expect(listening1.section === 'listening' && listening1.content.audioUrl).toBe(`/api/assets/${audio[1]}`);
    // What the resolved sitting must not carry, even on the server.
    for (const withheld of ['provenance', 'importRecord', 'generationRecord', 'sourceAssetId', 'audioTranscript', '"transcript"', 'needsReview', 'customGradingCriteria']) {
      expect(text.includes(withheld)).toBe(false);
    }
    // The server marks from this, so its questions keep their keys; no learner response is this object.
    expect(text.includes(listeningAnswer(1, 1))).toBe(true);
  });

  it('does not send that bundle for practice: a published bundle is exam content', async () => {
    const response = await learner(`/api/learner/bundles/${bundleId}`);
    expect(response.status).toBe(403);
    const text = await response.text();
    expect(JSON.parse(text).code).toBe('exam_content');
    for (const withheld of ['"test"', 'questions', 'correctAnswer', 'explanation', 'transcript', audio[1]]) {
      expect(text.includes(withheld)).toBe(false);
    }
    for (const part of [1, 2, 3, 4]) for (const index of [1, 2] as const) expect(text.includes(listeningAnswer(part, index))).toBe(false);
  });

  it('plans a full exam from it, with the configured minutes', () => {
    const plan = buildExamPlan(sitting);
    expect(plan.sections.map((section) => [section.section, section.durationSeconds])).toEqual([
      ['listening', 7 * 60],
      ['reading', 11 * 60],
      ['writing', 13 * 60],
      ['speaking', 5 * 60],
    ]);
    expect(plan.sections[0].questions).toHaveLength(40);
    expect(plan.sections[1].questions).toHaveLength(40);
  });

  it('answers a bundle that does not exist with a reason', async () => {
    const response = await learner('/api/learner/bundles/cdi-bundle-missing');
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe('bundle_not_found');
  });
});

/* -------------------------------------------------------------------------- */

/**
 * The bundle opens again: it passes the gate, is listed as available, and — being
 * published exam content — is refused as practice rather than sent (`practiceEligibility`).
 */
async function expectOpensAgain() {
  const listed = (await (await learner('/api/learner/bundles')).json()).bundles.find((bundle: { id: string }) => bundle.id === bundleId);
  expect(listed.available).toBe(true);
  const practiceView = await learner(`/api/learner/bundles/${bundleId}`);
  expect(practiceView.status).toBe(403);
  expect((await practiceView.json()).code).toBe('exam_content');
}

describe('a published bundle that goes bad is refused, never patched', () => {
  it('refuses it once a component is edited: withdrawn first, then changed, until the new version is republished and pinned on purpose', async () => {
    const readingId = ids['reading-2'];
    const current = (await (await admin(`/api/admin/materials/reading/${readingId}`)).json()).item;
    const edited = readingPayload(2);
    edited.content.passage.questions[0].prompt = 'An edited first question';
    const saved = await admin(`/api/admin/materials/reading/${readingId}`, { method: 'PUT', body: JSON.stringify({ ...edited, updatedAt: current.updatedAt }) });
    expect(saved.status).toBe(200);
    const savedBody = await saved.json();
    // The save withdraws the published material, and says which published exam that affects.
    expect([savedBody.item.status, savedBody.unpublished]).toEqual(['draft', true]);
    expect(savedBody.publishedBundles.map((bundle: { id: string }) => bundle.id)).toEqual([bundleId]);

    const withdrawn = await learner(`/api/learner/bundles/${bundleId}`);
    expect(withdrawn.status).toBe(409);
    const withdrawnBody = await withdrawn.json();
    expect(withdrawnBody.code).toBe('component_unpublished');
    expect(withdrawnBody.components).toBe(undefined);
    const blockers = codes((await (await admin(`/api/admin/bundles/${bundleId}/check`)).json()).blockers);
    expect(blockers).toContain('component_unpublished');
    expect(blockers).toContain('component_changed');

    // Republishing the material does not put its new version into the exam: the pin still names the old one.
    expect((await admin(`/api/admin/materials/reading/${readingId}/publish`, { method: 'POST' })).status).toBe(200);
    const opened = await learner(`/api/learner/bundles/${bundleId}`);
    expect(opened.status).toBe(409);
    const body = await opened.json();
    expect(body.code).toBe('component_changed');
    expect(body.components).toBe(undefined);
    const listed = (await (await learner('/api/learner/bundles')).json()).bundles[0];
    expect(listed.available).toBe(false);
    expect(listed.problem).toBe('component_changed');
    expect(codes((await (await admin(`/api/admin/bundles/${bundleId}/check`)).json()).blockers)).toContain('component_changed');

    await admin(`/api/admin/bundles/${bundleId}/unpublish`, { method: 'POST' });
    expect((await admin(`/api/admin/bundles/${bundleId}`, { method: 'PUT', body: draftBody(await currentPins()) })).status).toBe(200);
    expect((await admin(`/api/admin/bundles/${bundleId}/publish`, { method: 'POST' })).status).toBe(200);

    await expectOpensAgain();
    const reopened = await openSitting(bundleId);
    if (!reopened.ok) throw new Error(`the republished bundle did not resolve: ${reopened.code}`);
    const passage2 = sittingToAdaptedTest(reopened.sitting).test.reading?.passages.find((passage) => passage.passageNumber === 2);
    expect(passage2?.questions[0].prompt).toBe('An edited first question');
  });

  it('refuses it while a component is withdrawn', async () => {
    await admin(`/api/admin/materials/writing/${ids['writing-1']}/unpublish`, { method: 'POST' });
    const opened = await learner(`/api/learner/bundles/${bundleId}`);
    expect(opened.status).toBe(409);
    expect((await opened.json()).code).toBe('component_unpublished');

    await admin(`/api/admin/materials/writing/${ids['writing-1']}/publish`, { method: 'POST' });
    await expectOpensAgain();
  });

  it('refuses it when its Listening audio is gone, instead of reading the script aloud', async () => {
    const file = path.join(tempRoot, 'data', 'admin_content', 'assets.json');
    const before = readFileSync(file, 'utf8');
    writeFileSync(file, JSON.stringify((JSON.parse(before) as Array<{ id: string }>).filter((asset) => asset.id !== audio[3]), null, 2));
    try {
      const opened = await learner(`/api/learner/bundles/${bundleId}`);
      expect(opened.status).toBe(409);
      expect((await opened.json()).code).toBe('asset_unavailable');
    } finally {
      writeFileSync(file, before);
    }
    await expectOpensAgain();
  });

  it('refuses a published bundle that names a material which does not exist', async () => {
    const pins = await currentPins();
    const broken = pins.map((pin) => (pin.section === 'speaking' ? { ...pin, materialId: 'adm-spe-gone' } : pin));
    const stored = await bundleStore.create({ title: 'Broken CDI', module: 'academic', components: broken, timing: CUSTOM_TIMING });
    // Published at the store, past the gate: a bundle can go bad after publication.
    await bundleStore.setStatus(stored.id, 'published');

    const opened = await learner(`/api/learner/bundles/${stored.id}`);
    expect(opened.status).toBe(409);
    expect((await opened.json()).code).toBe('component_missing');
    await bundleStore.setStatus(stored.id, 'archived');
  });
});

/* -------------------------------------------------------------------------- */

describe('what anonymous callers and learners can reach', () => {
  it('gives anonymous callers bundle summaries only', async () => {
    for (const url of ['/api/admin/public/bundles', `/api/admin/public/bundles/${bundleId}`]) {
      const response = await anonymous(url);
      expect(response.status).toBe(200);
      const text = await response.text();
      for (const withheld of ['correctAnswer', 'explanation', 'provenance', 'sourceAssetId', 'transcript', 'materialId', 'contentHash', audio[1]]) {
        expect(text.includes(withheld)).toBe(false);
      }
    }
  });

  it('refuses anonymous access to sittings and files', async () => {
    expect((await anonymous('/api/learner/bundles')).status).toBe(401);
    expect((await anonymous(`/api/learner/bundles/${bundleId}`)).status).toBe(401);
    expect((await anonymous(`/api/assets/${audio[1]}`)).status).toBe(401);
  });

  it('lets a learner play exam audio but never download an original source document', async () => {
    expect((await learner(`/api/assets/${audio[1]}`)).status).toBe(200);
    expect((await learner(`/api/assets/${sourceDocumentId}`)).status).toBe(404);
  });
});
