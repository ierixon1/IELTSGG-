import './env';
import { after, describe, it } from 'node:test';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Firestore } from 'firebase-admin/firestore';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';
import type { ChecklistWeek, MockAttempt, PlanTask, UserProfile, VocabCard } from '../src/types';
import type { ExamSessionRecord } from '../src/types/examSession';
import type { SourceChunk, StoredSource } from '../src/types/source';
import type { DataStore } from '../src/services/storage/DataStore';
import type { GeneratedTestRecord } from '../src/services/storage/types';
import { CUSTOM_TIMING } from './bundleFixtures';

/**
 * Local and Firestore storage, compared operation by operation (Phase 23, H5/H10).
 *
 * Every scenario runs the same operations in the same order against the local
 * JSON stores and against the Firestore stores, and requires the same observable
 * result at every step — including a refusal, and including a field that a later
 * write removed. The Firestore side is the production adapter code talking to
 * `FakeFirestore`, whose write semantics are pinned in `fakeFirestore.test.ts`.
 *
 * What legitimately differs between two runs is normalised before comparing:
 * generated ids, clock readings, password and reset-token hashes. Where the two
 * backends store a different shape on purpose, the step says so.
 *
 * Passing proves the adapters agree with the local stores on the in-memory
 * Firestore. It is not a run against a real Firestore project (H10 stays unverified).
 */
process.env.STORAGE_BACKEND = 'local';
process.env.EXPLICIT_DEV_AUTH = 'true';
process.env.GCS_BUCKET_NAME = 'not-used-in-this-suite';
const originalCwd = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-storage-parity-'));
process.chdir(tempRoot);

const { FakeFirestore } = await import('./fakeFirestore');
const fake = new FakeFirestore({ concurrency: 'optimistic' });
const { setFirestoreDbForTesting } = await import('../src/services/firebaseAdmin');
setFirestoreDbForTesting(fake as unknown as Firestore);

const { LocalJsonDataStore } = await import('../src/services/storage/LocalJsonDataStore');
const { FirestoreDataStore } = await import('../src/services/storage/FirestoreDataStore');
const { adminStore } = await import('../src/services/adminStore');
const { bundleStore } = await import('../src/services/bundleStore');
const { sourceStore } = await import('../src/services/sourceStore');
const { assetStore } = await import('../src/services/assetStore');
const { authService } = await import('../src/services/authService');
const { requestRateLimitService } = await import('../src/services/requestRateLimitService');
const { aiRateLimitService } = await import('../src/services/aiRateLimitService');
const { generationLog } = await import('../src/services/bookToTest/generationLog');

after(() => {
  process.chdir(originalCwd);
  removeTempRoot(tempRoot);
});

type Backend = 'local' | 'firestore';
const BACKENDS: Backend[] = ['local', 'firestore'];
const dataStores: Record<Backend, DataStore> = { local: new LocalJsonDataStore(), firestore: new FirestoreDataStore() };

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Replaces what differs between two runs by nature — generated ids, clock readings, bcrypt hashes — with stable labels. */
function stable(value: unknown, ids: Map<string, string>): unknown {
  if (typeof value === 'string') {
    if (ISO_TIME.test(value)) return '<time>';
    if (/^\$2[aby]\$/.test(value)) return '<bcrypt>';
    let out = value;
    for (const [id, label] of ids) out = out.split(id).join(label);
    return out;
  }
  if (typeof value === 'number' && value > 1_000_000_000_000) return '<epoch>';
  if (value instanceof Date) return '<time>';
  if (Array.isArray(value)) return value.map((entry) => stable(entry, ids));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, stable(entry, ids)]));
  return value;
}

/** An operation's result, or the code (or message) it was refused with. */
async function outcome<T>(run: () => Promise<T>): Promise<{ value: T } | { refused: string }> {
  try {
    return { value: await run() };
  } catch (error) {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string') return { refused: error.code };
    return { refused: error instanceof Error ? error.message : String(error) };
  }
}

interface Steps {
  backend: Backend;
  record(step: string, value: unknown): void;
  name(id: string, label: string): void;
}

/** Runs `scenario` on both backends and requires the same result at every step. */
async function expectParity(scenario: (steps: Steps) => Promise<void>) {
  const transcripts: Record<Backend, Array<[string, unknown]>> = { local: [], firestore: [] };
  for (const backend of BACKENDS) {
    const ids = new Map<string, string>();
    process.env.STORAGE_BACKEND = backend === 'firestore' ? 'gcs_firestore' : 'local';
    try {
      await scenario({
        backend,
        record: (step, value) => transcripts[backend].push([step, stable(value, ids)]),
        name: (id, label) => ids.set(id, label),
      });
    } finally {
      process.env.STORAGE_BACKEND = 'local';
    }
  }
  const local = transcripts.local;
  expect(local.length).toBeGreaterThan(0);
  expect(transcripts.firestore.map(([step]) => step)).toEqual(local.map(([step]) => step));
  local.forEach(([step, value], index) => expect([step, transcripts.firestore[index][1]]).toEqual([step, value]));
}

function readingDocument(withOptionalFields: boolean) {
  return {
    title: 'Parity Reading',
    section: 'reading' as const,
    module: 'academic' as const,
    theme: 'Navigation',
    targetBand: '7.5',
    content: {
      ...(withOptionalFields ? { htmlContent: '<p>Old page markup</p>', sourceAssetId: 'ast_paritySource0001', assetIds: ['ast_paritySource0001'] } : {}),
      passage: {
        passageNumber: 1,
        title: 'Dead reckoning',
        text: 'Animals navigate without landmarks.',
        ...(withOptionalFields ? { htmlContent: '<p>Old passage markup</p>' } : {}),
        questions: [
          { id: 'par-1', questionNumber: 1, type: 'true_false_not_given', prompt: 'Path integration accumulates error.', correctAnswer: 'TRUE', ...(withOptionalFields ? { explanation: 'Old explanation.' } : {}) },
          { id: 'par-2', questionNumber: 2, type: 'sentence_completion', prompt: 'The error grows with every ___.', correctAnswer: 'step' },
        ],
      },
    },
  };
}

describe('materials', () => {
  it('create, save without nested fields, publish, edit while published, refuse a stale save, delete', async () => {
    await expectParity(async ({ record }) => {
      const id = 'parity-reading-0001';
      const created = await adminStore.saveMaterialDetailed('reading', { ...readingDocument(true), id }, 'parity');
      record('created', created);
      const trimmed = await outcome(() =>
        adminStore.saveMaterialDetailed('reading', { ...readingDocument(false), id }, 'parity', { expectedUpdatedAt: created.material.updatedAt, requireRevision: true }),
      );
      record('saved without the nested optional fields', trimmed);
      record('read back', await adminStore.getMaterial('reading', id));
      record('published', await adminStore.setMaterialStatus('reading', id, 'published', { assetExists: () => true }));
      const current = await adminStore.getMaterial('reading', id);
      record(
        'edited while published',
        await outcome(() => adminStore.saveMaterialDetailed('reading', { ...readingDocument(false), id, theme: 'Edited' }, 'parity', { expectedUpdatedAt: current?.updatedAt, requireRevision: true })),
      );
      record(
        'stale save',
        await outcome(() => adminStore.saveMaterialDetailed('reading', { ...readingDocument(false), id }, 'parity', { expectedUpdatedAt: created.material.updatedAt, requireRevision: true })),
      );
      record('drafts', (await adminStore.listMaterials('reading', 'draft')).map((material) => material.id));
      record('deleted', await adminStore.deleteMaterial('reading', id));
      record('after delete', await adminStore.getMaterial('reading', id));
    });
  });
});

describe('bundles', () => {
  it('create, edit away optional fields, publish on the revision read, refuse a stale revision, retire, refuse deletion', async () => {
    await expectParity(async ({ record, name }) => {
      const draft = await bundleStore.create({ title: 'Parity bundle', module: 'academic', targetBand: '7.0', description: 'Removed by the next edit.', components: [], timing: CUSTOM_TIMING });
      name(draft.id, '<bundle>');
      record('created', draft);
      const edited = await bundleStore.updateDraft(draft.id, { title: 'Parity bundle, edited', module: 'academic', components: [], timing: CUSTOM_TIMING });
      record('edited without description or band', edited);
      record('read back', await bundleStore.get(draft.id));
      record('publish on a stale revision', await outcome(() => bundleStore.setStatus(draft.id, 'published', draft.updatedAt)));
      record('publish on the revision read', await outcome(() => bundleStore.setStatus(draft.id, 'published', edited.updatedAt)));
      record('edit while published', await outcome(() => bundleStore.updateDraft(draft.id, { title: 'Refused', module: 'academic', components: [], timing: CUSTOM_TIMING })));
      record('archived', await outcome(() => bundleStore.setStatus(draft.id, 'archived')));
      record('delete once published', await outcome(() => bundleStore.remove(draft.id)));
      const other = await bundleStore.create({ title: 'Never published', module: 'academic', components: [], timing: CUSTOM_TIMING });
      name(other.id, '<other bundle>');
      record('delete a draft', await outcome(() => bundleStore.remove(other.id)));
      record('after delete', await bundleStore.get(other.id));
      record('listed', (await bundleStore.list()).map((bundle) => [bundle.id, bundle.status]));
    });
  });
});

describe('sources', () => {
  const source = (patch: Partial<StoredSource>): StoredSource => ({
    id: 'src-parity-0001',
    title: 'Parity book',
    filename: 'book.txt',
    mimeType: 'text/plain',
    fileKind: 'text',
    sourceAssetId: 'ast_parityBook000001',
    status: 'uploaded',
    warnings: [],
    stats: { characters: 0, chunks: 0, headings: 0 },
    extractorVersion: 'x1',
    chunkerVersion: 'c1',
    createdBy: 'parity',
    createdAt: '2026-09-12T08:00:00.000Z',
    updatedAt: '2026-09-12T08:00:00.000Z',
    ...patch,
  });
  const chunk = (ordinal: number): SourceChunk => ({
    id: `chunk-${ordinal}`,
    sourceId: 'src-parity-0001',
    ordinal,
    level: 1,
    location: { path: ['Chapter'], charStart: ordinal * 10, charEnd: ordinal * 10 + 9 },
    text: `Passage ${ordinal}.`,
    wordCount: 2,
    extractorVersion: 'x1',
    chunkerVersion: 'c1',
    contentHash: 'a'.repeat(64),
  });

  it('a failed run followed by a ready one leaves no error behind; chunks are replaced whole and read in order', async () => {
    await expectParity(async ({ record }) => {
      await sourceStore.save(source({ status: 'failed', error: 'The file could not be read.', warnings: [{ code: 'empty_page', message: 'Page 2 is empty.' }] }));
      record('failed', await sourceStore.get('src-parity-0001'));
      await sourceStore.save(source({ status: 'ready', extractedTextAssetId: 'ast_parityText000001', stats: { characters: 30, chunks: 3, headings: 1 }, updatedAt: '2026-09-12T08:05:00.000Z' }));
      record('ready', await sourceStore.get('src-parity-0001'));
      record('listed', await sourceStore.list());
      await sourceStore.saveChunks('src-parity-0001', [chunk(2), chunk(0), chunk(1)]);
      record('chunks', await sourceStore.getChunks('src-parity-0001'));
      await sourceStore.saveChunks('src-parity-0001', [chunk(1)]);
      record('chunks replaced', await sourceStore.getChunks('src-parity-0001'));
      record('deleted', await sourceStore.delete('src-parity-0001'));
      record('after delete', [await sourceStore.get('src-parity-0001'), await sourceStore.getChunks('src-parity-0001')]);
    });
  });
});

describe('asset records', () => {
  it('promote and reconcile change the records that exist, and an id with no record stays without one', async () => {
    await expectParity(async ({ record, name }) => {
      const audio = await assetStore.create({ originalName: 'part.mp3', content: Buffer.from('ID3 parity'), mimeType: 'audio/mpeg', kind: 'audio', createdBy: 'parity', sourceType: 'upload' });
      const image = await assetStore.create({ originalName: 'figure.png', content: Buffer.from('PNG parity'), mimeType: 'image/png', kind: 'image', createdBy: 'parity', sourceType: 'upload' });
      name(audio.id, '<audio>');
      name(image.id, '<image>');
      // Where the bytes live differs on purpose: a local filename, or a Cloud Storage key.
      const described = async () =>
        (await assetStore.list())
          .filter((asset) => asset.id === audio.id || asset.id === image.id)
          .map(({ storagePath: _storagePath, ...rest }) => rest)
          .sort((a, b) => a.originalName.localeCompare(b.originalName));
      record('created', await described());
      const missing = 'ast_noRecordHere00001';
      await assetStore.promote([audio.id, missing]);
      record('after promote', await described());
      record('the id with no record', await assetStore.get(missing));
      await assetStore.reconcile();
      record('after reconcile', await described());
      record('still no record', await assetStore.get(missing));
    });
  });
});

describe('learner data', () => {
  const task = (id: string, patch: Partial<PlanTask> = {}): PlanTask => ({
    id,
    title: `Task ${id}`,
    titleKey: 'plan.task',
    skill: 'reading',
    taskType: 'reading_passage',
    dueDate: '2026-09-20',
    completed: false,
    weight: 3,
    durationMins: 20,
    reason: 'Practice.',
    ...patch,
  });
  const week = (weekNumber: number): ChecklistWeek => ({ weekNumber, weekStart: `2026-09-${10 + weekNumber}`, mocksDone: 0, mocksTarget: 2, essaysDone: 0, essaysTarget: 4, speakingDone: 0, speakingTarget: 5 });
  const card = (id: string, note?: string): VocabCard => ({ id, term: `term ${id}`, source: 'annotation', skill: 'writing', box: 1, dueDate: '2026-09-13', reviews: 0, lapses: 0, createdAt: '2026-09-12T08:00:00.000Z', ...(note ? { note } : {}) });
  const generated = (id: string, timestamp: string): GeneratedTestRecord => ({ id, userId: 'usr_parity', timestamp, module: 'academic', section: 'reading', targetBand: '7.0', theme: 'Parity', contentHash: 'b'.repeat(64), title: `Generated ${id}`, questionTypes: ['short_answer'], data: { id } });
  const session = (patch: Partial<ExamSessionRecord>): ExamSessionRecord => ({
    id: 'attempt-00000000-parity-01',
    userId: 'usr_parity',
    bundleId: 'cdi-bundle-parity',
    bundlePublishedAt: '2026-09-12T08:00:00.000Z',
    pins: [],
    status: 'active',
    revision: 0,
    createdAt: '2026-09-12T08:00:00.000Z',
    updatedAt: '2026-09-12T08:00:00.000Z',
    progress: { sections: {} } as unknown as ExamSessionRecord['progress'],
    ...patch,
  });
  /** Firestore stores the owner's id on attempt and vocabulary documents as well; the local files are per user already. */
  const withoutOwner = <T extends object>(rows: T[]) => rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'userId')));

  it('profile, plan, checklist, vocabulary and attempts drop what a later save no longer carries', async () => {
    await expectParity(async ({ backend, record }) => {
      const store = dataStores[backend];
      const user = 'usr_parity';
      const profile: UserProfile = { id: user, targetBand: 7.5, currentLevel: 6, examDate: '2026-12-01', hoursPerWeek: 10, weakSection: 'writing', isOnboarded: true, name: 'Old name' };
      await store.saveUserProfile(user, profile);
      record('profile', await store.getUserProfile(user));
      const { examDate: _examDate, name: _name, ...cleared } = profile;
      await store.saveUserProfile(user, { ...cleared, targetBand: 8 });
      record('profile without exam date or name', await store.getUserProfile(user));

      await store.saveUserTasks(user, [task('a'), task('b'), task('c')]);
      const { titleKey: _titleKey, ...withoutKey } = task('a', { completed: true });
      await store.saveUserTasks(user, [withoutKey, task('c')]);
      record('tasks', await store.getUserTasks(user));

      await store.saveUserChecklist(user, [week(1), week(2)]);
      await store.saveUserChecklist(user, [week(2)]);
      record('checklist', await store.getUserChecklist(user));

      await store.saveUserVocab(user, [card('x', 'Old note.'), card('y', 'Kept.')]);
      await store.saveUserVocab(user, [card('x')]);
      record('vocabulary', withoutOwner(await store.getUserVocab(user)));

      const attempt: MockAttempt = { id: 'practice-parity-1', testId: 'test-1', date: '2026-09-12', scores: { reading: { band: 6.5 } }, notes: 'Old note.' };
      await store.saveUserAttempt(user, attempt);
      const { notes: _notes, ...withoutNotes } = attempt;
      await store.saveUserAttempt(user, withoutNotes);
      record('attempts', withoutOwner(await store.getUserAttempts(user)));
    });
  });

  it('generated tests, the daily quota and exam session revisions behave alike', async () => {
    await expectParity(async ({ backend, record }) => {
      const store = dataStores[backend];
      const user = 'usr_parity';
      for (const [id, timestamp] of [['gen-1', '2026-09-12T08:00:00.000Z'], ['gen-2', '2026-09-12T08:01:00.000Z'], ['gen-3', '2026-09-12T08:02:00.000Z']] as const) {
        await store.recordGeneratedTest(user, generated(id, timestamp));
      }
      record('two most recent', (await store.getRecentGenerations(user, 2)).map((test) => test.id));
      record('one by id', (await store.getGeneratedTestById(user, 'gen-2'))?.title);

      const reservations: Array<number | null> = [];
      for (let index = 0; index < 3; index += 1) reservations.push((await store.reserveGeneration(user, 2))?.generationsCount ?? null);
      record('reservations against a limit of two', reservations);
      await store.incrementUploadCount(user);
      const quota = await store.getDailyQuota(user);
      record('quota', [quota.generationsCount, quota.uploadsCount]);

      record('created', await store.saveExamSession(user, session({}), null));
      record('created again', await store.saveExamSession(user, session({}), null));
      record('saved on revision 0', await store.saveExamSession(user, session({ revision: 1, attemptSavedAt: '2026-09-12T09:00:00.000Z' }), 0));
      record('saved on a stale revision', await store.saveExamSession(user, session({ revision: 1 }), 0));
      record('saved without attemptSavedAt', await store.saveExamSession(user, session({ revision: 2, status: 'superseded' }), 1));
      record('session', await store.getExamSession(user, 'attempt-00000000-parity-01'));
    });
  });
});

describe('accounts', () => {
  it('register, refuse a duplicate, lock out, clear failures on success, reset once and remove the token', async () => {
    await expectParity(async ({ record, name }) => {
      /** The reset token is random, so its hash is too. */
      const redacted = <T extends object | null>(user: T) => (user && 'resetTokenHash' in user ? { ...user, resetTokenHash: '<token hash>' } : user);
      const first = await authService.register({ email: 'parity@example.com', username: 'parity_user', password: 'Parity-Passw0rd-1' });
      name(first.user.id, '<first user>');
      record('registered', first.user);
      record('duplicate', await outcome(() => authService.register({ email: 'parity@example.com', username: 'another_user', password: 'Parity-Passw0rd-1' })));

      const second = await authService.register({ email: 'second@example.com', username: 'second_user', password: 'Second-Passw0rd-1' });
      name(second.user.id, '<second user>');
      for (let index = 0; index < 2; index += 1) record('wrong password', await outcome(() => authService.login('second_user', 'not-the-password')));
      record('after two failures', await authService.getUserById(second.user.id));
      record('right password', await outcome(async () => (await authService.login('second_user', 'Second-Passw0rd-1')).user));
      record('failures cleared', await authService.getUserById(second.user.id));

      for (let index = 0; index < 5; index += 1) await outcome(() => authService.login('parity_user', 'not-the-password'));
      record('locked out', await authService.getUserById(first.user.id));
      record('right password while locked out', await outcome(() => authService.login('parity_user', 'Parity-Passw0rd-1')));

      const reset = await authService.requestPasswordReset('parity@example.com');
      const token = 'resetToken' in reset && reset.resetToken ? reset.resetToken : '';
      record('reset requested', redacted(await authService.getUserById(first.user.id)));
      record('reset', await outcome(() => authService.resetPassword('parity@example.com', token, 'Parity-Passw0rd-2')));
      record('after reset', redacted(await authService.getUserById(first.user.id)));
      record('the same token again', await outcome(() => authService.resetPassword('parity@example.com', token, 'Parity-Passw0rd-3')));
    });
  });
});

describe('limits and the generation ledger', () => {
  it('count, refuse and forget the same way', async () => {
    await expectParity(async ({ record }) => {
      const allowed: boolean[] = [];
      for (let index = 0; index < 6; index += 1) allowed.push((await requestRateLimitService.check('parity-client', 'forgot_password')).allowed);
      record('forgot-password requests against a limit of five', allowed);
      const ai: boolean[] = [];
      for (let index = 0; index < 4; index += 1) ai.push((await aiRateLimitService.consume('usr_parity', 'mock_generation')).allowed);
      record('mock generations against an hourly limit of three', ai);

      const request = { requestId: 'req-parity-0001', fingerprint: 'b'.repeat(64), sourceId: 'src-parity' };
      record('claim', await generationLog.claim(request, 60_000));
      record('claim while running', (await generationLog.claim(request, 60_000)).kind);
      await generationLog.finish(request.requestId, { status: 'succeeded', materialId: 'mat-parity-1' });
      record('succeeded', await generationLog.getRequest(request.requestId));
      record('claim once completed', (await generationLog.claim(request, 60_000)).kind);
      record('claim with another fingerprint', (await generationLog.claim({ ...request, fingerprint: 'c'.repeat(64) }, 60_000)).kind);
      record('reclaimed after its draft is gone', await generationLog.claim(request, 60_000, true));
      record('reclaimed entry holds no draft id', await generationLog.getRequest(request.requestId));
      await generationLog.finish(request.requestId, { status: 'failed' });
      record('failed without a draft', await generationLog.getRequest(request.requestId));
    });
  });
});
