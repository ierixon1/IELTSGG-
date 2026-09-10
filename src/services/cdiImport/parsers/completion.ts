import { closest, elementText, isTag, isText } from '../normalize';
import type { Element } from '../normalize';
import { answerAttributeOf, headerFor, stripMarker } from './shared';
import type { QuestionSite } from './shared';
import { buildQuestion } from './context';
import type { FamilyParser, ParserContext } from './context';
import type { AnswerStatus } from '../types';
import type { Question } from '../../../types';

/**
 * Gap fills: notes, forms, summaries, sentences and short answers.
 *
 * These are the questions an export most often carries with no control at all —
 * the input is stripped and only the `7.` marker survives in the flow of the
 * text. So the prompt is reconstructed from the text around the marker, which
 * is what a reader uses too: "Accommodation location | Near the farm or in the
 * 7." is a gap whose prompt is the line it sits in.
 */

const COMPLETION_TYPES = new Set<Question['type']>([
  'fill_in_blank',
  'note_completion',
  'form_completion',
  'summary_completion',
  'sentence_completion',
  'table_completion',
  'short_answer',
]);

/** The layout a completion type is printed in. */
export function layoutForCompletion(type: Question['type'], inTable: boolean): Question['layout'] {
  if (inTable) return 'table_row';
  if (type === 'note_completion') return 'note_line';
  if (type === 'form_completion') return 'form_row';
  if (type === 'summary_completion') return 'summary_gap';
  return 'standalone';
}

/**
 * The text of the line a gap sits in.
 *
 * For a table cell the whole row reads as the prompt, because the label is in
 * the neighbouring cell — "Food | Meat, seafood, and 8. food" only makes sense
 * whole.
 */
function promptOf(site: QuestionSite): string {
  const cell = closest(site.container, (element) => element.name === 'td' || element.name === 'th');
  const row = cell ? closest(cell, (element) => element.name === 'tr') : null;

  if (row) {
    const cells = row.children.filter(
      (child): child is Element => isTag(child) && (child.name === 'td' || child.name === 'th'),
    );
    const parts = cells.map((child) => elementText(child)).filter(Boolean);
    return stripMarker(parts.join(' — '), site.number);
  }

  const line = closest(site.container, (element) =>
    ['li', 'p', 'div', 'dd', 'dt'].includes(element.name),
  );
  return stripMarker(elementText(line ?? site.container), site.number);
}

export const parseCompletion: FamilyParser = (site: QuestionSite, context: ParserContext) => {
  const header = headerFor(context.headers, site.number);
  const inferred = header?.inferredType ?? null;

  const control = site.control;
  const isTextControl =
    control &&
    (control.name === 'textarea' ||
      (control.name === 'input' &&
        !['radio', 'checkbox'].includes(String(control.attribs.type || 'text').toLowerCase())));

  // Either the rubric names a completion family, or the page shows a text box.
  const type: Question['type'] =
    inferred && COMPLETION_TYPES.has(inferred) ? inferred : isTextControl ? 'fill_in_blank' : 'fill_in_blank';

  if (!(inferred && COMPLETION_TYPES.has(inferred)) && !isTextControl && site.via === 'control') {
    return null;
  }

  const inTable = closest(site.container, (element) => element.name === 'table') !== null;

  // --- the answer key ------------------------------------------------------
  const attributeAnswer =
    (control ? answerAttributeOf(control) : null) ?? answerAttributeOf(site.container);
  const sectionKey = context.answerKeys.get(site.number);
  // A `value` left on a text input in an export is the key often enough to read,
  // and a learner's own draft often enough never to trust.
  const controlValue = control ? String(control.attribs.value || '').trim() : '';

  let answer: string | undefined;
  let answerStatus: AnswerStatus = 'missing';
  if (attributeAnswer) {
    answer = attributeAnswer;
    answerStatus = 'extracted';
  } else if (sectionKey) {
    answer = sectionKey.value;
    answerStatus = sectionKey.status;
  } else if (controlValue) {
    answer = controlValue;
    answerStatus = 'uncertain';
  }

  return buildQuestion({
    site,
    type,
    prompt: promptOf(site) || `Gap ${site.number}`,
    instruction: header?.instruction,
    wordLimit: header?.wordLimit,
    layout: layoutForCompletion(type, inTable),
    group: header?.groupKey,
    answer,
    answerStatus,
    detectedAs: site.via === 'control' ? 'text input' : 'numbered gap marker',
  });
};

/** True when a node is a bare numbering marker rather than prose. */
export function isMarkerNode(node: unknown): boolean {
  return isText(node as never) && /^\s*\d{1,3}\s*[.)]\s*$/.test(String((node as never as { data: string }).data));
}
