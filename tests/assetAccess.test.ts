import './env';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';
import type { AssetKind } from '../src/types/asset';

/**
 * H3: a learner who knows an asset id must not be able to download a file that
 * is not theirs to see.
 *
 * An imported page is kept untouched, printed answer key and all, so a better
 * parser can re-read it later. The editors and the import review list that
 * original in the material's `assetIds`, the learner route served whatever a
 * published material listed, and so a learner with the id downloaded the key
 * (Phase 17, Probe 1 S4).
 *
 * Files are now authorised by the role the stored records give them, in one
 * policy (`assetAccess`), for learners and staff alike. These drive it over the
 * real routes: originals and private files refused to learners exactly like ids
 * that do not exist, the media a published material renders still served, and
 * staff access unchanged except that the source library stays an
 * administrator's.
 */
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-asset-access-'));
const originalCwd = process.cwd();
process.chdir(tempRoot);

const ADMIN_USER = 'asset_access_admin';
const ADMIN_PASSWORD = 'Str0ng-Passw0rd-For-Assets';
const EXAMINER_PASSWORD = 'Str0ng-Passw0rd-For-Examiner';
process.env.SEED_DEFAULT_ACCOUNTS = 'true';
process.env.ADMIN_USER = ADMIN_USER;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
process.env.EXAMINER_SEED_PASSWORD = EXAMINER_PASSWORD;

const express = (await import('express')).default;
const { adminRouter } = await import('../src/routes/adminRoutes');
const { learnerContentRouter } = await import('../src/routes/learnerContentRoutes');
const { authRouter } = await import('../src/routes/authRoutes');
const { authenticateRequest } = await import('../src/middleware/authMiddleware');
const { assetStore } = await import('../src/services/assetStore');

const SECRET = 'SECRET-KEY-MARKER-7F3A';
const ORIGINAL_HTML = `<html><body><h1>Algae as fuel</h1><p>Algae can grow in open ponds.</p><section><h2>Answer key</h2><p>1 TRUE ${SECRET}</p></section></body></html>`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64)]);
const DENIED = JSON.stringify({ error: 'Asset not found.' });

let server: Server;
let origin = '';
let adminCookie = '';
let examinerCookie = '';
let learnerCookie = '';

const call = (cookie: () => string) => (url: string, init: RequestInit = {}) =>
  fetch(`${origin}${url}`, { ...init, headers: { 'Content-Type': 'application/json', cookie: cookie(), ...(init.headers || {}) } });
const admin = call(() => adminCookie);
const examiner = call(() => examinerCookie);
const learner = call(() => learnerCookie);
const postForm = (url: string, form: FormData) => fetch(`${origin}${url}`, { method: 'POST', headers: { cookie: adminCookie }, body: form });

interface Reply {
  status: number;
  type: string;
  disposition: string;
  text: string;
}
async function read(response: Promise<Response>): Promise<Reply> {
  const settled = await response;
  return {
    status: settled.status,
    type: settled.headers.get('content-type') ?? '',
    disposition: settled.headers.get('content-disposition') ?? '',
    text: await settled.text(),
  };
}

/** A refusal: the same 404 an id that does not exist gets, carrying none of the given strings. */
function expectDenied(label: string, reply: Reply, ...withheld: string[]) {
  expect([label, reply.status, reply.text]).toEqual([label, 404, DENIED]);
  for (const text of withheld) expect([label, text, reply.text.includes(text)]).toEqual([label, text, false]);
}

const storeAsset = (originalName: string, content: Buffer, mimeType: string, kind: AssetKind) =>
  assetStore.create({ originalName, content, mimeType, kind, createdBy: 'test', sourceType: 'upload' });

function reading(title: string, content: Record<string, unknown> = {}, passage: Record<string, unknown> = {}) {
  return {
    title,
    section: 'reading',
    module: 'academic',
    theme: 'Renewable energy',
    targetBand: '7.0',
    content: {
      ...content,
      passage: {
        passageNumber: 1,
        title: 'Algae as fuel',
        text: 'Algae can grow in open ponds.',
        questions: [{ id: `${title}-q1`, questionNumber: 1, type: 'true_false_not_given', prompt: 'Algae need farmland.', correctAnswer: 'FALSE' }],
        ...passage,
      },
    },
  };
}

function listening(title: string, content: Record<string, unknown>) {
  return {
    title,
    section: 'listening',
    module: 'academic',
    theme: 'Travel',
    targetBand: '7.0',
    content: {
      ...content,
      section: {
        sectionNumber: 1,
        title: 'Booking a tour',
        contextDescription: 'A phone call.',
        questions: [{ id: `${title}-q1`, questionNumber: 1, type: 'form_completion', prompt: 'Tour departs at:', correctAnswer: '09:15' }],
      },
    },
  };
}

async function save(payload: object): Promise<{ id: string; section: string }> {
  const response = await admin('/api/admin/materials', { method: 'POST', body: JSON.stringify(payload) });
  const body = await response.json();
  if (response.status !== 200) throw new Error(`fixture did not save: ${JSON.stringify(body)}`);
  return { id: body.item.id, section: body.item.section };
}

async function publish(payload: object): Promise<string> {
  const { id, section } = await save(payload);
  const published = await admin(`/api/admin/materials/${section}/${id}/publish`, { method: 'POST' });
  if (published.status !== 200) throw new Error(`fixture did not publish: ${JSON.stringify(await published.json())}`);
  return id;
}

async function staffCookie(username: string, password: string): Promise<string> {
  const login = await fetch(`${origin}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  if (!cookie.includes('prep_admin_auth=')) throw new Error(`${username} could not sign in (${login.status})`);
  return cookie;
}

before(async () => {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/auth', authRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api', authenticateRequest, learnerContentRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  adminCookie = await staffCookie(ADMIN_USER, ADMIN_PASSWORD);
  examinerCookie = await staffCookie('examiner', EXAMINER_PASSWORD);
  const registered = await fetch(`${origin}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'asset_access_learner', email: 'asset-access@example.com', password: 'Str0ng-Passw0rd-For-Learner', name: 'Asset Learner' }),
  });
  learnerCookie = (registered.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  expect(learnerCookie).toContain('prep_auth=');
});

after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  process.chdir(originalCwd);
  removeTempRoot(tempRoot);
});

describe('H3: an imported original never reaches a learner', () => {
  it('the Phase 17 reproduction — a published material names its original in sourceAssetId and assetIds — gives a learner who knows the id a 404 and never the key', async () => {
    const original = await storeAsset('imported-page.html', Buffer.from(ORIGINAL_HTML), 'text/html', 'html');
    const materialId = await publish(
      reading('Imported Reading', { sourceAssetId: original.id, assetIds: [original.id] }, { htmlContent: '<h1>Algae as fuel</h1><p>Algae can grow in open ponds.</p>' }),
    );

    // The learner can open the material, and nothing in it names the original.
    const opened = await read(learner(`/api/learner/materials/reading/${materialId}`));
    expect([opened.status, opened.text.includes(original.id), opened.text.includes(SECRET)]).toEqual([200, false, false]);

    const denied = await read(learner(`/api/assets/${original.id}`));
    expectDenied('the original, by its id', denied, SECRET, 'imported-page.html', original.storagePath, 'text/html');

    // Kept, and still an administrator's to read.
    const kept = await read(admin(`/api/admin/assets/${original.id}`));
    expect([kept.status, kept.disposition.startsWith('attachment'), kept.text.includes(SECRET)]).toEqual([200, true, true]);
  });

  it('keeps the originals the import and upload routes store — and the sanitised copy — away from learners', async () => {
    const imported = await admin('/api/admin/import/html', { method: 'POST', body: JSON.stringify({ html: ORIGINAL_HTML, filename: 'cdi-page.html' }) });
    expect(imported.status).toBe(200);
    const importOriginal = (await imported.json()).sourceAssetId as string;

    const form = new FormData();
    form.append('file', new Blob([ORIGINAL_HTML], { type: 'text/html' }), 'uploaded-page.html');
    const uploaded = await postForm('/api/admin/upload', form);
    expect(uploaded.status).toBe(200);
    const { file } = await uploaded.json();
    const uploadOriginal = file.sourceAssetId as string;
    const sanitised = file.assetId as string;

    await publish(reading('Uploaded Reading', { sourceAssetId: uploadOriginal, assetIds: [importOriginal, uploadOriginal, sanitised] }, { htmlContent: file.extractedHtml }));

    for (const [label, id] of [['import original', importOriginal], ['upload original', uploadOriginal], ['sanitised copy', sanitised]] as const) {
      expectDenied(label, await read(learner(`/api/assets/${id}`)), SECRET);
      expect([label, (await admin(`/api/admin/assets/${id}`)).status]).toEqual([label, 200]);
    }
  });

  it('answers a guessed id, a known private id and a malformed id exactly alike', async () => {
    const staged = await storeAsset('staged-figure.png', PNG, 'image/png', 'image');
    for (const [label, id] of [
      ['a guessed id', `ast_${'x'.repeat(16)}`],
      ['a staged upload nothing references', staged.id],
      ['a malformed id', 'not-an-asset'],
      ['an encoded traversal', '..%2F..%2Fdata'],
    ] as const) {
      expectDenied(label, await read(learner(`/api/assets/${id}`)), 'staged-figure.png');
    }
  });
});

describe('the files a published material renders still reach the learner', () => {
  it('plays published Listening audio, and shows a question image and an image in the passage', async () => {
    const audio = await storeAsset('part-1.mp3', MP3, 'audio/mpeg', 'audio');
    const listeningId = await publish(listening('Audio Listening', { audioAssetId: audio.id, audioUrl: `/api/assets/${audio.id}`, assetIds: [audio.id] }));
    const played = await read(learner(`/api/assets/${audio.id}`));
    expect([played.status, played.type.includes('audio/mpeg'), played.disposition.startsWith('inline')]).toEqual([200, true, true]);
    const practice = await (await learner(`/api/learner/materials/listening/${listeningId}`)).json();
    expect(practice.test.listening.parts[0].audioUrl).toBe(`/api/assets/${audio.id}`);

    const questionImage = await storeAsset('diagram.png', PNG, 'image/png', 'image');
    const passageImage = await storeAsset('figure.png', PNG, 'image/png', 'image');
    await publish(
      reading(
        'Illustrated Reading',
        { assetIds: [questionImage.id, passageImage.id] },
        {
          htmlContent: `<p>See the figure.</p><img src="/api/assets/${passageImage.id}" alt="Pond">`,
          questions: [
            { id: 'illustrated-q1', questionNumber: 1, type: 'true_false_not_given', prompt: 'The diagram shows a pond.', correctAnswer: 'TRUE', mediaRef: { assetId: questionImage.id, kind: 'image' } },
          ],
        },
      ),
    );
    for (const [label, id] of [['question image', questionImage.id], ['passage image', passageImage.id]] as const) {
      const shown = await read(learner(`/api/assets/${id}`));
      expect([label, shown.status, shown.type.includes('image/png')]).toEqual([label, 200, true]);
    }
  });

  it('refuses the files of a draft or archived material, and a file a published material only lists', async () => {
    const image = await storeAsset('draft-figure.png', PNG, 'image/png', 'image');
    const draft = await save(reading('Draft Reading', { assetIds: [image.id] }, { htmlContent: `<img src="/api/assets/${image.id}" alt="Figure">` }));
    expectDenied('a draft material image', await read(learner(`/api/assets/${image.id}`)));

    expect((await admin(`/api/admin/materials/reading/${draft.id}/publish`, { method: 'POST' })).status).toBe(200);
    expect((await read(learner(`/api/assets/${image.id}`))).status).toBe(200);
    expect((await admin(`/api/admin/materials/reading/${draft.id}/archive`, { method: 'POST' })).status).toBe(200);
    expectDenied('an archived material image', await read(learner(`/api/assets/${image.id}`)));

    const listedOnly = await storeAsset('attachment.png', PNG, 'image/png', 'image');
    await publish(reading('Listing Reading', { assetIds: [listedOnly.id] }));
    expectDenied('a file only in assetIds', await read(learner(`/api/assets/${listedOnly.id}`)));
  });

  it('refuses an original even where learner media goes, and never serves HTML as learner media', async () => {
    const original = await storeAsset('original-page.html', Buffer.from(ORIGINAL_HTML), 'text/html', 'html');
    await publish(reading('Original Owner', { sourceAssetId: original.id, assetIds: [original.id] }));
    // Another published material points an image at it: the original is still an original.
    await publish(reading('Pointing Reading', { assetIds: [original.id] }, { htmlContent: `<p>Figure:</p><img src="/api/assets/${original.id}" alt="Figure">` }));
    expectDenied('an original shown as an image', await read(learner(`/api/assets/${original.id}`)), SECRET);

    const page = await storeAsset('page-as-audio.html', Buffer.from(ORIGINAL_HTML), 'text/html', 'html');
    await publish(listening('HTML Audio Listening', { audioAssetId: page.id, assetIds: [page.id] }));
    expectDenied('an HTML file named as audio', await read(learner(`/api/assets/${page.id}`)), SECRET);
  });
});

describe('staff access', () => {
  it('lets an administrator read every file, and an examiner every material file but not the source library', async () => {
    const book = new FormData();
    book.append('file', new Blob(['Chapter one.\n\nScanning means looking for specific words.\n\nSkimming means reading for gist.'], { type: 'text/plain' }), 'reading-skills.txt');
    const ingested = await postForm('/api/admin/sources', book);
    expect(ingested.status).toBe(200);
    const { item: source } = await ingested.json();
    expect(source.status).toBe('ready');

    for (const [label, id] of [['source original', source.sourceAssetId], ['source extraction', source.extractedTextAssetId]] as const) {
      expect([label, (await admin(`/api/admin/assets/${id}`)).status]).toEqual([label, 200]);
      expectDenied(`${label} to an examiner`, await read(examiner(`/api/admin/assets/${id}`)), 'reading-skills.txt');
      expectDenied(`${label} to a learner`, await read(learner(`/api/assets/${id}`)), 'Scanning means');
    }

    const listedByAdmin = (await (await admin('/api/admin/assets')).json()).items.map((asset: { id: string }) => asset.id);
    const listedByExaminer = (await (await examiner('/api/admin/assets')).json()).items.map((asset: { id: string }) => asset.id);
    expect([listedByAdmin.includes(source.sourceAssetId), listedByAdmin.includes(source.extractedTextAssetId)]).toEqual([true, true]);
    expect([listedByExaminer.includes(source.sourceAssetId), listedByExaminer.includes(source.extractedTextAssetId)]).toEqual([false, false]);

    const original = await storeAsset('examiner-review.html', Buffer.from(ORIGINAL_HTML), 'text/html', 'html');
    await publish(reading('Examiner Reading', { sourceAssetId: original.id, assetIds: [original.id] }));
    const reviewed = await read(examiner(`/api/admin/assets/${original.id}`));
    expect([reviewed.status, reviewed.text.includes(SECRET)]).toEqual([200, true]);
    expect(listedByExaminer.length).toBeGreaterThan(0);
  });
});

describe('a file is judged by the role its records give it, not only by its kind', () => {
  it('refuses an original that is an image — a scanned answer sheet — even when a published material renders it', async () => {
    const scan = await storeAsset('answer-sheet-scan.png', PNG, 'image/png', 'image');
    await publish(reading('Scanned Original', { sourceAssetId: scan.id, assetIds: [scan.id] }));
    await publish(reading('Scan Pointer', { assetIds: [scan.id] }, { htmlContent: `<p>Figure:</p><img src="/api/assets/${scan.id}" alt="Figure">` }));
    // Audio or image, rendered by a published material: only its role as an original refuses it.
    expectDenied('an image kept as an original', await read(learner(`/api/assets/${scan.id}`)), 'answer-sheet-scan.png');
    expect((await admin(`/api/admin/assets/${scan.id}`)).status).toBe(200);
  });

  it('builds learner views without the list of files a material keeps, so no payload built from one can carry an original id', async () => {
    const { adminStore } = await import('../src/services/adminStore');
    const { toLearnerMaterial } = await import('../src/services/sittingView');
    const original = await storeAsset('view-original.html', Buffer.from(ORIGINAL_HTML), 'text/html', 'html');
    const audio = await storeAsset('view-part.mp3', MP3, 'audio/mpeg', 'audio');
    const readingId = await publish(reading('View Reading', { sourceAssetId: original.id, assetIds: [original.id] }));
    const listeningId = await publish(listening('View Listening', { audioAssetId: audio.id, sourceAssetId: original.id, assetIds: [audio.id, original.id] }));
    for (const [section, id] of [['reading', readingId], ['listening', listeningId]] as const) {
      const stored = await adminStore.getMaterial(section, id);
      if (!stored) throw new Error(`expected ${section} material ${id}`);
      for (const keepTranscript of [true, false]) {
        const view = JSON.stringify(toLearnerMaterial(stored, { keepTranscript }));
        expect([section, keepTranscript, view.includes('"assetIds"'), view.includes('"sourceAssetId"'), view.includes(original.id)]).toEqual([section, keepTranscript, false, false, false]);
      }
    }
  });
});
