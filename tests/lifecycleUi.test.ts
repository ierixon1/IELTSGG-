import './env';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect } from './harness';
import { AdminMaterialCatalog } from '../src/components/admin/AdminMaterialCatalog';
import { MocksHub } from '../src/components/MocksHub';
import { ExamMode } from '../src/components/ExamMode';
import { I18nProvider } from '../src/i18n';
import { builtInPracticeTest, builtInSittableTest } from '../src/services/publishedTests';
import type { SittingQuestion } from '../src/types';
import type { SittableTest } from '../src/services/publishedTests';
import type { AdminMaterial, MaterialLifecycleStatus } from '../src/types/admin';

/**
 * What the two screens say, rather than what they do.
 *
 * The catalog assertions are about affordances: which lifecycle action a
 * material in each state offers. Publishing being a deliberate act only holds
 * if there is exactly one place it can be done from, and the editors no longer
 * offer it.
 *
 * The learner assertions are the other half of removing the built-in-test
 * backfill. `sittingToAdaptedTest` returning null for a missing section is only
 * safe because the screens refuse to open one — a test asserting the adapter
 * alone would not notice a screen that crashed or, worse, rendered an empty
 * paper as though it were the real thing.
 */

const material = (over: Partial<AdminMaterial> = {}): AdminMaterial =>
  ({
    id: 'adm-rea-catalog-1',
    title: 'Catalog Reading',
    section: 'reading',
    module: 'academic',
    status: 'draft' as MaterialLifecycleStatus,
    theme: 'Navigation',
    targetBand: '7.5',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    content: {
      passage: {
        passageNumber: 2,
        title: 'Dead reckoning',
        text: 'Body.',
        questions: [
          {
            id: 'q1',
            questionNumber: 1,
            type: 'true_false_not_given',
            prompt: 'A claim.',
            correctAnswer: 'TRUE',
          },
        ],
      },
    },
    ...over,
  }) as AdminMaterial;

const catalog = (materials: AdminMaterial[]) =>
  renderToStaticMarkup(
    createElement(AdminMaterialCatalog, {
      materials,
      searchQuery: '',
      onEdit: () => {},
      onPreview: () => {},
      onDelete: () => {},
      onChanged: () => {},
      onToast: () => {},
    }),
  );

const hub = (test: SittableTest<SittingQuestion>, initialSelectedSection: 'reading' | 'listening' | null = null) =>
  renderToStaticMarkup(
    createElement(
      I18nProvider,
      null,
      createElement(MocksHub, {
        mockTest: test,
        onMarkPractice: () => Promise.reject(new Error('not marked in a render test')),
        onRecordScore: () => {},
        initialSelectedSection,
      }),
    ),
  );

const exam = () =>
  renderToStaticMarkup(
    createElement(I18nProvider, null, createElement(ExamMode, { onCompleteExam: () => {}, onExitExam: () => {} })),
  );

describe('the admin material catalog', () => {
  it('offers publishing from exactly one place, and only for what is not published', () => {
    const html = catalog([material()]);

    expect(html.includes('btn-publish-adm-rea-catalog-1')).toBe(true);
    expect(html.includes('btn-check-adm-rea-catalog-1')).toBe(true);
    expect(html.includes('btn-unpublish-adm-rea-catalog-1')).toBe(false);
  });

  it('offers withdrawal rather than publication for a published material', () => {
    const html = catalog([material({ status: 'published' })]);

    expect(html.includes('btn-unpublish-adm-rea-catalog-1')).toBe(true);
    expect(html.includes('btn-publish-adm-rea-catalog-1')).toBe(false);
    expect(html.includes('btn-archive-adm-rea-catalog-1')).toBe(true);
  });

  it('offers restoring, not archiving again, for an archived material', () => {
    const html = catalog([material({ status: 'archived' })]);

    expect(html.includes('btn-restore-adm-rea-catalog-1')).toBe(true);
    expect(html.includes('btn-archive-adm-rea-catalog-1')).toBe(false);
    expect(html.includes('data-status-badge="archived"')).toBe(true);
  });

  it('counts each lifecycle state, so nothing is invisible behind a filter', () => {
    const html = catalog([
      material({ id: 'a', status: 'draft' }),
      material({ id: 'b', status: 'published' }),
      material({ id: 'c', status: 'published' }),
      material({ id: 'd', status: 'archived' }),
    ]);

    expect(html.includes('Draft (1)') || html.includes('draft (1)')).toBe(true);
    expect(html.includes('published (2)')).toBe(true);
    expect(html.includes('archived (1)')).toBe(true);
    expect(html.includes('all (4)')).toBe(true);
  });

  it('shows the classification a publish would require, including what is missing', () => {
    const html = catalog([material({ theme: undefined, targetBand: undefined })]);

    expect(html.includes('no theme')).toBe(true);
    expect(html.includes('no band')).toBe(true);
    expect(html.includes('Part 2')).toBe(true);
  });

  it('marks a material whose questions still need a human', () => {
    const html = catalog([material({ needsReview: ['Question 3: unknown type "mystery".'] })]);

    expect(html.includes('data-needs-review="1"')).toBe(true);
    expect(html.includes('unknown type')).toBe(true);
  });

  it('marks an imported material, so its provenance is visible in the list', () => {
    const imported = material();
    (imported.content as Record<string, unknown>).importRecord = {
      parserVersion: '1.0.0',
      diagnostics: [],
      unsupportedRegions: [],
      reviewedQuestions: [],
    };

    expect(catalog([imported]).includes('data-imported="true"')).toBe(true);
    expect(catalog([material()]).includes('data-imported="true"')).toBe(false);
  });
});

describe('a learner screen given a section the test does not carry', () => {
  const halfATest: SittableTest<SittingQuestion> = {
    id: 'cdi-half',
    title: 'Half a Test',
    difficulty: 'Standard Academic',
    listening: null,
    reading: { passages: builtInPracticeTest().reading?.passages ?? [] },
    writing: { task1: null, task2: null },
    speaking: null,
    origin: 'bundle',
    module: 'academic',
  };

  it('refuses to open it, and names the test that is misconfigured', () => {
    const html = hub(halfATest, 'listening');

    expect(html.includes('section-unavailable-listening')).toBe(true);
    expect(html.includes('Half a Test')).toBe(true);
    expect(html.includes('cdi-half')).toBe(true);
    // The other half still works.
    expect(html.includes('id="section-unavailable-reading"')).toBe(false);
  });

  it('opens a section the test does carry', () => {
    const html = hub(halfATest, 'reading');
    expect(html.includes('section-unavailable-reading')).toBe(false);
  });

  it('says up front which sections are not part of this test', () => {
    const html = hub(halfATest);

    expect(html.includes('data-unavailable-skill="listening"')).toBe(true);
    expect(html.includes('data-unavailable-skill="writing"')).toBe(true);
    expect(html.includes('data-unavailable-skill="speaking"')).toBe(true);
    expect(html.includes('data-unavailable-skill="reading"')).toBe(false);
  });

  it('never renders another test in its place', () => {
    const html = hub(halfATest, 'listening');
    const builtIn = builtInSittableTest();
    const borrowedTitle = builtIn.listening?.parts[0]?.title;

    expect(typeof borrowedTitle).toBe('string');
    expect(html.includes(String(borrowedTitle))).toBe(false);
  });

  it('offers a full exam only from published bundles, never the built-in test', () => {
    const html = exam();

    expect(html.includes('exam-bundle-catalog')).toBe(true);
    // Nothing is sittable until a published bundle has been opened through the server.
    expect(html.includes('btn-start-exam')).toBe(false);
    expect(html.includes(builtInSittableTest().title)).toBe(false);
  });
});
