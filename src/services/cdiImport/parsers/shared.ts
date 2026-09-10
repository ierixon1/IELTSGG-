import type { QuestionType } from '../../../types';
import {
  AnyNode,
  ChildNode,
  Element,
  blockText,
  closest,
  elementText,
  findElements,
  flatten,
  isTag,
  isText,
  rangeOf,
  squash,
  textNodes,
} from '../normalize';
import type { AnswerStatus, SourceRange } from '../types';

/**
 * The primitives every question family parser reads a page with.
 *
 * A CDI export says what its questions are in three places, and a parser that
 * uses only one of them under-reads real pages:
 *
 *   1. the *rubric* — "Questions 6–10 / Complete the table below. / Write ONE
 *      WORD ONLY for each answer." That is where the task type and the word
 *      limit live, and it applies to a numbered range.
 *   2. the *controls* — `<input name="q6">`, a radio group, a `<select>`. Live
 *      player exports have them.
 *   3. the *numbering markers* — a bare `6.` in the flow of a table cell or a
 *      note line. Printed and exported pages often have only these, because the
 *      controls were stripped on the way out.
 *
 * Everything here is deterministic. Where the page does not say, the parser
 * says it does not know — it never picks the likeliest answer.
 */

/* -------------------------------------------------------------------------- */
/* Rubrics                                                                     */
/* -------------------------------------------------------------------------- */

/** A word limit exactly as the paper prints it. */
export function extractWordLimit(text: string): string | undefined {
  const patterns = [
    /NO MORE THAN [A-Z]+ WORDS?(?: AND\/OR A NUMBER)?/i,
    /ONE WORD (?:AND\/OR A NUMBER )?ONLY/i,
    /[A-Z]+ WORDS? ONLY/i,
    /NO MORE THAN [A-Z]+ (?:NUMBERS?|LETTERS?)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return squash(match[0]).toUpperCase();
  }
  return undefined;
}

/**
 * How many options a "choose TWO letters" rubric asks for. Words, because that
 * is how the paper writes it.
 */
const COUNT_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };

export function extractChoiceCount(text: string): number | undefined {
  const match = /choose\s+(one|two|three|four|five|\d+)\s+letters/i.exec(text);
  if (!match) return undefined;
  const token = match[1].toLowerCase();
  return COUNT_WORDS[token] ?? (Number(token) || undefined);
}

/**
 * The canonical task type a rubric describes, or `null` when the wording does
 * not settle it.
 *
 * Order matters: "choose TWO letters" is a multi-select even though it also
 * contains "choose", and a heading list is a matching task even though it also
 * says "choose the correct".
 */
export function inferTypeFromRubric(rubric: string): QuestionType | null {
  const text = rubric.toLowerCase();

  if (/choose\s+(one|two|three|four|five|\d+)\s+letters/.test(text)) return 'multi_select';
  if (/(correct heading|list of headings)/.test(text)) return 'matching_headings';
  if (/which (paragraph|section)\b/.test(text)) return 'matching_information';
  if (/(sentence endings|complete each sentence with the correct ending)/.test(text)) {
    return 'matching_sentence_endings';
  }
  if (/\byes\b[\s,/]*\bno\b[\s,/]*\bnot given\b/.test(text)) return 'yes_no_not_given';
  if (/\btrue\b[\s,/]*\bfalse\b[\s,/]*\bnot given\b/.test(text)) return 'true_false_not_given';
  if (/do the following statements agree with the (views|claims)/.test(text)) {
    return 'yes_no_not_given';
  }
  if (/do the following statements agree with the information/.test(text)) {
    return 'true_false_not_given';
  }
  if (/label the (map|plan)/.test(text)) return 'map_label';
  if (/label the (diagram|flow-?chart|process)/.test(text)) return 'diagram_label';
  if (/complete the (notes?|note)\b/.test(text)) return 'note_completion';
  if (/complete the table/.test(text)) return 'table_completion';
  if (/complete the form/.test(text)) return 'form_completion';
  if (/complete the (summary|flow-?chart)/.test(text)) return 'summary_completion';
  if (/complete the sentences/.test(text)) return 'sentence_completion';
  if (/(choose .* from the box|match(ing)? each|which .* mentioned)/.test(text)) return 'matching';
  if (/answer the questions below/.test(text)) return 'short_answer';
  if (/choose the correct letter/.test(text)) return 'multiple_choice';

  return null;
}

/** A numbered range of questions the rubric above them governs. */
export interface QuestionGroupHeader {
  from: number;
  to: number;
  /** The rubric text, as printed. */
  instruction: string;
  wordLimit?: string;
  inferredType: QuestionType | null;
  /** For "Choose TWO letters". */
  choiceCount?: number;
  /** A stable key for grouping the questions this rubric governs. */
  groupKey: string;
  sourceRange: SourceRange;
}

const RANGE = /questions?\s+(\d{1,3})\s*(?:[-–—]|to|and)\s*(\d{1,3})/i;
const SINGLE = /^\s*questions?\s+(\d{1,3})\s*$/i;

/**
 * Finds the "Questions 6–10" rubrics and the instruction that follows each.
 *
 * The rubric is not one element: the heading, the task line and the word-limit
 * line are usually siblings. So the text of the elements between this heading
 * and the next one is taken as the rubric, which is what a reader does.
 */
export function detectGroupHeaders(root: ChildNode[], source: string): QuestionGroupHeader[] {
  const headers: QuestionGroupHeader[] = [];
  const elements = flatten(root);

  const headingLike = elements.filter((element) => {
    const text = elementText(element);
    if (!text || text.length > 120) return false;
    if (!RANGE.test(text) && !SINGLE.test(text)) return false;
    // The innermost element carrying the phrase, so an outer wrapper that also
    // contains it is not counted twice.
    return !element.children.some(
      (child) => isTag(child) && RANGE.test(elementText(child)),
    );
  });

  headingLike.forEach((heading, index) => {
    const text = elementText(heading);
    const range = RANGE.exec(text);
    const single = SINGLE.exec(text);
    const from = Number(range?.[1] ?? single?.[1]);
    const to = Number(range?.[2] ?? single?.[1]);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return;

    // The rubric runs to the next heading, or to the first numbered question.
    const next = headingLike[index + 1];
    const rubricParts: string[] = [];
    let cursor: AnyNode | null = heading.next;
    let scanned = 0;
    while (cursor && scanned < 12) {
      if (next && cursor === next) break;
      if (isTag(cursor)) {
        if (next && cursor.startIndex !== null && next.startIndex !== null && cursor.startIndex >= next.startIndex) break;
        const partText = elementText(cursor);
        // Stop once the questions themselves begin.
        if (/^\s*\d{1,3}\s*[.)]/.test(partText)) break;
        if (partText) rubricParts.push(partText);
      } else if (isText(cursor)) {
        const partText = squash(cursor.data);
        if (partText) rubricParts.push(partText);
      }
      cursor = cursor.next;
      scanned++;
    }

    const instruction = squash([text, ...rubricParts].join('\n')).slice(0, 1200);
    const readable = [text, ...rubricParts].join(' ');
    headers.push({
      from,
      to,
      instruction: [text, ...rubricParts].join('\n').trim(),
      wordLimit: extractWordLimit(readable),
      inferredType: inferTypeFromRubric(readable),
      choiceCount: extractChoiceCount(readable),
      groupKey: `q${from}-${to}`,
      sourceRange: rangeOf(heading, source),
    });
    void instruction;
  });

  return headers;
}

/**
 * The rubric governing a question number.
 *
 * A page nests these: "Listen and answer questions 1-10" is a section banner,
 * and "Questions 6-10 / Complete the table below" is the rubric that actually
 * says what the task is. The narrowest range wins, and among equals the one
 * that names a task type — otherwise every question on the page inherits the
 * banner and arrives as an anonymous gap fill.
 */
export function headerFor(
  headers: QuestionGroupHeader[],
  questionNumber: number,
): QuestionGroupHeader | undefined {
  const covering = headers.filter(
    (header) => questionNumber >= header.from && questionNumber <= header.to,
  );
  if (covering.length === 0) return undefined;

  return covering.slice().sort((a, b) => {
    const span = a.to - a.from - (b.to - b.from);
    if (span !== 0) return span;
    const typed = Number(Boolean(b.inferredType)) - Number(Boolean(a.inferredType));
    if (typed !== 0) return typed;
    return b.sourceRange.start - a.sourceRange.start;
  })[0];
}

/* -------------------------------------------------------------------------- */
/* Answer keys                                                                 */
/* -------------------------------------------------------------------------- */

export interface AnswerKeyEntry {
  value: string;
  status: AnswerStatus;
  /** Where the key was read from, for the diagnostic. */
  origin: 'data-attribute' | 'answer-key-section' | 'marked-option';
}

const ANSWER_ATTRIBUTES = ['data-answer', 'data-correct', 'data-correct-answer', 'data-key', 'data-solution'];

/** An answer written on the element itself. */
export function answerAttributeOf(element: Element): string | null {
  for (const attribute of ANSWER_ATTRIBUTES) {
    const value = element.attribs?.[attribute];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

const KEY_SECTION_HEADING = /^\s*(answer\s*key|answers|answer\s+sheet|key)\s*[:.]?\s*$/i;
const KEY_LINE = /(?:^|[\s;|])(\d{1,3})\s*[.):]\s*([^\n;|]{1,80})/g;

/**
 * Reads a dedicated answer-key section, the way most exported papers carry
 * their key.
 *
 * The section is found by its heading, and only text *after* that heading is
 * read — otherwise "1. How much should visitors tip?" in the question body
 * would be mistaken for the answer to question 1.
 */
export function detectAnswerKeySection(
  root: ChildNode[],
  source: string,
): { entries: Map<number, AnswerKeyEntry>; range?: SourceRange } {
  const entries = new Map<number, AnswerKeyEntry>();
  const elements = flatten(root);

  const heading = elements.find((element) => KEY_SECTION_HEADING.test(elementText(element)));
  if (!heading) return { entries };

  // Everything after the heading, in document order.
  const start = heading.startIndex ?? 0;
  const after = elements.filter((element) => (element.startIndex ?? -1) > start);

  const seen = new Set<string>();
  const collect = (text: string) => {
    KEY_LINE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = KEY_LINE.exec(text)) !== null) {
      const number = Number(match[1]);
      const value = squash(match[2]);
      if (!Number.isFinite(number) || !value) continue;
      const fingerprint = `${number}:${value}`;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      // A later, different value for the same number means the section is not
      // unambiguous; say so rather than picking one.
      const existing = entries.get(number);
      if (existing && existing.value.toLowerCase() !== value.toLowerCase()) {
        entries.set(number, { ...existing, status: 'uncertain' });
        continue;
      }
      if (!existing) {
        entries.set(number, { value, status: 'extracted', origin: 'answer-key-section' });
      }
    }
  };

  // Prefer list items and table rows — an answer key is nearly always one of
  // those — and fall back to the block text of the region.
  const rows = after.filter((element) => ['li', 'td', 'p', 'div', 'span'].includes(element.name));
  const leafRows = rows.filter((element) => !element.children.some((child) => isTag(child)));
  if (leafRows.length > 0) for (const row of leafRows) collect(elementText(row));
  else for (const element of after) collect(blockText(element));

  return { entries, range: rangeOf(heading, source) };
}

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

/** A choice as printed: its label and its text, kept together. */
export interface DetectedOption {
  label: string;
  text: string;
  /** The full option string a canonical question stores. */
  full: string;
  /** Present when the source marks this option as the answer. */
  isAnswer?: boolean;
}

const LABEL_ONLY = /^([A-Za-z]{1,4}|[ivxIVX]{1,5}|\d{1,2})[.)\]]?$/;

/** Builds a canonical option string from a label and its text. */
export function composeOption(label: string, text: string): string {
  const cleanLabel = label.replace(/[.)\]]+$/, '').trim();
  const cleanText = squash(text).replace(/^[.)\]]\s*/, '');
  if (!cleanLabel) return cleanText;
  return cleanText ? `${cleanLabel}. ${cleanText}` : cleanLabel;
}

/**
 * Reads the options of a choice rendered as inputs — a live player export.
 *
 * The visible text of an option is whatever sits beside its control, which is
 * usually a `<label>` and sometimes just the following text node.
 */
export function optionsFromInputs(inputs: Element[], source: string): DetectedOption[] {
  void source;
  return inputs.map((input, index) => {
    const label = closest(input, (element) => element.name === 'label');
    const container = label ?? (input.parent && isTag(input.parent) ? input.parent : null);
    const raw = container ? elementText(container) : '';
    const value = String(input.attribs.value || '').trim();

    // The control's own value is the label when it looks like one.
    const detectedLabel = LABEL_ONLY.test(value) ? value : '';
    const text = squash(raw.replace(/^\s*([A-Za-z]{1,4}|\d{1,2})[.)\]]\s*/, ''));
    const fallbackLabel = String.fromCharCode(65 + index);

    return {
      label: detectedLabel || fallbackLabel,
      text: text || value,
      full: composeOption(detectedLabel || fallbackLabel, text || value),
      isAnswer: answerAttributeOf(input) !== null || input.attribs.checked !== undefined,
    };
  });
}

/** Reads the options of a `<select>`. */
export function optionsFromSelect(select: Element): DetectedOption[] {
  const options = findElements(select.children, (element) => element.name === 'option');
  return options
    .map((option) => {
      const value = String(option.attribs.value ?? '').trim();
      const text = elementText(option);
      return {
        label: LABEL_ONLY.test(value) ? value.replace(/[.)\]]+$/, '') : '',
        text,
        value,
        selected: option.attribs.selected !== undefined,
      };
    })
    // The empty first row is a placeholder, not a choice.
    .filter((option) => option.value !== '' || option.text !== '')
    .filter((option) => !/^[—–-]$/.test(option.text))
    .map((option, index) => {
      const label = option.label || String.fromCharCode(65 + index);
      const text = squash(option.text.replace(/^\s*([A-Za-z]{1,4}|\d{1,2})[.)\]]\s*/, ''));
      return {
        label,
        text,
        full: composeOption(label, text),
        isAnswer: option.selected,
      };
    });
}

/**
 * Reads a lettered option bank printed as text — `A  competitors nearby` on its
 * own line, which is how an exported page carries a choice with no controls.
 */
export function optionsFromText(container: AnyNode): DetectedOption[] {
  const lines = blockText(container).split('\n');
  const options: DetectedOption[] = [];
  for (const line of lines) {
    const match = /^([A-H]|[ivx]{1,5})\s*[.)\]]?\s+(.{2,300})$/.exec(line.trim());
    if (!match) continue;
    options.push({
      label: match[1],
      text: squash(match[2]),
      full: composeOption(match[1], match[2]),
    });
  }
  return options;
}

/* -------------------------------------------------------------------------- */
/* Question sites                                                              */
/* -------------------------------------------------------------------------- */

/** Where one numbered question lives on the page. */
export interface QuestionSite {
  number: number;
  /** The control, when the page has one. */
  control?: Element;
  /** The element the question's text lives in. */
  container: Element;
  /**
   * How the site was found. `widget` means an element claimed the number
   * without being an answer control — a drop zone, a canvas — which is a
   * construct the importer reports rather than reads.
   */
  via: 'control' | 'marker' | 'widget';
  sourceRange: SourceRange;
}

const NAME_NUMBER = /^(?:q|question|ans|answer)?[_-]?(\d{1,3})$/i;

/** The question number a control's name or id encodes, if any. */
export function numberFromControl(element: Element): number | null {
  for (const attribute of ['name', 'id', 'data-question', 'data-number']) {
    const raw = String(element.attribs?.[attribute] ?? '').trim();
    if (!raw) continue;
    const match = NAME_NUMBER.exec(raw);
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0 && value <= 200) return value;
    }
  }
  return null;
}

const CONTROL_TAGS = new Set(['input', 'select', 'textarea']);

/**
 * Elements that claim a question number without being an answer control — a
 * drop zone, a canvas, a proprietary widget. They are found so the question can
 * be reported as unsupported rather than going missing entirely.
 */
export function widgetSites(root: ChildNode[], source: string): QuestionSite[] {
  const sites: QuestionSite[] = [];
  for (const element of findElements(root, (candidate) => !CONTROL_TAGS.has(candidate.name))) {
    const raw = String(element.attribs?.['data-question'] ?? '').trim();
    if (!raw) continue;
    const number = Number(raw);
    if (!Number.isFinite(number) || number < 1 || number > 200) continue;
    sites.push({
      number,
      container: element,
      via: 'widget',
      sourceRange: rangeOf(element, source),
    });
  }
  return sites;
}

/** Controls that answer a question, ignoring buttons and hidden fields. */
export function answerControls(root: ChildNode[]): Element[] {
  return findElements(root, (element) => {
    if (!CONTROL_TAGS.has(element.name)) return false;
    const type = String(element.attribs.type || '').toLowerCase();
    return !['submit', 'button', 'reset', 'hidden', 'image', 'file'].includes(type);
  });
}

/**
 * Finds every numbered question site.
 *
 * Controls win where they exist, because they say unambiguously which number
 * they belong to. A bare `12.` marker is used only for numbers no control
 * claimed — which is what carries an exported page whose controls were stripped
 * on the way out.
 */
export function detectQuestionSites(root: ChildNode[], source: string): QuestionSite[] {
  const sites = new Map<number, QuestionSite>();

  for (const control of answerControls(root)) {
    const number = numberFromControl(control);
    if (number === null) continue;
    if (sites.has(number)) continue;
    // A radio's nearest block is its own label, which holds one option and not
    // the question. The fieldset around the group is the question.
    const type = String(control.attribs.type || '').toLowerCase();
    const isChoice = type === 'radio' || type === 'checkbox';
    const container =
      (isChoice ? closest(control, (element) => element.name === 'fieldset') : null) ??
      closest(control, (element) => ['td', 'li', 'p', 'div', 'label'].includes(element.name)) ??
      control;
    sites.set(number, {
      number,
      control,
      container,
      via: 'control',
      sourceRange: rangeOf(container, source),
    });
  }

  // Marker pass: a text node beginning with `N.` or `N)`.
  for (const node of textNodes(root)) {
    const text = squash(node.data);
    const match = /^(\d{1,3})\s*[.)]\s*(.*)$/.exec(text);
    if (!match) continue;
    const number = Number(match[1]);
    if (!Number.isFinite(number) || number < 1 || number > 200) continue;
    if (sites.has(number)) continue;

    const parent = node.parent && isTag(node.parent) ? node.parent : null;
    if (!parent) continue;
    const container =
      closest(parent, (element) => ['td', 'li', 'p', 'div'].includes(element.name)) ?? parent;
    sites.set(number, {
      number,
      container,
      via: 'marker',
      sourceRange: rangeOf(container, source),
    });
  }

  return [...sites.values()].sort((a, b) => a.number - b.number);
}

/**
 * The lettered lines that follow a question, up to the next numbered one.
 *
 * A page with no controls prints its choices as siblings of the question — "12.
 * The writer mentions engineers…" then "A show that…", "B argue that…". They
 * are not inside the question's own element, so they have to be walked to.
 */
export function optionsFromFollowingSiblings(site: QuestionSite): DetectedOption[] {
  const options: DetectedOption[] = [];
  let cursor: AnyNode | null = site.container.next;
  let scanned = 0;

  while (cursor && scanned < 14) {
    if (isTag(cursor)) {
      const text = elementText(cursor);
      // The next question ends this question's options.
      if (/^\s*\d{1,3}\s*[.)]/.test(text)) break;
      const match = /^([A-H]|[ivx]{1,5})\s*[.)\]]?\s+(.{2,300})$/.exec(text);
      if (match) {
        options.push({
          label: match[1],
          text: squash(match[2]),
          full: composeOption(match[1], match[2]),
        });
      } else if (options.length > 0 && text) {
        // A non-option line after the options have started closes the run.
        break;
      }
    }
    cursor = cursor.next;
    scanned++;
  }
  return options;
}

/** Strips a leading `12.` marker from a prompt. */
export function stripMarker(text: string, questionNumber: number): string {
  return squash(
    text
      .replace(new RegExp(`^\\s*${questionNumber}\\s*[.)]\\s*`), '')
      .replace(/^\s*\d{1,3}\s*[.)]\s*/, ''),
  );
}
