import { Parser } from 'htmlparser2';
import type { IngestionWarning, SourceFileKind } from '../../types/source';
import { EXTRACTOR_VERSION } from './version';

/**
 * Turning a file into blocks of text that still know where they came from.
 *
 * The unit is a block, not a page and not a string: a heading and a paragraph
 * are different things to the chunker, and flattening them into one text blob
 * is what forces fixed-size slicing later. Every extractor here produces the
 * same shape, so the structure and chunking steps never learn what format the
 * book was in.
 *
 * What is *not* here matters as much. No format is guessed at, no page number
 * is inferred for a format that has none, and a file that yields no text is a
 * failure rather than an empty book — an empty book would ingest cleanly and
 * then quietly return nothing forever.
 */

/** One extracted run of text, tagged with what it is. */
export interface TextBlock {
  text: string;
  /** 1 for a top-level heading, 2 for a subheading, undefined for body text. */
  headingLevel?: number;
  /** The printed page, for formats that carry one. */
  page?: number;
}

export interface ExtractedDocument {
  blocks: TextBlock[];
  /** Pages the extractor saw, for formats that have pages. */
  pageCount?: number;
  warnings: IngestionWarning[];
  extractorVersion: string;
}

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionError';
  }
}

/** The extensions this pipeline really handles, mapped to how it reads them. */
export const SUPPORTED_EXTENSIONS: Record<string, SourceFileKind> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.html': 'html',
  '.htm': 'html',
  '.txt': 'text',
  '.md': 'text',
};

export function fileKindFor(extension: string): SourceFileKind | null {
  return SUPPORTED_EXTENSIONS[extension.toLowerCase()] ?? null;
}

/**
 * Collapses runs of whitespace without joining what the document separated.
 *
 * Line breaks inside a block are meaningful in a textbook — a bullet list is
 * not one sentence — so they survive as single newlines.
 */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    // Tab, no-break space and the Unicode space family, written as escapes so
    // that an invisible character in this file cannot change what is matched.
    .replace(/[\t\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

/**
 * Whether a line reads as a heading in a plain-text or PDF document.
 *
 * Deliberately conservative: a markdown rule, a numbered chapter or unit, or a
 * short line in title case with no terminal punctuation. Anything looser starts
 * treating ordinary short sentences as chapters, which produces a structure
 * that looks detailed and is meaningless.
 */
export function detectHeading(line: string): { level: number; title: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 120) return null;

  const markdown = /^(#{1,6})\s+(.*)$/.exec(trimmed);
  if (markdown) return { level: markdown[1].length, title: markdown[2].trim() };

  const numbered = /^(chapter|unit|part|module|section|lesson)\s+([0-9]+|[ivxlc]+)\b[.:)\s]*(.*)$/i.exec(
    trimmed,
  );
  if (numbered) {
    const label = `${numbered[1]} ${numbered[2]}`;
    const rest = numbered[3].trim();
    const isTopLevel = /^(chapter|unit|part|module)$/i.test(numbered[1]);
    return { level: isTopLevel ? 1 : 2, title: rest ? `${label}: ${rest}` : label };
  }

  const decimal = /^([0-9]+(?:\.[0-9]+)*)\s+(\S.*)$/.exec(trimmed);
  if (decimal && !/[.!?]$/.test(trimmed)) {
    const depth = decimal[1].split('.').length;
    return { level: Math.min(6, depth), title: trimmed };
  }

  if (trimmed.length <= 80 && !/[.!?,;:]$/.test(trimmed) && /^[A-Z]/.test(trimmed)) {
    const words = trimmed.split(/\s+/);
    const capitalised = words.filter((w) => /^[A-Z0-9]/.test(w)).length;
    if (words.length >= 2 && words.length <= 10 && capitalised / words.length >= 0.6) {
      return { level: 2, title: trimmed };
    }
  }

  return null;
}

/** Splits already-normalized text into heading and paragraph blocks. */
function blocksFromText(text: string, page?: number): TextBlock[] {
  const blocks: TextBlock[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length === 0) return;
    blocks.push({ text: paragraph.join('\n'), page });
    paragraph = [];
  };

  for (const line of text.split('\n')) {
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = detectHeading(line);
    if (heading) {
      flush();
      blocks.push({ text: heading.title, headingLevel: heading.level, page });
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

async function extractPdf(buffer: Buffer): Promise<ExtractedDocument> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const warnings: IngestionWarning[] = [];
  try {
    const result = await parser.getText();
    const blocks: TextBlock[] = [];

    for (const page of result.pages) {
      const text = normalizeWhitespace(page.text || '');
      if (!text) {
        // Recorded rather than skipped silently: a book that is half scanned
        // images will ingest with very few chunks, and this is the only place
        // that says why.
        warnings.push({
          code: 'empty_page',
          message: `Page ${page.num} carried no extractable text. It may be a scanned image.`,
          page: page.num,
        });
        continue;
      }
      blocks.push(...blocksFromText(text, page.num));
    }

    return { blocks, pageCount: result.total, warnings, extractorVersion: EXTRACTOR_VERSION };
  } catch (error) {
    throw new ExtractionError(
      error instanceof Error ? `The PDF could not be read: ${error.message}` : 'The PDF could not be read.',
    );
  } finally {
    try {
      await parser.destroy();
    } catch {
      // The parse already produced its result or threw; a failure to release
      // the worker is not something to report to the admin.
    }
  }
}

async function extractDocx(buffer: Buffer): Promise<ExtractedDocument> {
  const mammoth = (await import('mammoth')).default;
  try {
    // HTML rather than raw text: `extractRawText` throws away the heading
    // levels, and those are the whole basis for structural chunking.
    const result = await mammoth.convertToHtml({ buffer });
    const document = extractHtml(Buffer.from(result.value, 'utf8'));
    const warnings: IngestionWarning[] = document.warnings;
    for (const message of result.messages.slice(0, 20)) {
      if (message.type !== 'warning') continue;
      warnings.push({ code: 'unreadable_region', message: String(message.message) });
    }
    return { ...document, warnings };
  } catch (error) {
    throw new ExtractionError(
      error instanceof Error
        ? `The document could not be read: ${error.message}`
        : 'The document could not be read.',
    );
  }
}

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'li', 'blockquote', 'td', 'th', 'dd', 'dt', 'pre', 'figcaption',
]);
const HEADING_TAGS: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };
const IGNORED_TAGS = new Set(['script', 'style', 'noscript', 'head', 'title', 'svg']);

/**
 * Reads HTML structurally, using the document's own headings.
 *
 * Script and style content is dropped at the parser rather than stripped
 * afterwards, so nothing from a `<script>` body can end up quoted as textbook
 * prose. This does not execute anything and does not reuse the CDI parser: that
 * parser looks for questions, and this is looking for a book.
 */
export function extractHtml(buffer: Buffer): ExtractedDocument {
  const blocks: TextBlock[] = [];
  const warnings: IngestionWarning[] = [];

  let ignoreDepth = 0;
  let headingLevel: number | null = null;
  let buffered: string[] = [];

  const flush = (level: number | null) => {
    const text = normalizeWhitespace(buffered.join(' '));
    buffered = [];
    if (!text) return;
    if (level) blocks.push({ text, headingLevel: level });
    else blocks.push({ text });
  };

  const parser = new Parser(
    {
      onopentag(name) {
        if (IGNORED_TAGS.has(name)) {
          ignoreDepth += 1;
          return;
        }
        if (ignoreDepth > 0) return;
        if (HEADING_TAGS[name]) {
          flush(headingLevel);
          headingLevel = HEADING_TAGS[name];
          return;
        }
        if (BLOCK_TAGS.has(name) || name === 'br') flush(headingLevel);
      },
      ontext(text) {
        if (ignoreDepth > 0) return;
        buffered.push(text);
      },
      onclosetag(name) {
        if (IGNORED_TAGS.has(name)) {
          ignoreDepth = Math.max(0, ignoreDepth - 1);
          return;
        }
        if (ignoreDepth > 0) return;
        if (HEADING_TAGS[name]) {
          flush(headingLevel);
          headingLevel = null;
          return;
        }
        if (BLOCK_TAGS.has(name)) flush(headingLevel);
      },
    },
    { decodeEntities: true },
  );

  parser.write(buffer.toString('utf8'));
  parser.end();
  flush(headingLevel);

  return { blocks, warnings, extractorVersion: EXTRACTOR_VERSION };
}

function extractText(buffer: Buffer): ExtractedDocument {
  const warnings: IngestionWarning[] = [];
  const raw = buffer.toString('utf8');
  if (raw.includes('�')) {
    warnings.push({
      code: 'encoding_replaced',
      message: 'Some characters could not be decoded as UTF-8 and were replaced.',
    });
  }
  return {
    blocks: blocksFromText(normalizeWhitespace(raw)),
    warnings,
    extractorVersion: EXTRACTOR_VERSION,
  };
}

/**
 * Reads a source file into blocks, or refuses.
 *
 * A refusal is an `ExtractionError`, which the job turns into a `failed`
 * source. There is no path here that returns an empty document as a success.
 */
export async function extractSource(
  kind: SourceFileKind,
  buffer: Buffer,
): Promise<ExtractedDocument> {
  if (!buffer?.length) throw new ExtractionError('The file is empty.');

  const document =
    kind === 'pdf'
      ? await extractPdf(buffer)
      : kind === 'docx'
        ? await extractDocx(buffer)
        : kind === 'html'
          ? extractHtml(buffer)
          : extractText(buffer);

  const hasText = document.blocks.some((block) => block.text.trim().length > 0);
  if (!hasText) {
    throw new ExtractionError(
      'No text could be extracted from this file. A scanned PDF needs to be run through OCR first.',
    );
  }

  if (!document.blocks.some((block) => block.headingLevel)) {
    // Not a failure: a book with no headings still chunks, by paragraph. It is
    // worth saying, because retrieval results from it will cite no chapter.
    document.warnings.push({
      code: 'no_headings_found',
      message:
        'No headings were found, so chunks will be grouped by paragraph and will not cite a chapter.',
    });
  }

  return document;
}
