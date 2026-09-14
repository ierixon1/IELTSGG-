import './env';
import { after, before, describe, it } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import bcrypt from 'bcryptjs';
import type { Firestore } from 'firebase-admin/firestore';
import type { Request, Response } from 'express';
import type { GenerateContentParameters } from '@google/genai';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';
import type { FakeBatch } from './fakeFirestore';
import { readingPayload, speakingPayload, writingPayload } from './bundleFixtures';
import { I18nProvider } from '../src/i18n';
import { MocksHub } from '../src/components/MocksHub';
import { WritingSession } from '../src/components/WritingSession';
import { SpeakingSession } from '../src/components/SpeakingSession';
import { materialToSittable, toPracticeTest } from '../src/services/publishedTests';
import type { SittableTest } from '../src/services/publishedTests';
import type { AdminMaterial } from '../src/types/admin';
import type { SittingQuestion, SkillType } from '../src/types';
import type { AuthenticatedRequest } from '../src/middleware/authMiddleware';
import type { AdminAuditRecord } from '../src/http/adminAudit';

/**
 * Phase 29: the fixes that close the remaining audit findings, each held by what
 * it does rather than by how it is written.
 *
 * In process, on the local store, with the Firestore paths on the in-memory
 * Firestore. `serverHardening.test.ts` covers the same work over the real server.ts.
 */
const REPO_ROOT = process.cwd();
const ADMIN_USER = 'hardening_staff';
const ADMIN_PASSWORD = 'Hardening-Staff-Passw0rd';
const PASSWORD = 'Hardening-Learner-Passw0rd';
process.env.SEED_DEFAULT_ACCOUNTS = 'true';
process.env.ADMIN_USER = ADMIN_USER;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
process.env.GCS_BUCKET_NAME = 'not-used-in-this-suite';
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-final-hardening-'));
process.chdir(tempRoot);

const { FakeFirestore } = await import('./fakeFirestore');
const fake = new FakeFirestore({ concurrency: 'optimistic' });
const { setFirestoreDbForTesting } = await import('../src/services/firebaseAdmin');
setFirestoreDbForTesting(fake as unknown as Firestore);

const express = (await import('express')).default;
const { guardAsyncHandlers } = await import('../src/http/asyncHandlers');
const { apiErrorBoundary } = await import('../src/http/errorBoundary');
const { ClientRequestError } = await import('../src/http/errors');
const { assignRequestId } = await import('../src/http/requestId');
const { adminAuditTrail } = await import('../src/http/adminAudit');
const { securityHeaders, PRODUCTION_CONTENT_SECURITY_POLICY } = await import('../src/http/securityHeaders');
const { installGracefulShutdown } = await import('../src/http/gracefulShutdown');
const { sendAsset } = await import('../src/http/sendAsset');
const { authRouter } = await import('../src/routes/authRoutes');
const { adminRouter } = await import('../src/routes/adminRoutes');
const { enforceAdminSecurity } = await import('../src/middleware/adminSecurityMiddleware');
const { authenticateRequest } = await import('../src/middleware/authMiddleware');
const { authService } = await import('../src/services/authService');
const { adminStore } = await import('../src/services/adminStore');
const { sourceStore } = await import('../src/services/sourceStore');
const { explicitDevAuthEnabled } = await import('../src/config/devAuth');
const { LocalStoreCorruptError, readLocalJson, isJsonArray } = await import('../src/services/storage/localJson');
const { isStorageUnavailableError } = await import('../src/services/storage/availability');
const { namespaceCdiId } = await import('../src/utils/cdiIds');
const { sanitizeHtmlServer } = await import('../src/services/htmlSanitizer');
const grading = await import('../src/services/grading');
const retry = await import('../prompts/geminiRetry');

const DATA = path.join(tempRoot, 'data');
let server: Server;
let origin = '';

before(async () => {
  const app = guardAsyncHandlers(express());
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/admin', enforceAdminSecurity, adminRouter);
  app.use('/api', authenticateRequest);
  app.get('/api/probe', (req: AuthenticatedRequest, res: Response) => res.json({ userId: req.userId }));
  app.use('/api', apiErrorBoundary);
  server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  grading.setGradingProvider(null);
  grading.setGradingPolicy(null);
  process.chdir(REPO_ROOT);
  removeTempRoot(tempRoot);
});

interface Reply {
  status: number;
  headers: Headers;
  body: Record<string, unknown>;
  cookies: string[];
}

async function send(method: string, url: string, options: { json?: unknown; raw?: string; cookie?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  const headers: Record<string, string> = { ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.headers ?? {}) };
  const body = options.raw ?? (options.json === undefined ? undefined : JSON.stringify(options.json));
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${origin}${url}`, { method, headers, body });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { text };
  }
  return { status: response.status, headers: response.headers, body: parsed, cookies: response.headers.getSetCookie().map((line) => line.split(';')[0]) };
}

const post = (url: string, json: unknown, cookie = '') => send('POST', url, { json, cookie });

async function registerLearner(username: string) {
  const reply = await post('/api/auth/register', { email: `${username}@example.com`, username, password: PASSWORD });
  expect([username, reply.status]).toEqual([username, 201]);
  return { id: (reply.body.user as { id: string }).id, cookie: reply.cookies.find((pair) => pair.startsWith('prep_auth=')) ?? '' };
}

async function staffCookie() {
  const reply = await post('/api/admin/login', { username: ADMIN_USER, password: ADMIN_PASSWORD });
  expect(reply.status).toBe(200);
  return reply.cookies.find((pair) => pair.startsWith('prep_admin_auth=')) ?? '';
}

async function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T> | T): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const apply = (entries: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(values);
  try {
    return await run();
  } finally {
    apply(previous);
  }
}

const onFirestore = <T>(run: () => Promise<T>) => withEnv({ STORAGE_BACKEND: 'gcs_firestore' }, run);

async function until(condition: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
}

type StoredUser = { id: string; username: string; passwordHash: string; failedLoginAttempts?: number };
const usersFile = () => path.join(DATA, 'users.json');
const storedUser = (username: string) => (JSON.parse(readFileSync(usersFile(), 'utf8')) as StoredUser[]).find((user) => user.username === username);

/* -------------------------------------------------------------------------- */

describe('M4: a local store file that cannot be read is an outage, never an empty store', () => {
  it('readLocalJson reads a missing file as its fallback and refuses anything else, as storage unavailable', () => {
    const file = path.join(tempRoot, 'probe.json');
    expect(readLocalJson(file, ['fallback'], isJsonArray)).toEqual(['fallback']);
    for (const [label, content] of [['truncated', '[{"id": "a'], ['wrong shape', '{"id":"a"}'], ['empty', '']] as const) {
      writeFileSync(file, content, 'utf8');
      let thrown: unknown = null;
      try {
        readLocalJson(file, [], isJsonArray);
      } catch (error) {
        thrown = error;
      }
      expect([label, thrown instanceof LocalStoreCorruptError, isStorageUnavailableError(thrown)]).toEqual([label, true, true]);
    }
  });

  it('a corrupt accounts, rate-limit or materials file answers 503 and is left exactly as it was', async () => {
    const staff = await staffCookie();
    const corrupt = '[{"id": "usr_truncated", "username": "half-writ';

    const expectOutage = async (file: string, requests: Array<() => Promise<Reply>>) => {
      const original = existsSync(file) ? readFileSync(file) : null;
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, corrupt, 'utf8');
      try {
        for (const request of requests) {
          const reply = await request();
          expect([path.basename(file), reply.status, reply.body.code]).toEqual([path.basename(file), 503, 'storage_unavailable']);
        }
        expect([path.basename(file), readFileSync(file, 'utf8')]).toEqual([path.basename(file), corrupt]);
      } finally {
        if (original) writeFileSync(file, original);
        else writeFileSync(file, '[]', 'utf8');
      }
    };

    await expectOutage(usersFile(), [
      () => post('/api/auth/login', { username: 'anyone_here', password: PASSWORD }),
      () => post('/api/auth/register', { email: 'm4@example.com', username: 'm4_learner', password: PASSWORD }),
    ]);
    await expectOutage(path.join(DATA, 'admin_content', 'reading.json'), [
      () => send('GET', '/api/admin/materials?section=reading', { cookie: staff }),
      () => post('/api/admin/materials/reading', readingPayload(1), staff),
    ]);
    const limits = path.join(DATA, 'request_rate_limits.json');
    const limitsOriginal = readFileSync(limits);
    writeFileSync(limits, '{"truncated": ', 'utf8');
    try {
      const reply = await post('/api/auth/login', { username: ADMIN_USER, password: ADMIN_PASSWORD });
      expect([reply.status, reply.body.code, readFileSync(limits, 'utf8')]).toEqual([503, 'storage_unavailable', '{"truncated": ']);
    } finally {
      writeFileSync(limits, limitsOriginal);
    }
    // Everything works again once the files are readable.
    expect((await post('/api/auth/login', { username: ADMIN_USER, password: ADMIN_PASSWORD })).status).toBe(200);
  });
});

describe('M5: the material store sanitises what a learner screen renders as HTML, whoever wrote it', () => {
  it('passage and prompt markup is sanitised on save, plain text is kept verbatim, and saving it again changes nothing', async () => {
    const reading = structuredClone(readingPayload(2));
    reading.content.passage.text = '<p>Pigeons navigate by the sun.</p><script>alert(1)</script><img src="x" onerror="alert(2)"><a href="javascript:alert(3)">more</a>';
    const saved = await adminStore.saveMaterial('reading', reading);
    const text = (saved as unknown as { content: { passage: { text: string } } }).content.passage.text;
    expect([text.includes('<p>Pigeons navigate by the sun.</p>'), text.includes('<script'), text.includes('onerror'), text.includes('javascript:')]).toEqual([true, false, false, false]);

    // Only a published material can be "unchanged" (a draft save always writes). Sanitised markup must read as the
    // same content when it is saved back as it was opened, or every such save would silently unpublish it.
    const collection = path.join(DATA, 'admin_content', 'reading.json');
    const rows = JSON.parse(readFileSync(collection, 'utf8')) as Array<Record<string, unknown>>;
    writeFileSync(collection, JSON.stringify(rows.map((row) => (row.id === saved.id ? { ...row, status: 'published' } : row))), 'utf8');
    const again = await adminStore.saveMaterialDetailed('reading', saved, 'Admin', { expectedUpdatedAt: saved.updatedAt });
    expect([again.unchanged, again.unpublished, again.material.status]).toEqual([true, false, 'published']);

    const plain = structuredClone(readingPayload(3));
    const verbatim = 'Speed < 5 knots & depth > 10 metres — "dead reckoning" still works.';
    plain.content.passage.text = verbatim;
    const kept = await adminStore.saveMaterial('reading', plain);
    expect((kept as unknown as { content: { passage: { text: string } } }).content.passage.text).toBe(verbatim);

    const writing = structuredClone(writingPayload('academic'));
    writing.content.task.task1 = { title: 'Task 1', prompt: '<b onclick="steal()">Summarise</b> the chart.' };
    const written = await adminStore.saveMaterial('writing', writing);
    const task = (written as unknown as { content: { task: { task1: { prompt: string }; task2: { prompt: string } } } }).content.task;
    expect([task.task1.prompt, task.task2.prompt]).toEqual(['<b>Summarise</b> the chart.', 'To what extent should cities ban cars?']);
  });

  it('sanitising is idempotent: ids are not namespaced twice and a blocked image stays the same placeholder', () => {
    expect(namespaceCdiId(namespaceCdiId('q1'))).toBe(namespaceCdiId('q1'));
    const once = sanitizeHtmlServer('<p id="q1" class="cdi-note text-center rounded">Question</p><a href="#q1">back</a><img src="https://images.example/chart.png" onerror="alert(1)"><table style="width:50%;position:fixed"><tr><td>1</td></tr></table>');
    expect([once.includes('[External image blocked]'), once.includes('images.example'), once.includes('onerror'), once.includes('position')]).toEqual([true, false, false, false]);
    expect(sanitizeHtmlServer(once)).toBe(once);
  });
});

describe('M7: request ids and the admin audit trail', () => {
  it('records state-changing admin requests with the route, params, status and request id — and never the body or a password', async () => {
    const lines: string[] = [];
    const router = express.Router();
    router.post('/things/:id', (_req: Request, res: Response) => res.status(201).json({ ok: true }));
    router.get('/things', (_req: Request, res: Response) => res.json({ ok: true }));
    router.post('/login', (_req: Request, res: Response) => res.status(401).json({ error: 'Invalid credentials.' }));
    const app = express();
    app.use(assignRequestId);
    app.use('/api/admin', adminAuditTrail((line) => lines.push(line)), express.json(), router);
    const probe = await new Promise<Server>((resolve) => {
      const started = app.listen(0, '127.0.0.1', () => resolve(started));
    });
    try {
      const base = `http://127.0.0.1:${(probe.address() as AddressInfo).port}/api/admin`;
      const created = await fetch(`${base}/things/42`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: 'body-value' }) });
      await fetch(`${base}/things`);
      const login = await fetch(`${base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: '  Some.Staff ', password: 'the-password-123' }) });
      await until(() => lines.length >= 2);
      const records = lines.map((line) => JSON.parse(line) as AdminAuditRecord);
      expect(records.map(({ at: _at, ...rest }) => rest)).toEqual([
        { type: 'admin_audit', requestId: created.headers.get('x-request-id') ?? '', actor: null, method: 'POST', route: '/api/admin/things/:id', params: { id: '42' }, status: 201 },
        { type: 'admin_audit', requestId: login.headers.get('x-request-id') ?? '', actor: null, method: 'POST', route: '/api/admin/login', params: {}, status: 401, subject: 'some.staff' },
      ]);
      expect([lines.join('').includes('the-password-123'), lines.join('').includes('body-value')]).toEqual([false, false]);
    } finally {
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
  });

  it('the error boundary writes the request id the response carried', async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    const app = express();
    app.use(assignRequestId);
    app.get('/api/fails', () => {
      throw new ClientRequestError(409, 'already_taken', 'Already taken.');
    });
    app.use('/api', apiErrorBoundary);
    const probe = await new Promise<Server>((resolve) => {
      const started = app.listen(0, '127.0.0.1', () => resolve(started));
    });
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      const reply = await fetch(`http://127.0.0.1:${(probe.address() as AddressInfo).port}/api/fails`);
      const id = reply.headers.get('x-request-id') ?? 'missing';
      expect([reply.status, warnings.some((line) => line === `[HTTP] GET /api/fails -> 409 already_taken: Already taken. [request ${id}]`)]).toEqual([409, true]);
    } finally {
      console.warn = originalWarn;
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
  });
});

describe('M2: security headers', () => {
  const headersOf = async (production: boolean) => {
    const app = express();
    app.use(securityHeaders({ production }));
    app.get('/', (_req: Request, res: Response) => res.send('ok'));
    const probe = await new Promise<Server>((resolve) => {
      const started = app.listen(0, '127.0.0.1', () => resolve(started));
    });
    try {
      return (await fetch(`http://127.0.0.1:${(probe.address() as AddressInfo).port}/`)).headers;
    } finally {
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
  };

  it('production adds HSTS and a CSP that allows only the app’s own scripts and no framing', async () => {
    const production = await headersOf(true);
    expect([production.get('strict-transport-security'), production.get('content-security-policy'), production.get('x-frame-options')]).toEqual(['max-age=31536000; includeSubDomains', PRODUCTION_CONTENT_SECURITY_POLICY, 'DENY']);
    const directives = PRODUCTION_CONTENT_SECURITY_POLICY.split('; ');
    expect([directives.find((d) => d.startsWith('script-src')), directives.includes("frame-ancestors 'none'"), directives.includes("object-src 'none'"), PRODUCTION_CONTENT_SECURITY_POLICY.includes('unsafe-eval')]).toEqual(["script-src 'self'", true, true, false]);
    const development = await headersOf(false);
    expect([development.get('content-security-policy'), development.get('strict-transport-security'), development.get('x-content-type-options')]).toEqual([null, null, 'nosniff']);
  });

  it('the browser app tells Zod not to probe `new Function` — which the CSP reports as a violation — before any other module loads', async () => {
    const entry = readFileSync(path.join(REPO_ROOT, 'src', 'main.tsx'), 'utf8');
    expect(entry.split(/\r?\n/).find((line) => line.startsWith('import '))).toBe("import './zodBrowserConfig';");
    const { z } = await import('zod');
    await import('../src/zodBrowserConfig');
    expect(z.config().jitless).toBe(true);
  });

  it('the built app shell needs nothing the CSP refuses: no inline script', () => {
    const shell = readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
    const scripts = [...shell.matchAll(/<script\b[^>]*>/gi)].map((match) => match[0]);
    expect(scripts.every((tag) => /\bsrc=/.test(tag))).toBe(true);
    expect(/\son[a-z]+=/i.test(shell)).toBe(false);
  });
});

describe('M10 and L9 on the in-memory Firestore', () => {
  function recordCommits() {
    const original = fake.batch.bind(fake);
    const sizes: number[] = [];
    fake.batch = () => {
      const inner = original();
      let size = 0;
      const count = () => {
        size += 1;
        // Firestore documents 500 writes per commit; the code must never need more.
        if (size > 500) throw new Error('A commit of more than 500 writes.');
      };
      const batch: FakeBatch = {
        set: (ref, data, options) => (count(), inner.set(ref, data, options), batch),
        update: (ref, data) => (count(), inner.update(ref, data), batch),
        create: (ref, data) => (count(), inner.create(ref, data), batch),
        delete: (ref) => (count(), inner.delete(ref), batch),
        commit: async () => {
          sizes.push(size);
          await inner.commit();
        },
      };
      return batch;
    };
    return { sizes, restore: () => void (fake.batch = original) };
  }

  it('a session carries expireAt, the timestamp the auth_sessions TTL policy reads, at the moment it expires (L9)', async () => {
    const { user } = await onFirestore(() => authService.register({ email: 'ttl@example.com', username: 'ttl_user', password: PASSWORD }));
    await onFirestore(() => authService.login('ttl_user', PASSWORD));
    const sessions = [...fake.documents.entries()].filter(([documentPath, data]) => documentPath.startsWith('auth_sessions/') && data.userId === user.id).map(([, data]) => data);
    expect(sessions.length).toBe(2);
    for (const session of sessions) {
      const expireAt = session.expireAt;
      expect([expireAt instanceof Date, expireAt instanceof Date && expireAt.getTime() === session.expiresAt]).toEqual([true, true]);
    }
  });

  it('ending 900 sessions and deleting a 900-chunk source never puts more than 400 deletes in one commit (M10)', async () => {
    const { user } = await onFirestore(() => authService.register({ email: 'many@example.com', username: 'many_sessions', password: PASSWORD }));
    for (let index = 0; index < 899; index++) fake.documents.set(`auth_sessions/extra-${index}`, { userId: user.id, role: 'student', expiresAt: Date.now() + 60_000, sessionVersion: 0 });
    const sessions = recordCommits();
    try {
      expect((await onFirestore(() => authService.promoteAccount('many_sessions', 'examiner'))).outcome).toBe('promoted');
    } finally {
      sessions.restore();
    }
    const left = [...fake.documents.entries()].filter(([documentPath, data]) => documentPath.startsWith('auth_sessions/') && data.userId === user.id).length;
    expect([left, sessions.sizes.reduce((total, size) => total + size, 0), Math.max(...sessions.sizes) <= 400]).toEqual([0, 900, true]);

    const source = 'admin_content/sources/items/src-m10-0001';
    fake.documents.set(source, { id: 'src-m10-0001', title: 'A long book' });
    for (let index = 0; index < 900; index++) fake.documents.set(`${source}/chunks/chunk-${index}`, { id: `chunk-${index}`, ordinal: index });
    const chunks = recordCommits();
    try {
      expect(await onFirestore(() => sourceStore.delete('src-m10-0001'))).toBe(true);
    } finally {
      chunks.restore();
    }
    const remaining = [...fake.documents.keys()].filter((documentPath) => documentPath.startsWith(source)).length;
    expect([remaining, chunks.sizes.reduce((total, size) => total + size, 0), Math.max(...chunks.sizes) <= 400]).toEqual([0, 900, true]);
  });
});

describe('L16 and M13: signing in', () => {
  it('a learner with the right password at staff sign-in is refused before any session exists, and is not counted as a guess (L16)', async () => {
    const learner = await registerLearner('l16_learner');
    const replies: Reply[] = [];
    for (let attempt = 0; attempt < 8; attempt++) replies.push(await post('/api/admin/login', { username: 'l16_learner', password: PASSWORD }));
    // Five failures for one account name would be 429 from the sixth; a refused role is not a failure.
    expect(replies.map((reply) => reply.status)).toEqual([403, 403, 403, 403, 403, 403, 403, 403]);
    expect(replies.some((reply) => reply.cookies.some((pair) => pair.startsWith('prep_admin_auth=')))).toBe(false);
    const sessions = JSON.parse(readFileSync(path.join(DATA, 'sessions.json'), 'utf8')) as Record<string, { userId: string }>;
    expect(Object.values(sessions).filter((session) => session.userId === learner.id).length).toBe(1);
    expect((await send('GET', '/api/auth/me', { cookie: learner.cookie })).status).toBe(200);
    expect(await staffCookie()).toContain('prep_admin_auth=');
  });

  it('hashing and comparing a password yield the event loop (M13)', async () => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 1);
    try {
      await authService.register({ email: 'loop@example.com', username: 'event_loop', password: PASSWORD });
      const afterRegister = ticks;
      await authService.login('event_loop', PASSWORD);
      expect([afterRegister > 0, ticks > afterRegister]).toEqual([true, true]);
    } finally {
      clearInterval(timer);
    }
  });

  it('a password changed while a sign-in compares is not accepted on the old hash, and concurrent failures all count (M13)', async () => {
    await authService.register({ email: 'race@example.com', username: 'race_user', password: PASSWORD });
    const pending = authService.login('race_user', PASSWORD);
    const users = JSON.parse(readFileSync(usersFile(), 'utf8')) as StoredUser[];
    const target = users.find((user) => user.username === 'race_user');
    if (!target) throw new Error('race_user was not stored');
    target.passwordHash = bcrypt.hashSync('Changed-Passw0rd-123', 4);
    writeFileSync(usersFile(), JSON.stringify(users), 'utf8');
    expect(await pending.then(() => 'signed in', (error: unknown) => (error instanceof Error ? error.message : String(error)))).toBe('Invalid credentials.');

    await authService.register({ email: 'count@example.com', username: 'count_user', password: PASSWORD });
    await Promise.allSettled([authService.login('count_user', 'wrong-password-1'), authService.login('count_user', 'wrong-password-2'), authService.login('count_user', 'wrong-password-3')]);
    expect(storedUser('count_user')?.failedLoginAttempts).toBe(3);
  });
});

describe('M11: the development impersonation switch', () => {
  it('is on only when NODE_ENV is development or test', async () => {
    const cases: Array<[string | undefined, string, boolean]> = [
      ['test', 'true', true],
      ['development', 'true', true],
      [undefined, 'true', false],
      ['', 'true', false],
      ['staging', 'true', false],
      ['production', 'true', false],
      ['development', 'false', false],
    ];
    for (const [nodeEnv, flag, enabled] of cases) {
      expect([nodeEnv, flag, await withEnv({ NODE_ENV: nodeEnv, EXPLICIT_DEV_AUTH: flag }, () => explicitDevAuthEnabled())]).toEqual([nodeEnv, flag, enabled]);
    }
  });

  it('with NODE_ENV unset or staging, x-user-id signs nobody in and password recovery hands out no token', async () => {
    const learner = await registerLearner('m11_learner');
    const probe = () => send('GET', '/api/probe', { headers: { 'x-user-id': learner.id } });
    const recover = () => post('/api/auth/forgot-password', { email: 'm11_learner@example.com' });
    const inTest = await withEnv({ EXPLICIT_DEV_AUTH: 'true' }, async () => [await probe(), await recover()] as const);
    expect([inTest[0].status, inTest[0].body.userId, typeof inTest[1].body.devResetToken]).toEqual([200, learner.id, 'string']);
    for (const nodeEnv of [undefined, 'staging']) {
      const [signedIn, recovered] = await withEnv({ NODE_ENV: nodeEnv, EXPLICIT_DEV_AUTH: 'true' }, async () => [await probe(), await recover()] as const);
      expect([nodeEnv, signedIn.status, recovered.status, recovered.body.devResetToken]).toEqual([nodeEnv, 401, 200, undefined]);
    }
  });
});

describe('L10: a grade is recorded only with a valid band for every criterion', () => {
  const ESSAY = Array.from({ length: 12 }, () => 'Energy use rose steadily across the period while coal fell and wind power rose sharply after 2010.').join(' ');
  const writingCriterion = (band: unknown) => ({ name: 'Task Achievement', band, justification: 'Fixture.', improvement_tips: [] });
  const speakingCriterion = (band: unknown) => ({ name: 'Criterion', band, justification: 'Fixture.', improvement_tips: [] });
  const speakingCriteria = (pronunciation: unknown) => ({ fluency_coherence: speakingCriterion(7), lexical_resource: speakingCriterion(6.5), grammatical_range: speakingCriterion(7), pronunciation: speakingCriterion(pronunciation) });
  let learner = 0;
  const context = () => ({ userId: `usr_bandsLearner${String(++learner).padStart(3, '0')}` });

  const answering = (answer: unknown) => {
    grading.setGradingPolicy({ attemptTimeoutMs: 500, totalTimeoutMs: 2_000, initialDelayMs: 0, maxDelayMs: 0 });
    grading.setGradingProvider({ name: 'test', generate: async (_request: GenerateContentParameters) => ({ text: JSON.stringify(answer) }) });
  };
  const outcomeOf = (outcome: { ok: true; result: { band_overall: number } } | { ok: false; status: number; body: { code?: string } }) => (outcome.ok ? ['ok', outcome.result.band_overall] : [outcome.status, outcome.body.code]);

  it('Writing: a listed criterion band out of range, between half bands or missing is refused 502', async () => {
    const writing = { taskType: 'task1', prompt: 'Summarise the chart of energy use.', essay: ESSAY, module: 'academic' };
    const cases: Array<[string, unknown, unknown[]]> = [
      ['valid', [writingCriterion(6.5), writingCriterion(7)], ['ok', 6.5]],
      ['no criteria', [], [502, 'invalid_model_response']],
      ['quarter band', [writingCriterion(6.25)], [502, 'invalid_model_response']],
      ['above nine', [writingCriterion(9.5)], [502, 'invalid_model_response']],
      ['string band', [writingCriterion('6')], [502, 'invalid_model_response']],
      ['named instead of listed', { task_achievement: writingCriterion(6) }, [502, 'invalid_model_response']],
    ];
    for (const [label, criteria, expected] of cases) {
      answering({ band_overall: 6.5, criteria, annotated_text: [], general_commentary: 'Fixture.' });
      expect([label, ...outcomeOf(await grading.gradeWritingSubmission(writing, context()))]).toEqual([label, ...expected]);
    }
  });

  it('Speaking: each of the four named criteria needs a valid band — the shape the Speaking schema asks for', async () => {
    const speaking = { partNumber: 1, topic: 'Home', transcriptProvided: 'I live in a small flat near the river, and I like the quiet evenings there most of all.' };
    const answer = (criteria: unknown) => ({ band_overall: 7, transcript: 'I live in a small flat.', criteria, objective_metrics: { durationSeconds: 30, wordsPerMinute: 120, pausesCount: 1, totalPauseDurationSeconds: 1, fillerWords: [] }, actionable_drills: [] });
    const { pronunciation: _dropped, ...threeCriteria } = speakingCriteria(7);
    const cases: Array<[string, unknown, unknown[]]> = [
      ['valid', speakingCriteria(7.5), ['ok', 7]],
      ['a criterion between half bands', speakingCriteria(6.3), [502, 'invalid_model_response']],
      ['a criterion missing', threeCriteria, [502, 'invalid_model_response']],
      ['listed instead of named', [speakingCriterion(7)], [502, 'invalid_model_response']],
    ];
    for (const [label, criteria, expected] of cases) {
      answering(answer(criteria));
      expect([label, ...outcomeOf(await grading.gradeSpeakingSubmission(speaking, context()))]).toEqual([label, ...expected]);
    }
  });
});

describe('L13, L1 and graceful shutdown', () => {
  it('executeGeminiWithRetry hands each attempt its abort signal, and the mentor chat passes it to the SDK (L13)', async () => {
    const signals: AbortSignal[] = [];
    const value = await retry.executeGeminiWithRetry(async (signal) => {
      signals.push(signal);
      return 'answer';
    }, 0, 1);
    expect([value, signals.length, signals[0] instanceof AbortSignal, signals[0]?.aborted]).toEqual(['answer', 1, true, false]);
    expect(readFileSync(path.join(REPO_ROOT, 'server.ts'), 'utf8')).toContain('chat.sendMessage({message:latest,config:{abortSignal:signal}})');
  });

  it('a download’s filename cannot end or extend its Content-Disposition header (L1)', async () => {
    const app = express();
    app.get('/file/:name', (req: Request, res: Response) => sendAsset(req, res, { mimeType: 'application/zip', originalName: String(req.query.name) }, Buffer.from('PK')));
    const probe = await new Promise<Server>((resolve) => {
      const started = app.listen(0, '127.0.0.1', () => resolve(started));
    });
    try {
      const base = `http://127.0.0.1:${(probe.address() as AddressInfo).port}/file/x?name=`;
      const disposition = async (name: string) => (await fetch(`${base}${encodeURIComponent(name)}`)).headers.get('content-disposition');
      expect(await disposition(`report"; filename*=UTF-8''evil.html`)).toBe('attachment; filename="report__ filename__UTF-8__evil.html"');
      expect(await disposition('Band 7 answers.docx')).toBe('attachment; filename="Band 7 answers.docx"');
    } finally {
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
  });

  const heldServer = async () => {
    let arrived!: () => void;
    const reached = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const probe = http.createServer((_req, res) => {
      arrived();
      void held.then(() => res.end('done'));
    });
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
    const port = (probe.address() as AddressInfo).port;
    const request = () =>
      new Promise<string>((resolve) => {
        const outgoing = http.get({ host: '127.0.0.1', port, path: '/', agent: false }, (response) => {
          let body = '';
          response.on('data', (chunk: Buffer) => {
            body += String(chunk);
          });
          response.on('end', () => resolve(body));
        });
        outgoing.on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'));
      });
    return { probe, reached, release, request };
  };

  it('on SIGTERM the server stops accepting, lets the request in flight finish, then exits 0 — once', async () => {
    const { probe, reached, release, request } = await heldServer();
    const exits: number[] = [];
    let exited!: (code: number) => void;
    const exit = new Promise<number>((resolve) => {
      exited = resolve;
    });
    const shutdown = installGracefulShutdown(probe, { signals: [], timeoutMs: 5_000, log: () => undefined, exit: (code) => (exits.push(code), exited(code)) });
    // Released and closed however the assertions go, so a failure fails the test instead of holding it open.
    try {
      const inFlight = request();
      await reached;
      shutdown('SIGTERM');
      shutdown('SIGTERM');
      expect(await request()).toBe('ECONNREFUSED');
      release();
      expect([await inFlight, await exit]).toEqual(['done', 0]);
      expect(exits).toEqual([0]);
    } finally {
      release();
      probe.closeAllConnections();
      if (probe.listening) probe.close();
    }
  });

  it('exits 1 when a request is still in flight at the shutdown timeout', async () => {
    const { probe, reached, release, request } = await heldServer();
    let exited!: (code: number) => void;
    const exit = new Promise<number>((resolve) => {
      exited = resolve;
    });
    const shutdown = installGracefulShutdown(probe, { signals: [], timeoutMs: 100, log: () => undefined, exit: (code) => exited(code) });
    try {
      const inFlight = request();
      await reached;
      shutdown('SIGTERM');
      expect(await exit).toBe(1);
      release();
      await inFlight;
    } finally {
      release();
      probe.closeAllConnections();
      if (probe.listening) probe.close();
    }
  });
});

describe('M15 and L4: what the learner is told', () => {
  const published = (payload: object, id: string): AdminMaterial => ({ id, status: 'published', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...payload }) as AdminMaterial;
  const practice = (payload: object, id: string): SittableTest<SittingQuestion> => toPracticeTest(materialToSittable(published(payload, id)).test);
  const render = (element: ReactElement) => renderToStaticMarkup(createElement(I18nProvider, null, element));
  const hub = (test: SittableTest<SittingQuestion>, section: SkillType) =>
    render(createElement(MocksHub, { mockTest: test, onMarkPractice: () => Promise.reject(new Error('not marked in a render test')), onRecordScore: () => {}, initialSelectedSection: section }));
  const noop = () => {};

  it('an exam’s Writing and Speaking screens say only submitted work, submitted in time, is graded; practice does not (M15)', () => {
    const writing = practice(writingPayload('academic'), 'wri-m15');
    const writingExam = render(
      createElement(WritingSession, {
        examMode: true,
        task1Data: writing.writing.task1 ?? undefined,
        task2Data: writing.writing.task2 ?? undefined,
        module: 'academic',
        submit: () => Promise.reject(new Error('not submitted in a render test')),
        initialDrafts: {},
        gradedTasks: {},
        onRetryGrading: noop,
        onDraftChange: noop,
      }),
    );
    expect([writingExam.includes('id="writing-deadline-notice"'), writingExam.includes('Only work you submit is graded.')]).toEqual([true, true]);
    expect(hub(writing, 'writing').includes('deadline-notice')).toBe(false);

    const speakingTest = practice(speakingPayload(), 'spk-m15');
    if (!speakingTest.speaking) throw new Error('fixture has no Speaking');
    const speakingExam = render(
      createElement(SpeakingSession, {
        examMode: true,
        speakingData: speakingTest.speaking,
        submit: () => Promise.reject(new Error('not submitted in a render test')),
        gradedParts: {},
        onRetryGrading: noop,
      }),
    );
    expect([speakingExam.includes('id="speaking-deadline-notice"'), speakingExam.includes('Only work you submit is graded.')]).toEqual([true, true]);
    expect(hub(speakingTest, 'speaking').includes('deadline-notice')).toBe(false);
  });

  it('an incomplete test no longer claims built-in material stands in for what it lacks, in any language (L4)', () => {
    for (const locale of ['en', 'ru', 'uz']) {
      const source = readFileSync(path.join(REPO_ROOT, 'src', 'i18n', 'locales', `${locale}.ts`), 'utf8');
      const line = source.split('\n').find((entry) => entry.trim().startsWith('incompleteBody:') && entry.includes('{sections}')) ?? '';
      expect([locale, /built-in|встроенн|oʻrnatilgan|o‘rnatilgan/i.test(line), source.includes('deadlineNotice:')]).toEqual([locale, false, true]);
    }
  });
});

describe('deployment files and removed code', () => {
  it('Firestore rules refuse every client read and write, and the field settings declare both TTL policies', () => {
    const rules = readFileSync(path.join(REPO_ROOT, 'firestore.rules'), 'utf8');
    const allows = [...rules.matchAll(/allow [^;]+;/g)].map((match) => match[0]);
    expect(allows).toEqual(['allow read, write: if false;']);
    const indexes = JSON.parse(readFileSync(path.join(REPO_ROOT, 'firestore.indexes.json'), 'utf8')) as { fieldOverrides: Array<{ collectionGroup: string; fieldPath: string; ttl?: boolean }> };
    expect(indexes.fieldOverrides.map(({ collectionGroup, fieldPath, ttl }) => [collectionGroup, fieldPath, ttl])).toEqual([
      ['rate_limits', 'expiresAt', true],
      ['auth_sessions', 'expireAt', true],
    ]);
  });

  it('CI runs the whole suite, and the unused mock API, demo generator and audit-log service are gone (L7)', () => {
    expect(readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'security.yml'), 'utf8')).toContain('run: npm test');
    const gone = ['src/routes/mockRoutes.ts', 'src/services/mockGenerator.ts', 'src/schemas/mockGeneratorSchema.ts', 'src/services/auditLogService.ts', 'prompts/generateReading.ts', 'prompts/generateListening.ts', 'prompts/generateWriting.ts', 'prompts/generateSpeaking.ts'];
    expect(gone.filter((file) => existsSync(path.join(REPO_ROOT, file)))).toEqual([]);
    expect(readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8').includes('/api/mocks')).toBe(false);
  });
});
