import './env';
import { after, before, describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http, { type Server } from 'node:http';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';
import type { AssetKind } from '../src/types/asset';

/**
 * H8: exam and practice recordings are delivered the way media players fetch them.
 *
 * A browser's `<audio>` asks for byte ranges, Safari and iOS for every recording
 * before they play any of it. The asset routes used to ignore `Range` and send the
 * whole file with 200 (Phase 17, Probe 1 S4b). These drive the real learner and
 * staff routes: 206 with the exact bytes for a range, 200 without one, 416 for a
 * range the file cannot satisfy — and no range ever reaches a file the Phase 22
 * policy refuses, nor makes anything but audio look like audio.
 */
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-asset-range-'));
const originalCwd = process.cwd();
process.chdir(tempRoot);

const ADMIN_USER = 'asset_range_admin';
const ADMIN_PASSWORD = 'Str0ng-Passw0rd-For-Ranges';
process.env.SEED_DEFAULT_ACCOUNTS = 'true';
process.env.ADMIN_USER = ADMIN_USER;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;

const express = (await import('express')).default;
const { adminRouter } = await import('../src/routes/adminRoutes');
const { learnerContentRouter } = await import('../src/routes/learnerContentRoutes');
const { authRouter } = await import('../src/routes/authRoutes');
const { authenticateRequest } = await import('../src/middleware/authMiddleware');
const { assetStore } = await import('../src/services/assetStore');

/** A recording of 1,000 bytes whose every byte differs from its neighbours, so a wrong slice cannot pass. */
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.from(Array.from({ length: 996 }, (_, index) => (index * 7 + 3) % 256))]);
const SIZE = WAV.length;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const SECRET = 'SECRET-KEY-MARKER-9C1D';
const ORIGINAL_HTML = `<html><body><h1>Answer key</h1><p>1 TRUE ${SECRET}</p></body></html>`;
const DENIED = JSON.stringify({ error: 'Asset not found.' });

let server: Server;
let origin = '';
let adminCookie = '';
let learnerCookie = '';

interface Reply {
  status: number;
  headers: Headers;
  body: Buffer;
}

async function fetchAsset(cookie: string, url: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Reply> {
  const response = await fetch(`${origin}${url}`, { method, headers: { cookie, ...headers } });
  return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) };
}
const learner = (url: string, headers: Record<string, string> = {}, method = 'GET') => fetchAsset(learnerCookie, url, headers, method);

/**
 * A learner GET without fetch(). The Fetch standard turns a conditional request
 * into `Cache-Control: no-cache`, which rightly defeats a 304; a browser
 * revalidating what it has cached sends no such header.
 */
function rawLearnerGet(url: string, headers: Record<string, string>): Promise<{ status: number; length: number }> {
  return new Promise((resolve, reject) => {
    const request = http.get(`${origin}${url}`, { headers: { cookie: learnerCookie, ...headers } }, (response) => {
      let length = 0;
      response.on('data', (chunk: Buffer) => {
        length += chunk.length;
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, length }));
    });
    request.on('error', reject);
  });
}
const staff = (url: string, headers: Record<string, string> = {}) => fetchAsset(adminCookie, url, headers);

const storeAsset = (originalName: string, content: Buffer, mimeType: string, kind: AssetKind) =>
  assetStore.create({ originalName, content, mimeType, kind, createdBy: 'test', sourceType: 'upload' });

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

function reading(title: string, content: Record<string, unknown>, htmlContent?: string) {
  return {
    title,
    section: 'reading',
    module: 'academic',
    theme: 'Energy',
    targetBand: '7.0',
    content: {
      ...content,
      passage: {
        passageNumber: 1,
        title: 'Algae',
        text: 'Algae grow in ponds.',
        ...(htmlContent ? { htmlContent } : {}),
        questions: [{ id: `${title}-q1`, questionNumber: 1, type: 'true_false_not_given', prompt: 'Algae need farmland.', correctAnswer: 'FALSE' }],
      },
    },
  };
}

async function save(payload: object): Promise<{ id: string; section: string }> {
  const response = await fetch(`${origin}/api/admin/materials`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: adminCookie }, body: JSON.stringify(payload) });
  const body = await response.json();
  if (response.status !== 200) throw new Error(`fixture did not save: ${JSON.stringify(body)}`);
  return { id: body.item.id, section: body.item.section };
}

async function publish(payload: object): Promise<string> {
  const { id, section } = await save(payload);
  const published = await fetch(`${origin}/api/admin/materials/${section}/${id}/publish`, { method: 'POST', headers: { cookie: adminCookie } });
  if (published.status !== 200) throw new Error(`fixture did not publish: ${JSON.stringify(await published.json())}`);
  return id;
}

let audioId = '';
let audioEtag = '';

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

  const login = await fetch(`${origin}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASSWORD }) });
  adminCookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const registered = await fetch(`${origin}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'asset_range_learner', email: 'asset-range@example.com', password: 'Str0ng-Passw0rd-For-Learner', name: 'Range Learner' }),
  });
  learnerCookie = (registered.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

  const audio = await storeAsset('part-1.wav', WAV, 'audio/wav', 'audio');
  audioId = audio.id;
  audioEtag = `"${createHash('sha256').update(WAV).digest('hex')}"`;
  await publish(listening('Range Listening', { audioAssetId: audio.id }));
});

after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  process.chdir(originalCwd);
  removeTempRoot(tempRoot);
});

function expectSlice(label: string, reply: Reply, start: number, end: number) {
  expect([label, reply.status]).toEqual([label, 206]);
  expect([label, reply.headers.get('content-range')]).toEqual([label, `bytes ${start}-${end}/${SIZE}`]);
  expect([label, reply.headers.get('content-length')]).toEqual([label, String(end - start + 1)]);
  expect([label, reply.headers.get('content-type')]).toEqual([label, 'audio/wav']);
  expect([label, reply.headers.get('accept-ranges')]).toEqual([label, 'bytes']);
  expect([label, reply.body.equals(WAV.subarray(start, end + 1))]).toEqual([label, true]);
}

function expectWhole(label: string, reply: Reply) {
  expect([label, reply.status, reply.headers.get('content-range'), reply.headers.get('content-length')]).toEqual([label, 200, null, String(SIZE)]);
  expect([label, reply.body.equals(WAV)]).toEqual([label, true]);
}

/** A refusal: the same 404 an unknown id gets, with no range headers and nothing of the file. */
function expectDenied(label: string, reply: Reply) {
  expect([label, reply.status, reply.body.toString('utf8')]).toEqual([label, 404, DENIED]);
  expect([label, reply.headers.get('content-range'), reply.headers.get('accept-ranges')]).toEqual([label, null, null]);
  expect([label, reply.body.toString('utf8').includes(SECRET)]).toEqual([label, false]);
}

describe('H8: learner audio answers byte ranges', () => {
  it('sends the whole recording without a Range, saying it accepts byte ranges, validated by its digest and never cached shared', async () => {
    const whole = await learner(`/api/assets/${audioId}`);
    expectWhole('full request', whole);
    expect([whole.headers.get('content-type'), whole.headers.get('accept-ranges'), whole.headers.get('etag'), whole.headers.get('cache-control')]).toEqual([
      'audio/wav',
      'bytes',
      audioEtag,
      'private, no-cache',
    ]);
    expect(whole.headers.get('content-disposition')?.startsWith('inline')).toBe(true);
    expect(whole.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('answers HEAD with the headers of the recording and no body', async () => {
    const head = await learner(`/api/assets/${audioId}`, {}, 'HEAD');
    expect([head.status, head.headers.get('content-length'), head.headers.get('accept-ranges'), head.body.length]).toEqual([200, String(SIZE), 'bytes', 0]);
    const headRange = await learner(`/api/assets/${audioId}`, { Range: 'bytes=0-99' }, 'HEAD');
    expect([headRange.status, headRange.headers.get('content-range'), headRange.body.length]).toEqual([206, `bytes 0-99/${SIZE}`, 0]);
  });

  it('answers the first, a middle and the final range with 206 and exactly those bytes', async () => {
    expectSlice('first 100 bytes', await learner(`/api/assets/${audioId}`, { Range: 'bytes=0-99' }), 0, 99);
    expectSlice('first byte', await learner(`/api/assets/${audioId}`, { Range: 'bytes=0-0' }), 0, 0);
    expectSlice('open-ended from the start', await learner(`/api/assets/${audioId}`, { Range: 'bytes=0-' }), 0, SIZE - 1);
    expectSlice('a middle range', await learner(`/api/assets/${audioId}`, { Range: 'bytes=400-599' }), 400, 599);
    expectSlice('the final 100 bytes', await learner(`/api/assets/${audioId}`, { Range: 'bytes=-100' }), SIZE - 100, SIZE - 1);
    expectSlice('open-ended to the end', await learner(`/api/assets/${audioId}`, { Range: 'bytes=990-' }), 990, SIZE - 1);
    expectSlice('the last byte', await learner(`/api/assets/${audioId}`, { Range: `bytes=${SIZE - 1}-${SIZE - 1}` }), SIZE - 1, SIZE - 1);
    expectSlice('an end past the file', await learner(`/api/assets/${audioId}`, { Range: 'bytes=900-5000' }), 900, SIZE - 1);
    expectSlice('adjacent ranges combined', await learner(`/api/assets/${audioId}`, { Range: 'bytes=0-9,10-19' }), 0, 19);
  });

  it('refuses a byte range the recording cannot satisfy with 416, and ignores a header it cannot use', async () => {
    for (const range of [`bytes=${SIZE}-`, 'bytes=5000-6000', 'bytes=-0', 'bytes=500-100', 'bytes=abc']) {
      const refused = await learner(`/api/assets/${audioId}`, { Range: range });
      expect([range, refused.status, refused.headers.get('content-range'), refused.body.length]).toEqual([range, 416, `bytes */${SIZE}`, 0]);
    }
    for (const range of ['items=0-9', 'bytes 0-9', 'bytes=0-9,20-29']) {
      expectWhole(`ignored: ${range}`, await learner(`/api/assets/${audioId}`, { Range: range }));
    }
  });

  it('serves a range only against the version it was taken from, and revalidates by digest', async () => {
    expectSlice('matching If-Range', await learner(`/api/assets/${audioId}`, { Range: 'bytes=0-99', 'If-Range': audioEtag }), 0, 99);
    expectWhole('stale If-Range', await learner(`/api/assets/${audioId}`, { Range: 'bytes=0-99', 'If-Range': '"an-older-version"' }));
    const notModified = await rawLearnerGet(`/api/assets/${audioId}`, { 'If-None-Match': audioEtag });
    expect([notModified.status, notModified.length]).toEqual([304, 0]);
    const changed = await rawLearnerGet(`/api/assets/${audioId}`, { 'If-None-Match': '"an-older-version"' });
    expect([changed.status, changed.length]).toEqual([200, SIZE]);
  });
});

describe('H8: a Range header never widens what a learner may read', () => {
  it('answers an unknown, guessed or malformed id with the same 404, with or without a Range', async () => {
    for (const id of [`ast_${'x'.repeat(16)}`, 'not-an-asset', '..%2F..%2Fdata']) {
      for (const headers of [{}, { Range: 'bytes=0-9' }, { Range: 'bytes=0-' }] as Array<Record<string, string>>) {
        expectDenied(`${id} ${JSON.stringify(headers)}`, await learner(`/api/assets/${id}`, headers));
      }
    }
  });

  it('refuses an original, a private upload and a draft recording exactly as without a Range', async () => {
    const original = await storeAsset('imported-page.html', Buffer.from(ORIGINAL_HTML), 'text/html', 'html');
    await publish(reading('Range Original', { sourceAssetId: original.id, assetIds: [original.id] }));
    const staged = await storeAsset('staged.wav', WAV, 'audio/wav', 'audio');
    const draftAudio = await storeAsset('draft.wav', WAV, 'audio/wav', 'audio');
    await save(listening('Range Draft', { audioAssetId: draftAudio.id }));
    const originalAudio = await storeAsset('original-recording.wav', WAV, 'audio/wav', 'audio');
    await publish(listening('Range Original Audio', { audioAssetId: originalAudio.id, sourceAssetId: originalAudio.id }));

    for (const [label, id] of [
      ['an imported original', original.id],
      ['a staged upload', staged.id],
      ['a draft material recording', draftAudio.id],
      ['a recording kept as an original', originalAudio.id],
    ] as const) {
      for (const range of [undefined, 'bytes=0-9', 'bytes=-10', `bytes=${SIZE}-`]) {
        const headers: Record<string, string> = range ? { Range: range } : {};
        expectDenied(`${label} ${range ?? 'no range'}`, await learner(`/api/assets/${id}`, headers));
      }
    }
  });

  it('serves an image as an image and never lets anything but audio bytes pass as audio', async () => {
    const image = await storeAsset('figure-as-audio.png', PNG, 'image/png', 'image');
    await publish(listening('Image As Audio', { audioAssetId: image.id }));
    const shown = await learner(`/api/assets/${image.id}`, { Range: 'bytes=0-3' });
    expect([shown.status, shown.headers.get('content-type'), shown.body.equals(PNG.subarray(0, 4))]).toEqual([206, 'image/png', true]);

    const page = await storeAsset('page-as-audio.html', Buffer.from(ORIGINAL_HTML), 'text/html', 'html');
    await publish(listening('Page As Audio', { audioAssetId: page.id }));
    expectDenied('an HTML file named as audio, with a Range', await learner(`/api/assets/${page.id}`, { Range: 'bytes=0-9' }));
  });
});

describe('H8: staff reads', () => {
  it('serves staff the same ranges, and sends a download whole, without ranges', async () => {
    expectSlice('staff range', await staff(`/api/admin/assets/${audioId}`, { Range: 'bytes=100-199' }), 100, 199);
    const page = await storeAsset('staff-page.html', Buffer.from(ORIGINAL_HTML), 'text/html', 'html');
    const download = await staff(`/api/admin/assets/${page.id}`, { Range: 'bytes=0-9' });
    expect([download.status, download.headers.get('content-type'), download.headers.get('accept-ranges'), download.headers.get('content-range')]).toEqual([
      200,
      'application/octet-stream',
      'none',
      null,
    ]);
    expect([download.headers.get('content-disposition')?.startsWith('attachment'), download.body.toString('utf8')]).toEqual([true, ORIGINAL_HTML]);
  });
});
