import { after, before, describe, it } from 'node:test';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';
import { sniffFileType, validateUpload } from '../src/services/fileTypeSniffer';

/**
 * The asset pipeline.
 *
 * Every behaviour here replaces something that used to be impossible to get
 * right: the declared MIME type was trusted and echoed back as `Content-Type`;
 * an upload was written to disk under a caller-supplied name and, for HTML,
 * immediately overwritten with its own sanitised output; nothing recorded which
 * material used which file, so `deleteFile` had no caller and every upload was
 * a guaranteed orphan; and a learner could not read an uploaded file at all,
 * because the only static mount pointed at a directory nothing wrote to.
 */

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64)]);
const CDI_HTML = Buffer.from(
  '<html><body><h2>Section 1</h2><p>Write NO MORE THAN TWO WORDS.</p>' +
    '<form><input name="q1" data-answer="helen123"></form>' +
    '<script>grade()</script></body></html>',
);

describe('file type sniffing', () => {
  it('identifies formats from their bytes', () => {
    expect(sniffFileType(PNG)?.mimeType).toBe('image/png');
    expect(sniffFileType(MP3)?.mimeType).toBe('audio/mpeg');
    expect(sniffFileType(Buffer.from('%PDF-1.7 body'))?.mimeType).toBe('application/pdf');
    expect(sniffFileType(CDI_HTML)?.mimeType).toBe('text/html');
    expect(sniffFileType(Buffer.from('just prose'))?.mimeType).toBe('text/plain');
  });

  it('accepts a file whose extension, declared type and bytes agree', () => {
    const verdict = validateUpload({ extension: '.png', declaredMimeType: 'image/png', buffer: PNG });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.kind).toBe('image');
  });

  it('tolerates the MIME synonyms browsers actually send', () => {
    expect(validateUpload({ extension: '.mp3', declaredMimeType: 'audio/mp3', buffer: MP3 }).ok).toBe(true);
    expect(validateUpload({ extension: '.png', declaredMimeType: 'application/octet-stream', buffer: PNG }).ok).toBe(true);
  });

  it('refuses HTML wearing a .png extension', () => {
    // The case that mattered: stored as image/png, served back inline, and
    // executing on the app's own origin.
    const verdict = validateUpload({ extension: '.png', declaredMimeType: 'image/png', buffer: CDI_HTML });
    expect(verdict.ok).toBe(false);
    if (verdict.ok !== true) expect(verdict.error).toContain('do not match');
  });

  it('refuses a declared type that contradicts the extension', () => {
    const verdict = validateUpload({ extension: '.mp3', declaredMimeType: 'text/html', buffer: MP3 });
    expect(verdict.ok).toBe(false);
  });

  it('refuses an unsupported extension and unrecognised bytes', () => {
    expect(validateUpload({ extension: '.exe', buffer: PNG }).ok).toBe(false);
    expect(validateUpload({ extension: '.png', buffer: Buffer.from([0x01, 0x02, 0x00, 0x03]) }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-assets-'));
const originalCwd = process.cwd();
process.env.STORAGE_BACKEND = 'local';
process.env.NODE_ENV = 'test';
process.chdir(tempRoot);

const ADMIN_USER = 'asset_admin';
const ADMIN_PASSWORD = 'Str0ng-Passw0rd-For-Tests';
process.env.SEED_DEFAULT_ACCOUNTS = 'true';
process.env.ADMIN_USER = ADMIN_USER;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;

const express = (await import('express')).default;
const { adminRouter } = await import('../src/routes/adminRoutes');
const { learnerContentRouter } = await import('../src/routes/learnerContentRoutes');
const { authenticateRequest } = await import('../src/middleware/authMiddleware');
const { authService } = await import('../src/services/authService');
const { assetStore, extractAssetIds } = await import('../src/services/assetStore');

let server: Server;
let origin = '';
let adminCookie = '';
let learnerCookie = '';

function multipart(filename: string, contentType: string, content: Buffer) {
  const boundary = '----everstudytest' + Math.random().toString(36).slice(2);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, content, tail]), boundary };
}

async function upload(filename: string, contentType: string, content: Buffer) {
  const { body, boundary } = multipart(filename, contentType, content);
  const response = await fetch(`${origin}/api/admin/upload`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, cookie: adminCookie },
    body,
  });
  return { status: response.status, json: await response.json().catch(() => ({})) as any };
}

async function admin(pathname: string, init: RequestInit = {}) {
  return fetch(`${origin}${pathname}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', cookie: adminCookie, ...(init.headers || {}) },
  });
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  app.use('/api', authenticateRequest);
  app.use('/api', learnerContentRouter);
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
  adminCookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  expect(adminCookie).toContain('prep_admin_auth=');

  const learner = await authService.register({
    email: 'asset-learner@example.com',
    username: 'asset_learner',
    password: 'Str0ng-Passw0rd-For-Tests',
    name: 'Asset Learner',
  });
  learnerCookie = `prep_auth=${learner.token}`;
});

after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  process.chdir(originalCwd);
  removeTempRoot(tempRoot);
});

describe('upload', () => {
  it('rejects a spoofed file over HTTP, not just in the sniffer', async () => {
    const result = await upload('innocent.png', 'image/png', CDI_HTML);
    expect(result.status).toBe(400);
    expect(String(result.json.error)).toContain('do not match');
  });

  it('stores audio as a staged asset with a sniffed type', async () => {
    const result = await upload('section1.mp3', 'audio/mpeg', MP3);
    expect(result.status).toBe(200);
    expect(result.json.file.kind).toBe('audio');
    expect(result.json.file.mimeType).toBe('audio/mpeg');
    expect(result.json.file.url).toContain('/api/admin/assets/');

    const asset = await assetStore.get(result.json.file.assetId);
    expect(asset?.state).toBe('staged');
    expect(asset?.sha256).toHaveLength(64);
    // The storage path comes from the generated id, never from the upload.
    expect(asset?.storagePath).toBe(asset?.id);
  });

  it('keeps the original HTML as well as the sanitised version', async () => {
    const result = await upload('cdi.html', 'text/html', CDI_HTML);
    expect(result.status).toBe(200);

    const summary = result.json.file;
    expect(summary.sourceAssetId).toBeTruthy();
    expect(summary.assetId).not.toBe(summary.sourceAssetId);

    // Sanitised: no script, no form controls.
    expect(summary.extractedHtml).toContain('<h2>Section 1</h2>');
    expect(summary.extractedHtml).not.toContain('<script');
    expect(summary.extractedHtml).not.toContain('<input');

    // The original still has all of it — this is what makes re-parsing possible
    // later. The upload route used to overwrite it with the sanitised output.
    const original = await assetStore.get(summary.sourceAssetId);
    const originalBytes = (await assetStore.readContent(original!)).toString('utf8');
    expect(originalBytes).toContain('<script>grade()</script>');
    expect(originalBytes).toContain('data-answer="helen123"');
    expect(original?.sourceType).toBe('upload');

    const derived = await assetStore.get(summary.assetId);
    expect(derived?.sourceType).toBe('derived');
    expect(derived?.derivedFromAssetId).toBe(summary.sourceAssetId);
  });
});

describe('serving', () => {
  let audioId = '';
  let htmlId = '';

  before(async () => {
    audioId = (await upload('serve.mp3', 'audio/mpeg', MP3)).json.file.assetId;
    htmlId = (await upload('serve.html', 'text/html', CDI_HTML)).json.file.assetId;
  });

  it('serves audio inline with its real type', async () => {
    const response = await admin(`/api/admin/assets/${audioId}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('audio/mpeg');
    expect(response.headers.get('content-disposition')).toContain('inline');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('never serves imported HTML as an executable page', async () => {
    const response = await admin(`/api/admin/assets/${htmlId}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/octet-stream');
    expect(response.headers.get('content-disposition')).toContain('attachment');
  });

  it('refuses an asset without an admin session', async () => {
    const response = await fetch(`${origin}/api/admin/assets/${audioId}`);
    expect(response.status).toBe(403);
  });

  it('refuses a learner an asset that no published material references', async () => {
    const response = await fetch(`${origin}/api/assets/${audioId}`, {
      headers: { cookie: learnerCookie },
    });
    expect(response.status).toBe(404);
  });
});

describe('asset lifecycle', () => {
  it('references are found in explicit fields and in embedded URLs', () => {
    const ids = extractAssetIds({
      content: {
        audioAssetId: 'ast_aaaaaaaaaaaaaaaa',
        assetIds: ['ast_bbbbbbbbbbbbbbbb'],
        passage: { htmlContent: '<img src="/api/assets/ast_cccccccccccccccc">' },
      },
    });
    expect(ids.length).toBe(3);
    expect(ids).toContain('ast_cccccccccccccccc');
  });

  it('promotes on save, releases on delete, and lets a learner read it while published', async () => {
    const audio = (await upload('lesson.mp3', 'audio/mpeg', MP3)).json.file;
    expect((await assetStore.get(audio.assetId))?.state).toBe('staged');

    const saved = await (
      await admin('/api/admin/materials', {
        method: 'POST',
        body: JSON.stringify({
          title: 'Asset Listening',
          section: 'listening',
          module: 'academic',
          theme: 'Eco-tourism',
          targetBand: '7.0',
          content: {
            section: {
              sectionNumber: 1,
              title: 'Eco-farm',
              contextDescription: 'Call',
              questions: [
                {
                  id: 'a1',
                  questionNumber: 1,
                  type: 'form_completion',
                  prompt: 'Tour departs at:',
                  correctAnswer: '09:15',
                },
              ],
            },
            audioAssetId: audio.assetId,
            audioUrl: `/api/assets/${audio.assetId}`,
            assetIds: [audio.assetId],
          },
        }),
      })
    ).json();
    expect(saved.success).toBe(true);
    expect(saved.item.status).toBe('draft');
    expect((await assetStore.get(audio.assetId))?.state).toBe('active');

    // A draft references it, so it is pinned as active — but the learner route
    // serves only what published content names.
    const beforePublish = await fetch(`${origin}/api/assets/${audio.assetId}`, {
      headers: { cookie: learnerCookie },
    });
    expect(beforePublish.status).toBe(404);

    const published = await admin(
      `/api/admin/materials/listening/${saved.item.id}/publish`,
      { method: 'POST' },
    );
    expect(published.status).toBe(200);

    // Now that published content references it, the learner can play it.
    const played = await fetch(`${origin}/api/assets/${audio.assetId}`, {
      headers: { cookie: learnerCookie },
    });
    expect(played.status).toBe(200);
    expect(played.headers.get('content-type')).toContain('audio/mpeg');

    // Deleting it while published would break a link the catalog is showing.
    const refused = await admin(`/api/admin/materials/listening/${saved.item.id}`, {
      method: 'DELETE',
    });
    expect(refused.status).toBe(409);
    expect(await assetStore.get(audio.assetId)).not.toBe(null);

    const withdrawn = await admin(
      `/api/admin/materials/listening/${saved.item.id}/unpublish`,
      { method: 'POST' },
    );
    expect(withdrawn.status).toBe(200);

    const deleted = await admin(`/api/admin/materials/listening/${saved.item.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect((await deleted.json()).releasedAssets).toContain(audio.assetId);
    // Released means gone, not merely unlinked — this is the orphan that used
    // to be guaranteed.
    expect(await assetStore.get(audio.assetId)).toBe(null);
  });

  it('keeps an asset that another material still uses', async () => {
    const shared = (await upload('shared.mp3', 'audio/mpeg', MP3)).json.file;
    const body = (title: string) => ({
      title,
      section: 'listening',
      module: 'academic',
      status: 'draft',
      content: {
        section: { sectionNumber: 1, title, contextDescription: 'Call', questions: [] },
        audioAssetId: shared.assetId,
        assetIds: [shared.assetId],
      },
    });

    const first = await (await admin('/api/admin/materials', { method: 'POST', body: JSON.stringify(body('First')) })).json();
    await admin('/api/admin/materials', { method: 'POST', body: JSON.stringify(body('Second')) });

    const deleted = await admin(`/api/admin/materials/listening/${first.item.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect((await deleted.json()).releasedAssets).toHaveLength(0);
    expect((await assetStore.get(shared.assetId))?.state).toBe('active');
  });

  it('refuses to delete a material a bundle still names', async () => {
    const material = await (
      await admin('/api/admin/materials', {
        method: 'POST',
        body: JSON.stringify({
          title: 'Bundled Reading',
          section: 'reading',
          module: 'academic',
          status: 'published',
          content: { passage: { passageNumber: 1, title: 'P', text: 'T', questions: [] } },
        }),
      })
    ).json();

    await admin('/api/admin/bundles', {
      method: 'POST',
      body: JSON.stringify({ title: 'Holding Bundle', status: 'published', materials: { readingId: material.item.id } }),
    });

    const response = await admin(`/api/admin/materials/reading/${material.item.id}`, { method: 'DELETE' });
    // Deleting it would leave the bundle resolving that slot to null, and the
    // learner sitting built-in content under the bundle's own title.
    expect(response.status).toBe(409);
    expect(String((await response.json()).error)).toContain('Holding Bundle');
  });

  it('reaps a staged asset only once it is past the grace period', async () => {
    const stray = (await upload('stray.mp3', 'audio/mpeg', MP3)).json.file;

    expect(await assetStore.reapUnreferenced()).not.toContain(stray.assetId);
    expect(await assetStore.get(stray.assetId)).not.toBe(null);

    const tomorrow = Date.now() + 25 * 60 * 60 * 1000;
    expect(await assetStore.reapUnreferenced(tomorrow)).toContain(stray.assetId);
    expect(await assetStore.get(stray.assetId)).toBe(null);
  });
});
