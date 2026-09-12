import { after, before, describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Express } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';
import { expectControlledError, type ErrorReply } from './errorAssertions';
import type { FakeTransaction } from './fakeFirestore';
import type { AuthenticatedRequest } from '../src/middleware/authMiddleware';

/**
 * The API error boundary, on its own and in front of the real routers.
 *
 * The first half drives `guardAsyncHandlers` and `apiErrorBoundary` with routes
 * that fail in each way a route can: a rejection, a synchronous throw, a client
 * error that carries its own status, a data backend that cannot be reached, a
 * body that is not JSON, an upload over its limits, a failure after the answer
 * started. Each gets a deterministic answer with nothing internal in it, and the
 * app answers the next request.
 *
 * The second half runs the real admin, auth and authentication middleware
 * against Firestore (the in-memory one) and fails it underneath them: the
 * anonymous public route that had no error handling, and the rate limiter every
 * request passes first. `serverStability.test.ts` does the same over the real
 * `server.ts` with a Firestore that has no credentials at all.
 */

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-error-boundary-'));
process.env.NODE_ENV = 'test';
process.env.STORAGE_BACKEND = 'gcs_firestore';
process.env.GCS_BUCKET_NAME = 'error-boundary-test';
process.chdir(tempRoot);

const express = (await import('express')).default;
const multer = (await import('multer')).default;
const { FakeFirestore, FakeCollection, FakeDocument } = await import('./fakeFirestore');
const fake = new FakeFirestore();
const { setFirestoreDbForTesting } = await import('../src/services/firebaseAdmin');
setFirestoreDbForTesting(fake as unknown as Firestore);
const { guardAsyncHandlers } = await import('../src/http/asyncHandlers');
const { apiErrorBoundary } = await import('../src/http/errorBoundary');
const { ClientRequestError, InvalidIdentifierError } = await import('../src/http/errors');
const { adminRouter } = await import('../src/routes/adminRoutes');
const { authRouter } = await import('../src/routes/authRoutes');
const { enforceAdminSecurity } = await import('../src/middleware/adminSecurityMiddleware');
const { authenticateRequest } = await import('../src/middleware/authMiddleware');
const { checkStorageHealth } = await import('../src/services/storage');

/** What Firestore raises when it cannot be reached: a gRPC status with details. */
function unavailable(): Error {
  return Object.assign(new Error('14 UNAVAILABLE: No connection established'), { code: 14, details: 'No connection established', metadata: {} });
}

/** Switches that fail parts of the in-memory Firestore the way a real outage would. */
const outage = { adminContentQueries: false, transactions: false, documentReads: false, documentReadsHang: false };

const queryPrototype = Object.getPrototypeOf(FakeCollection.prototype) as { get(this: { path: string }): Promise<unknown> };
const queryGet = queryPrototype.get;
queryPrototype.get = function (this: { path: string }) {
  return outage.adminContentQueries && this.path.startsWith('admin_content/') ? Promise.reject(unavailable()) : queryGet.call(this);
};
const documentGet = FakeDocument.prototype.get;
FakeDocument.prototype.get = function (this: InstanceType<typeof FakeDocument>) {
  if (outage.documentReadsHang) return new Promise<never>(() => undefined);
  return outage.documentReads ? Promise.reject(unavailable()) : documentGet.call(this);
};
const runTransaction = fake.runTransaction.bind(fake);
fake.runTransaction = <T,>(run: (tx: FakeTransaction) => Promise<T>): Promise<T> => (outage.transactions ? Promise.reject(unavailable()) : runTransaction(run));

const servers: Server[] = [];
async function listen(app: Express): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function send(url: string, init: { method?: string; cookie?: string; raw?: string; json?: unknown; form?: FormData } = {}): Promise<ErrorReply> {
  const headers: Record<string, string> = {};
  if (init.cookie) headers.cookie = init.cookie;
  if (init.raw !== undefined || init.json !== undefined) headers['Content-Type'] = 'application/json';
  try {
    const response = await fetch(url, {
      method: init.method ?? (init.raw !== undefined || init.json !== undefined || init.form ? 'POST' : 'GET'),
      headers,
      body: init.form ?? init.raw ?? (init.json === undefined ? undefined : JSON.stringify(init.json)),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, type: response.headers.get('content-type') ?? '', text: await response.text() };
  } catch (error) {
    return { status: 0, type: '', text: `no response: ${error instanceof Error ? error.message : String(error)}` };
  }
}

let synthetic = '';
let wired = '';

before(async () => {
  const app = guardAsyncHandlers(express());
  app.use(express.json({ limit: '1kb' }));
  const tinyUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8, files: 1 } });
  app.get('/ok', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/rejects', async () => {
    throw new Error('secret-token-123 at C:\\srv\\app\\src\\thing.ts:12:3');
  });
  app.get('/rejects-with-route', async () => {
    throw 'route';
  });
  app.get('/rejects-with-route', (_req, res) => {
    res.json({ reachedTheNextRoute: true });
  });
  app.get('/throws', () => {
    throw new Error('synchronous secret');
  });
  app.get('/client-error', async () => {
    throw new ClientRequestError(404, 'thing_not_found', 'No such thing.');
  });
  app.get('/invalid-id', async () => {
    throw new InvalidIdentifierError();
  });
  app.get('/firestore-unavailable', async () => {
    throw unavailable();
  });
  app.get('/no-credentials', async () => {
    throw new Error('Could not load the default credentials. Browse to https://cloud.google.com/docs/authentication/getting-started for more information.');
  });
  app.post('/json', (req, res) => {
    res.json({ received: req.body });
  });
  app.post('/upload', tinyUpload.single('file'), (_req, res) => {
    res.json({ uploaded: true });
  });
  app.get('/fails-after-answering', async (_req, res) => {
    res.write('partial');
    await Promise.resolve();
    throw new Error('after the response started');
  });
  app.use(apiErrorBoundary);
  synthetic = await listen(app);

  // The same order as server.ts.
  const routes = guardAsyncHandlers(express());
  routes.use(express.json());
  routes.use('/api/auth', authRouter);
  routes.use('/api/admin', enforceAdminSecurity, adminRouter);
  routes.use('/api', authenticateRequest);
  routes.get('/api/whoami', (req: AuthenticatedRequest, res) => {
    res.json({ userId: req.userId });
  });
  routes.use('/api', apiErrorBoundary);
  wired = await listen(routes);
});

after(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  process.chdir(originalCwd);
  removeTempRoot(tempRoot);
});

async function expectServing(label: string) {
  const reply = await send(`${synthetic}/ok`);
  expect([label, reply.status]).toEqual([label, 200]);
}

describe('the API error boundary', () => {
  it('answers a rejected async handler with a 500 that says nothing about the error, and serves the next request', async () => {
    expectControlledError('rejected handler', await send(`${synthetic}/rejects`), 500, 'internal_error');
    await expectServing('after a rejection');
  });

  it('never lets a rejection act as next("route")', async () => {
    const reply = await send(`${synthetic}/rejects-with-route`);
    expectControlledError('rejection with "route"', reply, 500, 'internal_error');
    expect(reply.text.includes('reachedTheNextRoute')).toBe(false);
  });

  it('answers a synchronous throw the same way', async () => {
    expectControlledError('synchronous throw', await send(`${synthetic}/throws`), 500, 'internal_error');
    await expectServing('after a throw');
  });

  it('keeps the status a client error carries', async () => {
    expectControlledError('client error', await send(`${synthetic}/client-error`), 404, 'thing_not_found');
    expectControlledError('invalid identifier', await send(`${synthetic}/invalid-id`), 400, 'invalid_id');
  });

  it('answers 503 when the data backend cannot be reached, without the library message', async () => {
    expectControlledError('Firestore unavailable', await send(`${synthetic}/firestore-unavailable`), 503, 'storage_unavailable');
    expectControlledError('no credentials', await send(`${synthetic}/no-credentials`), 503, 'storage_unavailable');
    await expectServing('after the backend failures');
  });

  it('answers a body that is not JSON with 400 and an oversized one with 413', async () => {
    expectControlledError('not JSON', await send(`${synthetic}/json`, { raw: '{"unfinished": ' }), 400, 'invalid_json');
    expectControlledError('too large', await send(`${synthetic}/json`, { raw: JSON.stringify({ text: 'x'.repeat(4096) }) }), 413, 'payload_too_large');
    const valid = await send(`${synthetic}/json`, { json: { fine: true } });
    expect([valid.status, JSON.parse(valid.text)]).toEqual([200, { received: { fine: true } }]);
  });

  it('answers upload limits with 413 and 400', async () => {
    const large = new FormData();
    large.append('file', new Blob(['far more than eight bytes']), 'large.txt');
    expectControlledError('file too large', await send(`${synthetic}/upload`, { form: large }), 413, 'file_too_large');
    const two = new FormData();
    two.append('file', new Blob(['a']), 'a.txt');
    two.append('file', new Blob(['b']), 'b.txt');
    expectControlledError('too many files', await send(`${synthetic}/upload`, { form: two }), 400, 'too_many_files');
    const one = new FormData();
    one.append('file', new Blob(['tiny']), 'tiny.txt');
    expect((await send(`${synthetic}/upload`, { form: one })).status).toBe(200);
  });

  it('ends the connection when a handler fails after its answer started, and serves the next request', async () => {
    const reply = await send(`${synthetic}/fails-after-answering`);
    expect(reply.status === 0 || !reply.text.includes('internal_error')).toBe(true);
    await expectServing('after a failure mid-answer');
  });
});

describe('the real routes on Firestore that fails underneath them', () => {
  const token = 'prep_error_boundary_admin_session';
  let adminCookie = '';

  before(async () => {
    const now = Date.now();
    await fake.collection('auth_users').doc('usr_boundary_admin').set({ id: 'usr_boundary_admin', email: 'boundary-admin@example.com', username: 'boundary_admin', name: 'Boundary Admin', passwordHash: 'unused', role: 'admin', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), failedLoginAttempts: 0, sessionVersion: 0 });
    await fake
      .collection('auth_sessions')
      .doc(createHash('sha256').update(token).digest('hex'))
      .set({ userId: 'usr_boundary_admin', username: 'boundary_admin', email: 'boundary-admin@example.com', name: 'Boundary Admin', role: 'admin', createdAt: now, expiresAt: now + 60 * 60 * 1000, sessionVersion: 0 });
    adminCookie = `prep_admin_auth=${token}`;
  });

  it('the anonymous public materials route answers 503 when its query fails, then 200 once Firestore answers', async () => {
    outage.adminContentQueries = true;
    try {
      expectControlledError('public materials during the outage', await send(`${wired}/api/admin/public/materials/reading`), 503, 'storage_unavailable');
    } finally {
      outage.adminContentQueries = false;
    }
    const recovered = await send(`${wired}/api/admin/public/materials/reading`);
    expect([recovered.status, JSON.parse(recovered.text)]).toEqual([200, { items: [] }]);
  });

  it('a rate limiter that cannot reach Firestore is a 503 — not the 429 or 401 it used to be — for admin, learner and sign-in requests', async () => {
    outage.transactions = true;
    try {
      expectControlledError('admin security check', await send(`${wired}/api/admin/public/bundles`), 503, 'storage_unavailable');
      expectControlledError('learner authentication', await send(`${wired}/api/whoami`), 503, 'storage_unavailable');
      expectControlledError('sign-in', await send(`${wired}/api/auth/login`, { json: { username: 'someone', password: 'not-a-real-password' } }), 503, 'storage_unavailable');
    } finally {
      outage.transactions = false;
    }
    expect((await send(`${wired}/api/admin/public/bundles`)).status).toBe(200);
    expect((await send(`${wired}/api/whoami`)).status).toBe(401);
    expect((await send(`${wired}/api/auth/login`, { json: { username: 'someone', password: 'not-a-real-password' } })).status).toBe(401);
  });

  it('a session store that fails is a 503 for an admin, and a cookie that is not valid encoding is still refused', async () => {
    outage.documentReads = true;
    try {
      expectControlledError('admin session lookup', await send(`${wired}/api/admin/materials`, { cookie: adminCookie }), 503, 'storage_unavailable');
    } finally {
      outage.documentReads = false;
    }
    expect((await send(`${wired}/api/admin/materials`, { cookie: adminCookie })).status).toBe(200);
    expect((await send(`${wired}/api/admin/materials`, { cookie: 'prep_admin_auth=%E0%A4%A' })).status).toBe(403);
    const learner = await send(`${wired}/api/whoami`, { cookie: 'prep_auth=%E0%A4%A' });
    expect([learner.status, JSON.parse(learner.text)]).toEqual([401, { error: 'Unauthorized.' }]);
  });

  it('a malformed material id through the real admin router is a 400, and the catalog still loads', async () => {
    expectControlledError('malformed id', await send(`${wired}/api/admin/materials/reading/${'a'.repeat(200)}`, { cookie: adminCookie }), 400, 'invalid_id');
    expect((await send(`${wired}/api/admin/materials`, { cookie: adminCookie })).status).toBe(200);
  });
});

describe('the storage health check', () => {
  it('reports Firestore as it is: ok, unavailable when a read fails, unavailable when a read does not answer in time', async () => {
    expect(await checkStorageHealth()).toEqual({ backend: 'gcs_firestore', status: 'ok' });
    outage.documentReads = true;
    try {
      expect(await checkStorageHealth()).toEqual({ backend: 'gcs_firestore', status: 'unavailable' });
    } finally {
      outage.documentReads = false;
    }
    outage.documentReadsHang = true;
    try {
      expect(await checkStorageHealth(50)).toEqual({ backend: 'gcs_firestore', status: 'unavailable' });
    } finally {
      outage.documentReadsHang = false;
    }
    expect(await checkStorageHealth()).toEqual({ backend: 'gcs_firestore', status: 'ok' });
  });
});
