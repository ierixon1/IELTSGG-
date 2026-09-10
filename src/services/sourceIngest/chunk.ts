import { createHash } from 'node:crypto';
import type { SourceChunk, SourceLocation } from '../../types/source';
import type { ExtractedDocument, TextBlock } from './extract';
import { CHUNKER_VERSION } from './version';

/**
 * Cutting a book at its own joints.
 *
 * The obvious implementation is to slide a 1000-character window over the whole
 * text. It is also the wrong one for this purpose: a window cuts mid-sentence,
 * mid-exercise and mid-table, so a chunk retrieved later says half of something
 * and the citation points at a span that means nothing on its own. Worse, the
 * cut positions depend on everything before them, so inserting a paragraph on
 * page 3 renumbers every chunk in the book.
 *
 * So chunks are built from structure: a chunk belongs to exactly one heading,
 * contains whole paragraphs, and only ever splits when a single section is
 * longer than `MAX_CHARACTERS` — and then it splits between paragraphs, never
 * inside one.
 *
 * Determinism is a requirement rather than a nice property: the same bytes and
 * the same chunker version must produce byte-identical chunks, or a re-ingested
 * book silently invalidates every citation made against the previous run.
 * Nothing here reads a clock, a random source, or the order of a hash map.
 */

/** What the stored extracted text puts between chunks. */
export const CHUNK_SEPARATOR = '\n\n';

/** Above this, a section is split between its paragraphs. */
export const MAX_CHARACTERS = 1800;
/**
 * Nothing is merged across a heading. A two-line section stays its own chunk,
 * short and correctly attributed, because folding it into the section below
 * would file that text under a heading it never appeared beneath — and a
 * citation that names the wrong subsection is worse than a short chunk.
 */

interface Section {
  heading?: string;
  level: number;
  path: string[];
  page?: number;
  paragraphs: string[];
}

/**
 * Groups blocks under the heading they follow.
 *
 * The heading stack is what turns a flat list of blocks into `book → chapter →
 * subsection`: a heading of level N pops everything at level N or deeper, so
 * the path is always the real ancestry rather than the last few headings seen.
 */
export function sectionsOf(document: ExtractedDocument): Section[] {
  const sections: Section[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  let current: Section | null = null;

  const open = (heading: string | undefined, level: number, page?: number): Section => {
    const section: Section = {
      heading,
      level,
      path: stack.map((entry) => entry.title),
      page,
      paragraphs: [],
    };
    current = section;
    sections.push(section);
    return section;
  };

  for (const block of document.blocks) {
    const text = block.text.trim();
    if (!text) continue;

    if (block.headingLevel) {
      while (stack.length > 0 && stack[stack.length - 1].level >= block.headingLevel) stack.pop();
      // The path is read before the heading joins the stack: it is this
      // section's ancestry, and `heading` already names the section itself.
      open(text, block.headingLevel, block.page);
      stack.push({ level: block.headingLevel, title: text });
      continue;
    }

    const section = current ?? open(undefined, 0, block.page);
    if (section.page === undefined && block.page !== undefined) section.page = block.page;
    section.paragraphs.push(text);
  }

  return sections.filter((section) => section.paragraphs.length > 0 || section.heading);
}

/**
 * Splits one section's paragraphs into pieces no longer than `MAX_CHARACTERS`.
 *
 * A paragraph longer than the limit on its own is kept whole rather than cut:
 * an over-long chunk is honest, whereas half a paragraph reads as a complete
 * thought and is not one. It is reported as a warning by the caller.
 */
export function packParagraphs(paragraphs: string[]): string[] {
  const pieces: string[] = [];
  let current: string[] = [];
  let length = 0;

  for (const paragraph of paragraphs) {
    const cost = paragraph.length + (current.length > 0 ? 2 : 0);
    if (current.length > 0 && length + cost > MAX_CHARACTERS) {
      pieces.push(current.join('\n\n'));
      current = [];
      length = 0;
    }
    current.push(paragraph);
    length += paragraph.length + (current.length > 1 ? 2 : 0);
  }

  if (current.length > 0) pieces.push(current.join('\n\n'));
  return pieces;
}

const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export interface ChunkingResult {
  chunks: SourceChunk[];
  /** Sections that had to be emitted over the size limit. */
  oversized: number;
  headings: number;
  characters: number;
}

/**
 * Cuts an extracted document into chunks, in reading order.
 *
 * `charStart` and `charEnd` are offsets into the concatenation of every chunk's
 * text in ordinal order, which is the same "extracted text" the job stores
 * alongside the original file. That makes the span reproducible: reading those
 * offsets out of the stored text yields exactly the chunk, and nothing else.
 */
export function chunkDocument(sourceId: string, document: ExtractedDocument): ChunkingResult {
  const sections = sectionsOf(document);
  const chunks: SourceChunk[] = [];
  let cursor = 0;
  let oversized = 0;
  let headings = 0;

  for (const section of sections) {
    if (section.heading) headings += 1;
    const body = section.paragraphs.filter((paragraph) => paragraph.trim().length > 0);
    if (body.length === 0) continue;

    for (const piece of packParagraphs(body)) {
      if (piece.length > MAX_CHARACTERS) oversized += 1;

      const ordinal = chunks.length;
      const path = section.heading ? [...section.path, section.heading] : [...section.path];
      const location: SourceLocation = {
        page: section.page,
        chapter: path[0],
        section: section.heading ?? path[path.length - 1],
        path,
        charStart: cursor,
        charEnd: cursor + piece.length,
      };

      chunks.push({
        id: `${sourceId}-c${String(ordinal).padStart(5, '0')}`,
        sourceId,
        ordinal,
        heading: section.heading,
        level: section.level,
        location,
        text: piece,
        wordCount: piece.split(/\s+/).filter(Boolean).length,
        extractorVersion: document.extractorVersion,
        chunkerVersion: CHUNKER_VERSION,
        contentHash: hash(piece),
      });

      // The separator the stored extracted text uses between chunks, counted so
      // the offsets keep matching it.
      cursor += piece.length + CHUNK_SEPARATOR.length;
    }
  }

  return {
    chunks,
    oversized,
    headings,
    characters: chunks.reduce((total, chunk) => total + chunk.text.length, 0),
  };
}

/** The extracted text exactly as the chunk offsets describe it. */
export function extractedTextOf(chunks: SourceChunk[]): string {
  return chunks.map((chunk) => chunk.text).join(CHUNK_SEPARATOR);
}
