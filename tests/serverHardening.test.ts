import './env';
import { after, before, describe, it } from 'node:test';
import { expect } from './harness';
import { startServer, type ServerProcess } from './serverProcess';
import type { AdminAuditRecord } from '../src/http/adminAudit';

/**
 * Phase 29 over the real `server.ts`: what every response carries, how much body
 * a caller may send, the inline AI routes' checks, and the admin audit trail.
 *
 *   - M2: security headers on every response, no `X-Powered-By`;
 *   - M7: a server-made request id on every response, on the error boundary's log
 *     line, and on an audit record for every state-changing admin request;
 *   - L3: an /api path no route answers is a JSON 404, never the app shell;
 *   - L11: sign-in and anonymous admin requests read at most 64 kB, and nothing
 *     else reads a body before the request is signed in;
 *   - M14: the AI routes defined in server.ts refuse an anonymous caller and bad
 *     input before any model, and answer 503 when no model is configured.
 */

const STAFF_USER = 'hardening_admin';
const STAFF_PASSWORD = 'Hardening-Passw0rd-2026-x';
const LEARNER_PASSWORD = 'Hardening-Learner-Passw0rd';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ESSAY = Array.from({ length: 12 }, () => 'Energy use rose steadily across the period while coal fell and wind power rose sharply after 2010.').join(' ');

let server: ServerProcess;
let learnerCookie = '';
let staffCookie = '';

interface Reply {
  status: number;
  headers: Headers;
  text: string;
  body: Record<string, unknown> | null;
}

async function call(method: string, url: string, options: { cookie?: string; json?: unknown; raw?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  const headers: Record<string, string> = { ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.headers ?? {}) };
  let body: string | undefined;
  if (options.json !== undefined) body = JSON.stringify(options.json);
  if (options.raw !== undefined) body = options.raw;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${server.origin}${url}`, { method, headers, body, signal: AbortSignal.timeout(60_000) });
  const text = await response.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  return { status: response.status, headers: response.headers, text, body: parsed };
}

const cookieOf = (headers: Headers, name: string) =>
  headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .find((pair) => pair.startsWith(`${name}=`)) ?? '';

/** The audit records the server has written so far that match, waiting briefly for ones written after a response. */
async function auditRecords(matches: (record: AdminAuditRecord) => boolean, atLeast = 1): Promise<AdminAuditRecord[]> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const records = [...server.output().matchAll(/^\{"type":"admin_audit"[^\n]*\}/gm)].map((match) => JSON.parse(match[0]) as AdminAuditRecord);
    const found = records.filter(matches);
    if (found.length >= atLeast || Date.now() > deadline) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

before(async () => {
  server = await startServer({ NODE_ENV: 'development', STORAGE_BACKEND: 'local', SEED_DEFAULT_ACCOUNTS: 'true', ADMIN_USER: STAFF_USER, ADMIN_PASSWORD: STAFF_PASSWORD }, 120_000);
  const registered = await call('POST', '/api/auth/register', { json: { username: 'hardening_learner', email: 'hardening@example.com', password: LEARNER_PASSWORD } });
  expect(registered.status).toBe(201);
  learnerCookie = cookieOf(registered.headers, 'prep_auth');
  const staff = await call('POST', '/api/admin/login', { json: { username: STAFF_USER, password: STAFF_PASSWORD } });
  expect(staff.status).toBe(200);
  staffCookie = cookieOf(staff.headers, 'prep_admin_auth');
});

after(async () => {
  await server?.stop();
});

describe('what every response carries (M2, M7)', () => {
  it('security headers, no X-Powered-By, and a request id the server made — never the one the client sent', async () => {
    const first = await call('GET', '/api/health', { headers: { 'X-Request-Id': 'forged-by-the-client' } });
    const second = await call('GET', '/api/health');
    const shell = await call('GET', '/');
    for (const [label, reply] of [['health', first], ['app shell', shell]] as const) {
      expect([
        label,
        reply.headers.get('x-content-type-options'),
        reply.headers.get('x-frame-options'),
        reply.headers.get('referrer-policy'),
        reply.headers.get('cross-origin-opener-policy'),
        reply.headers.get('permissions-policy'),
        reply.headers.get('x-powered-by'),
      ]).toEqual([label, 'nosniff', 'DENY', 'strict-origin-when-cross-origin', 'same-origin', 'camera=(), geolocation=(), payment=(), usb=(), microphone=(self)', null]);
    }
    const ids = [first.headers.get('x-request-id') ?? '', second.headers.get('x-request-id') ?? ''];
    expect(ids.map((id) => UUID.test(id))).toEqual([true, true]);
    expect([ids[0] === ids[1], ids[0] === 'forged-by-the-client']).toEqual([false, false]);
    // Development serves Vite's inline dev client, so only production sends the CSP and HSTS (unit-tested in finalHardening).
    expect([first.headers.get('content-security-policy'), first.headers.get('strict-transport-security')]).toEqual([null, null]);
  });

  it('an /api path no route answers is a JSON 404 for a signed-in learner, and 401 JSON without a session — never the app shell (L3)', async () => {
    const signedIn = await call('GET', '/api/no-such-route', { cookie: learnerCookie });
    expect([signedIn.status, signedIn.headers.get('content-type')?.includes('application/json'), signedIn.body]).toEqual([404, true, { error: 'Not found.', code: 'not_found' }]);
    const posted = await call('POST', '/api/no-such-route/deeper', { cookie: learnerCookie, json: {} });
    expect([posted.status, posted.body?.code]).toEqual([404, 'not_found']);
    const anonymous = await call('GET', '/api/no-such-route');
    expect([anonymous.status, anonymous.text.includes('<html')]).toEqual([401, false]);
  });
});

describe('the query string', () => {
  it('is parsed flat: bracket keys build no objects, so no query can make a route throw, and qs is not on the request path', async () => {
    const queries = ['status[toString]=x', 'status[constructor][isBuffer]=1', 'section[toString]=x', 'status=published&status=draft', `a[]=${'1,'.repeat(2_000)}1`];
    for (const query of queries) {
      const reply = await call('GET', `/api/admin/materials?${query}`, { cookie: staffCookie });
      expect([query.slice(0, 32), reply.status, Array.isArray(reply.body?.items)]).toEqual([query.slice(0, 32), 200, true]);
    }
  });
});

describe('how much body a caller may send (L11)', () => {
  const big = (bytes: number) => ({ username: 'nobody_here', password: 'x', padding: 'x'.repeat(bytes) });

  it('sign-in, sign-up and anonymous admin requests read at most 64 kB', async () => {
    const small = await call('POST', '/api/auth/login', { json: big(20_000) });
    expect(small.status).toBe(401);
    for (const url of ['/api/auth/login', '/api/auth/register', '/api/admin/login', '/api/admin/materials/reading']) {
      const reply = await call('POST', url, { json: big(100_000) });
      expect([url, reply.status, reply.body?.code]).toEqual([url, 413, 'payload_too_large']);
    }
  });

  it('nothing else reads a body before the request is signed in: anonymous malformed JSON is 401, not 400', async () => {
    const anonymous = await call('POST', '/api/data/profile', { raw: '{"not json' });
    expect(anonymous.status).toBe(401);
    const signedIn = await call('POST', '/api/data/profile', { cookie: learnerCookie, raw: '{"not json' });
    expect([signedIn.status, signedIn.body?.code]).toEqual([400, 'invalid_json']);
  });

  it('a signed-in learner and a signed-in staff member may still send large bodies', async () => {
    const learner = await call('POST', '/api/grade/writing', { cookie: learnerCookie, json: { taskType: 'task1', module: 'academic', prompt: 'Summarise the chart of energy use.', essay: ESSAY, padding: 'x'.repeat(1_000_000) } });
    expect([learner.status, learner.body?.code]).toEqual([503, 'ai_not_configured']);
    const staff = await call('POST', '/api/admin/materials/reading', { cookie: staffCookie, json: { padding: 'x'.repeat(1_000_000) } });
    expect([staff.status === 413, staff.status < 500]).toEqual([false, true]);
  });
});

describe('the AI routes defined in server.ts (M14)', () => {
  it('refuse a caller without a session before reading anything', async () => {
    for (const url of ['/api/grade/writing', '/api/grade/speaking', '/api/writing/improve', '/api/writing/transcribe', '/api/preppy/chat']) {
      const reply = await call('POST', url, { json: {} });
      expect([url, reply.status]).toEqual([url, 401]);
    }
  });

  it('refuse bad input with 400, and answer 503 ai_not_configured when the input is good but no model is configured', async () => {
    const cookie = learnerCookie;
    const expectReply = async (label: string, url: string, json: unknown, status: number, code?: string) => {
      const reply = await call('POST', url, { cookie, json });
      expect([label, reply.status, code === undefined ? undefined : reply.body?.code]).toEqual([label, status, code]);
    };
    await expectReply('improve without a module', '/api/writing/improve', { paragraph: ESSAY }, 400);
    await expectReply('improve a short paragraph', '/api/writing/improve', { module: 'academic', paragraph: 'Too short to rewrite.' }, 400, 'too_short');
    await expectReply('improve, no model', '/api/writing/improve', { module: 'academic', paragraph: ESSAY }, 503, 'ai_not_configured');
    await expectReply('transcribe without an image', '/api/writing/transcribe', {}, 400);
    await expectReply('transcribe a gif', '/api/writing/transcribe', { imageBase64: 'aGVsbG8=', mimeType: 'image/gif' }, 400, 'bad_image_type');
    await expectReply('transcribe, no model', '/api/writing/transcribe', { imageBase64: 'aGVsbG8=', mimeType: 'image/png' }, 503, 'ai_not_configured');
    await expectReply('chat without messages', '/api/preppy/chat', { messages: [] }, 400);
    await expectReply('writing grade without an essay', '/api/grade/writing', { taskType: 'task1', module: 'academic', prompt: 'Summarise.' }, 400);
    const chat = await call('POST', '/api/preppy/chat', { cookie, json: { messages: [{ role: 'user', content: 'How do I plan a Task 2 essay?' }] } });
    expect(chat.status).toBe(503);
    const taxonomy = await call('GET', '/api/taxonomy', { cookie });
    expect([taxonomy.status, Array.isArray(taxonomy.body?.themes)]).toEqual([200, true]);
  });
});

describe('the admin audit trail and request ids in the log (M7)', () => {
  it('records every state-changing admin request — sign-in, a staff write, an anonymous refusal — with no password, and no reads', async () => {
    const login = await call('POST', '/api/admin/login', { json: { username: STAFF_USER, password: STAFF_PASSWORD } });
    expect(login.status).toBe(200);
    const loginId = login.headers.get('x-request-id');
    const write = await call('POST', '/api/admin/materials/reading', { cookie: staffCookie, json: { title: 'Not a material' } });
    const writeId = write.headers.get('x-request-id');
    const refused = await call('POST', '/api/admin/materials/reading', { json: { title: 'Not a material' } });
    expect(refused.status).toBe(403);
    const refusedId = refused.headers.get('x-request-id');
    const read = await call('GET', '/api/admin/me', { cookie: staffCookie });
    expect(read.status).toBe(200);
    const readId = read.headers.get('x-request-id');

    const [signIn] = await auditRecords((record) => record.requestId === loginId);
    expect(signIn && { actor: signIn.actor, method: signIn.method, route: signIn.route, status: signIn.status, subject: signIn.subject }).toEqual({ actor: null, method: 'POST', route: '/api/admin/login', status: 200, subject: STAFF_USER });

    const [staffWrite] = await auditRecords((record) => record.requestId === writeId);
    expect(staffWrite && { role: staffWrite.actor?.role, hasUser: Boolean(staffWrite.actor?.userId), route: staffWrite.route, params: staffWrite.params, status: staffWrite.status }).toEqual({ role: 'admin', hasUser: true, route: '/api/admin/materials/:section', params: { section: 'reading' }, status: write.status });

    const [anonymous] = await auditRecords((record) => record.requestId === refusedId);
    expect(anonymous && { actor: anonymous.actor, status: anonymous.status }).toEqual({ actor: null, status: 403 });

    expect((await auditRecords((record) => record.requestId === readId, 1)).length).toBe(0);
    expect(server.output().includes(STAFF_PASSWORD)).toBe(false);
  });

  it('the error boundary logs a failure with the request id its response carried', async () => {
    const reply = await call('PUT', '/api/data/profile', { cookie: learnerCookie, raw: '{broken' });
    expect(reply.status).toBe(400);
    const id = reply.headers.get('x-request-id') ?? '';
    expect(UUID.test(id)).toBe(true);
    const deadline = Date.now() + 5_000;
    while (!server.output().includes(`[request ${id}]`) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.output()).toContain(`-> 400 invalid_json: The request body is not valid JSON. [request ${id}]`);
  });
});
