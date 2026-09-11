import { describe, it } from 'node:test';
import { expect } from './harness';
import {
  canonicalQuestionType,
  describeQuestionIssue,
  isCanonicalQuestionType,
  normalizeAuthoredQuestions,
} from '../src/schemas/question';
import { sittingToAdaptedTest, sectionAvailable } from '../src/services/publishedTests';
import { MOCK_TEST_1 } from '../src/data/mockBank';
import type { ExamSitting, SittingComponent } from '../src/types/bundle';

/**
 * The adapter layer, exercised directly.
 *
 * Every defect these cover shipped at some point: questions arriving with an
 * empty prompt because the editor wrote `questionText`, unknown task types
 * becoming gap fills, answer variants dropped, and a resolved bundle read under
 * the wrong field name so selecting a published test did nothing at all.
 */

/** A sitting as the learner route resolves it: exactly the pinned components, nothing else. */
const sitting = (components: Array<Omit<SittingComponent, 'contentHash'>>): ExamSitting => ({
  bundle: {
    id: 'cdi-test',
    title: 'Adapter Bundle',
    module: 'academic',
    publishedAt: '2026-01-01T00:00:00.000Z',
    timing: { listeningMinutes: 30, readingMinutes: 60, writingMinutes: 60, speakingMinutes: 14, basis: 'custom', allowEarlyFinish: true },
  },
  components: components.map((component) => ({ ...component, contentHash: 'a'.repeat(64) })),
});

const listeningMaterial = (id: string, part: number, title: string): any => ({
  id,
  title,
  section: 'listening',
  module: 'academic',
  status: 'published',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  content: {
    audioAssetId: `ast_${id.replace(/[^A-Za-z0-9]/g, '')}0000000`,
    audioUrl: `/api/assets/ast_${id}`,
    section: {
      sectionNumber: part,
      title,
      contextDescription: 'A call.',
      questions: [{ type: 'short_answer', prompt: `Question for ${title}`, correctAnswer: 'seven' }],
    },
  },
});

const readingMaterial = (questions: unknown[]): any => ({
  id: 'adm-rea-1',
  title: 'Adapter Reading',
  section: 'reading',
  module: 'academic',
  status: 'published',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  content: {
    passage: { passageNumber: 2, title: 'Algae', text: 'Body text.', questions },
  },
});

describe('canonical question types', () => {
  it('accepts the engine vocabulary unchanged', () => {
    expect(canonicalQuestionType('multiple_choice')).toBe('multiple_choice');
    expect(canonicalQuestionType('matching_sentence_endings')).toBe('matching_sentence_endings');
    expect(isCanonicalQuestionType('map_label')).toBeTruthy();
  });

  it('resolves the spellings that diverged across taxonomy, generator and editors', () => {
    // Four names existed for two concepts; all four now resolve.
    expect(canonicalQuestionType('diagram_label_completion')).toBe('diagram_label');
    expect(canonicalQuestionType('diagram_label')).toBe('diagram_label');
    expect(canonicalQuestionType('map_diagram_labelling')).toBe('map_label');
    expect(canonicalQuestionType('map_label')).toBe('map_label');
    // The reading editor's own spelling.
    expect(canonicalQuestionType('fill_in_the_blank')).toBe('fill_in_blank');
    // Casing and separators are incidental.
    expect(canonicalQuestionType('True-False-Not-Given')).toBe('true_false_not_given');
    expect(canonicalQuestionType(' MATCHING_OPTIONS ')).toBe('matching');
  });

  it('reports a genuinely unknown type rather than inventing one', () => {
    expect(canonicalQuestionType('interpretive_dance')).toBe(null);
    expect(canonicalQuestionType(undefined)).toBe(null);
    expect(canonicalQuestionType(42)).toBe(null);
  });
});

describe('normalizeAuthoredQuestions', () => {
  it('reads the canonical field names', () => {
    const { questions, issues } = normalizeAuthoredQuestions(
      [
        {
          id: 'q1',
          questionNumber: 7,
          type: 'multiple_choice',
          instruction: 'Choose the correct letter.',
          prompt: 'What is the main obstacle?',
          options: ['A. Cost', 'B. Land'],
          wordLimit: 'NO MORE THAN TWO WORDS',
          correctAnswer: 'A. Cost',
          acceptableAnswers: ['cost'],
          explanation: 'Paragraph C.',
        },
      ],
      'p',
    );

    expect(issues).toHaveLength(0);
    expect(questions).toHaveLength(1);
    expect(questions[0].id).toBe('q1');
    expect(questions[0].questionNumber).toBe(7);
    expect(questions[0].prompt).toBe('What is the main obstacle?');
    expect(questions[0].instruction).toBe('Choose the correct letter.');
    expect(questions[0].wordLimit).toBe('NO MORE THAN TWO WORDS');
    expect(questions[0].acceptableAnswers).toEqual(['cost']);
    expect(questions[0].explanation).toBe('Paragraph C.');
  });

  it('still reads material saved by the old editors', () => {
    // `questionText` and `instructions` are what every stored material carries.
    const { questions, issues } = normalizeAuthoredQuestions(
      [
        {
          id: 1,
          type: 'fill_in_the_blank',
          questionText: 'The gap is ___.',
          instructions: 'Write ONE WORD ONLY.',
          correctAnswer: 'algae',
        },
      ],
      'legacy',
    );

    expect(issues).toHaveLength(0);
    expect(questions[0].prompt).toBe('The gap is ___.');
    expect(questions[0].instruction).toBe('Write ONE WORD ONLY.');
    expect(questions[0].type).toBe('fill_in_blank');
    // A numeric id is not a usable question id, so one is derived.
    expect(questions[0].id).toBe('legacy-q1');
  });

  it('keeps an array answer key intact', () => {
    const { questions } = normalizeAuthoredQuestions(
      [{ type: 'short_answer', prompt: 'How many?', correctAnswer: ['19', 'nineteen'] }],
      'p',
    );
    expect(questions[0].correctAnswer).toEqual(['19', 'nineteen']);
  });

  it('reports, and does not ship, a question with no answer key', () => {
    const { questions, issues } = normalizeAuthoredQuestions(
      [{ type: 'short_answer', prompt: 'Unmarkable.' }],
      'p',
    );
    expect(questions).toHaveLength(0);
    expect(issues).toHaveLength(1);
    expect(issues[0].reason).toBe('missing_answer');
    expect(describeQuestionIssue(issues[0])).toContain('cannot be marked');
  });

  it('reports, and does not coerce, an unknown task type', () => {
    const { questions, issues } = normalizeAuthoredQuestions(
      [{ type: 'drag_and_drop_matrix', prompt: 'Place the labels.', correctAnswer: 'A' }],
      'p',
    );
    // Silently becoming `fill_in_blank` is what used to happen, and it turned a
    // drag-and-drop task into a bare text box with no sign anything was wrong.
    expect(questions).toHaveLength(0);
    expect(issues[0].reason).toBe('unknown_type');
    expect(issues[0].rawType).toBe('drag_and_drop_matrix');
  });

  it('reports a question with no text at all', () => {
    const { questions, issues } = normalizeAuthoredQuestions(
      [{ type: 'multiple_choice', correctAnswer: 'A' }],
      'p',
    );
    expect(questions).toHaveLength(0);
    expect(issues[0].reason).toBe('missing_prompt');
  });

  it('keeps good questions when a sibling is broken, and numbers them by position', () => {
    const { questions, issues } = normalizeAuthoredQuestions(
      [
        { type: 'nonsense', prompt: 'bad', correctAnswer: 'x' },
        { type: 'true_false_not_given', prompt: 'good', correctAnswer: 'TRUE' },
      ],
      'p',
    );
    expect(questions).toHaveLength(1);
    expect(questions[0].prompt).toBe('good');
    expect(questions[0].questionNumber).toBe(2);
    expect(issues).toHaveLength(1);
    expect(issues[0].index).toBe(0);
  });

  it('treats a non-array as no questions rather than throwing', () => {
    expect(normalizeAuthoredQuestions(undefined, 'p').questions).toHaveLength(0);
    expect(normalizeAuthoredQuestions('nope', 'p').questions).toHaveLength(0);
  });
});

describe('sittingToAdaptedTest', () => {
  it('adapts exactly the components the sitting carries, at the parts they were pinned to', () => {
    const adapted = sittingToAdaptedTest(
      sitting([
        {
          section: 'reading',
          part: 2,
          materialId: 'adm-rea-1',
          material: readingMaterial([{ type: 'true_false_not_given', prompt: 'Claim one.', correctAnswer: 'FALSE' }]),
        },
      ]),
    );

    expect(adapted.test.id).toBe('cdi-test');
    expect(adapted.test.title).toBe('Adapter Bundle');
    const passages = adapted.test.reading?.passages ?? [];
    expect(passages).toHaveLength(1);
    expect(passages[0].title).toBe('Algae');
    expect(passages[0].passageNumber).toBe(2);
    expect(passages[0].questions[0].prompt).toBe('Claim one.');
  });

  it('never hands the learner a question with an empty prompt', () => {
    const adapted = sittingToAdaptedTest(
      sitting([
        {
          section: 'reading',
          part: 1,
          materialId: 'adm-rea-1',
          material: readingMaterial([
            { id: 1, type: 'multiple_choice', questionText: 'Legacy text', options: ['A', 'B'], correctAnswer: 'A' },
            { id: 2, type: 'fill_in_the_blank', prompt: 'Canonical text', correctAnswer: 'x' },
          ]),
        },
      ]),
    );

    const questions = adapted.test.reading?.passages[0].questions ?? [];
    expect(questions).toHaveLength(2);
    expect(questions.filter((q) => !q.prompt)).toHaveLength(0);
  });

  it('reports every section it cannot supply, and substitutes nothing', () => {
    const adapted = sittingToAdaptedTest(
      sitting([
        {
          section: 'reading',
          part: 1,
          materialId: 'adm-rea-1',
          material: readingMaterial([{ type: 'true_false_not_given', prompt: 'Claim.', correctAnswer: 'TRUE' }]),
        },
      ]),
    );

    expect(adapted.missingSections).toEqual(['listening', 'writing', 'speaking']);
    // The screen refuses a missing section instead of seating the learner in
    // front of the built-in paper under this bundle's title.
    expect(adapted.test.listening).toBe(null);
    expect(sectionAvailable(adapted.test, 'listening')).toBe(false);
    expect(sectionAvailable(adapted.test, 'reading')).toBe(true);
  });

  it('orders Listening parts by part, each from its own material, with its recording', () => {
    const adapted = sittingToAdaptedTest(
      sitting([
        { section: 'listening', part: 2, materialId: 'adm-lis-2', material: listeningMaterial('adm-lis-2', 2, 'Second') },
        { section: 'listening', part: 1, materialId: 'adm-lis-1', material: listeningMaterial('adm-lis-1', 1, 'First') },
      ]),
    );

    const parts = adapted.test.listening?.parts ?? [];
    expect(parts.map((part) => [part.partNumber, part.title])).toEqual([
      [1, 'First'],
      [2, 'Second'],
    ]);
    expect(parts[0].audioUrl).toBe('/api/assets/ast_adm-lis-1');
    expect(parts[1].questions[0].prompt).toBe('Question for Second');
  });

  it('surfaces question issues per skill', () => {
    const adapted = sittingToAdaptedTest(
      sitting([
        { section: 'reading', part: 1, materialId: 'adm-rea-1', material: readingMaterial([{ type: 'mystery', prompt: 'x', correctAnswer: 'y' }]) },
      ]),
    );

    expect(adapted.issues.reading).toHaveLength(1);
    expect(adapted.issues.reading![0].reason).toBe('unknown_type');
  });

  it('adapts writing task 1 and task 2 separately', () => {
    const adapted = sittingToAdaptedTest(
      sitting([
        {
          section: 'writing',
          part: 1,
          materialId: 'adm-wri-1',
          material: {
            id: 'adm-wri-1',
            title: 'Adapter Writing',
            section: 'writing',
            module: 'academic',
            status: 'published',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            content: {
              task: {
                task1: { prompt: 'Describe the chart.', minimumWords: 150 },
                task2: { prompt: 'To what extent do you agree?', minimumWords: 250 },
              },
            },
          } as any,
        },
      ]),
    );

    // Both tasks used to receive the same adapted object, so Task 2 showed the
    // Task 1 prompt.
    expect(adapted.test.writing.task1?.prompt).toBe('Describe the chart.');
    expect(adapted.test.writing.task2?.prompt).toBe('To what extent do you agree?');
    expect(adapted.test.writing.task1?.minWordCount).toBe(150);
    expect(adapted.test.writing.task2?.minWordCount).toBe(250);
  });
});
