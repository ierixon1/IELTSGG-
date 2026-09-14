import './env';
import { after, before, describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Firestore } from 'firebase-admin/firestore';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';

/**
 * M3: creating the first administrator of a production (Firestore) deployment.
 *
 * `SEED_DEFAULT_ACCOUNTS` and `ADMIN_PROMOTE_USERNAME` ran only in the local
 * store's constructor, so a Firestore deployment had no supported way to get an
 * administrator: someone had to edit a document by hand. An account that
 * registered normally is now promoted on either store — by `npm run
 * admin:promote`, or by `ADMIN_PROMOTE_USERNAME` when the server starts — and its
 * sessions end so the new role applies from its next sign-in.
 *
 * On the in-memory Firestore, through the real auth and admin routers; the script
 * runs as a child process against a local store.
 */
process.env.STORAGE_BACKEND = 'gcs_firestore';
process.env.GCS_BUCKET_NAME = 'not-used-uploads-are-stubbed';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const originalCwd = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-admin-bootstrap-'));
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
const { authService } = await import('../src/services/authService');

const PASSWORD = 'Bootstrap-Passw0rd-1';
let server: Server;
let origin = '';

before(async () => {
  const app = guardAsyncHandlers(express());
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/admin', enforceAdminSecurity, adminRouter);
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

async function post(url: string, body: unknown, cookie = '') {
  const response = await fetch(`${origin}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const cookies = response.headers.getSetCookie().map((line) => line.split(';')[0]);
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, cookies };
}

async function register(username: string) {
  const reply = await post('/api/auth/register', { email: `${username}@example.com`, username, password: PASSWORD });
  expect(reply.status).toBe(201);
  const user = reply.body.user as { id: string };
  return { id: user.id, cookie: reply.cookies.find((pair) => pair.startsWith('prep_auth=')) ?? '' };
}

describe('the first administrator on Firestore', () => {
  it('a registered account is promoted: the role is stored, its sessions end, and it signs in to the admin API', async () => {
    const account = await register('first_admin');
    expect((await post('/api/admin/login', { username: 'first_admin', password: PASSWORD })).status).toBe(403);

    const sessionsOf = (userId: string) => [...fake.documents.entries()].filter(([documentPath, data]) => documentPath.startsWith('auth_sessions/') && data.userId === userId).length;
    // Registration's session only: the refused staff sign-in above is refused before a session is created (L16).
    expect(sessionsOf(account.id)).toBe(1);
    expect(await authService.promoteAccount('  First_Admin ', 'admin')).toEqual({ outcome: 'promoted', userId: account.id });
    const stored = fake.documents.get(`auth_users/${account.id}`) ?? {};
    expect([stored.role, stored.sessionVersion]).toEqual(['admin', 1]);
    // The account's sessions are deleted, not only refused when next read.
    expect(sessionsOf(account.id)).toBe(0);
    const me = await fetch(`${origin}/api/auth/me`, { headers: { cookie: account.cookie } });
    expect(me.status).toBe(401);

    const staff = await post('/api/admin/login', { username: 'first_admin', password: PASSWORD });
    expect([staff.status, (staff.body.admin as { role?: string } | undefined)?.role]).toEqual([200, 'admin']);
    const adminCookie = staff.cookies.find((pair) => pair.startsWith('prep_admin_auth=')) ?? '';
    expect((await fetch(`${origin}/api/admin/me`, { headers: { cookie: adminCookie } })).status).toBe(200);

    expect(await authService.promoteAccount('first_admin', 'admin')).toEqual({ outcome: 'unchanged', userId: account.id });
    expect(await authService.promoteAccount('no_such_account', 'admin')).toEqual({ outcome: 'not_found' });
  });

  it('ADMIN_PROMOTE_USERNAME is applied on Firestore when the server starts, with the role it names', async () => {
    const account = await register('first_examiner');
    process.env.ADMIN_PROMOTE_USERNAME = 'first_examiner';
    process.env.ADMIN_PROMOTE_ROLE = 'examiner';
    try {
      await authService.applyConfiguredPromotion();
    } finally {
      delete process.env.ADMIN_PROMOTE_USERNAME;
      delete process.env.ADMIN_PROMOTE_ROLE;
    }
    expect(fake.documents.get(`auth_users/${account.id}`)?.role).toBe('examiner');
    expect((await post('/api/admin/login', { username: 'first_examiner', password: PASSWORD })).status).toBe(200);
  });
});

describe('npm run admin:promote', () => {
  it('promotes an account in the local store, and exits 1 for an account that does not exist', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'everstudy-promote-script-'));
    try {
      mkdirSync(path.join(directory, 'data'), { recursive: true });
      const now = new Date().toISOString();
      const account = { id: 'usr_local_learner', email: 'local@example.com', username: 'local_learner', name: 'Local', passwordHash: 'unused', role: 'student', createdAt: now, updatedAt: now, failedLoginAttempts: 0, sessionVersion: 0 };
      writeFileSync(path.join(directory, 'data', 'users.json'), JSON.stringify([account]), 'utf8');
      const run = (...args: string[]) =>
        spawnSync(process.execPath, [path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(REPO_ROOT, 'scripts', 'promoteAccount.ts'), ...args], {
          cwd: directory,
          encoding: 'utf8',
          env: { ...process.env, STORAGE_BACKEND: 'local', NODE_ENV: 'development', ADMIN_PROMOTE_USERNAME: '', SEED_DEFAULT_ACCOUNTS: '' },
          timeout: 120_000,
        });

      const promoted = run('local_learner', 'admin');
      expect([promoted.status, promoted.stdout.includes('Promoted local_learner')]).toEqual([0, true]);
      const stored = (JSON.parse(readFileSync(path.join(directory, 'data', 'users.json'), 'utf8')) as Array<{ role: string; sessionVersion: number }>)[0];
      expect([stored.role, stored.sessionVersion]).toEqual(['admin', 1]);

      expect(run('nobody_here', 'admin').status).toBe(1);
      expect(run('local_learner', 'owner').status).toBe(64);
    } finally {
      removeTempRoot(directory);
    }
  });
});
