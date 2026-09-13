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
import { rawRequest, type RawReply } from './rateLimitHttp';
import type { FakeTransaction } from './fakeFirestore';

/**
 * H10, the parts that can be proven without a real Firestore project: the request
 * limiter when its transactions keep colliding, the documents it writes for a TTL
 * policy, and sign-ins given back while others are counted.
 *
 * `FakeFirestore` runs in its optimistic mode: a transaction whose read changed
 * before it committed is run again, up to five attempts, and then fails ABORTED —
 * as the Firestore client does. This is the in-memory Firestore, not a real
 * project; real contention, retries and TTL deletion remain unverified (H10).
 */
process.env.STORAGE_BACKEND = 'gcs_firestore';
process.env.GCS_BUCKET_NAME = 'not-used-uploads-are-stubbed';
const originalCwd = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-rate-limit-contention-'));
process.chdir(tempRoot);

const { FakeFirestore, FakeDocument } = await import('./fakeFirestore');
const fake = new FakeFirestore({ concurrency: 'optimistic' });
const { setFirestoreDbForTesting } = await import('../src/services/firebaseAdmin');
setFirestoreDbForTesting(fake as unknown as Firestore);

const express = (await import('express')).default;
const { guardAsyncHandlers } = await import('../src/http/asyncHandlers');
const { apiErrorBoundary } = await import('../src/http/errorBoundary');
const { authRouter } = await import('../src/routes/authRoutes');
const { authenticateRequest } = await import('../src/middleware/authMiddleware');
const { RATE_LIMITS, requestRateLimitService } = await import('../src/services/requestRateLimitService');

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });
let server: Server;
let origin = '';

async function seedLearner(id: string): Promise<string> {
  const now = Date.now();
  const token = `prep_${id}_${'t'.repeat(40)}`;
  await fake.collection('auth_users').doc(id).set({ id, email: `${id}@example.com`, username: id, name: id, passwordHash: 'unused', role: 'student', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), failedLoginAttempts: 0, sessionVersion: 0 });
  await fake.collection('auth_sessions').doc(sha256(token)).set({ userId: id, username: id, email: `${id}@example.com`, name: id, role: 'student', createdAt: now, expiresAt: now + 60 * 60 * 1000, sessionVersion: 0 });
  return `prep_auth=${token}`;
}

let contended = '';
let expiring = '';

before(async () => {
  contended = await seedLearner('usr_contended');
  expiring = await seedLearner('usr_expiring');
  const app = guardAsyncHandlers(express());
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/auth', authRouter);
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

const send = (method: string, url: string, headers: Record<string, string> = {}, json?: unknown) => rawRequest(origin, method, url, { headers, json, agent });

/** Runs `during` with another writer changing every rate-limit document right after each transaction reads it. */
async function withConcurrentWriter(during: () => Promise<void>): Promise<void> {
  const runTransaction = fake.runTransaction.bind(fake);
  let writes = 0;
  fake.runTransaction = <T,>(run: (tx: FakeTransaction) => Promise<T>): Promise<T> =>
    runTransaction((tx) =>
      run({
        ...tx,
        get: (async (target: Parameters<FakeTransaction['get']>[0]) => {
          const snapshot = await tx.get(target);
          if (target instanceof FakeDocument && target.path.startsWith('rate_limits/')) {
            writes += 1;
            await target.set({ concurrentWriter: writes }, { merge: true });
          }
          return snapshot;
        }) as FakeTransaction['get'],
      }),
    );
  try {
    await during();
  } finally {
    fake.runTransaction = runTransaction;
  }
}

describe('the request limiter on Firestore under contention', () => {
  it('a transaction that loses to concurrent writes on every attempt is 503 — not 429, not 500 — and the same request goes through once the writes stop', async () => {
    const conflictsBefore = fake.conflicts;
    let reply: RawReply | undefined;
    await withConcurrentWriter(async () => {
      reply = await send('GET', '/api/probe', { cookie: contended });
    });
    if (!reply) throw new Error('No reply during contention.');
    expectControlledError('a learner request whose rate-limit transaction never commits', reply, 503, 'storage_unavailable');
    expect(fake.conflicts - conflictsBefore).toBe(5);
    expect((await send('GET', '/api/probe', { cookie: contended })).status).toBe(200);
    const stored = fake.documents.get(`rate_limits/${sha256('api_user:account:usr_contended')}`);
    expect(stored?.count).toBe(1);
  });

  it('every rate_limits document carries expiresAt: a date, exactly when its window closes', async () => {
    const before = Date.now();
    expect((await send('GET', '/api/probe', { cookie: expiring })).status).toBe(200);
    expect((await send('POST', '/api/auth/login', {}, { username: 'nobody_expiring', password: 'not-a-real-password' })).status).toBe(401);
    const after = Date.now();
    const documents: Array<[string, string]> = [
      ['api_user', sha256('api_user:account:usr_expiring')],
      ['login', sha256('login:ip4:127.0.0.1')],
      ['login_account', sha256('login_account:ip4:127.0.0.1|nobody_expiring')],
    ];
    for (const [operation, id] of documents) {
      const stored = fake.documents.get(`rate_limits/${id}`) ?? {};
      const windowStart = Number(stored.windowStart);
      const expiresAt = stored.expiresAt;
      expect([operation, stored.operation, expiresAt instanceof Date]).toEqual([operation, operation, true]);
      expect([operation, windowStart >= before && windowStart <= after]).toEqual([operation, true]);
      expect([operation, expiresAt instanceof Date ? expiresAt.getTime() : NaN]).toEqual([operation, windowStart + RATE_LIMITS[operation as 'api_user' | 'login' | 'login_account'].windowMs]);
    }
  });

  it('an attempt given back while another is being counted: the transactions collide, both land, and the count is right', async () => {
    const key = 'ip4:198.51.100.77';
    const { max } = RATE_LIMITS.login;
    let windowStart = 0;
    for (let index = 0; index < max - 1; index += 1) windowStart = (await requestRateLimitService.check(key, 'login')).windowStart;
    const conflictsBefore = fake.conflicts;
    fake.holdTransactionReads(2);
    const [, counted] = await Promise.all([requestRateLimitService.release(key, 'login', windowStart), requestRateLimitService.check(key, 'login')]);
    expect(counted.allowed).toBe(true);
    expect(fake.conflicts - conflictsBefore).toBeGreaterThan(0);
    expect(fake.documents.get(`rate_limits/${sha256(`login:${key}`)}`)?.count).toBe(max - 1);
  });

  it('nothing is given back from a window that has closed, and never below zero', async () => {
    const key = 'ip4:198.51.100.78';
    const first = await requestRateLimitService.check(key, 'login');
    await requestRateLimitService.release(key, 'login', first.windowStart - RATE_LIMITS.login.windowMs);
    expect(fake.documents.get(`rate_limits/${sha256(`login:${key}`)}`)?.count).toBe(1);
    await requestRateLimitService.release(key, 'login', first.windowStart);
    await requestRateLimitService.release(key, 'login', first.windowStart);
    expect(fake.documents.get(`rate_limits/${sha256(`login:${key}`)}`)?.count).toBe(0);
  });
});
