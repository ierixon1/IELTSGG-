import { closest, elementText, findElements, isTag } from '../normalize';
import type { Element } from '../normalize';
import {
  DetectedOption,
  answerAttributeOf,
  headerFor,
  optionsFromFollowingSiblings,
  optionsFromInputs,
  optionsFromText,
  stripMarker,
} from './shared';
import type { QuestionSite } from './shared';
import { buildQuestion } from './context';
import type { FamilyParser, ParserContext } from './context';
import type { AnswerStatus } from '../types';

/**
 * Choices: single answer, multiple answer, and the two statement families.
 *
 * A choice is the one construct a CDI page renders three different ways — a
 * radio group, a checkbox group, or plain lettered lines with no control at all
 * — so the options are gathered from whichever of those the page used, and the
 * type comes from the rubric rather than from the control. A checkbox group
 * under a "choose TWO letters" rubric is a multi-select; the same markup with
 * no such rubric is not assumed to be one.
 */

const STATEMENT_SETS: Record<string, string[]> = {
  true_false_not_given: ['TRUE', 'FALSE', 'NOT GIVEN'],
  yes_no_not_given: ['YES', 'NO', 'NOT GIVEN'],
};

/** Radio or checkbox inputs belonging to this question. */
function choiceInputs(site: QuestionSite): { inputs: Element[]; kind: 'radio' | 'checkbox' | null } {
  const scope =
    closest(site.control ?? site.container, (element) =>
      ['fieldset', 'li', 'td', 'div', 'p'].includes(element.name),
    ) ?? site.container;

  const inputs = findElements([scope], (element) => element.name === 'input').filter((input) => {
    const type = String(input.attribs.type || '').toLowerCase();
    return type === 'radio' || type === 'checkbox';
  });
  if (inputs.length < 2) return { inputs: [], kind: null };

  const kind = String(inputs[0].attribs.type).toLowerCase() as 'radio' | 'checkbox';
  return { inputs, kind };
}

/** The prompt: the question's own text, minus its options and its number. */
function promptOf(site: QuestionSite, options: DetectedOption[]): string {
  // A fieldset states its question in the legend, which is the cleanest source
  // there is; everything else is the block text with the options removed.
  const legend = findElements([site.container], (element) => element.name === 'legend')[0];
  if (legend) {
    const fromLegend = stripMarker(elementText(legend), site.number);
    if (fromLegend) return fromLegend;
  }

  const full = elementText(site.container);
  let text = stripMarker(full, site.number);
  // The option text sits inside the same container in most exports; removing it
  // leaves the stem, which is what the prompt is.
  for (const option of options) {
    if (option.text && text.includes(option.text)) text = text.replace(option.text, ' ');
  }
  return text
    .replace(/\s*\b([A-H])\b\s*(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const parseChoice: FamilyParser = (site: QuestionSite, context: ParserContext) => {
  const header = headerFor(context.headers, site.number);
  const inferred = header?.inferredType ?? null;

  const isChoiceFamily =
    inferred === 'multiple_choice' ||
    inferred === 'multi_select' ||
    inferred === 'true_false_not_given' ||
    inferred === 'yes_no_not_given';

  const { inputs, kind } = choiceInputs(site);
  if (!isChoiceFamily && inputs.length === 0) return null;
  if (!isChoiceFamily && kind === null) return null;

  // Options: from controls when the page has them, from lettered text lines
  // otherwise — which is how an exported page carries the same question.
  let options: DetectedOption[] =
    inputs.length > 0 ? optionsFromInputs(inputs, context.source) : optionsFromText(site.container);
  // A control-free page prints its choices beside the question, not inside it.
  if (options.length < 2) options = optionsFromFollowingSiblings(site);

  const statementSet = inferred ? STATEMENT_SETS[inferred] : undefined;
  if (statementSet && options.length === 0) {
    options = statementSet.map((value) => ({ label: value, text: value, full: value }));
  }
  if (options.length < 2) return null;

  const type =
    inferred === 'multi_select' || (kind === 'checkbox' && header?.choiceCount)
      ? 'multi_select'
      : (inferred ?? 'multiple_choice');

  // Statement families store their three legal values as the options.
  const optionStrings = statementSet ? statementSet : options.map((option) => option.full);

  // --- the answer key ------------------------------------------------------
  const marked = options.filter((option) => option.isAnswer).map((option) => option.label);
  // A data-answer on any option of the group is the key, wherever it sits. Only
  // a bare `checked` is ambiguous, because in a live-player export that is the
  // learner's own answer.
  const attributeAnswer =
    (site.control ? answerAttributeOf(site.control) : null) ??
    answerAttributeOf(site.container) ??
    inputs.map((input) => answerAttributeOf(input)).find((value) => value !== null) ??
    null;
  const markedByAttribute = inputs
    .filter((input) => answerAttributeOf(input) !== null)
    .map((input, index) => {
      const value = String(input.attribs.value || '').trim();
      return value || String.fromCharCode(65 + index);
    });
  const sectionKey = context.answerKeys.get(site.number);

  let answer: string | string[] | undefined;
  let answerStatus: AnswerStatus = 'missing';

  if (markedByAttribute.length > 0) {
    answer = type === 'multi_select' ? markedByAttribute : markedByAttribute[0];
    answerStatus = 'extracted';
  } else if (attributeAnswer) {
    const parts = attributeAnswer.split(/[,;\s]+/).filter(Boolean);
    answer = type === 'multi_select' ? parts : parts[0];
    answerStatus = 'extracted';
  } else if (sectionKey) {
    const parts = sectionKey.value.split(/[,;\s]+/).filter(Boolean);
    answer = type === 'multi_select' ? parts : sectionKey.value;
    answerStatus = sectionKey.status;
  } else if (marked.length > 0) {
    // A `checked` attribute in a live-player export could be a learner's own
    // answer rather than the key, so it is never treated as certain.
    answer = type === 'multi_select' ? marked : marked[0];
    answerStatus = 'uncertain';
  }

  if (type === 'multi_select' && typeof answer === 'string') answer = [answer];

  return buildQuestion({
    site,
    type,
    prompt: promptOf(site, options) || `Question ${site.number}`,
    options: optionStrings,
    instruction: header?.instruction,
    group: header?.groupKey,
    answer,
    answerStatus,
    detectedAs: kind ? `${kind} group` : 'lettered options',
  });
};

/** True when a container holds a choice the parser can read. */
export function looksLikeChoice(element: Element): boolean {
  return findElements([element], (child) => {
    if (!isTag(child) || child.name !== 'input') return false;
    const type = String(child.attribs.type || '').toLowerCase();
    return type === 'radio' || type === 'checkbox';
  }).length >= 2;
}
