import { closest, elementText, findElements, flatten } from '../normalize';
import type { Element } from '../normalize';
import {
  DetectedOption,
  answerAttributeOf,
  composeOption,
  headerFor,
  optionsFromSelect,
  optionsFromText,
  stripMarker,
} from './shared';
import type { QuestionGroupHeader, QuestionSite } from './shared';
import { buildQuestion } from './context';
import type { FamilyParser, ParserContext } from './context';
import type { AnswerStatus, ImportDiagnostic } from '../types';

/**
 * Matching families: headings, information, features, sentence endings.
 *
 * These share one shape — a bank of lettered options printed once, and a list
 * of numbered items answered from it — and that shape is what makes them
 * different from a multiple choice: the options do not sit with the question.
 * So the bank is found once for the whole group and attached to each member,
 * which is also what the learner engine needs, since a bank question without
 * options renders as unsupported.
 */

const MATCHING_TYPES = new Set([
  'matching',
  'matching_headings',
  'matching_information',
  'matching_features',
  'matching_sentence_endings',
]);

/**
 * The option bank governing a group.
 *
 * A bank is printed as its own block — a box of headings, a list of features —
 * somewhere between the rubric and the questions. It is found by looking for
 * the densest run of lettered lines in that region, because a bank is exactly
 * that and prose is not.
 */
export function findOptionBank(
  header: QuestionGroupHeader,
  context: ParserContext,
): DetectedOption[] {
  const elements = flatten(context.root);
  const start = header.sourceRange.start;

  let best: DetectedOption[] = [];
  for (const element of elements) {
    const at = element.startIndex ?? -1;
    if (at < start) continue;
    // Stop well before the far end of the paper.
    if (at > start + 12000) break;
    // A select on the page already carries the bank.
    if (element.name === 'select') {
      const fromSelect = optionsFromSelect(element);
      if (fromSelect.length > best.length) best = fromSelect;
      continue;
    }
    if (!['ul', 'ol', 'table', 'div', 'blockquote', 'section', 'p'].includes(element.name)) continue;
    const found = optionsFromText(element);
    // Prefer the tightest block that still holds the whole bank: a page wrapper
    // also "contains" the bank but drags in the questions with it.
    if (found.length >= 2 && (found.length > best.length || (found.length === best.length && best.length === 0))) {
      best = found;
    }
  }
  return best;
}

/**
 * The prompt for one matching item.
 *
 * The dropdown sits inside the same block as the item text, and its option list
 * would otherwise read as part of the question — "no music —ABCDEF".
 */
function promptOf(site: QuestionSite): string {
  const selects = findElements([site.container], (element) => element.name === 'select');
  let text = elementText(site.container);
  for (const select of selects) {
    const optionText = elementText(select);
    if (optionText && text.includes(optionText)) text = text.replace(optionText, ' ');
  }
  return stripMarker(text, site.number)
    .replace(/[—–-]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export const parseMatching: FamilyParser = (site: QuestionSite, context: ParserContext) => {
  const header = headerFor(context.headers, site.number);
  const inferred = header?.inferredType ?? null;

  const select =
    site.control?.name === 'select'
      ? site.control
      : (findElements([site.container], (element) => element.name === 'select')[0] ?? null);

  if (!inferred || !MATCHING_TYPES.has(inferred)) {
    // With no rubric to say so, a bare select is still a bank-answered question,
    // but which family it is cannot be settled — so it is not guessed.
    if (!select) return null;
  }

  const type = (inferred && MATCHING_TYPES.has(inferred) ? inferred : 'matching') as
    | 'matching'
    | 'matching_headings'
    | 'matching_information'
    | 'matching_features'
    | 'matching_sentence_endings';

  let options: DetectedOption[] = select ? optionsFromSelect(select) : [];
  if (options.length < 2 && header) options = findOptionBank(header, context);

  const diagnostics: ImportDiagnostic[] = [];
  if (options.length < 2) {
    diagnostics.push({
      code: 'option_bank_missing' as const,
      message: `Question ${site.number}: no option bank was found for this matching task.`,
      questionNumber: site.number,
      sourceRange: site.sourceRange,
    });
  }

  // --- the answer key ------------------------------------------------------
  const attributeAnswer =
    (site.control ? answerAttributeOf(site.control) : null) ?? answerAttributeOf(site.container);
  const sectionKey = context.answerKeys.get(site.number);
  const selected = options.find((option) => option.isAnswer);

  let answer: string | undefined;
  let answerStatus: AnswerStatus = 'missing';
  if (attributeAnswer) {
    answer = attributeAnswer;
    answerStatus = 'extracted';
  } else if (sectionKey) {
    answer = sectionKey.value;
    answerStatus = sectionKey.status;
  } else if (selected) {
    answer = selected.label;
    answerStatus = 'uncertain';
  }

  return buildQuestion({
    site,
    type,
    prompt: promptOf(site) || `Item ${site.number}`,
    options: options.map((option) => option.full),
    instruction: header?.instruction,
    group: header?.groupKey,
    answer,
    answerStatus,
    diagnostics,
    detectedAs: select ? 'select from bank' : 'lettered bank',
  });
};

export { composeOption };

/** True when this element is a select answering from a bank. */
export function isBankSelect(element: Element): boolean {
  return element.name === 'select' && closest(element, (parent) => parent.name === 'form') !== null;
}
