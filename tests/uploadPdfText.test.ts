import './env';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';
import { buildPdf } from './pdfFixture';

/**
 * L15: the text a PDF upload hands back to the editors.
 *
 * `POST /api/admin/upload` called pdf-parse 2 the version-1 way, as a function.
 * Its export is a class, so every call threw, the catch swallowed it, and every
 * PDF was stored with no extracted text — while Source Library ingestion, which
 * uses the class, read the same file. These upload real PDFs through the real
 * admin router and require the text back, and the same file to still ingest.
 */
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-upload-pdf-'));
const originalCwd = process.cwd();
process.chdir(tempRoot);

const ADMIN_USER = 'upload_pdf_admin';
const ADMIN_PASSWORD = 'Str0ng-Passw0rd-For-Pdf-Uploads';
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

const PAGES = [
  ['Chapter One: Urban Foxes', 'Foxes hunt mostly at night in cities.'],
  ['Chapter Two: Salt and Trade', 'Soldiers were sometimes paid in salt.'],
];

async function upload(filename: string, content: Buffer, mimeType: string) {
  const boundary = '----everstudypdf' + Math.random().toString(36).slice(2);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const response = await fetch(`${origin}/api/admin/upload`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, cookie: adminCookie },
    body,
  });
  return { status: response.status, json: (await response.json()) as { file?: Record<string, unknown>; error?: string } };
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

describe('POST /api/admin/upload with a PDF', () => {
  it('stores the file and hands back its text, every page of it, with no extraction error', async () => {
    const pdf = buildPdf(PAGES);
    const { status, json } = await upload('two-chapters.pdf', pdf, 'application/pdf');
    expect(status).toBe(200);
    const file = json.file ?? {};
    const text = String(file.extractedText ?? '');
    for (const line of PAGES.flat()) expect([line, text.includes(line)]).toEqual([line, true]);
    expect(file.extractionError).toBeUndefined();
    expect([file.mimeType, file.kind]).toEqual(['application/pdf', 'document']);
    const stored = await assetStore.get(String(file.assetId));
    expect(stored?.size).toBe(pdf.length);
  });

  it('a PDF that cannot be parsed is still stored, and says its text could not be extracted', async () => {
    const broken = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF garbage', 'latin1');
    const { status, json } = await upload('broken.pdf', broken, 'application/pdf');
    expect(status).toBe(200);
    expect([json.file?.extractedText, json.file?.extractionError]).toEqual([undefined, 'Text could not be extracted from this PDF.']);
  });

  it('the same PDF still ingests through Source Library, page by page', async () => {
    const extracted = await extractSource('pdf', buildPdf(PAGES));
    const text = extracted.blocks.map((block) => block.text).join(' ');
    for (const line of PAGES.flat()) expect([line, text.includes(line)]).toEqual([line, true]);
    expect(extracted.pageCount).toBe(2);
  });
});
