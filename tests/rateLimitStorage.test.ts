import './env';
import { after, before, describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Firestore } from 'firebase-admin/firestore';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';
import { expectControlledError } from './errorAssertions';
import { all, expectRateLimited, rawRequest, statuses, type RawReply } from './rateLimitHttp';
import type { FakeTransaction } from './fakeFirestore';

/**
 * H2 on Firestore, the production store: the request limiter under concurrent
 * requests and when its store cannot be reached, behind the real admin, auth and
 * learner authentication middleware.
 *
 * `FakeFirestore` runs in its optimistic mode, where a transaction whose read
 * changed underneath it is run again. This is the contract on the in-memory
 * Firestore; it has not been run against a real Firestore project (H10).
 */
process.env.STORAGE_BACKEND = 'gcs_firestore';
process.env.GCS_BUCKET_NAME = 'not-used-uploads-are-stubbed';
const originalCwd = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-rate-limit-storage-'));
process.chdir(tempRoot);

const { FakeFirestore } = await import('./fakeFirestore');
const fake = new FakeFirestore({ concurrency: 'optimistic' });
const { setFirestoreDbForTesting } = await import('../src/services/firebaseAdmin');
setFirestoreDbForTesting(fake as unknown as Firestore);

const express = (await import('express')).default;
const { guardAsyncHandlers } = await import('../src/http/asyncHandlers');
const { apiErrorBoundary } = await import('../src/http/errorBoundary');
const { authRouter } = await import('../src/routes/authRoutes');
const { adminRouter } = await import('../src/routes/adminRoutes');
const { enforceAdminSecurity } = await import('../src/middleware/adminSecurityMiddleware');
const { authenticateRequest } = await import('../src/middleware/authMiddleware');
const { RATE_LIMITS } = await import('../src/services/requestRateLimitService');

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const agent = new http.Agent({ keepAlive: true, maxSockets: 16 });
let server: Server;
let origin = '';

/** An account and a live session for it, written straight into Firestore; returns the session token. */
async function seedAccount(id: string, role: 'student' | 'admin' | 'examiner'): Promise<string> {
  const now = Date.now();
  const email = `${id}@example.com`;
  const token = `prep_${id}_${'t'.repeat(40)}`;
  await fake.collection('auth_users').doc(id).set({
    id,
    email,
    username: id,
    name: id,
    passwordHash: 'unused',
    role,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    failedLoginAttempts: 0,
    sessionVersion: 0,
  });
  await fake
    .collection('auth_sessions')
    .doc(sha256(token))
    .set({ userId: id, username: id, email, name: id, role, createdAt: now, expiresAt: now + 60 * 60 * 1000, sessionVersion: 0 });
  return token;
}

let raceLearner = '';
let outageLearner = '';
let staffCookie = '';
let editorCookie = '';
let examinerCookie = '';

before(async () => {
  raceLearner = `prep_auth=${await seedAccount('usr_limits_race', 'student')}`;
  outageLearner = `prep_auth=${await seedAccount('usr_limits_outage', 'student')}`;
  staffCookie = `prep_admin_auth=${await seedAccount('usr_limits_staff', 'admin')}`;
  editorCookie = `prep_admin_auth=${await seedAccount('usr_limits_editor', 'admin')}`;
  examinerCookie = `prep_admin_auth=${await seedAccount('usr_limits_examiner', 'examiner')}`;

  // Mounted as server.ts mounts them. The route behind the learner middleware does no storage work of its own.
  const app = guardAsyncHandlers(express());
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/auth', authRouter);
  app.use('/api/admin', enforceAdminSecurity, adminRouter);
  app.use('/api', authenticateRequest);
  app.get('/api/probe', (_req, res) => {
    res.json({ ok: true });
  });
  app.use('/api', apiErrorBoundary);
  server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  agent.destroy();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  process.chdir(originalCwd);
  removeTempRoot(tempRoot);
});

const send = (method: string, url: string, headers: Record<string, string> = {}, json?: unknown): Promise<RawReply> => rawRequest(origin, method, url, { headers, json, agent });
const probe = (cookie: string) => send('GET', '/api/probe', { cookie });
const asStaff = (cookie: string) => send('GET', '/api/admin/me', { cookie });

/** Runs `during` with every Firestore transaction refused as Firestore refuses it when it cannot be reached. */
async function withLimiterOutage(during: () => Promise<void>): Promise<void> {
  const runTransaction = fake.runTransaction.bind(fake);
  fake.runTransaction = <T,>(_run: (tx: FakeTransaction) => Promise<T>): Promise<T> =>
    Promise.reject(Object.assign(new Error('14 UNAVAILABLE: No connection established'), { code: 14, details: 'No connection established' }));
  try {
    await during();
  } finally {
    fake.runTransaction = runTransaction;
  }
}

describe('the request limiter on Firestore', () => {
  it('requests racing for a learner\'s last slots take exactly what is left: the transactions collided and were run again', async () => {
    const { max, windowMs } = RATE_LIMITS.api_user;
    expect(await statuses(max - 2, () => probe(raceLearner))).toEqual(all(max - 2, 200));

    const conflictsBefore = fake.conflicts;
    fake.holdTransactionReads(4);
    const replies = await Promise.all([probe(raceLearner), probe(raceLearner), probe(raceLearner), probe(raceLearner)]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 200, 429, 429]);
    for (const reply of replies.filter((candidate) => candidate.status === 429)) expectRateLimited('a request that lost the race', reply, windowMs);
    expect(fake.conflicts - conflictsBefore).toBeGreaterThan(0);

    // One document for the account, holding exactly the allowance.
    const stored = fake.documents.get(`rate_limits/${sha256('api_user:account:usr_limits_race')}`);
    expect([stored?.count, stored?.operation]).toEqual([max, 'api_user']);
  });

  it('two staff members behind one address each get their own allowance', async () => {
    const { max, windowMs } = RATE_LIMITS.staff_api;
    expect(await statuses(max, () => asStaff(editorCookie))).toEqual(all(max, 200));
    expectRateLimited('the editor, over their own allowance', await asStaff(editorCookie), windowMs);
    expect(await statuses(max, () => asStaff(examinerCookie))).toEqual(all(max, 200));
    expectRateLimited('the examiner, over their own allowance', await asStaff(examinerCookie), windowMs);
  });

  it('a limiter store that cannot be reached is 503 for every caller — never 429 — nothing is counted, and the same requests go through once it answers', async () => {
    const { max, windowMs } = RATE_LIMITS.api_user;
    expect(await statuses(max - 1, () => probe(outageLearner))).toEqual(all(max - 1, 200));
    const signIn = () => send('POST', '/api/auth/login', {}, { username: 'nobody_here', password: 'not-a-real-password' });

    await withLimiterOutage(async () => {
      expectControlledError('signed-in learner', await probe(outageLearner), 503, 'storage_unavailable');
      expectControlledError('signed-in learner, again', await probe(outageLearner), 503, 'storage_unavailable');
      expectControlledError('no session', await send('GET', '/api/probe'), 503, 'storage_unavailable');
      expectControlledError('staff', await asStaff(staffCookie), 503, 'storage_unavailable');
      expectControlledError('public catalogue', await send('GET', '/api/admin/public/bundles'), 503, 'storage_unavailable');
      expectControlledError('learner sign-in', await signIn(), 503, 'storage_unavailable');
      expectControlledError('staff sign-in', await send('POST', '/api/admin/login', {}, { username: 'nobody_here', password: 'not-a-real-password' }), 503, 'storage_unavailable');
      expectControlledError('password recovery', await send('POST', '/api/auth/forgot-password', {}, { email: 'nobody@example.com' }), 503, 'storage_unavailable');
    });

    // The learner still has exactly the one request left that they had before the outage.
    expect((await probe(outageLearner)).status).toBe(200);
    expectRateLimited('the learner, over the allowance the outage did not spend', await probe(outageLearner), windowMs);
    expect((await send('GET', '/api/probe')).status).toBe(401);
    expect((await asStaff(staffCookie)).status).toBe(200);
    expect((await send('GET', '/api/admin/public/bundles')).status).toBe(200);
    expect((await signIn()).status).toBe(401);
  });

  it('staff sign-in is limited per address, like learner sign-in, and counted apart from it', async () => {
    const { max, windowMs } = RATE_LIMITS.login;
    // A different account name each time: one name is also held to its own, lower count (M16).
    let attempt = 0;
    const staffSignIn = () => send('POST', '/api/admin/login', {}, { username: `nobody_${(attempt += 1)}`, password: 'not-a-real-password' });
    expect(await statuses(max, staffSignIn)).toEqual(all(max, 401));
    expectRateLimited('staff sign-in, over the address allowance', await staffSignIn(), windowMs);
    // Learner sign-in from the same address has its own count (the previous test made one attempt).
    expect((await send('POST', '/api/auth/login', {}, { username: 'nobody_here', password: 'not-a-real-password' })).status).toBe(401);
    // A signed-in staff member is not refused by it.
    expect((await asStaff(staffCookie)).status).toBe(200);
  });
});
