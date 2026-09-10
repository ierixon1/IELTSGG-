import { after, before, describe, it } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';

/**
 * The import endpoint.
 *
 * Separate from the parser suite because the store reads its data directory and
 * its seed accounts from the environment when it is first imported — so all of
 * that has to be set before anything reaches it, which rules out static
 * imports of the app's own modules.
 *
 * What matters here is the boundary between analysing and keeping. The endpoint
 * stores exactly two things — the untouched original page, and any asset the
 * page carries inline, neither of which can be recovered later — and saves no
 * material at all. Turning an analysis into content is phase 7's job.
 */

const FIXTURE = readFileSync(
  path.join(process.cwd(), 'tests', 'fixtures', 'cdi', 'listening-mixed.html'),
  'utf8',
);

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-import-'));
const originalCwd = process.cwd();
process.env.STORAGE_BACKEND = 'local';
process.env.NODE_ENV = 'test';
process.chdir(tempRoot);

const ADMIN_USER = 'import_admin';
const ADMIN_PASSWORD = 'Str0ng-Passw0rd-For-Tests';
process.env.SEED_DEFAULT_ACCOUNTS = 'true';
process.env.ADMIN_USER = ADMIN_USER;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;

const express = (await import('express')).default;
const { adminRouter } = await import('../src/routes/adminRoutes');
const { assetStore } = await import('../src/services/assetStore');
const { adminStore } = await import('../src/services/adminStore');
const { PARSER_VERSION } = await import('../src/services/cdiImport');

let server: Server;
let origin = '';
let cookie = '';

before(async () => {
  const app = express();
  app.use(express.json({ limit: '16mb' }));
  app.use('/api/admin', adminRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  const login = await fetch(`${origin}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASSWORD }),
  });
  cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  expect(cookie).toContain('prep_admin_auth=');
});

after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  process.chdir(originalCwd);
  removeTempRoot(tempRoot);
});

const postImport = (body: unknown, withCookie = true) =>
  fetch(`${origin}/api/admin/import/html`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(withCookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

describe('POST /api/admin/import/html', () => {
  it('needs an admin session', async () => {
    expect((await postImport({ html: '<p>x</p>' }, false)).status).toBe(403);
  });

  it('refuses input that is not a document', async () => {
    expect((await postImport({ html: '' })).status).toBe(400);
    expect((await postImport({ html: 'just some prose' })).status).toBe(400);
  });

  it('analyses a page and reports everything a reviewer needs', async () => {
    const response = await postImport({ html: FIXTURE, filename: 'section2.html' });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.parserVersion).toBe(PARSER_VERSION);
    expect(body.detectedSection).toBe('listening');
    expect(body.stats.parsed).toBe(10);
    expect(body.needsReview).toBe(0);
    expect(Array.isArray(body.diagnostics)).toBe(true);
    expect(Array.isArray(body.unsupportedRegions)).toBe(true);
    expect(Array.isArray(body.assets)).toBe(true);
    // The draft comes back for review; it is not saved.
    expect(body.material.status).toBe('draft');
    expect(body.material.content.section.questions).toHaveLength(10);
    expect(body.material.parserVersion).toBe(PARSER_VERSION);
  });

  it('preserves the original page byte for byte', async () => {
    const body = await (await postImport({ html: FIXTURE, filename: 'section2.html' })).json();
    expect(body.sourceAssetId).toMatch(/^ast_/);

    const asset = await assetStore.get(body.sourceAssetId);
    const bytes = await assetStore.readContent(asset!);
    // Not the sanitised version: a better parser has to be able to re-read this.
    expect(bytes.toString('utf8')).toBe(FIXTURE);
  });

  it('stores an inline asset and points the question at it', async () => {
    const body = await (await postImport({ html: FIXTURE })).json();
    const stored = body.assets.find((asset: { origin: string }) => asset.origin === 'inline');
    expect(stored.assetId).toMatch(/^ast_/);

    const question = body.questions.find((q: { questionNumber: number }) => q.questionNumber === 11);
    expect(question.question.mediaRef.assetId).toBe(stored.assetId);

    const asset = await assetStore.get(stored.assetId);
    expect(asset?.kind).toBe('image');
    expect(asset?.mimeType).toBe('image/png');
  });

  it('does not send inline file data back to the caller', async () => {
    const body = await (await postImport({ html: FIXTURE })).json();
    expect(JSON.stringify(body.assets)).not.toContain('inlineData');
  });

  it('saves no material', async () => {
    await postImport({ html: FIXTURE });
    // Analysis is analysis. Phase 7 is where a reviewer turns it into content.
    expect(await adminStore.listMaterials('listening')).toHaveLength(0);
    expect(await adminStore.listMaterials('reading')).toHaveLength(0);
  });
});
