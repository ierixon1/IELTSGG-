import './env';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';
import type { MockAttempt, SpeakingGradingResult, WritingGradingResult } from '../src/types';
import type { AdminMaterial } from '../src/types/admin';
import type { ExamSessionOpened, ExamSessionView } from '../src/types/examSession';
import type { GradeOutcome } from '../src/services/grading';
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
 * The bundle lifecycle and a full exam sitting on the Firestore code path.
 *
 * There is no Firestore emulator here, so every store runs against
 * `FakeFirestore`, which refuses what real Firestore refuses — an `undefined`
 * field, a nested array. The stores, the bundle service, the exam session and
 * the learner routes are the production code, selected by
 * `STORAGE_BACKEND=gcs_firestore`; only Cloud Storage uploads are stubbed.
 *
 * This proves the Firestore adapters speak the same contracts as the local
 * ones and write documents Firestore accepts. It does not prove a real
 * Firestore project behaves this way: that has not been run.
 */
process.env.STORAGE_BACKEND = 'gcs_firestore';
process.env.GCS_BUCKET_NAME = 'not-used-uploads-are-stubbed';
const originalCwd = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-firestore-exam-'));
process.chdir(tempRoot);

const { FakeFirestore } = await import('./fakeFirestore');
const fake = new FakeFirestore();
const { setFirestoreDbForTesting } = await import('../src/services/firebaseAdmin');
// The fake implements only the surface the stores use, so it is not a `Firestore` to the type system.
setFirestoreDbForTesting(fake as unknown as Firestore);

const express = (await import('express')).default;
const { storageProvider, dataStore } = await import('../src/services/storage');
const { FirestoreDataStore } = await import('../src/services/storage/FirestoreDataStore');
const { assetStore } = await import('../src/services/assetStore');
const { adminStore } = await import('../src/services/adminStore');
const { bundleStore } = await import('../src/services/bundleStore');
const { openSitting, publishBundle, transitionBundle } = await import('../src/services/bundleService');
const { verifyExamAttempt } = await import('../src/services/attemptVerification');
const { materialContentHash } = await import('../src/services/materialVersion');
const { learnerContentRouter } = await import('../src/routes/learnerContentRoutes');
const { userDataRouter } = await import('../src/routes/userDataRoutes');
const { createExamSessionRouter } = await import('../src/routes/examSessionRoutes');
const { createExamSessionService } = await import('../src/services/examSession');

// Bytes would go to Cloud Storage; the record goes to (fake) Firestore, which is what is under test.
storageProvider.uploadFile = async (storagePath: string) => ({ storagePath });

const LEARNER = 'usr_firestoreLearner01';
let clock = Date.parse('2026-09-11T12:00:00.000Z');
let sequence = 0;

const writingGrade = async (): Promise<GradeOutcome<WritingGradingResult>> => ({
  ok: true,
  result: { band_overall: 6.5, criteria: [], annotated_text: [], word_count: 0, meets_word_limit: false, general_commentary: 'Fixture.' },
});
const criterion = { name: 'Fixture', band: 7, justification: 'Fixture.', improvement_tips: [] };
const speakingGrade = async (): Promise<GradeOutcome<SpeakingGradingResult>> => ({
  ok: true,
  result: {
    band_overall: 7,
    transcript: 'A transcribed answer.',
    criteria: { fluency_coherence: criterion, lexical_resource: criterion, grammatical_range: criterion, pronunciation: criterion },
    objective_metrics: { durationSeconds: 0, wordsPerMinute: 0, pausesCount: 0, totalPauseDurationSeconds: 0, fillerWords: [] },
    actionable_drills: [],
  },
});

const service = createExamSessionService({
  store: dataStore,
  resolveSitting: openSitting,
  verifyAttempt: verifyExamAttempt,
  gradeWriting: writingGrade,
  gradeSpeaking: speakingGrade,
  now: () => clock,
  newId: () => `00000000-0000-4000-9000-${String(++sequence).padStart(12, '0')}`,
});

let server: Server;
let origin = '';
const ids: Record<string, string> = {};
let bundleId = '';

const call = (url: string, init: RequestInit = {}) =>
  fetch(`${origin}${url}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers || {}) } });
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

async function publishedMaterial(section: AdminMaterial['section'], payload: object, knownAssets: Set<string>) {
  const saved = await adminStore.saveMaterial(section, payload, 'Firestore test');
  const result = await adminStore.setMaterialStatus(section, saved.id, 'published', { assetExists: (id) => knownAssets.has(id) });
  if (!result.ok) throw new Error(`fixture did not publish: ${JSON.stringify(result.blockers)}`);
  return saved.id;
}

before(async () => {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  // Authentication is not what this suite tests: every request is the one learner.
  app.use('/api', (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { userId?: string }).userId = LEARNER;
    next();
  });
  app.use('/api', userDataRouter);
  app.use('/api', learnerContentRouter);
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

describe('the Firestore path: stores', () => {
  it('runs on the Firestore data store', () => {
    expect(dataStore instanceof FirestoreDataStore).toBe(true);
  });

  it('configures Firestore to store an undefined optional field as absent, as the JSON stores do', async () => {
    expect(fake.rules.ignoreUndefinedProperties).toBe(true);
    // Unconfigured, Firestore refuses a canonical material outright: every question carries optional fields.
    const strict = new FakeFirestore();
    let refused = '';
    try {
      await strict.collection('probe').doc('one').set({ question: { id: 'q1', provenance: undefined } });
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error);
    }
    expect(refused).toContain('question.provenance');
    // Nested arrays stay refused either way.
    let nested = '';
    try {
      await fake.collection('probe').doc('two').set({ grid: [['a']] });
    } catch (error) {
      nested = error instanceof Error ? error.message : String(error);
    }
    expect(nested).toContain('Nested arrays');
  });

  it('stores assets and publishes every component through the material gate', async () => {
    const known = new Set<string>();
    for (const part of [1, 2, 3, 4]) {
      const asset = await assetStore.create({
        originalName: `part-${part}.mp3`,
        content: Buffer.from(`ID3 part ${part}`),
        mimeType: 'audio/mpeg',
        kind: 'audio',
        createdBy: 'test',
        sourceType: 'upload',
      });
      known.add(asset.id);
      expect(fake.documents.has(`admin_assets/${asset.id}`)).toBe(true);
      ids[`listening-${part}`] = await publishedMaterial('listening', listeningPayload(part, asset.id), known);
    }
    for (const part of [1, 2, 3]) ids[`reading-${part}`] = await publishedMaterial('reading', readingPayload(part), known);
    ids['writing-1'] = await publishedMaterial('writing', writingPayload(), known);
    ids['speaking-1'] = await publishedMaterial('speaking', speakingPayload(), known);

    const published = await adminStore.listMaterials('reading', 'published');
    expect(published.map((material) => material.id).sort()).toEqual([ids['reading-1'], ids['reading-2'], ids['reading-3']].sort());
  });

  it('creates a draft bundle, refuses to publish it incomplete, and publishes it complete', async () => {
    const pins = await Promise.all(
      FULL_SLOTS.map(async ({ section, part }) => {
        const materialId = ids[`${section}-${part}`];
        const material = await adminStore.getMaterial(section, materialId);
        return { section, part, materialId, contentHash: material ? materialContentHash(material) : '' };
      }),
    );

    const incomplete = await bundleStore.create({ title: 'Firestore half', module: 'academic', components: pins.filter((pin) => pin.section === 'reading'), timing: CUSTOM_TIMING });
    const refused = await publishBundle(incomplete.id);
    expect(refused.ok).toBe(false);
    expect((await bundleStore.get(incomplete.id))?.status).toBe('draft');

    const draft = await bundleStore.create({ title: 'Firestore CDI', module: 'academic', components: pins, timing: CUSTOM_TIMING });
    bundleId = draft.id;
    expect(fake.documents.get(`admin_content/bundles/items/${bundleId}`)?.status).toBe('draft');
    const outcome = await publishBundle(bundleId);
    expect(outcome.ok).toBe(true);
    expect((await bundleStore.list('published')).map((bundle) => bundle.id)).toEqual([bundleId]);
  });

  it('withdraws, retires and restores the bundle, and never deletes it once published', async () => {
    await transitionBundle(bundleId, 'unpublish');
    expect((await openSitting(bundleId)).ok).toBe(false);
    await transitionBundle(bundleId, 'archive');
    const retired = await openSitting(bundleId);
    expect(retired.ok === false && retired.code).toBe('bundle_archived');

    let deleteRefused = false;
    try {
      await bundleStore.remove(bundleId);
    } catch {
      deleteRefused = true;
    }
    expect(deleteRefused).toBe(true);

    await transitionBundle(bundleId, 'restore');
    expect((await publishBundle(bundleId)).ok).toBe(true);
  });
});

describe('the Firestore path: a full exam sitting', () => {
  let sessionId = '';
  const run = async (events: unknown[]) => (await (await call(`/api/learner/exams/${sessionId}/events`, post({ events }))).json()) as ExamSessionView;

  it('opens the published bundle for the learner and stores the session in Firestore', async () => {
    const list = await (await call('/api/learner/bundles')).json();
    expect(list.bundles.map((bundle: { id: string; available: boolean }) => [bundle.id, bundle.available])).toEqual([[bundleId, true]]);

    const opened = (await (await call('/api/learner/exams', post({ bundleId }))).json()) as ExamSessionOpened;
    sessionId = opened.sessionId;
    const stored = fake.documents.get(`users/${LEARNER}/examSessions/${sessionId}`);
    expect(stored?.status).toBe('active');
    expect(typeof stored?.progress).toBe('string');
    expect(stored?.revision).toBe(0);
  });

  it('resumes the same session with its saved answers', async () => {
    await run([{ type: 'start' }, { type: 'answers', answers: { 'lis-p1-q1': listeningAnswer(1, 1) } }]);
    clock += 60_000;
    const reopened = (await (await call('/api/learner/exams', post({ bundleId }))).json()) as ExamSessionOpened;
    expect(reopened.sessionId).toBe(sessionId);
    expect(reopened.resumed).toBe(true);
    expect(reopened.run.sections.listening.answers).toEqual({ 'lis-p1-q1': listeningAnswer(1, 1) });
    expect(await dataStore.listExamSessions(LEARNER)).toHaveLength(1);
  });

  it('refuses a stale write, as the revision check requires', async () => {
    const current = await dataStore.getExamSession(LEARNER, sessionId);
    if (!current) throw new Error('session missing');
    expect(await dataStore.saveExamSession(LEARNER, { ...current, revision: current.revision + 1 }, current.revision - 1)).toBe(false);
    expect(await dataStore.saveExamSession(LEARNER, { ...current, id: 'attempt-00000000-dupe' }, null)).toBe(true);
    expect(await dataStore.saveExamSession(LEARNER, { ...current, id: 'attempt-00000000-dupe' }, null)).toBe(false);
  });

  it('runs every section to the end and stores the attempt in Firestore', async () => {
    await run([{ type: 'submit_answers' }, { type: 'finish_section' }]);
    await run([
      { type: 'answers', answers: { 'rea-p1-q1': readingAnswer(1, 1), 'rea-p2-q2': readingAnswer(2, 2), 'rea-p3-q1': 'no' } },
      { type: 'submit_answers' },
      { type: 'finish_section' },
    ]);
    for (const task of [1, 2]) {
      const response = await call(`/api/learner/exams/${sessionId}/writing/${task}`, post({ essay: `Essay for task ${task}, long enough to be read.` }));
      expect(response.status).toBe(200);
    }
    await run([{ type: 'finish_section' }]);
    for (const part of [1, 2, 3]) {
      const response = await call(`/api/learner/exams/${sessionId}/speaking/${part}`, post({ transcriptProvided: `Spoken answer for part ${part}.` }));
      expect(response.status).toBe(200);
    }
    clock += 30_000;
    const finished = await run([{ type: 'finish_section' }]);
    expect(finished.status).toBe('finished');
    expect(finished.attemptSaved).toBe(true);

    const document = fake.documents.get(`users/${LEARNER}/attempts/${sessionId}`) as (MockAttempt & { userId: string }) | undefined;
    expect(document?.userId).toBe(LEARNER);
    expect(document?.bundleId).toBe(bundleId);
    expect(document?.timing).toEqual(CUSTOM_TIMING);
    expect(document?.status).toBe('completed');
    expect((document?.responses ?? []).map((response) => response.questionId).sort()).toEqual(['lis-p1-q1', 'rea-p1-q1', 'rea-p2-q2', 'rea-p3-q1']);

    const data = await (await call('/api/data')).json();
    expect((data.attempts as MockAttempt[]).map((attempt) => attempt.id)).toEqual([sessionId]);
    expect(fake.documents.get(`users/${LEARNER}/examSessions/${sessionId}`)?.attemptSavedAt).toBe(new Date(clock).toISOString());
  });

  it('withdraws a component edited after publication, and still refuses the exam once it is republished until it is pinned again', async () => {
    const edited = readingPayload(3);
    edited.content.passage.text = 'Edited after publication.';
    const saved = await adminStore.saveMaterialDetailed('reading', { ...edited, id: ids['reading-3'] }, 'Firestore test');
    // One transaction: the new content and the withdrawal land in the same write.
    expect([saved.material.status, saved.unpublished]).toEqual(['draft', true]);
    expect(fake.documents.get(`admin_content/reading/items/${ids['reading-3']}`)?.status).toBe('draft');
    const withdrawn = await call('/api/learner/exams', post({ bundleId }));
    expect(withdrawn.status).toBe(409);
    expect((await withdrawn.json()).code).toBe('component_unpublished');

    const republished = await adminStore.setMaterialStatus('reading', ids['reading-3'], 'published', { assetExists: () => false });
    expect(republished.ok).toBe(true);
    const opened = await call('/api/learner/exams', post({ bundleId }));
    expect(opened.status).toBe(409);
    expect((await opened.json()).code).toBe('component_changed');
  });
});
