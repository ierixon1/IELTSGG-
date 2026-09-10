import type { SourceChunk } from '../../types/source';

/**
 * The passage a generated Reading material presents: the retrieved source text
 * itself, not something written about it.
 *
 * Nothing here paraphrases, summarises or joins text across chunks. The learner
 * reads exactly the sentences the questions were checked against, so a question
 * that validated against the source validated against what the learner sees.
 */

export interface PassageSection {
  chunkId: string;
  /** "A", "B", … — how the passage and a matching-headings task refer to it. */
  label: string;
  /** Where this chunk's text sits in `text`. */
  start: number;
  end: number;
}

export interface Passage {
  text: string;
  html: string;
  sections: PassageSection[];
}

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export const sectionLabel = (index: number) => String.fromCharCode(65 + index);

/**
 * Builds the passage from chunks in reading order.
 *
 * `showHeadings` is false for matching headings, and it has to be: printing the
 * book's own heading above each section would print the answer to every
 * question. Sections are then introduced only by their letter.
 */
export function buildPassage(chunks: SourceChunk[], options: { showHeadings: boolean }): Passage {
  const ordered = [...chunks].sort((a, b) => a.ordinal - b.ordinal);
  const sections: PassageSection[] = [];
  const html: string[] = [];
  let text = '';

  ordered.forEach((chunk, index) => {
    const label = sectionLabel(index);
    if (text) text += '\n\n';
    const start = text.length;
    text += chunk.text;
    sections.push({ chunkId: chunk.id, label, start, end: text.length });

    const heading = options.showHeadings && chunk.heading ? chunk.heading : `Section ${label}`;
    html.push(`<h3>${escapeHtml(heading)}</h3>`);
    for (const paragraph of chunk.text.split(/\n{2,}/)) {
      html.push(`<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`);
    }
  });

  return { text, html: html.join('\n'), sections };
}
