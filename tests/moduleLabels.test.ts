import './env';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect } from './harness';
import { I18nProvider } from '../src/i18n';
import { MocksHub } from '../src/components/MocksHub';
import { ListeningSession } from '../src/components/ListeningSession';
import { ReadingSession } from '../src/components/ReadingSession';
import { WritingSession } from '../src/components/WritingSession';
import { materialToSittable, toPracticeTest } from '../src/services/publishedTests';
import { questionNumberRange } from '../src/utils/questionNumbers';
import type { SittableTest } from '../src/services/publishedTests';
import type { AdminMaterial } from '../src/types/admin';
import type { SkillType, SittingQuestion } from '../src/types';
import { listeningPayload, readingPayload, writingPayload } from './bundleFixtures';

/**
 * What a learner is told about the paper in front of them, per module.
 *
 * IELTS Academic and General Training share Listening and Speaking but not
 * Reading texts or Writing Task 1 (ielts.org test formats): General Training
 * Task 1 is a letter, and its Reading is sections of everyday and workplace
 * texts. These pin that a General Training paper is not described in Academic
 * terms, and that an Academic one still is — each module checked on its own.
 * They also pin that a Listening part is headed with its own question numbers.
 */

const published = (payload: object, id: string): AdminMaterial =>
  ({ id, status: 'published', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...payload }) as AdminMaterial;

const practice = (payload: object, id: string): SittableTest<SittingQuestion> => toPracticeTest(materialToSittable(published(payload, id)).test);

const render = (element: ReactElement) => renderToStaticMarkup(createElement(I18nProvider, null, element));

const hub = (test: SittableTest<SittingQuestion>, section: SkillType | null = null) =>
  render(
    createElement(MocksHub, {
      mockTest: test,
      onMarkPractice: () => Promise.reject(new Error('not marked in a render test')),
      onRecordScore: () => {},
      initialSelectedSection: section,
    }),
  );

const noop = () => {};

describe('Listening part headings', () => {
  it('heads each part with the question numbers it carries', () => {
    const part1 = hub(practice(listeningPayload(1, undefined), 'lis-1'), 'listening');
    expect(part1).toContain('Questions 1–10');

    const part2 = hub(practice(listeningPayload(2, undefined), 'lis-2'), 'listening');
    expect(part2).toContain('Questions 11–20');
    expect(part2.includes('Questions 1–10')).toBe(false);

    const part4 = hub(practice(listeningPayload(4, undefined), 'lis-4'), 'listening');
    expect(part4).toContain('Questions 31–40');
  });

  it('uses the same numbering inside a full exam', () => {
    const part3 = practice(listeningPayload(3, undefined), 'lis-3').listening;
    if (!part3) throw new Error('fixture has no Listening part');
    const html = render(
      createElement(ListeningSession, {
        examMode: true,
        listeningData: part3,
        initialAnswers: {},
        submitted: false,
        onAnswersChange: noop,
        onSubmitAnswers: noop,
        audioStarted: {},
        onAudioStart: noop,
      }),
    );
    expect(html).toContain('Questions 21–30');
    expect(html.includes('Questions 1–10')).toBe(false);
  });

  it('reads the range from the numbers, not from how many questions there are', () => {
    expect(questionNumberRange([{ questionNumber: 14 }, { questionNumber: 11 }, { questionNumber: 20 }])).toEqual({ first: 11, last: 20 });
    expect(questionNumberRange([{ questionNumber: 7 }])).toEqual({ first: 7, last: 7 });
    expect(questionNumberRange([])).toBe(null);
  });
});

describe('the practice header', () => {
  it('shows an Academic material as Academic', () => {
    const html = hub(practice(readingPayload(1, 'academic'), 'rea-ac'));
    expect(html).toContain('data-module="academic">Academic<');
    expect(html.includes('Standard Academic')).toBe(false);
  });

  it('shows a General Training material as General Training, never as Academic', () => {
    const html = hub(practice(readingPayload(1, 'general'), 'rea-gt'));
    expect(html).toContain('data-module="general">General Training<');
    expect(html.includes('Standard Academic')).toBe(false);
  });
});

describe('Reading, by module', () => {
  it('describes Academic Reading as academic passages', () => {
    const test = practice(readingPayload(1, 'academic'), 'rea-ac');
    expect(hub(test)).toContain('Academic passages in the authentic computer-delivered format');
    expect(hub(test, 'reading')).toContain('Three academic passages');
  });

  it('describes General Training Reading as General Training, in practice and in an exam', () => {
    const test = practice(readingPayload(1, 'general'), 'rea-gt');
    const card = hub(test);
    expect(card).toContain('General Training texts in the authentic computer-delivered format');
    expect(card.includes('Academic passages')).toBe(false);

    const session = hub(test, 'reading');
    expect(session).toContain('Three General Training sections');
    expect(session.includes('academic passages')).toBe(false);

    if (!test.reading) throw new Error('fixture has no Reading passage');
    const exam = render(
      createElement(ReadingSession, {
        examMode: true,
        readingData: test.reading,
        module: 'general',
        initialAnswers: {},
        submitted: false,
        onAnswersChange: noop,
        onSubmitAnswers: noop,
      }),
    );
    expect(exam).toContain('Three General Training sections');
    expect(exam.includes('academic passages')).toBe(false);
  });
});

describe('Writing, by module', () => {
  it('calls Academic Task 1 a report and keeps its structure hint', () => {
    const html = hub(practice(writingPayload('academic', { task2: false }), 'wri-ac'), 'writing');
    expect(html).toContain('Task 1 · Report');
    expect(html.includes('Task 1 · Letter')).toBe(false);
    expect(html).toContain('Write or paste your response here.');
  });

  it('calls General Training Task 1 a letter, with a letter’s structure hint', () => {
    const html = hub(practice(writingPayload('general', { task2: false }), 'wri-gt'), 'writing');
    expect(html).toContain('Task 1 · Letter');
    expect(html.includes('Report')).toBe(false);
    expect(html).toContain('Write or paste your letter here.');
    expect(html.includes('trend')).toBe(false);
  });

  it('keeps Task 2 an essay in General Training, as in Academic', () => {
    const html = hub(practice(writingPayload('general'), 'wri-gt-both'), 'writing');
    // Both tasks are offered; practice opens on Task 2.
    expect(html).toContain('Task 1 · Letter');
    expect(html).toContain('Task 2 · Essay');
    expect(html).toContain('Write or paste your response here.');
  });

  it('labels General Training Task 1 a letter inside a full exam', () => {
    const test = practice(writingPayload('general'), 'wri-gt-exam');
    const html = render(
      createElement(WritingSession, {
        examMode: true,
        task1Data: test.writing.task1 ?? undefined,
        task2Data: test.writing.task2 ?? undefined,
        module: 'general',
        submit: () => Promise.reject(new Error('not submitted in a render test')),
        initialDrafts: {},
        gradedTasks: {},
        onRetryGrading: noop,
        onDraftChange: noop,
      }),
    );
    // An exam opens on Task 1.
    expect(html).toContain('Task 1 · Letter');
    expect(html.includes('Report')).toBe(false);
    expect(html).toContain('Write or paste your letter here.');
  });
});
