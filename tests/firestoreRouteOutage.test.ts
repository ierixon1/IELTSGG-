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
import { CUSTOM_TIMING } from './bundleFixtures';
import type { AuthenticatedRequest } from '../src/middleware/authMiddleware';

/**
 * A Firestore that fails underneath a bundle or learner-data write (Phase 23, Part D).
 *
 * These routes caught every error themselves: the bundle routes answered 500
 * "The bundle request failed.", and the learner-data routes 500 "Unable to save…".
 * Nothing internal leaked, but an outage looked like a defect in the request.
 * The Phase 20 boundary answers an unreachable data backend with 503
 * `storage_unavailable`, so these routes now hand it that error.
 *
 * Each test fails the commit of the write — the point at which a real outage
 * refuses it — and requires a 503 with nothing internal, nothing stored, and the
 * same request succeeding once Firestore answers again.
 *
 * The Firestore is `FakeFirestore`; this is not a run against a real project (H10).
 */
process.env.STORAGE_BACKEND = 'gcs_firestore';
process.env.GCS_BUCKET_NAME = 'not-used-uploads-are-stubbed';
const originalCwd = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-firestore-route-outage-'));
process.chdir(tempRoot);

const { FakeFirestore } = await import('./fakeFirestore');
const fake = new FakeFirestore({ concurrency: 'optimistic' });
const { setFirestoreDbForTesting } = await import('../src/services/firebaseAdmin');
setFirestoreDbForTesting(fake as unknown as Firestore);

const express = (await import('express')).default;
const { guardAsyncHandlers } = await import('../src/http/asyncHandlers');
const { apiErrorBoundary } = await import('../src/http/errorBoundary');
const { adminRouter } = await import('../src/routes/adminRoutes');
const { userDataRouter } = await import('../src/routes/userDataRoutes');
const { dataStore } = await import('../src/services/storage');

const LEARNER = 'usr_outageLearner';
const ADMIN_TOKEN = 'prep_route_outage_admin_session';
let server: Server;
let origin = '';

before(async () => {
  const now = Date.now();
  await fake.collection('auth_users').doc('usr_outage_admin').set({
    id: 'usr_outage_admin',
    email: 'outage-admin@example.com',
    username: 'outage_admin',
    name: 'Outage Admin',
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
    .set({ userId: 'usr_outage_admin', username: 'outage_admin', email: 'outage-admin@example.com', name: 'Outage Admin', role: 'admin', createdAt: now, expiresAt: now + 60 * 60 * 1000, sessionVersion: 0 });

  const app = guardAsyncHandlers(express());
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/admin', adminRouter);
  // Learner authentication is not under test: every learner request is the one learner.
  app.use('/api', (req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).userId = LEARNER;
    next();
  });
  app.use('/api', userDataRouter);
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

async function call(url: string, init: { method?: string; body?: unknown; admin?: boolean } = {}) {
  const response = await fetch(`${origin}${url}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json', ...(init.admin ? { cookie: `prep_admin_auth=${ADMIN_TOKEN}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: response.status, type: response.headers.get('content-type') ?? '', text: await response.text() };
}

/** Runs `during` with every commit that writes under `prefix` refused as Firestore refuses it when unreachable. */
async function outage(prefix: string, during: () => Promise<void>) {
  const apply = fake.apply.bind(fake);
  fake.apply = (operations) => {
    if (operations.some((operation) => operation.path.startsWith(prefix))) {
      throw Object.assign(new Error('14 UNAVAILABLE: No connection established'), { code: 14, details: 'No connection established' });
    }
    apply(operations);
  };
  try {
    await during();
  } finally {
    fake.apply = apply;
  }
}

const documentsUnder = (prefix: string) => [...fake.documents.entries()].filter(([documentPath]) => documentPath.startsWith(prefix));

describe('Firestore failing underneath bundle and learner-data writes (Part D)', () => {
  it('creating a bundle during an outage answers 503 with nothing internal, stores nothing, and succeeds once Firestore answers', async () => {
    const body = { title: 'Outage bundle', module: 'academic', components: [], timing: CUSTOM_TIMING };
    const before = documentsUnder('admin_content/bundles/');
    await outage('admin_content/bundles/', async () => {
      expectControlledError('bundle create during the outage', await call('/api/admin/bundles', { body, admin: true }), 503, 'storage_unavailable');
    });
    expect(documentsUnder('admin_content/bundles/')).toEqual(before);
    const created = await call('/api/admin/bundles', { body, admin: true });
    expect(created.status).toBe(201);
    expect(documentsUnder('admin_content/bundles/')).toHaveLength(before.length + 1);
  });

  it('saving a profile or a plan during an outage answers 503 with nothing internal, changes nothing, and succeeds once Firestore answers', async () => {
    const profile = { targetBand: 7.5, currentLevel: 6, hoursPerWeek: 10, weakSection: 'writing' as const, isOnboarded: true };
    const task = { id: 'outage-task-1', title: 'Read a passage', skill: 'reading', taskType: 'reading_passage', dueDate: '2026-09-20', completed: false, weight: 3, durationMins: 20, reason: 'Practice.' };
    await dataStore.saveUserProfile(LEARNER, { ...profile, id: LEARNER, targetBand: 6.5 });
    const before = documentsUnder(`users/${LEARNER}`);
    await outage(`users/${LEARNER}`, async () => {
      expectControlledError('profile save during the outage', await call('/api/data/profile', { method: 'PUT', body: profile }), 503, 'storage_unavailable');
      expectControlledError('plan save during the outage', await call('/api/data/tasks', { method: 'PUT', body: { tasks: [task] } }), 503, 'storage_unavailable');
    });
    expect(documentsUnder(`users/${LEARNER}`)).toEqual(before);

    expect((await call('/api/data/profile', { method: 'PUT', body: profile })).status).toBe(200);
    expect((await call('/api/data/tasks', { method: 'PUT', body: { tasks: [task] } })).status).toBe(200);
    expect([(await dataStore.getUserProfile(LEARNER))?.targetBand, (await dataStore.getUserTasks(LEARNER)).map((stored) => stored.id)]).toEqual([7.5, ['outage-task-1']]);
  });
});
