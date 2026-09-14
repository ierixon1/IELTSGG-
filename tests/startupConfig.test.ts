import './env';
import { describe, it } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';
import { checkStartupConfig } from '../src/config/startupConfig';
import { startServer } from './serverProcess';

/**
 * Deployment configuration checked when the server starts (Phase 28).
 *
 * The port was hard-coded to 3000 (M1), and a production deployment missing its
 * bucket, email settings or proxy setting started anyway and failed later — or
 * never noticeably: a password reset simply sent nothing. Now every problem is
 * named before anything loads, and the process exits.
 */

const PRODUCTION: Record<string, string> = {
  NODE_ENV: 'production',
  PORT: '8080',
  TRUST_PROXY: '1',
  STORAGE_BACKEND: 'gcs_firestore',
  GCS_BUCKET_NAME: 'everstudy-uploads',
  RESEND_API_KEY: 're_placeholder_value',
  EMAIL_FROM: 'Ever Study <no-reply@everstudy.example>',
  APP_URL: 'https://everstudy.example',
};

const problemsOf = (env: Record<string, string | undefined>) => checkStartupConfig(env).problems;
const without = (name: string) => Object.fromEntries(Object.entries(PRODUCTION).filter(([key]) => key !== name));

function expectProblem(label: string, env: Record<string, string | undefined>, fragment: string) {
  const { config, problems } = checkStartupConfig(env);
  expect([label, config, problems.some((problem) => problem.includes(fragment))]).toEqual([label, null, true]);
}

describe('the startup configuration check', () => {
  it('outside production an unset PORT is 3000 and an unset TRUST_PROXY believes no proxy; both can be set', () => {
    expect(checkStartupConfig({})).toEqual({ config: { port: 3000, trustProxy: false, production: false }, problems: [] });
    expect(checkStartupConfig({ PORT: '4100', TRUST_PROXY: '2' }).config).toEqual({ port: 4100, trustProxy: 2, production: false });
  });

  it('in every mode, an unreadable PORT, TRUST_PROXY or promotion role is refused', () => {
    for (const port of ['abc', '0', '65536', '80.5', '-1']) expectProblem(`PORT=${port}`, { PORT: port }, 'PORT must be a whole number');
    expectProblem('TRUST_PROXY=true', { TRUST_PROXY: 'true' }, 'TRUST_PROXY=true');
    expectProblem('ADMIN_PROMOTE_ROLE=owner', { ADMIN_PROMOTE_USERNAME: 'someone', ADMIN_PROMOTE_ROLE: 'owner' }, 'ADMIN_PROMOTE_ROLE must be admin or examiner');
  });

  it('a complete production configuration is accepted, TRUST_PROXY=false included', () => {
    expect(checkStartupConfig(PRODUCTION)).toEqual({ config: { port: 8080, trustProxy: 1, production: true }, problems: [] });
    expect(checkStartupConfig({ ...PRODUCTION, TRUST_PROXY: 'false' }).config?.trustProxy).toBe(false);
  });

  it('production names each required setting that is missing', () => {
    for (const name of ['PORT', 'TRUST_PROXY', 'GCS_BUCKET_NAME', 'RESEND_API_KEY', 'EMAIL_FROM', 'APP_URL']) expectProblem(`without ${name}`, without(name), `${name} must`);
    expectProblem('without STORAGE_BACKEND', without('STORAGE_BACKEND'), 'STORAGE_BACKEND must be gcs_firestore');
    expectProblem('STORAGE_BACKEND=local', { ...PRODUCTION, STORAGE_BACKEND: 'local' }, 'STORAGE_BACKEND must be gcs_firestore');
    // PORT, TRUST_PROXY, STORAGE_BACKEND, GCS_BUCKET_NAME, RESEND_API_KEY, EMAIL_FROM, APP_URL.
    expect(problemsOf({ NODE_ENV: 'production' }).length).toBe(7);
  });

  it('production Firestore credentials are a complete service-account key or none of it, and a named credentials file exists', () => {
    const secret = 'not-a-pem-SECRET-VALUE-123';
    expectProblem('client email alone', { ...PRODUCTION, FIREBASE_CLIENT_EMAIL: 'svc@project.iam.gserviceaccount.com' }, 'go together');
    expectProblem('key without project', { ...PRODUCTION, FIREBASE_CLIENT_EMAIL: 'svc@project.iam.gserviceaccount.com', FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----' }, 'FIREBASE_PROJECT_ID must be set');
    const notPem = checkStartupConfig({ ...PRODUCTION, FIREBASE_PROJECT_ID: 'project', FIREBASE_CLIENT_EMAIL: 'svc@project.iam.gserviceaccount.com', FIREBASE_PRIVATE_KEY: secret });
    expect([notPem.config, notPem.problems.some((problem) => problem.includes('not a PEM private key')), notPem.problems.join(' ').includes(secret)]).toEqual([null, true, false]);
    expect(checkStartupConfig({ ...PRODUCTION, FIREBASE_PROJECT_ID: 'project', FIREBASE_CLIENT_EMAIL: 'svc@project.iam.gserviceaccount.com', FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----' }).problems).toEqual([]);

    const directory = mkdtempSync(path.join(os.tmpdir(), 'everstudy-credentials-'));
    try {
      expectProblem('a credentials file that does not exist', { ...PRODUCTION, GOOGLE_APPLICATION_CREDENTIALS: path.join(directory, 'missing.json') }, 'names a file that does not exist');
      const file = path.join(directory, 'service-account.json');
      writeFileSync(file, '{}', 'utf8');
      expect(problemsOf({ ...PRODUCTION, GOOGLE_APPLICATION_CREDENTIALS: file })).toEqual([]);
    } finally {
      removeTempRoot(directory);
    }
  });

  it('production requires an https APP_URL and refuses the development switches', () => {
    expectProblem('http APP_URL', { ...PRODUCTION, APP_URL: 'http://everstudy.example' }, 'APP_URL must be the https://');
    expectProblem('APP_URL that is not a URL', { ...PRODUCTION, APP_URL: 'everstudy' }, 'APP_URL must be the https://');
    expectProblem('EXPLICIT_DEV_AUTH', { ...PRODUCTION, EXPLICIT_DEV_AUTH: 'true' }, 'EXPLICIT_DEV_AUTH=true');
    expectProblem('SEED_DEFAULT_ACCOUNTS', { ...PRODUCTION, SEED_DEFAULT_ACCOUNTS: 'true' }, 'SEED_DEFAULT_ACCOUNTS');
  });

  it('outside production the impersonation switch needs NODE_ENV to be development or test — an unset NODE_ENV is refused (M11)', () => {
    for (const nodeEnv of [undefined, '', 'staging', 'prod']) {
      expectProblem(`NODE_ENV=${String(nodeEnv)}`, { NODE_ENV: nodeEnv, EXPLICIT_DEV_AUTH: 'true' }, 'EXPLICIT_DEV_AUTH=true lets any request act as any account');
    }
    expect(problemsOf({ EXPLICIT_DEV_AUTH: 'true' }).join(' ')).toContain('NODE_ENV is unset');
    for (const nodeEnv of ['development', 'test']) expect([nodeEnv, problemsOf({ NODE_ENV: nodeEnv, EXPLICIT_DEV_AUTH: 'true' })]).toEqual([nodeEnv, []]);
    expect([problemsOf({ EXPLICIT_DEV_AUTH: 'false' }), problemsOf({})]).toEqual([[], []]);
  });
});

describe('the real server.ts at start', () => {
  it('production with nothing configured exits before listening, naming every missing setting', async () => {
    let failure = '';
    try {
      const started = await startServer({ NODE_ENV: 'production' }, 90_000);
      await started.stop();
      failure = 'the server started';
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(failure).toContain('exited ({"code":1');
    for (const fragment of ['[Config] The server cannot start', 'PORT must be set', 'TRUST_PROXY must be set', 'STORAGE_BACKEND must be gcs_firestore', 'GCS_BUCKET_NAME must', 'RESEND_API_KEY must', 'APP_URL must']) {
      expect([fragment, failure.includes(fragment)]).toEqual([fragment, true]);
    }
    // A clear stop, not a crash further on: nothing after the configuration check ran.
    expect([failure.includes('TypeError'), /\n\s+at \S/.test(failure)]).toEqual([false, false]);
  });

  it('an unreadable PORT stops a development server too', async () => {
    let failure = '';
    try {
      const started = await startServer({ STORAGE_BACKEND: 'local', PORT: 'eighty' }, 90_000);
      await started.stop();
      failure = 'the server started';
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(failure).toContain('exited ({"code":1');
    expect(failure).toContain('[Config] PORT must be a whole number');
    expect([failure.includes('TypeError'), /\n\s+at \S/.test(failure)]).toEqual([false, false]);
  });

  it('EXPLICIT_DEV_AUTH with NODE_ENV unset stops the server; with NODE_ENV=development the x-user-id header works (M11)', async () => {
    let failure = '';
    try {
      const started = await startServer({ STORAGE_BACKEND: 'local', EXPLICIT_DEV_AUTH: 'true' }, 90_000);
      await started.stop();
      failure = 'the server started';
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(failure).toContain('exited ({"code":1');
    expect(failure).toContain('EXPLICIT_DEV_AUTH=true lets any request act as any account');
    expect(failure).toContain('NODE_ENV is unset');

    const development = await startServer({ STORAGE_BACKEND: 'local', NODE_ENV: 'development', EXPLICIT_DEV_AUTH: 'true' }, 120_000);
    try {
      const registered = await fetch(`${development.origin}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'dev_header_user', email: 'dev_header@example.com', password: 'Dev-Header-Passw0rd' }) });
      const { user } = (await registered.json()) as { user: { id: string } };
      const impersonated = await fetch(`${development.origin}/api/auth/me`, { headers: { 'x-user-id': user.id } });
      // /api/auth/me reads only the cookie; the learner API is where the header applies.
      expect(impersonated.status).toBe(401);
      const data = await fetch(`${development.origin}/api/quotas`, { headers: { 'x-user-id': user.id } });
      expect(data.status).toBe(200);
    } finally {
      await development.stop();
    }
  });

  it('a complete production configuration starts; with no Firestore credentials the health check answers 503', async () => {
    // PORT=3000 is the port the test harness moves to a free one.
    const server = await startServer({ ...PRODUCTION, PORT: '3000' }, 120_000);
    try {
      const health = await fetch(`${server.origin}/api/health`, { signal: AbortSignal.timeout(30_000) });
      expect(health.status).toBe(503);
      expect(server.exit()).toBe(null);
    } finally {
      await server.stop();
    }
  });
});
