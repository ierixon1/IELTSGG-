import './env';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';

/**
 * The plain text an HTML upload hands back to the editors.
 *
 * `POST /api/admin/upload` used to collapse "whitespace" with `/s+/g` — a regex
 * that had lost its backslash, so it matched runs of the letter s instead. Every
 * word containing an s came back broken ("skills" → " kill "), tabs and newlines
 * survived untouched, and the result was pasted straight into a Reading passage
 * or a Listening transcript. Nothing failed; the text was simply wrong.
 *
 * The assertions are exact on purpose. "Contains skills" would pass for a
 * regex that both kept the letter and failed to collapse whitespace; only the
 * whole string proves both halves of the fix at once.
 */
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-upload-text-'));
const originalCwd = process.cwd();
process.chdir(tempRoot);

const ADMIN_USER = 'upload_text_admin';
const ADMIN_PASSWORD = 'Str0ng-Passw0rd-For-Uploads';
process.env.SEED_DEFAULT_ACCOUNTS = 'true';
process.env.ADMIN_USER = ADMIN_USER;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;

const express = (await import('express')).default;
const { adminRouter } = await import('../src/routes/adminRoutes');
const { assetStore } = await import('../src/services/assetStore');
const { extractSource } = await import('../src/services/sourceIngest/extract');

let server: Server;
let origin = '';
let adminCookie = '';

/**
 * Letter s everywhere, and every kind of whitespace a real export contains:
 * runs of spaces, a tab, single and blank-line newlines, and CRLF.
 */
const HTML = Buffer.from(
  '<html><body>\r\n' +
    '<h1>Scanning   skills</h1>\n' +
    '<p>students\tsuccessfully\n\n   assess    classes</p>\r\n' +
    '<p>Sisters\t\tsuss\nstress-less sessions</p>\n' +
    '</body></html>\n',
  'utf8',
);
const EXPECTED = 'Scanning skills students successfully assess classes Sisters suss stress-less sessions';

async function uploadHtml(filename: string, content: Buffer) {
  const boundary = '----everstudytext' + Math.random().toString(36).slice(2);
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        'Content-Type: text/html\r\n\r\n',
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const response = await fetch(`${origin}/api/admin/upload`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, cookie: adminCookie },
    body,
  });
  return { status: response.status, json: (await response.json()) as Record<string, any> };
}

before(async () => {
  const app = express();
  app.use(express.json());
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
  adminCookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  expect(adminCookie).toContain('prep_admin_auth=');
});

after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  process.chdir(originalCwd);
  removeTempRoot(tempRoot);
});

describe('text extracted from an uploaded HTML file', () => {
  it('keeps every letter s and collapses every run of whitespace to one space', async () => {
    const { status, json } = await uploadHtml('reading-passage.html', HTML);
    expect(status).toBe(200);

    const text: string = json.file.extractedText;
    expect(text).toBe(EXPECTED);
  });

  it('keeps each word containing s intact', async () => {
    const { json } = await uploadHtml('words.html', HTML);
    const words = String(json.file.extractedText).split(' ');

    for (const word of ['skills', 'Scanning', 'students', 'successfully', 'assess', 'classes', 'sessions']) {
      expect(words.includes(word)).toBe(true);
    }
    // The old regex's signature: an s-word broken into fragments.
    expect(words.includes('kill')).toBe(false);
    expect(words.includes('tudent')).toBe(false);
  });

  it('leaves no tab, newline, carriage return or double space behind', async () => {
    const { json } = await uploadHtml('whitespace.html', HTML);
    const text = String(json.file.extractedText);

    expect(/[\t\n\r]/.test(text)).toBe(false);
    expect(text.includes('  ')).toBe(false);
    expect(text).toBe(text.trim());
  });

  it('does not alter the stored original, byte for byte', async () => {
    const { json } = await uploadHtml('original.html', HTML);

    // The response points at the sanitised copy; the untouched upload is the
    // source asset it was derived from.
    const original = await assetStore.get(json.file.sourceAssetId);
    expect(original === null).toBe(false);
    const stored = await assetStore.readContent(original!);
    expect(stored.equals(HTML)).toBe(true);
    // Including the whitespace the extracted text collapsed.
    expect(stored.toString('utf8').includes('Scanning   skills')).toBe(true);
    expect(stored.toString('utf8').includes('students\tsuccessfully')).toBe(true);

    // The sanitised derivative is built from the same bytes, not from the
    // extracted text, so it keeps its s-words too.
    const derived = await assetStore.get(json.file.assetId);
    expect(derived?.derivedFromAssetId).toBe(original!.id);
    const sanitised = (await assetStore.readContent(derived!)).toString('utf8');
    expect(sanitised.includes('skills')).toBe(true);
    expect(sanitised.includes('students')).toBe(true);
  });
});

describe('the source-ingestion HTML path', () => {
  it('was never on the broken code path, and reads the same page intact', async () => {
    // Textbook ingestion reads HTML through `extractHtml`, not the upload
    // route. Asserted here so the two paths cannot silently drift into
    // disagreeing about the same file.
    const document = await extractSource('html', HTML);
    const joined = document.blocks.map((block) => block.text).join(' ');

    for (const word of ['Scanning', 'skills', 'students', 'successfully', 'classes', 'sessions']) {
      expect(joined.includes(word)).toBe(true);
    }
    expect(joined.includes('kill ')).toBe(false);
  });
});
