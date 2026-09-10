import './env';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';
import type { SourceChunk, StoredSource } from '../src/types/source';

/**
 * Book → knowledge base, driven through the job and the admin API.
 *
 * Most of what is asserted here is what must *not* happen: a malformed file
 * that ingests as an empty but "ready" book, a chunk that cites a chapter it
 * never sat under, a citation whose offsets point at different text, a search
 * for something the book never mentions that returns the three least-unrelated
 * passages anyway, and an original file the reaper quietly collects.
 */
const originalCwd = process.cwd();
const FIXTURES = path.join(originalCwd, 'tests', 'fixtures', 'sources');
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-sources-'));
process.chdir(tempRoot);

const ADMIN_USER = 'sources_admin';
const ADMIN_PASSWORD = 'Str0ng-Passw0rd-For-Sources';
process.env.SEED_DEFAULT_ACCOUNTS = 'true';
process.env.ADMIN_USER = ADMIN_USER;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;

const express = (await import('express')).default;
const { adminRouter } = await import('../src/routes/adminRoutes');
const { ingestSource, UnsupportedSourceError } = await import('../src/services/sourceIngest/ingest');
const { extractSource, detectHeading } = await import('../src/services/sourceIngest/extract');
const { chunkDocument, extractedTextOf, MAX_CHARACTERS } = await import(
  '../src/services/sourceIngest/chunk'
);
const { retrieve } = await import('../src/services/sourceIngest/retrieve');
const { sourceStore } = await import('../src/services/sourceStore');
const { assetStore } = await import('../src/services/assetStore');

const fixture = (name: string) => readFileSync(path.join(FIXTURES, name));

/**
 * A two-page PDF with a real text layer, written byte by byte.
 *
 * Built here rather than committed as a binary so the test says exactly what is
 * in it: two pages, two chapters, text that pdf-parse must recover per page.
 */
function buildPdf(pages: string[][]): Buffer {
  const objects: string[] = [];
  const push = (body: string) => objects.push(body);

  push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'); // 1
  const contentNums: number[] = [];
  for (const lines of pages) {
    const stream =
      'BT /F1 12 Tf 72 720 Td 14 TL\n' +
      lines.map((line) => `(${line.replace(/[()\\]/g, '\\$&')}) Tj T*`).join('\n') +
      '\nET';
    contentNums.push(push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`));
  }
  const pagesNum = objects.length + pages.length + 1;
  const pageNums = pages.map((_, i) =>
    push(
      `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 1 0 R >> >> /Contents ${contentNums[i]} 0 R >>`,
    ),
  );
  push(`<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageNums.length} >>`);
  const catalog = push(`<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

let server: Server;
let origin = '';
let adminCookie = '';

const api = (url: string, init: RequestInit = {}) =>
  fetch(`${origin}${url}`, { ...init, headers: { cookie: adminCookie, ...(init.headers || {}) } });

const uploadViaApi = async (filename: string, content: Buffer, mimeType: string, title?: string) => {
  const form = new FormData();
  form.append('file', new Blob([content], { type: mimeType }), filename);
  if (title) form.append('title', title);
  return api('/api/admin/sources', { method: 'POST', body: form });
};

before(async () => {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/admin', adminRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const address = server.address();
      origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
      resolve();
    });
  });

  const login = await fetch(`${origin}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASSWORD }),
  });
  expect(login.status).toBe(200);
  adminCookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
});

after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  process.chdir(originalCwd);
  removeTempRoot(tempRoot);
});

describe('successful ingestion', () => {
  it('takes a structured text book from upload to ready', async () => {
    const source = await ingestSource({
      filename: 'study-skills.md',
      buffer: fixture('study-skills.md'),
      mimeType: 'text/plain',
      createdBy: 'test',
    });

    expect(source.status).toBe('ready');
    expect(source.error).toBe(undefined);
    expect(source.fileKind).toBe('text');
    expect(source.stats.chunks > 0).toBe(true);
    expect(source.stats.headings >= 3).toBe(true);

    const chunks = await sourceStore.getChunks(source.id);
    expect(chunks).toHaveLength(source.stats.chunks);
  });

  it('reads a PDF page by page and records the page each passage came from', async () => {
    const pdf = buildPdf([
      ['Chapter 1: Reading for gist', 'Skim the passage before you read the questions.'],
      ['Chapter 2: Reading for detail', 'Scan for numbers, names and dates in the passage.'],
    ]);
    const source = await ingestSource({
      filename: 'two-pages.pdf',
      buffer: pdf,
      mimeType: 'application/pdf',
      createdBy: 'test',
    });

    expect(source.status).toBe('ready');
    expect(source.stats.pages).toBe(2);

    const chunks = await sourceStore.getChunks(source.id);
    const gist = chunks.find((chunk) => chunk.text.includes('Skim the passage'));
    const detail = chunks.find((chunk) => chunk.text.includes('Scan for numbers'));
    expect(gist?.location.page).toBe(1);
    expect(detail?.location.page).toBe(2);
    expect(detail?.location.chapter).toBe('Chapter 2: Reading for detail');
  });

  it('reads HTML by its own headings and never quotes script or style content', async () => {
    const document = await extractSource('html', fixture('listening-guide.html'));
    const { chunks } = chunkDocument('src-html', document);

    expect(chunks.some((chunk) => chunk.text.includes('kangaroos'))).toBe(false);
    expect(chunks.some((chunk) => chunk.text.includes('font-family'))).toBe(false);

    const spelling = chunks.find((chunk) => chunk.text.includes('Double letters'));
    expect(spelling?.location.path).toEqual([
      'Listening Practice Guide',
      'Section 1: everyday conversation',
      'Spelling traps',
    ]);
  });

  it('is reachable end to end through the admin API', async () => {
    const response = await uploadViaApi(
      'listening-guide.html',
      fixture('listening-guide.html'),
      'text/html',
      'Listening Guide',
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.item.status).toBe('ready');
    expect(body.item.title).toBe('Listening Guide');

    const listed = await (await api('/api/admin/sources')).json();
    expect(listed.items.some((item: StoredSource) => item.id === body.item.id)).toBe(true);
  });
});

describe('malformed and unsupported sources', () => {
  it('refuses a format the pipeline does not read, and stores nothing for it', async () => {
    const before = (await sourceStore.list()).length;
    let thrown: unknown = null;
    try {
      await ingestSource({
        filename: 'slides.pptx',
        buffer: Buffer.from('PK not really slides'),
        mimeType: 'application/octet-stream',
        createdBy: 'test',
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof UnsupportedSourceError).toBe(true);
    expect((await sourceStore.list()).length).toBe(before);
  });

  it('answers 400 at the API for an unsupported extension, naming what is supported', async () => {
    const response = await uploadViaApi('notes.rtf', Buffer.from('{\\rtf1 hello}'), 'application/rtf');
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.supported.includes('.pdf')).toBe(true);
  });

  it('refuses a file whose content does not match its extension', async () => {
    // A PNG header wearing a .pdf name: the sniffer, not the extractor, stops it.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const response = await uploadViaApi('book.pdf', png, 'application/pdf');
    expect(response.status).toBe(400);
  });

  it('marks a PDF it cannot parse as failed, with the reason, never ready', async () => {
    const broken = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF garbage', 'latin1');
    const source = await ingestSource({
      filename: 'broken.pdf',
      buffer: broken,
      mimeType: 'application/pdf',
      createdBy: 'test',
    });

    expect(source.status).toBe('failed');
    expect(typeof source.error).toBe('string');
    expect(source.stats.chunks).toBe(0);
    expect(await sourceStore.getChunks(source.id)).toHaveLength(0);
  });

  it('marks a file with no text as failed rather than as an empty ready book', async () => {
    const source = await ingestSource({
      filename: 'blank.txt',
      buffer: Buffer.from('   \n\n\t  \n'),
      mimeType: 'text/plain',
      createdBy: 'test',
    });

    expect(source.status).toBe('failed');
    expect(String(source.error)).toContain('No text could be extracted');
  });

  it('refuses to search a source that did not become ready', async () => {
    const source = await ingestSource({
      filename: 'blank-again.txt',
      buffer: Buffer.from('\n\n'),
      mimeType: 'text/plain',
      createdBy: 'test',
    });
    const response = await api(`/api/admin/sources/${source.id}/chunks?q=anything`);
    expect(response.status).toBe(409);
  });
});

describe('a failed job does not leave an apparently-ready textbook', () => {
  it('lands on failed, with no chunks, when storing the passages throws', async () => {
    const original = sourceStore.saveChunks.bind(sourceStore);
    let calls = 0;
    // Fail the real write (the one with chunks), let the cleanup write through.
    sourceStore.saveChunks = async (id: string, chunks: SourceChunk[]) => {
      calls += 1;
      if (chunks.length > 0) throw new Error('disk full');
      return original(id, chunks);
    };

    let source: StoredSource;
    try {
      source = await ingestSource({
        filename: 'study-skills.md',
        buffer: fixture('study-skills.md'),
        mimeType: 'text/plain',
        createdBy: 'test',
      });
    } finally {
      sourceStore.saveChunks = original;
    }

    expect(calls >= 1).toBe(true);
    expect(source.status).toBe('failed');
    expect(String(source.error)).toContain('could not be stored');

    const stored = await sourceStore.get(source.id);
    expect(stored?.status).toBe('failed');
    expect(await sourceStore.getChunks(source.id)).toHaveLength(0);
  });

  it('never reports ready while a job is still in flight', async () => {
    const seen: string[] = [];
    const original = sourceStore.save.bind(sourceStore);
    sourceStore.save = async (record: StoredSource) => {
      seen.push(record.status);
      return original(record);
    };
    try {
      await ingestSource({
        filename: 'study-skills.md',
        buffer: fixture('study-skills.md'),
        mimeType: 'text/plain',
        createdBy: 'test',
      });
    } finally {
      sourceStore.save = original;
    }

    // `ready` is written once, and last.
    expect(seen.filter((status) => status === 'ready')).toHaveLength(1);
    expect(seen[seen.length - 1]).toBe('ready');
    expect(seen.slice(0, -1).includes('ready')).toBe(false);
  });
});

describe('deterministic chunking', () => {
  it('produces byte-identical chunks from the same bytes', async () => {
    const bytes = fixture('study-skills.md');
    const first = chunkDocument('src-det', await extractSource('text', bytes)).chunks;
    const second = chunkDocument('src-det', await extractSource('text', bytes)).chunks;

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('cuts at headings, never across them', async () => {
    const { chunks } = chunkDocument('src-cut', await extractSource('text', fixture('study-skills.md')));

    for (const chunk of chunks) {
      // No chunk carries the text of a different section's heading in its body.
      const otherHeadings = chunks
        .map((c) => c.heading)
        .filter((heading): heading is string => Boolean(heading) && heading !== chunk.heading);
      for (const heading of otherHeadings) expect(chunk.text.includes(heading)).toBe(false);
    }
  });

  it('splits an over-long section between paragraphs, never inside one', async () => {
    const paragraph = (n: number) => `Paragraph ${n}. ` + 'word '.repeat(90).trim() + '.';
    const body = Array.from({ length: 12 }, (_, i) => paragraph(i + 1)).join('\n\n');
    const document = await extractSource('text', Buffer.from(`# Long chapter\n\n${body}\n`));
    const { chunks } = chunkDocument('src-long', document);

    expect(chunks.length > 1).toBe(true);
    for (const chunk of chunks) {
      expect(chunk.text.length <= MAX_CHARACTERS).toBe(true);
      // Every piece starts at a paragraph boundary.
      expect(/^Paragraph \d+\./.test(chunk.text)).toBe(true);
      expect(chunk.location.section).toBe('Long chapter');
    }
  });

  it('builds the heading path from real ancestry, not from the last headings seen', () => {
    expect(detectHeading('## Chapter 2: Scanning')?.level).toBe(2);
    expect(detectHeading('Unit 4: Cohesion')?.level).toBe(1);
    expect(detectHeading('This is an ordinary sentence that ends with a full stop.')).toBe(null);
  });
});

describe('provenance preservation', () => {
  it('gives every chunk its source, location, and the versions that produced it', async () => {
    const source = await ingestSource({
      filename: 'study-skills.md',
      buffer: fixture('study-skills.md'),
      mimeType: 'text/plain',
      createdBy: 'test',
    });
    const chunks = await sourceStore.getChunks(source.id);

    for (const chunk of chunks) {
      expect(chunk.sourceId).toBe(source.id);
      expect(chunk.extractorVersion).toBe(source.extractorVersion);
      expect(chunk.chunkerVersion).toBe(source.chunkerVersion);
      expect(chunk.location.charEnd > chunk.location.charStart).toBe(true);
      expect(Array.isArray(chunk.location.path)).toBe(true);
      expect(chunk.contentHash).toHaveLength(64);
    }

    const scan = chunks.find((chunk) => chunk.text.includes('least likely to be paraphrased'));
    expect(scan?.location.path).toEqual([
      'IELTS Reading Skills',
      'Chapter 2: Scanning for detail',
      'Choosing the search term',
    ]);
    expect(scan?.location.chapter).toBe('IELTS Reading Skills');
    expect(scan?.location.section).toBe('Choosing the search term');
    // A format without pages records none rather than inventing one.
    expect(scan?.location.page).toBe(undefined);
  });

  it('resolves every chunk offset against the stored extraction exactly', async () => {
    const source = await ingestSource({
      filename: 'study-skills.md',
      buffer: fixture('study-skills.md'),
      mimeType: 'text/plain',
      createdBy: 'test',
    });
    const chunks = await sourceStore.getChunks(source.id);
    const asset = await assetStore.get(String(source.extractedTextAssetId));
    const stored = (await assetStore.readContent(asset!)).toString('utf8');

    expect(stored).toBe(extractedTextOf(chunks));
    for (const chunk of chunks) {
      expect(stored.slice(chunk.location.charStart, chunk.location.charEnd)).toBe(chunk.text);
    }

    // And the API says so for a single chunk.
    const check = await (
      await api(`/api/admin/sources/${source.id}/chunks/${chunks[2].id}/source`)
    ).json();
    expect(check.matches).toBe(true);
    expect(check.provenance.sourceAssetId).toBe(source.sourceAssetId);
  });

  it('reports a mismatch rather than smoothing it over when the extraction changed', async () => {
    const source = await ingestSource({
      filename: 'study-skills.md',
      buffer: fixture('study-skills.md'),
      mimeType: 'text/plain',
      createdBy: 'test',
    });
    const chunks = await sourceStore.getChunks(source.id);

    // Tamper with the stored extraction on disk.
    const asset = await assetStore.get(String(source.extractedTextAssetId));
    const file = path.join(tempRoot, 'data', 'private_uploads', path.basename(asset!.storagePath));
    writeFileSync(file, 'x'.repeat(5000));

    const check = await (
      await api(`/api/admin/sources/${source.id}/chunks/${chunks[1].id}/source`)
    ).json();
    expect(check.matches).toBe(false);
  });
});

describe('asset preservation', () => {
  it('keeps the original bytes untouched and outside the reaper', async () => {
    const bytes = fixture('study-skills.md');
    const source = await ingestSource({
      filename: 'study-skills.md',
      buffer: bytes,
      mimeType: 'text/plain',
      createdBy: 'test',
    });

    const original = await assetStore.get(source.sourceAssetId);
    expect(original === null).toBe(false);
    expect((await assetStore.readContent(original!)).equals(bytes)).toBe(true);
    expect(original?.state).toBe('active');

    // Run the reaper as if a week had passed. Materials reference nothing here,
    // so only the source scan keeps these alive.
    const removed = await assetStore.reapUnreferenced(Date.now() + 7 * 24 * 60 * 60 * 1000);
    expect(removed.includes(source.sourceAssetId)).toBe(false);
    expect(removed.includes(String(source.extractedTextAssetId))).toBe(false);
    expect(await assetStore.get(source.sourceAssetId)).not.toBe(null);
  });

  it('keeps the original of a failed job, so a better extractor can retry it', async () => {
    const source = await ingestSource({
      filename: 'empty.txt',
      buffer: Buffer.from('\n \n'),
      mimeType: 'text/plain',
      createdBy: 'test',
    });
    expect(source.status).toBe('failed');

    const removed = await assetStore.reapUnreferenced(Date.now() + 7 * 24 * 60 * 60 * 1000);
    expect(removed.includes(source.sourceAssetId)).toBe(false);
  });
});

describe('retrieval', () => {
  let chunks: SourceChunk[] = [];

  before(async () => {
    const source = await ingestSource({
      filename: 'study-skills.md',
      buffer: fixture('study-skills.md'),
      mimeType: 'text/plain',
      createdBy: 'test',
    });
    chunks = await sourceStore.getChunks(source.id);
  });

  it('ranks the passage about a topic above passages that mention it in passing', () => {
    const outcome = retrieve(chunks, 'scanning for dates and proper nouns');
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;

    expect(outcome.hits[0].chunk.location.section).toBe('Chapter 2: Scanning for detail');
    expect(outcome.hits[0].confidence).toBe(1);
    for (let i = 1; i < outcome.hits.length; i++) {
      expect(outcome.hits[i - 1].score >= outcome.hits[i].score).toBe(true);
    }
  });

  it('returns only stored chunks, each with its provenance and the terms it matched', () => {
    const outcome = retrieve(chunks, 'distractors plausible wrong answer');
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;

    const storedIds = new Set(chunks.map((chunk) => chunk.id));
    for (const hit of outcome.hits) {
      expect(storedIds.has(hit.chunk.id)).toBe(true);
      expect(hit.chunk.text).toBe(chunks.find((c) => c.id === hit.chunk.id)!.text);
      expect(hit.matchedTerms.length > 0).toBe(true);
      for (const term of hit.matchedTerms) {
        expect(hit.chunk.text.toLowerCase().includes(term.slice(0, 5)) ||
          String(hit.chunk.heading).toLowerCase().includes(term.slice(0, 5))).toBe(true);
      }
    }
  });

  it('gives the same ranking every time', () => {
    const a = retrieve(chunks, 'skimming timing passage');
    const b = retrieve(chunks, 'skimming timing passage');
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('says there is no result, explicitly, when nothing matches', () => {
    const outcome = retrieve(chunks, 'photosynthesis chlorophyll');
    expect(outcome.status).toBe('no_match');
    expect('hits' in outcome).toBe(false);
  });

  it('rejects an unrelated query instead of returning the least-bad passages', () => {
    // "passage" appears in the book; nothing else in the query does. One
    // coincidental term out of four is not a result.
    const outcome = retrieve(chunks, 'volcanic eruption magma passage');
    expect(outcome.status === 'ok').toBe(false);
  });

  it('reports a query made only of stop words as empty, not as matching everything', () => {
    expect(retrieve(chunks, 'the and of to').status).toBe('empty_query');
    expect(retrieve(chunks, '   ').status).toBe('empty_query');
  });

  it('surfaces the explicit outcome through the API too', async () => {
    const source = (await sourceStore.list()).find((item) => item.status === 'ready');
    const body = await (
      await api(`/api/admin/sources/${source!.id}/chunks?q=${encodeURIComponent('photosynthesis chlorophyll')}`)
    ).json();
    expect(body.mode).toBe('search');
    expect(['no_match', 'low_confidence'].includes(body.retrieval.status)).toBe(true);
  });
});

describe('access', () => {
  it('refuses every source route without an admin session', async () => {
    const saved = adminCookie;
    adminCookie = '';
    try {
      expect((await api('/api/admin/sources')).status).toBe(403);
      expect((await uploadViaApi('a.txt', Buffer.from('# A\n\nText.'), 'text/plain')).status).toBe(403);
    } finally {
      adminCookie = saved;
    }
  });
});
