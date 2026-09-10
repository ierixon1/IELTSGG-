import { closest, elementText, findElements, isTag } from '../normalize';
import type { ChildNode, Element } from '../normalize';
import { rangeOf } from '../normalize';
import type { QuestionSite } from './shared';
import type { UnsupportedRegion } from '../types';

/**
 * Table-shaped completions.
 *
 * A table completion is not a different question — each gap is still one
 * `table_completion` question, parsed by the completion family. What a table
 * adds is *grouping*: every gap in the same table belongs to one block, and the
 * learner engine renders it as a table because the questions say so.
 *
 * So this module does not parse questions. It decides which table a gap belongs
 * to, which is the piece the completion parser cannot see on its own.
 */

/** A stable key for the table a site sits in, or null when it sits in none. */
export function tableGroupKey(site: QuestionSite, root: ChildNode[]): string | null {
  const table = closest(site.container, (element) => element.name === 'table');
  if (!table) return null;

  const tables = findElements(root, (element) => element.name === 'table');
  const index = tables.indexOf(table);
  return index >= 0 ? `table-${index + 1}` : null;
}

/** The caption a table carries, used as the block's heading when present. */
export function tableCaption(site: QuestionSite): string | undefined {
  const table = closest(site.container, (element) => element.name === 'table');
  if (!table) return undefined;
  const caption = findElements([table], (element) =>
    ['caption', 'th'].includes(element.name),
  )[0];
  const text = caption ? elementText(caption) : '';
  return text || undefined;
}

/**
 * Tables a page uses for layout rather than for a question.
 *
 * Reported so a reviewer can see what the parser walked past, rather than the
 * parser silently deciding an empty table was not interesting.
 */
export function emptyTables(root: ChildNode[], source: string): UnsupportedRegion[] {
  const regions: UnsupportedRegion[] = [];
  for (const table of findElements(root, (element) => element.name === 'table')) {
    const hasControl = findElements([table], (element) =>
      ['input', 'select', 'textarea'].includes(element.name),
    ).length;
    const hasMarker = /\b\d{1,3}\s*[.)]/.test(elementText(table));
    if (hasControl || hasMarker) continue;
    regions.push({
      construct: 'table without questions',
      reason: 'The table carries no controls and no question numbers, so it was read as content only.',
      sourceRange: rangeOf(table, source),
    });
  }
  return regions;
}

/** True when this element is a table row holding at least one gap. */
export function isQuestionRow(element: Element): boolean {
  if (element.name !== 'tr') return false;
  const hasControl = findElements([element], (child) =>
    isTag(child) && ['input', 'select', 'textarea'].includes(child.name),
  ).length > 0;
  return hasControl || /\b\d{1,3}\s*[.)]/.test(elementText(element));
}
