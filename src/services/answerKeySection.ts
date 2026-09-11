import { getOuterHTML, removeElement } from 'domutils';
import { elementText, isTag, squash, normalizeCdiHtml, type ChildNode, type Element } from './cdiImport/normalize';
import { detectAnswerKeySection } from './cdiImport/parsers/shared';

/**
 * Removes an imported page's answer-key section from what a learner is sent.
 *
 * A CDI export often prints its key at the end — "Answer Key: 1. ii 2. iv …" —
 * and the importer reads the answers from exactly there. The display markup and
 * the passage text keep the page as it was, key included, which is right for
 * the admin reviewing an import and wrong for a learner about to answer it: a
 * response with no `correctAnswer` field still gave the answers away.
 *
 * The section is found with the importer's own detector, so what is removed is
 * precisely what the importer treated as the key: the key heading and
 * everything after it in document order. A page on which the detector reads no
 * key is returned unchanged.
 */

export interface AnswerKeyCut {
  /** The markup without the key section. */
  html: string;
  /** The key heading as printed, e.g. "Answer Key". */
  headingText: string;
  /** Each leaf line of the removed region — "1. ii", "2. iv" — as the page prints it. */
  removedLines: string[];
}

/** Cuts the key section out of display markup, or answers null when the page carries none. */
export function cutAnswerKeySection(html: string): AnswerKeyCut | null {
  if (!html) return null;
  const document = normalizeCdiHtml(html);
  const { entries, range } = detectAnswerKeySection(document.root, document.source);
  if (entries.size === 0 || !range) return null;

  const all = flattenNodes(document.root);
  const heading = all.find((node) => node.startIndex === range.start);
  if (!heading) return null;

  // The heading and everything after it in document order: its later siblings,
  // then its ancestors' later siblings, all the way up.
  const removed: ChildNode[] = [];
  let current: ChildNode = heading;
  let first = true;
  for (;;) {
    const parent = current.parent;
    // Top-level nodes hang off the document, which is not an element; the walk stops there.
    const siblings: ChildNode[] = parent && isTag(parent) ? parent.children : document.root;
    const index = siblings.indexOf(current);
    if (index >= 0) removed.push(...siblings.slice(first ? index : index + 1));
    first = false;
    if (!parent || !isTag(parent)) break;
    current = parent;
  }

  const headingText = elementText(heading);
  const removedLines = removed
    .flatMap((node) => flattenNodes([node]))
    .filter((node): node is Element => isTag(node) && ['p', 'div', 'li', 'td', 'span'].includes(node.name) && !node.children.some((child) => isTag(child)))
    .map((node) => elementText(node))
    .filter(Boolean);

  for (const node of removed) {
    if (node.parent) removeElement(node);
  }
  const kept = document.root.filter((node) => !removed.includes(node));
  return { html: getOuterHTML(kept), headingText, removedLines };
}

const compact = (value: string) => value.replace(/\s+/g, '').toLowerCase();

/**
 * Text taken from the page — a passage's text — without the key section.
 *
 * The key is the tail of the page, so it is the tail of the text: everything
 * from the last printed key heading, provided every key line the markup carried
 * really follows it there. Whitespace is ignored in that check, because the
 * text was flattened from the markup and does not keep its line breaks.
 */
export function withoutKeyText(text: string | undefined, cut: AnswerKeyCut): string | undefined {
  if (text === undefined || !cut.headingText) return text;
  const at = text.toLowerCase().lastIndexOf(cut.headingText.toLowerCase());
  if (at < 0) return text;
  const tail = compact(text.slice(at));
  if (!cut.removedLines.every((line) => tail.includes(compact(line)))) return text;
  return squash(text.slice(0, at));
}

/** A transcript assembled from page lines, without the lines of the key section. */
export function withoutKeyLines(text: string | undefined, cut: AnswerKeyCut): string | undefined {
  if (text === undefined || cut.removedLines.length === 0) return text;
  const removed = new Set(cut.removedLines);
  return text
    .split('\n')
    .filter((line) => !removed.has(line.trim()))
    .join('\n');
}

function flattenNodes(nodes: ChildNode[]): ChildNode[] {
  const out: ChildNode[] = [];
  const walk = (list: ChildNode[]) => {
    for (const node of list) {
      out.push(node);
      if (isTag(node)) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}
