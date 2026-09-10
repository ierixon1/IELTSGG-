import { sanitizeHtmlServer } from '../../routes/adminRoutes';
import type { Question } from '../../types';
import {
  blockText,
  elementText,
  findElements,
  flatten,
  normalizeCdiHtml,
  rangeOf,
  squash,
} from './normalize';
import { PARSER_VERSION } from './version';
import {
  detectAnswerKeySection,
  detectGroupHeaders,
  detectQuestionSites,
  widgetSites,
} from './parsers/shared';
import type { QuestionSite } from './parsers/shared';
import { unsupportedQuestion } from './parsers/context';
import type { ParserContext } from './parsers/context';
import { parseChoice } from './parsers/multipleChoice';
import { parseMatching } from './parsers/matching';
import { parseCompletion } from './parsers/completion';
import { emptyTables, tableGroupKey } from './parsers/table';
import { captionFor, imageForGroup, isLabellingSite, mediaRefFor } from './parsers/diagram';
import type {
  CdiImportResult,
  DetectedAsset,
  ImportDiagnostic,
  ParsedQuestion,
  UnsupportedRegion,
} from './types';

/**
 * Reading a CDI page into our own test model.
 *
 * The point of this module is the direction of travel. An imported page is a
 * *source of content and structure*, and it is turned into canonical questions
 * that our own learner engine renders and marks. It is never turned into a
 * runtime: no script from the page is kept, no behaviour from the page is
 * executed, and the markup that survives for display goes through the same
 * sanitiser as everything else.
 *
 * Where the page does not say something, the parser says it does not know. It
 * never fills a gap with the likeliest value — least of all an answer key,
 * which is the one field where being confidently wrong silently corrupts a
 * learner's band.
 */

/** Constructs that will not be parsed, and are reported rather than mangled. */
const UNSUPPORTED_SIGNATURES: Array<{ construct: string; reason: string; test: (html: string) => boolean }> = [
  {
    construct: 'drag and drop',
    reason:
      'Drag-and-drop placement is not in the question model. It would have to be invented as a new task type before it could be imported.',
    test: (html) => /draggable\s*=\s*["']?true|\bdrag(start|over|drop)\b|class="[^"]*\bdrag/i.test(html),
  },
  {
    construct: 'canvas widget',
    reason: 'A canvas carries no readable structure, so nothing can be extracted from it.',
    test: (html) => /<canvas\b/i.test(html),
  },
  {
    construct: 'script-driven question',
    reason:
      'The page builds questions in JavaScript, which is removed rather than executed. Only what is present in the markup could be read.',
    test: (html) => /<script\b[^>]*>[\s\S]{40,}?(question|answer|option)/i.test(html),
  },
];

function detectUnsupportedRegions(html: string): UnsupportedRegion[] {
  const regions: UnsupportedRegion[] = [];
  for (const signature of UNSUPPORTED_SIGNATURES) {
    if (!signature.test(html)) continue;
    const at = Math.max(0, html.search(/draggable|<canvas|<script/i));
    regions.push({
      construct: signature.construct,
      reason: signature.reason,
      sourceRange: { start: at, end: at, excerpt: html.slice(at, at + 200) },
    });
  }
  return regions;
}

/** Reads the page's own title, falling back to its first heading. */
function detectTitle(root: ReturnType<typeof normalizeCdiHtml>['root']): string {
  const titleTag = findElements(root, (element) => element.name === 'title')[0];
  const fromTitle = titleTag ? elementText(titleTag) : '';
  if (fromTitle) return fromTitle.slice(0, 300);

  const heading = findElements(root, (element) => /^h[1-3]$/.test(element.name))[0];
  return (heading ? elementText(heading) : 'Imported CDI material').slice(0, 300);
}

/**
 * Which skill the page is, from what it says about itself.
 *
 * `null` rather than a guess: filing a Listening test as Reading is exactly the
 * mistake that already happened once by hand in this repo.
 */
function detectSection(text: string): 'listening' | 'reading' | null {
  const lower = text.toLowerCase();
  const listening = /\blisten(ing)?\b|\btranscript\b|\baudio\b|\bsection [1-4]\b/.test(lower);
  const reading = /\breading passage\b|\bpassage [1-3]\b|\bthe passage has\b/.test(lower);
  if (listening && !reading) return 'listening';
  if (reading && !listening) return 'reading';
  return null;
}

/** The transcript block a listening export usually carries at the end. */
function detectTranscript(root: ReturnType<typeof normalizeCdiHtml>['root']): string | undefined {
  const elements = flatten(root);
  const heading = elements.find((element) =>
    /^(transcription|transcript|audio\s*script|tapescript)\s*[:.]?$/i.test(elementText(element)),
  );
  if (!heading) return undefined;

  const start = heading.startIndex ?? 0;
  const after = elements.filter(
    (element) => (element.startIndex ?? -1) > start && ['p', 'div', 'li'].includes(element.name),
  );
  const text = after
    .filter((element) => !element.children.some((child) => 'name' in child))
    .map((element) => elementText(element))
    .filter(Boolean)
    .join('\n');
  return text ? text.slice(0, 200_000) : undefined;
}

/**
 * The display HTML: the page's content with the questions' own controls gone.
 *
 * This is what the learner sees *around* the questions — the notes, the table
 * headings, the passage. It goes through the same sanitiser as any other
 * imported markup, because nothing from an imported page is trusted to render.
 */
function buildDisplayHtml(source: string): string {
  return sanitizeHtmlServer(source);
}

const FAMILIES = [parseMatching, parseChoice, parseCompletion];

/**
 * Reads one question site by trying each family in turn.
 *
 * Order is deliberate: matching first because its rubric is the most specific,
 * then choices, then completions — which is also the order from most structural
 * evidence to least, so a family only sees a site the more specific ones
 * declined.
 */
function parseSite(site: QuestionSite, context: ParserContext): ParsedQuestion {
  for (const family of FAMILIES) {
    const result = family(site, context);
    if (result) return result;
  }
  return {
    status: 'needs_review',
    answerStatus: 'missing',
    questionNumber: site.number,
    sourceRange: site.sourceRange,
    diagnostics: [
      {
        code: 'question_type_ambiguous',
        message: `Question ${site.number}: the page does not say what kind of task this is, and it was not guessed.`,
        questionNumber: site.number,
        sourceRange: site.sourceRange,
      },
    ],
  };
}

/**
 * Attaches the picture a labelling question depends on, and re-types the
 * question so it does not arrive as an anonymous gap fill.
 */
function applyLabelling(
  parsed: ParsedQuestion,
  site: QuestionSite,
  context: ParserContext,
  result: CdiImportResult,
): ParsedQuestion {
  const labellingType = isLabellingSite(site, context.headers);
  if (!labellingType) return parsed;

  const found = imageForGroup(site, context.root, result.assets);
  const alt = found ? captionFor(found.element, context.source).alt : undefined;
  const { mediaRef, diagnostics } = mediaRefFor(found?.asset, alt);

  const retype = <T extends Partial<Question>>(question: T): T => ({
    ...question,
    type: labellingType,
    ...(mediaRef ? { mediaRef } : {}),
  });

  if (parsed.question) {
    return {
      ...parsed,
      question: retype(parsed.question) as Question,
      // A labelling question with no picture is not answerable, however well it
      // parsed, so it is held for review rather than published as complete.
      status: mediaRef ? parsed.status : 'needs_review',
      diagnostics: [...parsed.diagnostics, ...diagnostics],
    };
  }

  return {
    ...parsed,
    draft: parsed.draft ? retype(parsed.draft) : parsed.draft,
    diagnostics: [...parsed.diagnostics, ...diagnostics],
  };
}

/** Groups a table's gaps together so the engine renders them as a table. */
function applyTableGrouping(parsed: ParsedQuestion, site: QuestionSite, context: ParserContext): ParsedQuestion {
  const key = tableGroupKey(site, context.root);
  if (!key) return parsed;

  const withGroup = <T extends Partial<Question>>(question: T): T => ({
    ...question,
    group: key,
    layout: question.layout === 'standalone' || !question.layout ? 'table_row' : question.layout,
  });

  if (parsed.question) return { ...parsed, question: withGroup(parsed.question) as Question };
  if (parsed.draft) return { ...parsed, draft: withGroup(parsed.draft) };
  return parsed;
}

/** Reports numbering that is missing or repeated, without repairing it. */
function checkNumbering(sites: QuestionSite[]): ImportDiagnostic[] {
  const diagnostics: ImportDiagnostic[] = [];
  const numbers = sites.map((site) => site.number);
  if (numbers.length === 0) return diagnostics;

  const seen = new Set<number>();
  for (const number of numbers) {
    if (seen.has(number)) {
      diagnostics.push({
        code: 'numbering_duplicate',
        message: `Question ${number} appears more than once on the page.`,
        questionNumber: number,
      });
    }
    seen.add(number);
  }

  const first = Math.min(...numbers);
  const last = Math.max(...numbers);
  const missing: number[] = [];
  for (let n = first; n <= last; n++) if (!seen.has(n)) missing.push(n);
  if (missing.length > 0) {
    diagnostics.push({
      code: 'numbering_gap',
      message: `The page numbers questions ${first}–${last} but ${missing.length} of them were not found: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? '…' : ''}.`,
    });
  }
  return diagnostics;
}

/**
 * Imports a CDI page.
 *
 * Nothing here mutates the input, and the caller keeps the original bytes — the
 * result carries `parserVersion` so a material imported today can be found and
 * re-read when the parser is better.
 */
export interface ImportOptions {
  /**
   * Stores an asset the page carries and returns its id.
   *
   * The importer does not store anything itself — it has no business writing
   * files — but a data: URI is self-contained, so a caller that can store it
   * lets a labelling question arrive complete instead of held for its picture.
   * Returning `null` leaves the asset unresolved, which is the honest result
   * for a path the page only references.
   */
  resolveAsset?: (asset: DetectedAsset) => string | null;
}

export function importCdiHtml(html: string, options: ImportOptions = {}): CdiImportResult {
  const document = normalizeCdiHtml(html);
  const { root, source } = document;

  const headers = detectGroupHeaders(root, source);
  const { entries: answerKeys } = detectAnswerKeySection(root, source);
  const parsedSites = detectQuestionSites(root, source);
  // Numbers claimed by a widget rather than a control: a drop zone, a canvas.
  // Reported as unsupported rather than left out of the count, which would
  // flatter the coverage figure.
  const claimed = new Set(parsedSites.map((site) => site.number));
  const widgets = widgetSites(root, source).filter((site) => !claimed.has(site.number));
  const sites = [...parsedSites, ...widgets].sort((a, b) => a.number - b.number);
  const context: ParserContext = { root, source, headers, answerKeys };

  const pageText = root.map((node) => blockText(node)).filter(Boolean).join('\n');
  const result: CdiImportResult = {
    parserVersion: PARSER_VERSION,
    detectedSection: detectSection(pageText.slice(0, 20000)),
    title: detectTitle(root),
    normalizedHtml: buildDisplayHtml(source),
    normalizedText: squash(pageText).slice(0, 200_000),
    questions: [],
    unsupportedRegions: [...detectUnsupportedRegions(source), ...emptyTables(root, source)],
    assets: document.assets,
    diagnostics: [...document.diagnostics, ...checkNumbering(sites)],
    transcript: detectTranscript(root),
    stats: { detected: 0, parsed: 0, needsReview: 0, unsupported: 0, coverage: 0 },
  };

  // Assets the caller can store are resolved before questions are built, so a
  // labelling question can carry its picture rather than be held for it.
  if (options.resolveAsset) {
    for (const asset of result.assets) {
      if (asset.assetId) continue;
      const id = options.resolveAsset(asset);
      if (id) asset.assetId = id;
    }
  }

  // A site inside a construct the parser refuses is reported as unsupported
  // rather than half-read.
  const unsupportedRanges = result.unsupportedRegions.map((region) => region.sourceRange);

  for (const site of sites) {
    if (site.via === 'widget') {
      const construct = String(site.container.attribs?.['data-widget'] || site.container.name);
      result.questions.push(
        unsupportedQuestion(
          site.number,
          site.sourceRange,
          construct === 'div' ? 'interactive widget' : construct,
          'The question is driven by a widget rather than by an answer control, so nothing could be read from it.',
        ),
      );
      continue;
    }

    const inUnsupported = unsupportedRanges.some(
      (range) => site.sourceRange.start >= range.start && site.sourceRange.start <= range.end && range.end > range.start,
    );
    if (inUnsupported) {
      result.questions.push(
        unsupportedQuestion(
          site.number,
          site.sourceRange,
          'unsupported region',
          'This question sits inside a construct the importer does not handle.',
        ),
      );
      continue;
    }

    let parsed = parseSite(site, context);
    parsed = applyTableGrouping(parsed, site, context);
    parsed = applyLabelling(parsed, site, context, result);
    result.questions.push(parsed);
  }

  if (sites.length === 0) {
    result.diagnostics.push({
      code: 'no_questions_found',
      message:
        'No numbered questions were found. The page may build them in JavaScript, or use a numbering style this parser does not recognise.',
    });
  }

  result.stats = {
    detected: result.questions.length,
    parsed: result.questions.filter((q) => q.status === 'parsed').length,
    needsReview: result.questions.filter((q) => q.status === 'needs_review').length,
    unsupported: result.questions.filter((q) => q.status === 'unsupported').length,
    coverage: 0,
  };
  result.stats.coverage =
    result.stats.detected === 0 ? 0 : result.stats.parsed / result.stats.detected;

  // Diagnostics raised per question also belong to the page-level report, so a
  // caller that only reads `diagnostics` still sees everything.
  for (const question of result.questions) {
    for (const diagnostic of question.diagnostics) result.diagnostics.push(diagnostic);
  }

  return result;
}

export { PARSER_VERSION } from './version';
export type { CdiImportResult, ParsedQuestion } from './types';
