import { after, describe, it } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';
import type { ReviewState } from '../src/services/cdiImport/review';

/**
 * What survives the storage boundary after an import review.
 *
 * The review screen can assemble a perfect import record and still save none of
 * it: Zod strips keys the content schema does not declare, so an `importRecord`
 * that is not in the write contract disappears silently and the material looks,
 * months later, exactly like one somebody typed by hand. That is the failure
 * this suite exists to catch — the review screen asserting on its own output
 * proves only that the review screen agrees with itself.
 *
 * The second half is about permanence. Provenance is evidence: an ordinary edit
 * through the material editor must not erase it, and a request must not be able
 * to rewrite it into a claim the parser never made.
 */
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-import-'));
const originalCwd = process.cwd();
const FIXTURE_ROOT = path.join(originalCwd, 'tests', 'fixtures', 'cdi');

process.env.STORAGE_BACKEND = 'local';
process.env.NODE_ENV = 'test';
process.chdir(tempRoot);

const { importCdiHtml } = await import('../src/services/cdiImport');
const { buildReviewState, setClassification, toSavePayload, includedQuestions } = await import(
  '../src/services/cdiImport/review'
);
const { adminStore } = await import('../src/services/adminStore');
const { extractAssetIds } = await import('../src/services/assetStore');
const { parseMaterialForWrite } = await import('../src/schemas/material');

after(() => {
  process.chdir(originalCwd);
  removeTempRoot(tempRoot);
});

const SOURCE_ASSET = 'ast_source000000001';

const reviewed = (name: string): ReviewState => {
  const html = readFileSync(path.join(FIXTURE_ROOT, name + '.html'), 'utf8');
  const result = importCdiHtml(html, { resolveAsset: () => null });
  const state = buildReviewState(result, { sourceHtml: html, sourceAssetId: SOURCE_ASSET });
  return setClassification(state, {
    section: state.classification.section ?? 'reading',
    module: 'academic',
    theme: 'Navigation',
    targetBand: '7.5',
    part: 1,
  });
};

/** The content of a stored material, without every caller writing the cast. */
const contentOf = (material: unknown): Record<string, any> =>
  (material as { content: Record<string, any> }).content;

const savePayloadOf = (state: ReviewState): object => {
  const payload = toSavePayload(state);
  if (!payload) throw new Error('the fixture should be saveable once classified');
  return payload as unknown as object;
};

describe('an imported material keeps its provenance in storage', () => {
  it('persists the import record through the write schema', async () => {
    const state = reviewed('reading-markers');
    const saved = await adminStore.saveMaterial('reading', savePayloadOf(state));
    const record = contentOf(saved).importRecord;

    expect(record === undefined).toBe(false);
    expect(record.parserVersion).toBe(state.parserVersion);
    expect(record.sourceAssetId).toBe(SOURCE_ASSET);
    expect(record.reviewedQuestions.length).toBe(state.questions.length);
  });

  it('reads the same record back from the store, not just from the write call', async () => {
    const state = reviewed('reading-markers');
    const saved = await adminStore.saveMaterial('reading', savePayloadOf(state));

    const listed = await adminStore.listMaterials('reading');
    const found = listed.find((item) => item.id === (saved as { id: string }).id);

    expect(found === undefined).toBe(false);
    expect(contentOf(found).importRecord.sourceAssetId).toBe(SOURCE_ASSET);
  });

  it('records what the parser decided about every question, including excluded ones', async () => {
    const state = reviewed('listening-mixed');
    const saved = await adminStore.saveMaterial('listening', savePayloadOf(state));
    const record = contentOf(saved).importRecord;
    const stored = contentOf(saved).section.questions;

    // Every question the parser saw is in the record; only the included ones
    // are in the material. A test that lost fourteen of its forty questions
    // must still be able to say which fourteen.
    expect(record.reviewedQuestions.length).toBe(state.questions.length);
    expect(stored.length).toBe(includedQuestions(state).length);
    expect(record.reviewedQuestions.length >= stored.length).toBe(true);
    for (const entry of record.reviewedQuestions) {
      expect(typeof entry.originalStatus).toBe('string');
      expect(typeof entry.sourceRange.start).toBe('number');
    }
  });

  it('keeps the parser diagnostics, not only the questions that worked', async () => {
    const state = reviewed('listening-mixed');
    const saved = await adminStore.saveMaterial('listening', savePayloadOf(state));
    const record = contentOf(saved).importRecord;

    expect(record.diagnostics.length).toBe(state.diagnostics.length);
    expect(record.unsupportedRegions.length).toBe(state.unsupportedRegions.length);
  });

  it('keeps the original bytes reachable, so the asset reaper cannot collect them', async () => {
    const saved = await adminStore.saveMaterial(
      'reading',
      savePayloadOf(reviewed('reading-markers')),
    );

    expect(extractAssetIds(saved).includes(SOURCE_ASSET)).toBe(true);
  });
});

describe('provenance is written once', () => {
  it('survives an edit that knows nothing about importing', async () => {
    const state = reviewed('reading-markers');
    const saved = await adminStore.saveMaterial('reading', savePayloadOf(state));
    const id = (saved as { id: string }).id;

    // Exactly the shape the reading editor sends: a whole content object, with
    // no idea that an import record exists.
    const edited = await adminStore.saveMaterial('reading', {
      id,
      title: 'Renamed by hand',
      section: 'reading',
      module: 'academic',
      status: 'draft',
      content: {
        passage: {
          passageNumber: 1,
          title: 'Renamed by hand',
          text: 'Edited passage text.',
          questions: contentOf(saved).passage.questions,
        },
      },
    });

    expect((edited as { title: string }).title).toBe('Renamed by hand');
    expect(contentOf(edited).importRecord.sourceAssetId).toBe(SOURCE_ASSET);
    expect(contentOf(edited).importRecord.parserVersion).toBe(state.parserVersion);
  });

  it('refuses to let a later request rewrite the record', async () => {
    const state = reviewed('reading-markers');
    const saved = await adminStore.saveMaterial('reading', savePayloadOf(state));
    const id = (saved as { id: string }).id;

    const tampered = await adminStore.saveMaterial('reading', {
      id,
      title: contentOf(saved).passage.title,
      section: 'reading',
      module: 'academic',
      content: {
        ...contentOf(saved),
        importRecord: {
          parserVersion: 'not-the-parser',
          sourceAssetId: 'ast_someoneelses1',
          diagnostics: [],
          unsupportedRegions: [],
          reviewedQuestions: [],
        },
      },
    });

    const record = contentOf(tampered).importRecord;
    expect(record.parserVersion).toBe(state.parserVersion);
    expect(record.sourceAssetId).toBe(SOURCE_ASSET);
    expect(record.reviewedQuestions.length).toBe(state.questions.length);
  });

  it('does not invent a record for a material that was never imported', () => {
    const parsed = parseMaterialForWrite('reading', {
      title: 'Typed by hand',
      section: 'reading',
      module: 'academic',
      content: {
        passage: {
          passageNumber: 1,
          title: 'Typed by hand',
          text: 'A passage somebody wrote.',
          questions: [
            {
              id: 'h1',
              questionNumber: 1,
              type: 'true_false_not_given',
              prompt: 'The passage was typed by a person.',
              correctAnswer: 'TRUE',
            },
          ],
        },
      },
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(contentOf(parsed.material).importRecord).toBe(undefined);
  });

  it('rejects an import record that claims an impossible review decision', () => {
    const parsed = parseMaterialForWrite('reading', {
      title: 'Imported',
      section: 'reading',
      module: 'academic',
      content: {
        importRecord: {
          parserVersion: 'cdi-1',
          reviewedQuestions: [
            {
              questionNumber: 1,
              originalStatus: 'definitely_fine',
              originalAnswerStatus: 'extracted',
              decision: 'include',
              edited: false,
              sourceRange: { start: 0, end: 10, excerpt: '' },
            },
          ],
        },
        passage: {
          passageNumber: 1,
          title: 'Imported',
          text: 'Text.',
          questions: [],
        },
      },
    });

    expect(parsed.ok).toBe(false);
  });
});
