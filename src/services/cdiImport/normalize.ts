import { Parser } from 'htmlparser2';
import { AnyNode, ChildNode, DomHandler, Element, Text, isTag, isText } from 'domhandler';
import { getText, textContent } from 'domutils';
import type { DetectedAsset, ImportDiagnostic, SourceRange } from './types';

/**
 * Turning an imported page into something a parser can read, safely.
 *
 * Two things are true at once and the whole design follows from holding both:
 * the page's *structure* is the only reliable source of its questions, and the
 * page's *behaviour* must never run. So the document is parsed into a real DOM
 * — tables stay tables, option lists stay ordered — while script, style, event
 * handlers and anything else executable are dropped before a parser ever sees a
 * node.
 *
 * Nothing here produces display HTML. Rendering is the sanitiser's job and the
 * learner engine's; this exists to be read.
 */

/** Elements whose content is code, not content. */
const EXECUTABLE_TAGS = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'applet']);

/** Attributes that carry behaviour rather than data. */
const isEventHandler = (name: string) => /^on[a-z]+$/i.test(name);

export interface NormalizedDocument {
  /** The document root, script-free. */
  root: ChildNode[];
  /** The original HTML, unmodified, so offsets mean something. */
  source: string;
  assets: DetectedAsset[];
  diagnostics: ImportDiagnostic[];
}

/** Reads an element's source offsets, when the parser recorded them. */
export function rangeOf(node: AnyNode, source: string): SourceRange {
  const start = typeof node.startIndex === 'number' && node.startIndex >= 0 ? node.startIndex : 0;
  const end = typeof node.endIndex === 'number' && node.endIndex >= 0 ? node.endIndex + 1 : start;
  return { start, end, excerpt: source.slice(start, Math.min(end, start + 300)) };
}

/** Collapses runs of whitespace, including the non-breaking kind pages use. */
export function squash(value: string): string {
  return value.replace(/[   ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** An element's visible text, whitespace-normalised. */
export function elementText(node: AnyNode): string {
  return squash(textContent(node));
}

/** An element's text with block boundaries kept as newlines. */
export function blockText(node: AnyNode): string {
  return getText(node)
    .replace(/[   ]/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

const DATA_URI = /^data:(image\/[a-z0-9.+-]+|audio\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i;

function classifyAsset(src: string): DetectedAsset['origin'] {
  if (DATA_URI.test(src)) return 'inline';
  if (/^https?:\/\//i.test(src) || src.startsWith('//')) return 'external';
  return 'local';
}

/**
 * Finds the images and audio a page needs.
 *
 * External URLs are recorded, never fetched: importing a page must not make the
 * server issue requests that a stranger chose the destination of. A relative
 * path is recorded as `local`, which the review step resolves by asking for the
 * file — the page alone does not carry it.
 */
function collectAssets(element: Element, source: string, assets: DetectedAsset[]): void {
  const push = (src: string, kind: DetectedAsset['kind']) => {
    const trimmed = src.trim();
    if (!trimmed) return;
    const origin = classifyAsset(trimmed);
    const match = DATA_URI.exec(trimmed);
    assets.push({
      originalSrc: trimmed,
      kind,
      origin,
      inlineData: match ? { mimeType: match[1].toLowerCase(), base64: match[2] } : undefined,
      sourceRange: rangeOf(element, source),
    });
  };

  if (element.name === 'img') push(String(element.attribs.src || ''), 'image');
  if (element.name === 'audio') {
    const direct = String(element.attribs.src || '');
    if (direct) push(direct, 'audio');
  }
  if (element.name === 'source') {
    const type = String(element.attribs.type || '');
    const parentName = (element.parent && isTag(element.parent) && element.parent.name) || '';
    const kind: DetectedAsset['kind'] =
      type.startsWith('image/') || parentName === 'picture' ? 'image' : 'audio';
    push(String(element.attribs.src || ''), kind);
  }
}

/**
 * Parses a page into a DOM the parsers can walk, with executable content gone.
 *
 * Offsets from the original source are kept on every node, which is what lets a
 * parsed question point back at the markup it came from.
 */
export function normalizeCdiHtml(html: string): NormalizedDocument {
  const source = typeof html === 'string' ? html : '';
  const diagnostics: ImportDiagnostic[] = [];
  const assets: DetectedAsset[] = [];

  const handler = new DomHandler(undefined, {
    withStartIndices: true,
    withEndIndices: true,
  });
  const parser = new Parser(handler, {
    decodeEntities: true,
    lowerCaseTags: true,
    lowerCaseAttributeNames: true,
    recognizeSelfClosing: true,
  });
  parser.write(source);
  parser.end();

  let removedScripts = 0;

  const walk = (nodes: ChildNode[]): ChildNode[] => {
    const kept: ChildNode[] = [];
    for (const node of nodes) {
      if (isTag(node)) {
        if (EXECUTABLE_TAGS.has(node.name)) {
          // Recorded rather than silently dropped: a page whose questions live
          // in JavaScript is a page this parser will under-read, and the
          // reviewer needs to know that is why.
          if (node.name === 'script' || node.name === 'noscript') removedScripts++;
          continue;
        }
        for (const attribute of Object.keys(node.attribs)) {
          if (isEventHandler(attribute)) delete node.attribs[attribute];
        }
        collectAssets(node, source, assets);
        node.children = walk(node.children);
      }
      kept.push(node);
    }
    return kept;
  };

  const root = walk(handler.dom);

  if (removedScripts > 0) {
    diagnostics.push({
      code: 'script_removed',
      message:
        `${removedScripts} script block(s) were removed and not executed. ` +
        'Any question behaviour that lived in them has not been imported.',
    });
  }

  for (const asset of assets) {
    if (asset.origin === 'external') {
      diagnostics.push({
        code: 'asset_external',
        message: `External ${asset.kind} "${asset.originalSrc}" was not fetched. Upload it separately to attach it.`,
        sourceRange: asset.sourceRange,
      });
    }
    if (asset.origin === 'local') {
      diagnostics.push({
        code: 'asset_missing',
        message: `The page references "${asset.originalSrc}", which is not contained in it. Upload the file to attach it.`,
        sourceRange: asset.sourceRange,
      });
    }
  }

  return { root, source, assets, diagnostics };
}

/* -------------------------------------------------------------------------- */
/* Walking helpers                                                             */
/* -------------------------------------------------------------------------- */

export function eachElement(nodes: ChildNode[], visit: (element: Element) => void): void {
  for (const node of nodes) {
    if (!isTag(node)) continue;
    visit(node);
    eachElement(node.children, visit);
  }
}

export function findElements(nodes: ChildNode[], predicate: (element: Element) => boolean): Element[] {
  const found: Element[] = [];
  eachElement(nodes, (element) => {
    if (predicate(element)) found.push(element);
  });
  return found;
}

export function findByTag(nodes: ChildNode[], ...names: string[]): Element[] {
  const wanted = new Set(names);
  return findElements(nodes, (element) => wanted.has(element.name));
}

/** The nearest ancestor matching `predicate`, including the node itself. */
export function closest(node: AnyNode | null, predicate: (element: Element) => boolean): Element | null {
  let current: AnyNode | null = node;
  while (current) {
    if (isTag(current) && predicate(current)) return current;
    current = current.parent as AnyNode | null;
  }
  return null;
}

/** Text nodes in document order, with their offsets. */
export function textNodes(nodes: ChildNode[]): Text[] {
  const found: Text[] = [];
  const walk = (list: ChildNode[]) => {
    for (const node of list) {
      if (isText(node)) found.push(node);
      else if (isTag(node)) walk(node.children);
    }
  };
  walk(nodes);
  return found;
}

/** Every element in document order, flattened. */
export function flatten(nodes: ChildNode[]): Element[] {
  return findElements(nodes, () => true);
}

export { isTag, isText };
export type { AnyNode, ChildNode, Element, Text };
