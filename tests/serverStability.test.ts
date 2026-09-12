import { after, before, describe, it } from 'node:test';
import { expect } from './harness';
import { expectControlledError, type ErrorReply } from './errorAssertions';
import { startServer, type ServerProcess } from './serverProcess';

/**
 * H1, over the real `server.ts`.
 *
 * Express 4 does not catch a rejected promise and nothing handled one at the
 * process level, so one request that made an async handler throw exited the
 * server. A malformed material id from an admin screen did it. With Firestore
 * configured but without credentials, the first request that touched Firestore
 * did it — the anonymous public routes and learner sign-in included. Every
 * learner in the middle of an exam lost the server along with it.
 *
 * These start the file `npm run dev` runs, in a child process, and hold every
 * failure to one sequence: the bad request gets a JSON error with the status
 * that fits it and nothing internal in it; the process is still running; and a
 * valid request after it succeeds.
 */

const ADMIN_USER = 'stability_admin';
const ADMIN_PASSWORD = 'Stability-Passw0rd-Long';
const LONG_ID = 'a'.repeat(200);

async function send(
  server: ServerProcess,
  method: string,
  url: string,
  init: { cookie?: string; json?: unknown; raw?: string; form?: FormData; timeoutMs?: number } = {},
): Promise<ErrorReply> {
  const headers: Record<string, string> = {};
  if (init.cookie) headers.cookie = init.cookie;
  if (init.json !== undefined || init.raw !== undefined) headers['Content-Type'] = 'application/json';
  try {
    const response = await fetch(`${server.origin}${url}`, {
      method,
      headers,
      body: init.form ?? init.raw ?? (init.json === undefined ? undefined : JSON.stringify(init.json)),
      // A request that is never answered is a failure, not a wait.
      signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
    });
    return { status: response.status, type: response.headers.get('content-type') ?? '', text: await response.text() };
  } catch (error) {
    return { status: 0, type: '', text: `no response: ${error instanceof Error ? `${error.name} ${error.message}` : String(error)}` };
  }
}

async function cookieFrom(server: ServerProcess, url: string, body: unknown, name: string): Promise<string> {
  const response = await fetch(`${server.origin}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const cookie = response.headers.getSetCookie().map((line) => line.split(';')[0]).find((pair) => pair.startsWith(`${name}=`));
  if (!cookie) throw new Error(`${url} set no ${name} cookie (${response.status}): ${await response.text()}`);
  return cookie;
}

async function expectStillRunning(label: string, server: ServerProcess): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect([label, server.exit()]).toEqual([label, null]);
}

async function expectSucceeds(label: string, reply: Promise<ErrorReply>): Promise<void> {
  const answer = await reply;
  expect([label, answer.status]).toEqual([label, 200]);
}

describe('the real server.ts on local storage', () => {
  let server: ServerProcess;
  let admin = '';
  let learner = '';

  before(async () => {
    server = await startServer({ STORAGE_BACKEND: 'local', SEED_DEFAULT_ACCOUNTS: 'true', ADMIN_USER, ADMIN_PASSWORD });
    admin = await cookieFrom(server, '/api/admin/login', { username: ADMIN_USER, password: ADMIN_PASSWORD }, 'prep_admin_auth');
    learner = await cookieFrom(server, '/api/auth/register', { email: 'stability@example.com', username: 'stability_learner', password: 'Learner-Passw0rd-1' }, 'prep_auth');
  });

  after(async () => {
    await server?.stop();
  });

  it('a malformed admin material id: 400 from the async handler, the process alive, the catalog still loads', async () => {
    const requests: Array<[string, string, string]> = [
      ['read, encoded traversal', 'GET', '/api/admin/materials/reading/..%2F..%2Fusers'],
      ['read, 200-character id', 'GET', `/api/admin/materials/reading/${LONG_ID}`],
      ['publish check', 'GET', `/api/admin/materials/reading/${LONG_ID}/publish-check`],
      ['delete by section', 'DELETE', `/api/admin/materials/reading/${LONG_ID}`],
      ['delete by id', 'DELETE', `/api/admin/materials/${LONG_ID}`],
    ];
    for (const [label, method, url] of requests) {
      expectControlledError(label, await send(server, method, url, { cookie: admin }), 400, 'invalid_id');
      await expectStillRunning(label, server);
      await expectSucceeds(`${label}, then the catalog`, send(server, 'GET', '/api/admin/materials', { cookie: admin }));
    }
  });

  it('a malformed upload to the admin and source routes: 400, the process alive, both libraries still load', async () => {
    const executable = new FormData();
    executable.append('file', new Blob(['MZ']), 'tool.exe');
    expectControlledError('upload of an unsupported type', await send(server, 'POST', '/api/admin/upload', { cookie: admin, form: executable }), 400, 'unsupported_file_type');
    await expectStillRunning('upload of an unsupported type', server);
    await expectSucceeds('then the asset list', send(server, 'GET', '/api/admin/assets', { cookie: admin }));

    const twoFiles = new FormData();
    twoFiles.append('file', new Blob(['first book']), 'first.txt');
    twoFiles.append('file', new Blob(['second book']), 'second.txt');
    expectControlledError('source upload with two files', await send(server, 'POST', '/api/admin/sources', { cookie: admin, form: twoFiles }), 400, 'too_many_files');
    await expectStillRunning('source upload with two files', server);
    await expectSucceeds('then the source library', send(server, 'GET', '/api/admin/sources', { cookie: admin }));
  });

  it('malformed JSON to bundle, exam session, learner data and sign-in routes: 400 with nothing internal, and each still works', async () => {
    const cases: Array<[string, string, string, () => Promise<ErrorReply>]> = [
      ['bundle draft', admin, '/api/admin/bundles', () => send(server, 'GET', '/api/admin/bundles', { cookie: admin })],
      ['exam session events', learner, '/api/learner/exams/attempt-00000000-0000-4000-8000-000000000000/events', () => send(server, 'GET', '/api/learner/exams', { cookie: learner })],
      ['learner data sync', learner, '/api/data/sync', () => send(server, 'GET', '/api/data', { cookie: learner })],
      ['public sign-in', '', '/api/auth/login', () => send(server, 'GET', '/api/admin/public/materials/reading')],
    ];
    for (const [label, cookie, url, valid] of cases) {
      expectControlledError(label, await send(server, 'POST', url, { cookie, raw: '{"unfinished": ' }), 400, 'invalid_json');
      await expectStillRunning(label, server);
      await expectSucceeds(`${label}, then a valid request`, valid());
    }
  });

  it('logs each failure with its method, path, who asked and the status', () => {
    const log = server.output();
    expect(log).toMatch(/\[HTTP\] GET \/api\/admin\/materials\/reading\/\S+ \(admin usr_admin_[\w-]+\) -> 400 invalid_id/);
    // A body that is not JSON is refused before anyone is authenticated.
    expect(log).toContain('[HTTP] POST /api/data/sync -> 400 invalid_json');
  });

  it('reports the local backend as healthy', async () => {
    const health = await send(server, 'GET', '/api/health');
    expect([health.status, JSON.parse(health.text)]).toEqual([200, { status: 'ok', aiConfigured: false, storage: { backend: 'local', status: 'ok' } }]);
  });
});

describe('the real server.ts with Firestore configured and no credentials', () => {
  let server: ServerProcess;

  before(async () => {
    server = await startServer({ STORAGE_BACKEND: 'gcs_firestore', GCS_BUCKET_NAME: 'stability-check', FIREBASE_PROJECT_ID: 'stability-check' });
  });

  after(async () => {
    await server?.stop();
  });

  it('answers 503 to every request that needs Firestore, stays up, and keeps serving', async () => {
    // The Firestore client takes about ten seconds to give up without credentials,
    // and rejects promises of its own nobody awaits along the way — that is what
    // used to exit the process.
    const [health, publicMaterials, learnerData, signIn] = await Promise.all([
      send(server, 'GET', '/api/health', { timeoutMs: 60_000 }),
      send(server, 'GET', '/api/admin/public/materials/reading', { timeoutMs: 60_000 }),
      send(server, 'GET', '/api/data', { timeoutMs: 60_000 }),
      send(server, 'POST', '/api/auth/login', { json: { username: 'someone', password: 'not-a-real-password' }, timeoutMs: 60_000 }),
    ]);

    expect([health.status, JSON.parse(health.text)]).toEqual([503, { status: 'unavailable', aiConfigured: false, storage: { backend: 'gcs_firestore', status: 'unavailable' } }]);
    expectControlledError('anonymous public materials', publicMaterials, 503, 'storage_unavailable');
    expectControlledError('learner data', learnerData, 503, 'storage_unavailable');
    expectControlledError('learner sign-in', signIn, 503, 'storage_unavailable');

    await expectStillRunning('after the Firestore failures', server);
    const shell = await send(server, 'GET', '/');
    expect([shell.status, shell.type.includes('text/html'), shell.status === 200 ? '' : shell.text.slice(0, 300)]).toEqual([200, true, '']);
    const again = await send(server, 'GET', '/api/health', { timeoutMs: 60_000 });
    expect(again.status).toBe(503);
    await expectStillRunning('after asking again', server);

    const log = server.output();
    expect(log).toContain('[HTTP] GET /api/data -> 503 storage_unavailable');
    expect(log).toContain('[Process] Unhandled promise rejection');
  });
});
