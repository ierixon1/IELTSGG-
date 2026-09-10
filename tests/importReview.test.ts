import './env';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect } from './harness';
import { importCdiHtml } from '../src/services/cdiImport';
import {
  applyCorrection,
  attachAsset,
  blockingReasons,
  buildReviewState,
  includedQuestions,
  isQuestionReady,
  phaseFor,
  questionProblems,
  setClassification,
  setDecision,
  sourceFragment,
  toSavePayload,
} from '../src/services/cdiImport/review';
import type { ReviewState } from '../src/services/cdiImport/review';
import { AdminImportReview } from '../src/components/admin/AdminImportReview';
import { QuestionSchema } from '../src/schemas/question';

/**
 * The import review flow.
 *
 * The screen exists to answer one question honestly: what did the parser
 * understand, and what did it not? So most of what is tested here is what
 * *cannot* happen — an unsupported construct quietly becoming a gap fill, a
 * supplied answer erasing the record that the parser could not find one, a
 * correction rewriting the evidence, an incomplete import being saved.
 *
 * The preview assertions render the real component, because a review screen
 * that previewed with its own renderer would only prove the preview works.
 */

const FIXTURE_ROOT = path.join(process.cwd(), 'tests', 'fixtures', 'cdi');
const fixture = (name: string) => readFileSync(path.join(FIXTURE_ROOT, `${name}.html`), 'utf8');

let assetCounter = 0;
const reviewOf = (name: string): ReviewState => {
  const html = fixture(name);
  const result = importCdiHtml(html, {
    resolveAsset: (asset) =>
      asset.origin === 'inline' ? `ast_review${String(++assetCounter).padStart(10, '0')}` : null,
  });
  return buildReviewState(result, { sourceHtml: html, sourceAssetId: 'ast_source000000001' });
};

/** Fills in the classification an admin must confirm. */
const classified = (state: ReviewState, over: Record<string, unknown> = {}): ReviewState =>
  setClassification(state, {
    section: state.classification.section ?? 'reading',
    module: 'academic',
    theme: 'Navigation',
    targetBand: '7.5',
    part: 1,
    ...over,
  });

const render = (state: ReviewState) =>
  renderToStaticMarkup(
    createElement(AdminImportReview, {
      state,
      onChange: () => {},
      onSaveDraft: async () => {},
      onCancel: () => {},
    }),
  );

const questionByNumber = (state: ReviewState, n: number) =>
  state.questions.find((question) => question.questionNumber === n)!;

/* -------------------------------------------------------------------------- */

describe('1. an import becomes a review', () => {
  const state = reviewOf('reading-markers');

  it('carries everything the parser reported', () => {
    expect(state.parserVersion).toBeTruthy();
    expect(state.sourceAssetId).toBe('ast_source000000001');
    expect(state.questions).toHaveLength(13);
    expect(state.sourceHtml.length).toBeGreaterThan(1000);
  });

  it('proposes a classification without deciding it', () => {
    // The parser read "reading" off the page, but module, theme and band are
    // not on the page and are not invented.
    expect(state.classification.section).toBe('reading');
    expect(state.classification.module).toBe(null);
    expect(state.classification.theme).toBe('');
    expect(state.classification.targetBand).toBe('');
  });

  it('shows the counts and the parser version on screen', () => {
    const html = render(state);
    expect(html).toContain('Detected');
    expect(html).toContain('Needs review');
    expect(html).toContain('Unsupported');
    expect(html).toContain(state.parserVersion);
    expect(html).toContain('Review imported material');
  });
});

describe('2. parsed questions reach the real learner preview', () => {
  const state = classified(reviewOf('reading-markers'));

  it('renders the learner components, not a stand-in', () => {
    const html = render(state);
    expect(html).toContain('id="import-learner-preview"');
    // A matching-headings question renders as the learner's dropdown, with the
    // option labels the engine stores.
    expect(html).toContain('<select');
    expect(html).toContain('value="ii"');
    // A TRUE/FALSE question renders as the learner's radios.
    expect(html).toContain('type="radio"');
    expect(html).toContain('NOT GIVEN');
    // A completion renders as the learner's text box, with its word limit.
    expect(html).toContain('type="text"');
    expect(html).toContain('ONE WORD ONLY');
  });

  it('previews exactly the questions that would be saved', () => {
    const ready = includedQuestions(state);
    expect(ready).toHaveLength(13);
    expect(render(state)).toContain(`${ready.length} question(s) that will be saved`);
  });
});

describe('3. a question that needs review is visibly marked', () => {
  const state = reviewOf('mixed-hostile');

  it('keeps the parser verdict on every row', () => {
    const html = render(state);
    expect(html).toContain('needs review');
    expect(html).toContain('unsupported');
    // The reason the parser gave is shown, not summarised away.
    expect(html).toContain('What the parser reported');
  });

  it('reports the phase as blocked while anything is unresolved', () => {
    expect(phaseFor(state)).toBe('blocked');
    expect(blockingReasons(state).length).toBeGreaterThan(0);
  });
});

describe('4. an unsupported construct cannot become another question type', () => {
  const state = reviewOf('mixed-hostile');
  const widget = questionByNumber(state, 5);

  it('arrives excluded from the material by default', () => {
    expect(widget.originalStatus).toBe('unsupported');
    // Not "include and hope": the default decision keeps it out.
    expect(widget.decision).toBe('mark_unsupported');
    expect(isQuestionReady(widget)).toBe(false);
  });

  it('is not silently a fill_in_blank', () => {
    expect(widget.draft.type).not.toBe('fill_in_blank');
    expect(includedQuestions(state).some((q) => q.questionNumber === 5)).toBe(false);
  });

  it('blocks the save if an admin includes it without fixing it', () => {
    const forced = setDecision(state, widget.key, 'include');
    expect(blockingReasons(forced).join(' ')).toContain('incomplete');
    expect(toSavePayload(classified(forced))).toBe(null);
  });

  it('can be excluded outright, and then stops blocking', () => {
    let next = state;
    for (const question of state.questions) {
      if (question.originalStatus !== 'parsed') next = setDecision(next, question.key, 'exclude');
    }
    // Everything in this fixture needs a human, so excluding all of it leaves
    // nothing to save — which is itself a blocking reason, correctly.
    expect(blockingReasons(classified(next)).join(' ')).toContain('No questions are included');
  });
});

describe('5. a missing answer key must be resolved by a human', () => {
  const state = reviewOf('mixed-hostile');
  const q4 = questionByNumber(state, 4);

  it('is flagged, and the flag survives being corrected', () => {
    expect(q4.originalAnswerStatus).toBe('missing');
    expect(questionProblems(q4).length).toBeGreaterThan(0);

    const fixed = applyCorrection(state, q4.key, { correctAnswer: 'A' });
    const after = fixed.questions.find((question) => question.key === q4.key)!;

    expect(after.draft.correctAnswer).toBe('A');
    expect(isQuestionReady(after)).toBe(true);
    // The record that the parser could not read a key is not erased by
    // supplying one — otherwise a hand-entered answer would later look like
    // something the parser got right.
    expect(after.originalAnswerStatus).toBe('missing');
    expect(after.edited).toBe(true);
  });

  it('says so on screen', () => {
    const html = render(state);
    expect(html).toContain('key missing');
    expect(html).toContain('the parser could not read one');
  });
});

describe('6. a correction changes the question, never the evidence', () => {
  const state = reviewOf('reading-markers');
  const q1 = questionByNumber(state, 1);

  const corrected = applyCorrection(state, q1.key, {
    prompt: 'Paragraph A — corrected by hand',
    correctAnswer: 'iii',
    acceptableAnswers: ['III'],
    instruction: 'Edited rubric',
  });
  const after = corrected.questions.find((question) => question.key === q1.key)!;

  it('applies the correction', () => {
    expect(after.draft.prompt).toBe('Paragraph A — corrected by hand');
    expect(after.draft.correctAnswer).toBe('iii');
    expect(after.draft.acceptableAnswers).toEqual(['III']);
    expect(after.draft.instruction).toBe('Edited rubric');
  });

  it('leaves the source HTML byte-identical', () => {
    expect(corrected.sourceHtml).toBe(state.sourceHtml);
    expect(corrected.sourceAssetId).toBe(state.sourceAssetId);
  });

  it('keeps the source range, the parser version and the diagnostics', () => {
    expect(after.sourceRange).toEqual(q1.sourceRange);
    expect(corrected.parserVersion).toBe(state.parserVersion);
    expect(after.diagnostics).toEqual(q1.diagnostics);
    expect(corrected.diagnostics).toEqual(state.diagnostics);
  });

  it('does not renumber a question as a side effect', () => {
    expect(after.draft.questionNumber).toBe(q1.draft.questionNumber);
    // Renumbering is possible, but only as a deliberate act.
    const renumbered = applyCorrection(corrected, q1.key, { questionNumber: 40 });
    expect(renumbered.questions.find((q) => q.key === q1.key)!.draft.questionNumber).toBe(40);
  });

  it('still points at the markup it was read from', () => {
    const fragment = sourceFragment(corrected, after);
    expect(fragment.length).toBeGreaterThan(0);
    expect(state.sourceHtml).toContain(fragment.slice(0, 40));
  });
});

describe('7. a file the page needs but does not contain is shown', () => {
  const state = reviewOf('listening-controls');

  it('lists the unresolved asset with its origin', () => {
    const missing = state.assets.filter((asset) => !asset.assetId);
    expect(missing.length).toBeGreaterThan(0);

    const html = render(state);
    expect(html).toContain('the page needs but does not contain');
    expect(html).toContain('audio/section1.mp3');
    expect(html).toContain('Attach the audio');
  });

  it('refuses an external URL as a trusted local file', () => {
    const hostile = reviewOf('mixed-hostile');
    const external = hostile.assets.find((asset) => asset.origin === 'external');
    expect(external?.assetId).toBeUndefined();
    expect(render(hostile)).toContain('not imported as a trusted file');
  });

  it('links an attached asset to the questions that need it', () => {
    const mixed = reviewOf('listening-mixed');
    const image = mixed.assets.find((asset) => asset.kind === 'image')!;
    const attached = attachAsset(mixed, image.originalSrc, 'ast_uploaded00000001');

    expect(attached.assets.find((a) => a.originalSrc === image.originalSrc)?.assetId).toBe(
      'ast_uploaded00000001',
    );
    const labelling = attached.questions.find((q) => q.draft.type === 'map_label');
    expect(labelling?.draft.mediaRef?.assetId).toBe('ast_uploaded00000001');
  });

  it('blocks a save while a question points at an unattached file', () => {
    const mixed = reviewOf('listening-mixed');
    // Pretend the image never resolved.
    const orphaned: ReviewState = {
      ...mixed,
      assets: mixed.assets.map((asset) => ({ ...asset, assetId: undefined })),
    };
    expect(blockingReasons(classified(orphaned, { section: 'listening' })).join(' ')).toContain(
      'not been attached',
    );
  });
});

describe('8. classification is required before saving', () => {
  const state = reviewOf('reading-markers');

  it('blocks while section, module or title are unset', () => {
    expect(blockingReasons(state).join(' ')).toContain('Academic or General');
    expect(toSavePayload(state)).toBe(null);

    const noTitle = setClassification(classified(state), { title: '  ' });
    expect(blockingReasons(noTitle).join(' ')).toContain('title');
    expect(toSavePayload(noTitle)).toBe(null);
  });

  it('unblocks once the admin has confirmed them', () => {
    const ready = classified(state);
    expect(blockingReasons(ready)).toEqual([]);
    expect(phaseFor(ready)).toBe('ready');
  });

  it('shows the classification form as required', () => {
    expect(render(state)).toContain('Classification — required before saving');
  });
});

describe('9. saving a draft produces a valid material', () => {
  const state = classified(reviewOf('reading-markers'));
  const payload = toSavePayload(state)!;

  it('produces a draft, never a published material', () => {
    expect(payload).toBeTruthy();
    expect(payload.status).toBe('draft');
    expect(payload.section).toBe('reading');
    expect(payload.module).toBe('academic');
    expect(payload.theme).toBe('Navigation');
    expect(payload.targetBand).toBe('7.5');
  });

  it('carries only questions that validate against the canonical schema', () => {
    const questions = (payload.content as any).passage.questions;
    expect(questions).toHaveLength(13);
    for (const question of questions) {
      expect(QuestionSchema.safeParse(question).success).toBe(true);
    }
  });

  it('keeps the import record with the material', () => {
    const record = (payload.content as any).importRecord;
    expect(record.parserVersion).toBe(state.parserVersion);
    expect(record.sourceAssetId).toBe('ast_source000000001');
    expect(record.reviewedQuestions).toHaveLength(13);
    // Each row keeps what the parser originally said about it.
    expect(record.reviewedQuestions[0].originalStatus).toBe('parsed');
    expect(record.reviewedQuestions[0].sourceRange).toBeTruthy();
    expect(Array.isArray(record.diagnostics)).toBe(true);
  });

  it('references the source asset so the original can be re-parsed', () => {
    expect((payload.content as any).assetIds).toContain('ast_source000000001');
    expect((payload.content as any).sourceAssetId).toBe('ast_source000000001');
  });
});

describe('10. an incomplete import cannot be saved', () => {
  it('refuses at the payload boundary, not only in the UI', () => {
    const blocked = classified(reviewOf('mixed-hostile'), { section: 'reading' });
    expect(blockingReasons(blocked).length).toBeGreaterThan(0);
    expect(toSavePayload(blocked)).toBe(null);
  });

  it('disables the save control while blocked', () => {
    const blocked = reviewOf('mixed-hostile');
    const html = render(blocked);
    expect(html).toContain('This import cannot be saved yet');
    expect(html).toContain('disabled=""');
  });

  it('enables it once nothing is blocking', () => {
    const ready = classified(reviewOf('reading-markers'));
    const html = render(ready);
    expect(html).not.toContain('This import cannot be saved yet');
    expect(html).toContain('Save as draft');
  });

  it('never lets a partially corrected question into the material', () => {
    const state = classified(reviewOf('reading-markers'));
    const q1 = questionByNumber(state, 1);
    // An answer that names none of its own options is not a valid question.
    const broken = applyCorrection(state, q1.key, { correctAnswer: 'zzz' });
    expect(blockingReasons(broken).join(' ')).toContain('incomplete');
    expect(toSavePayload(broken)).toBe(null);
    expect(includedQuestions(broken).some((q) => q.questionNumber === 1)).toBe(false);
  });
});
