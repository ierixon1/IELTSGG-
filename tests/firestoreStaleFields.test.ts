import './env';
import { after, before, describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';
import { expectControlledError } from './errorAssertions';
import type { AuthenticatedRequest } from '../src/middleware/authMiddleware';
import type { StoredSource } from '../src/types/source';

/**
 * H5: on Firestore, a save that no longer carries a field used to leave that field
 * stored, and learners kept being served it.
 *
 * Material saves wrote the canonical document with `merge: true`, and Firestore
 * merges nested maps field by field: passage markup an admin removed stayed in
 * `content.passage.htmlContent`, and the learner adapters prefer it over the text
 * (Phase 17, Probe 3). Sources merged the same way, and the profile merged its
 * nested map. The local store replaces the row, so the two backends disagreed.
 *
 * Each test here makes a field exist, saves a document without it through the
 * production route or store, and requires that Firestore no longer holds it,
 * that the stored document is exactly the one the save produced, and — where a
 * learner sees the entity — that the learner no longer gets it.
 *
 * The Firestore is `FakeFirestore`, whose merge, replace and `mergeFields`
 * semantics are pinned in `fakeFirestore.test.ts`. This is not a run against a
 * real Firestore project (H10).
 */
process.env.STORAGE_BACKEND = 'gcs_firestore';
process.env.GCS_BUCKET_NAME = 'not-used-uploads-are-stubbed';
const originalCwd = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-firestore-stale-fields-'));
process.chdir(tempRoot);

const { FakeFirestore } = await import('./fakeFirestore');
const fake = new FakeFirestore({ concurrency: 'optimistic' });
const { setFirestoreDbForTesting } = await import('../src/services/firebaseAdmin');
setFirestoreDbForTesting(fake as unknown as Firestore);

const express = (await import('express')).default;
const { guardAsyncHandlers } = await import('../src/http/asyncHandlers');
const { apiErrorBoundary } = await import('../src/http/errorBoundary');
const { adminRouter } = await import('../src/routes/adminRoutes');
const { learnerContentRouter } = await import('../src/routes/learnerContentRoutes');
const { userDataRouter } = await import('../src/routes/userDataRoutes');
const { storageProvider, dataStore } = await import('../src/services/storage');
const { assetStore } = await import('../src/services/assetStore');
const { adminStore } = await import('../src/services/adminStore');
const { sourceStore } = await import('../src/services/sourceStore');

// Bytes would go to Cloud Storage; kept in memory so learner audio can still be served.
const bytes = new Map<string, Buffer>();
storageProvider.uploadFile = async (storagePath, content) => {
  bytes.set(storagePath, typeof content === 'string' ? Buffer.from(content) : Buffer.from(content));
  return { storagePath };
};
storageProvider.downloadFile = async (storagePath) => {
  const stored = bytes.get(storagePath);
  if (!stored) throw new Error(`No bytes for ${storagePath}.`);
  return stored;
};

const LEARNER = 'usr_staleFieldsLearner';
const ADMIN_TOKEN = 'prep_stale_fields_admin_session';
let server: Server;
let origin = '';

before(async () => {
  const now = Date.now();
  await fake.collection('auth_users').doc('usr_stale_admin').set({
    id: 'usr_stale_admin',
    email: 'stale-admin@example.com',
    username: 'stale_admin',
    name: 'Stale Admin',
    passwordHash: 'unused',
    role: 'admin',
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    failedLoginAttempts: 0,
    sessionVersion: 0,
  });
  await fake
    .collection('auth_sessions')
    .doc(createHash('sha256').update(ADMIN_TOKEN).digest('hex'))
    .set({ userId: 'usr_stale_admin', username: 'stale_admin', email: 'stale-admin@example.com', name: 'Stale Admin', role: 'admin', createdAt: now, expiresAt: now + 60 * 60 * 1000, sessionVersion: 0 });

  const app = guardAsyncHandlers(express());
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/admin', adminRouter);
  // Learner authentication is not under test: every learner request is the one learner.
  app.use('/api', (req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).userId = LEARNER;
    next();
  });
  app.use('/api', userDataRouter);
  app.use('/api', learnerContentRouter);
  app.use('/api', apiErrorBoundary);
  server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  process.chdir(originalCwd);
  removeTempRoot(tempRoot);
});

interface Reply {
  status: number;
  type: string;
  text: string;
  json: Record<string, unknown>;
}

async function call(url: string, init: { method?: string; body?: unknown; admin?: boolean } = {}): Promise<Reply> {
  const response = await fetch(`${origin}${url}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json', ...(init.admin ? { cookie: `prep_admin_auth=${ADMIN_TOKEN}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Not every answer is JSON; the status says what happened.
  }
  return { status: response.status, type: response.headers.get('content-type') ?? '', text, json };
}

const storedMaterial = (section: string, id: string) => fake.documents.get(`admin_content/${section}/items/${id}`);
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

/** Every field path in a document, arrays by index: `content.passage.questions.0.explanation`. */
function fieldPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => fieldPaths(entry, `${prefix}${index}.`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) => [`${prefix}${key}`, ...fieldPaths(entry, `${prefix}${key}.`)]);
  }
  return [];
}

function expectAbsent(label: string, document: unknown, removed: string[]) {
  const paths = fieldPaths(document);
  for (const field of removed) expect([label, field, paths.includes(field)]).toEqual([label, field, false]);
}

async function createMaterial(body: object): Promise<{ id: string; updatedAt: string }> {
  const created = await call('/api/admin/materials', { body, admin: true });
  expect([created.status, created.status === 200 ? '' : created.text]).toEqual([200, '']);
  return created.json.item as { id: string; updatedAt: string };
}

async function publish(section: string, id: string): Promise<{ id: string; updatedAt: string }> {
  const published = await call(`/api/admin/materials/${section}/${id}/publish`, { body: {}, admin: true });
  expect([published.status, published.status === 200 ? '' : published.text]).toEqual([200, '']);
  return published.json.item as { id: string; updatedAt: string };
}

const storeAsset = (name: string, content: string, kind: 'html' | 'audio', mimeType: string) =>
  assetStore.create({ originalName: name, content: Buffer.from(content), mimeType, kind, createdBy: 'test', sourceType: 'upload' });

function readingMaterial(old: { sourceAssetId: string } | null, extra: { assetIds?: string[] } = {}) {
  return {
    title: 'Stale Field Reading',
    section: 'reading',
    module: 'academic',
    theme: 'Navigation',
    targetBand: '7.5',
    content: {
      ...(old ? { sourceAssetId: old.sourceAssetId, assetIds: [old.sourceAssetId], htmlContent: '<p>OLD PAGE MARKUP H5-CONTENT-MARKER</p>' } : {}),
      ...extra,
      passage: {
        passageNumber: 1,
        title: 'Dead reckoning',
        text: 'Animals navigate without landmarks.',
        ...(old ? { htmlContent: '<p>OLD PASSAGE MARKUP H5-PASSAGE-MARKER</p>' } : {}),
        questions: [
          { id: 'h5-1', questionNumber: 1, type: 'true_false_not_given', prompt: 'Path integration accumulates error.', correctAnswer: 'TRUE', ...(old ? { explanation: 'OLD EXPLANATION H5-EXPLANATION-MARKER' } : {}) },
          { id: 'h5-2', questionNumber: 2, type: 'sentence_completion', prompt: 'The error grows with every ___.', correctAnswer: 'step' },
        ],
      },
    },
  };
}

const markReading = (materialId: string) =>
  call('/api/learner/practice/mark', { body: { source: { kind: 'material', section: 'reading', materialId }, section: 'reading', answers: { 'h5-1': 'TRUE' } } });

describe('H5: a canonical save that drops a field removes it from Firestore and from what learners get', () => {
  it('Reading: old page and passage markup, the source references and a question explanation are gone', async () => {
    const original = await storeAsset('reading-original.html', '<p>the untouched original</p>', 'html', 'text/html');
    const created = await createMaterial(readingMaterial({ sourceAssetId: original.id }));
    const published = await publish('reading', created.id);

    // Before: every one of the fields is stored, and the learner is served them.
    const before = storedMaterial('reading', created.id);
    for (const field of ['content.htmlContent', 'content.passage.htmlContent', 'content.sourceAssetId', 'content.assetIds', 'content.passage.questions.0.explanation']) {
      expect([field, fieldPaths(before).includes(field)]).toEqual([field, true]);
    }
    expect(fake.documents.get(`admin_assets/${original.id}`)?.state).toBe('active');
    expect((await call(`/api/learner/materials/reading/${created.id}`)).text).toContain('H5-PASSAGE-MARKER');
    expect((await markReading(created.id)).text).toContain('H5-EXPLANATION-MARKER');

    const saved = await call(`/api/admin/materials/reading/${created.id}`, { method: 'PUT', body: { ...readingMaterial(null), updatedAt: published.updatedAt }, admin: true });
    expect([saved.status, saved.json.unpublished]).toEqual([200, true]);

    const after = storedMaterial('reading', created.id);
    expectAbsent('reading', after, ['content.htmlContent', 'content.passage.htmlContent', 'content.sourceAssetId', 'content.assetIds', 'content.passage.questions.0.explanation']);
    expect(JSON.stringify(after).includes('H5-')).toBe(false);
    // What Firestore holds is exactly the canonical document the save produced and returned, and what the store reads back.
    expect(after).toEqual(plain(saved.json.item));
    expect(plain(await adminStore.getMaterial('reading', created.id))).toEqual(after);

    await publish('reading', created.id);
    const learner = await call(`/api/learner/materials/reading/${created.id}`);
    expect([learner.status, learner.text.includes('H5-'), learner.text.includes('Animals navigate without landmarks.')]).toEqual([200, false, true]);
    const marked = await markReading(created.id);
    expect([marked.status, marked.text.includes('H5-EXPLANATION-MARKER')]).toEqual([200, false]);
  });

  it('an imported Listening material: old page and section markup, its source reference and replaced audio are gone; the import record stays', async () => {
    const original = await storeAsset('listening-original.html', '<p>the imported page</p>', 'html', 'text/html');
    const oldAudio = await storeAsset('old-part.mp3', 'ID3 old recording', 'audio', 'audio/mpeg');
    const newAudio = await storeAsset('new-part.mp3', 'ID3 new recording', 'audio', 'audio/mpeg');
    const importRecord = { parserVersion: 'cdi-test-1', sourceAssetId: original.id, diagnostics: [], unsupportedRegions: [], reviewedQuestions: [] };
    const listening = (old: boolean) => ({
      title: 'Imported Listening',
      section: 'listening',
      module: 'academic',
      theme: 'Campus services',
      targetBand: '7.0',
      content: {
        ...(old
          ? { importRecord, sourceAssetId: original.id, htmlContent: '<p>OLD IMPORTED PAGE H5-IMPORT-MARKER</p>', audioAssetId: oldAudio.id, audioUrl: `/api/assets/${oldAudio.id}`, assetIds: [original.id, oldAudio.id] }
          : { audioAssetId: newAudio.id, audioUrl: `/api/assets/${newAudio.id}`, assetIds: [newAudio.id] }),
        transcript: 'The full script.',
        section: {
          sectionNumber: 1,
          title: 'Part 1: an enquiry',
          contextDescription: 'A telephone call.',
          ...(old ? { htmlContent: '<p>OLD SECTION MARKUP H5-SECTION-MARKER</p>' } : {}),
          questions: [
            { id: 'h5-l1', questionNumber: 1, type: 'short_answer', prompt: 'The caller wants a ___.', correctAnswer: 'room' },
            { id: 'h5-l2', questionNumber: 2, type: 'short_answer', prompt: 'The office opens at ___.', correctAnswer: 'nine' },
          ],
        },
      },
    });

    const created = await createMaterial(listening(true));
    const published = await publish('listening', created.id);
    const before = storedMaterial('listening', created.id);
    expect(['content.htmlContent', 'content.section.htmlContent', 'content.sourceAssetId'].map((field) => fieldPaths(before).includes(field))).toEqual([true, true, true]);
    const learnerBefore = await call(`/api/learner/materials/listening/${created.id}`);
    expect([learnerBefore.text.includes('H5-SECTION-MARKER'), learnerBefore.text.includes(oldAudio.id)]).toEqual([true, true]);
    expect((await call(`/api/assets/${oldAudio.id}`)).status).toBe(200);

    const saved = await call(`/api/admin/materials/listening/${created.id}`, { method: 'PUT', body: { ...listening(false), updatedAt: published.updatedAt }, admin: true });
    expect([saved.status, saved.json.unpublished]).toEqual([200, true]);

    const after = storedMaterial('listening', created.id);
    expectAbsent('listening', after, ['content.htmlContent', 'content.section.htmlContent', 'content.sourceAssetId']);
    const text = JSON.stringify(after);
    expect([text.includes('H5-'), text.includes(oldAudio.id), text.includes(newAudio.id)]).toEqual([false, false, true]);
    // Provenance is evidence, carried forward by every save on both backends.
    expect((after?.content as { importRecord?: unknown } | undefined)?.importRecord).toEqual(importRecord);
    expect(after).toEqual(plain(saved.json.item));

    await publish('listening', created.id);
    const learner = await call(`/api/learner/materials/listening/${created.id}`);
    expect([learner.status, learner.text.includes('H5-'), learner.text.includes(oldAudio.id), learner.text.includes(`/api/assets/${newAudio.id}`)]).toEqual([200, false, false, true]);
    // The replaced recording is no longer anything a published material renders, so a learner cannot fetch it.
    expect([(await call(`/api/assets/${oldAudio.id}`)).status, (await call(`/api/assets/${newAudio.id}`)).status]).toEqual([404, 200]);
  });

  it('a source ingested again after a failed run keeps no error from the failed run', async () => {
    const failed: StoredSource = {
      id: 'src-h5-0001',
      title: 'Stale source',
      filename: 'book.txt',
      mimeType: 'text/plain',
      fileKind: 'text',
      sourceAssetId: 'ast_staleSourceBook01',
      status: 'failed',
      error: 'OLD FAILURE H5-SOURCE-MARKER',
      warnings: [{ code: 'empty_page', message: 'Page 3 is empty.' }],
      stats: { characters: 0, chunks: 0, headings: 0 },
      extractorVersion: 'x1',
      chunkerVersion: 'c1',
      createdBy: 'test',
      createdAt: '2026-09-12T08:00:00.000Z',
      updatedAt: '2026-09-12T08:00:00.000Z',
    };
    await sourceStore.save(failed);
    const documentPath = 'admin_content/sources/items/src-h5-0001';
    expect(fieldPaths(fake.documents.get(documentPath)).includes('error')).toBe(true);

    const { error: _error, ...withoutError } = failed;
    const ready: StoredSource = { ...withoutError, status: 'ready', extractedTextAssetId: 'ast_staleSourceText01', warnings: [], stats: { characters: 40, chunks: 2, headings: 1 }, updatedAt: '2026-09-12T08:10:00.000Z' };
    await sourceStore.save(ready);
    expect(fake.documents.get(documentPath)).toEqual(plain(ready));
    const listed = (await sourceStore.list()).find((source) => source.id === 'src-h5-0001');
    expect([listed?.status, listed !== undefined && 'error' in listed, listed?.warningCount]).toEqual(['ready', false, 0]);
  });

  it('a profile update drops an exam date and a name the stored profile held, keeps the other fields of the user document, and /api/data stops returning them', async () => {
    await dataStore.saveUserProfile(LEARNER, { id: LEARNER, targetBand: 7, currentLevel: 6, examDate: '2026-12-01', hoursPerWeek: 8, weakSection: 'reading', isOnboarded: true, name: 'Old Name H5-PROFILE-MARKER' });
    // The user document is merged at its top level on purpose: a field another writer keeps there must survive a profile save.
    await fake.collection('users').doc(LEARNER).set({ keptByAnotherWriter: 'kept' }, { merge: true });
    expect((await call('/api/data')).text).toContain('H5-PROFILE-MARKER');

    const profile = { targetBand: 8, currentLevel: 6.5, hoursPerWeek: 10, weakSection: 'writing', isOnboarded: true };
    expect((await call('/api/data/profile', { method: 'PUT', body: profile })).status).toBe(200);

    const document = fake.documents.get(`users/${LEARNER}`);
    expect(document?.profile).toEqual({ ...profile, id: LEARNER });
    expect(document?.keptByAnotherWriter).toBe('kept');
    const data = await call('/api/data');
    expect([data.status, data.text.includes('H5-PROFILE-MARKER'), data.text.includes('examDate')]).toEqual([200, false, false]);
  });
});

describe('asset references on Firestore', () => {
  it('saving a material that names a file with no record creates no record, so publishing is still refused for the missing file', async () => {
    const missing = 'ast_neverStored000001';
    const created = await createMaterial(readingMaterial(null, { assetIds: [missing] }));
    expect(fake.documents.has(`admin_assets/${missing}`)).toBe(false);
    const refused = await call(`/api/admin/materials/reading/${created.id}/publish`, { body: {}, admin: true });
    expect([refused.status, refused.text.includes('asset_missing')]).toEqual([409, true]);
    expect(fake.documents.has(`admin_assets/${missing}`)).toBe(false);
  });
});

describe('Firestore failing underneath a material write (Part D)', () => {
  it('a save and a publish during an outage answer 503 with nothing internal, change nothing, and succeed once Firestore answers', async () => {
    const created = await createMaterial(readingMaterial(null));
    const before = structuredClone(storedMaterial('reading', created.id));
    const apply = fake.apply.bind(fake);
    let failing = true;
    fake.apply = (operations) => {
      if (failing && operations.some((operation) => operation.path.startsWith('admin_content/'))) {
        throw Object.assign(new Error('14 UNAVAILABLE: No connection established'), { code: 14, details: 'No connection established' });
      }
      apply(operations);
    };
    const edit = () => call(`/api/admin/materials/reading/${created.id}`, { method: 'PUT', body: { ...readingMaterial(null), theme: 'Written during the outage', updatedAt: created.updatedAt }, admin: true });
    try {
      expectControlledError('save during the outage', await edit(), 503, 'storage_unavailable');
      expectControlledError('publish during the outage', await call(`/api/admin/materials/reading/${created.id}/publish`, { body: {}, admin: true }), 503, 'storage_unavailable');
    } finally {
      failing = false;
      fake.apply = apply;
    }
    expect(storedMaterial('reading', created.id)).toEqual(before);

    const recovered = await edit();
    expect([recovered.status, (recovered.json.item as { theme?: string } | undefined)?.theme]).toEqual([200, 'Written during the outage']);
    const published = await call(`/api/admin/materials/reading/${created.id}/publish`, { body: {}, admin: true });
    expect(published.status).toBe(200);
  });
});
