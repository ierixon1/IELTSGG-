import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect } from './harness';
import {
  QUESTION_CONTROLS,
  QuestionField,
  asAnswerList,
  controlFor,
  toggleAnswer,
} from '../src/components/common/QuestionField';
import { QuestionBlock, groupQuestions } from '../src/components/common/QuestionBlock';
import { CANONICAL_QUESTION_TYPES } from '../src/schemas/question';
import { checkQuestionAnswer } from '../src/utils/ieltsScoring';
import { MOCK_TEST_1 } from '../src/data/mockBank';
import type { AnswerValue, Question, QuestionType } from '../src/types';

/**
 * The learner question engine.
 *
 * `QuestionField` had three controls and a fallback: radios whenever options
 * existed, a dropdown for the bank types, and a text box for everything else.
 * That made `multi_select` unplayable (it rendered as single-choice radios), it
 * gave a map-labelling task no map, it flattened a table completion into a list
 * of loose boxes, and an unrecognised type became an anonymous text field.
 *
 * These tests render the real components and mark real answers.
 */

const question = (over: Partial<Question> = {}): Question => ({
  id: 'q1',
  questionNumber: 1,
  type: 'fill_in_blank',
  prompt: 'Algae are grown in ___.',
  correctAnswer: 'ponds',
  ...over,
});

/** Renders a control and hands back its markup. */
const render = (q: Question, value: AnswerValue = '', disabled = false) =>
  renderToStaticMarkup(
    createElement(QuestionField, { question: q, value, disabled, onChange: () => {}, groupName: 'sec' }),
  );

const renderBlock = (questions: Question[], answers: Record<string, AnswerValue> = {}) =>
  renderToStaticMarkup(
    createElement(QuestionBlock, {
      group: groupQuestions(questions)[0],
      answers,
      disabled: false,
      onChange: () => {},
      groupName: 'sec',
    }),
  );

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe('every canonical type has a control', () => {
  it('maps all 18 types, with none left to a fallback', () => {
    for (const type of CANONICAL_QUESTION_TYPES) {
      expect(QUESTION_CONTROLS[type]).toBeDefined();
    }
    expect(Object.keys(QUESTION_CONTROLS)).toHaveLength(CANONICAL_QUESTION_TYPES.length);
  });
});

describe('multiple choice', () => {
  const mcq = question({
    type: 'multiple_choice',
    prompt: 'What is the main obstacle?',
    options: ['A. Land', 'B. Cost', 'C. Water'],
    correctAnswer: 'B',
  });

  it('renders one radio per option', () => {
    const html = render(mcq);
    expect(count(html, 'type="radio"')).toBe(3);
    expect(count(html, 'type="checkbox"')).toBe(0);
    expect(html).toContain('role="radiogroup"');
  });

  it('stores the option label, which is how the key is written', () => {
    // The control used to store the full option text while the key was "B", so
    // picking the right answer scored wrong.
    expect(render(mcq)).toContain('value="B"');
    expect(render(mcq, 'B')).toContain('checked=""');
  });

  it('marks a pick by label and by full text', () => {
    expect(checkQuestionAnswer(mcq, 'B')).toBe(true);
    expect(checkQuestionAnswer(mcq, 'B. Cost')).toBe(true);
    expect(checkQuestionAnswer(mcq, 'A')).toBe(false);
    expect(checkQuestionAnswer(mcq, '')).toBe(false);
    expect(checkQuestionAnswer(mcq, undefined)).toBe(false);
  });

  it('marks a key written as full text against a label pick', () => {
    const byText = question({
      type: 'multiple_choice',
      options: ['A. Land', 'B. Cost'],
      correctAnswer: 'B. Cost',
    });
    expect(checkQuestionAnswer(byText, 'B')).toBe(true);
    expect(checkQuestionAnswer(byText, 'B. Cost')).toBe(true);
  });
});

describe('multi select', () => {
  const multi = question({
    type: 'multi_select',
    prompt: 'Which TWO are mentioned?',
    options: ['A. Cost', 'B. Land', 'C. Water', 'D. Law'],
    correctAnswer: ['A', 'C'],
  });

  it('renders checkboxes, not radios', () => {
    const html = render(multi);
    expect(count(html, 'type="checkbox"')).toBe(4);
    expect(count(html, 'type="radio"')).toBe(0);
    // The learner is told how many to pick.
    expect(html).toContain('Choose 2');
  });

  it('shows every stored choice as checked', () => {
    const html = render(multi, ['A', 'C']);
    expect(count(html, 'checked=""')).toBe(2);
  });

  it('accumulates choices instead of replacing them', () => {
    const options = multi.options!;
    let value: AnswerValue = '';
    value = toggleAnswer(value, 'A', options);
    expect(value).toEqual(['A']);
    value = toggleAnswer(value, 'C', options);
    // The whole point: a second pick does not overwrite the first.
    expect(value).toEqual(['A', 'C']);
    value = toggleAnswer(value, 'A', options);
    expect(value).toEqual(['C']);
  });

  it('keeps choices in the order the options are printed', () => {
    const options = multi.options!;
    const value = toggleAnswer(toggleAnswer('', 'C', options), 'A', options);
    expect(value).toEqual(['A', 'C']);
  });

  it('marks as a set: order-independent, complete, and nothing extra', () => {
    expect(checkQuestionAnswer(multi, ['A', 'C'])).toBe(true);
    expect(checkQuestionAnswer(multi, ['C', 'A'])).toBe(true);
    expect(checkQuestionAnswer(multi, ['A'])).toBe(false);
    expect(checkQuestionAnswer(multi, ['A', 'C', 'D'])).toBe(false);
    expect(checkQuestionAnswer(multi, ['A', 'B'])).toBe(false);
    expect(checkQuestionAnswer(multi, [])).toBe(false);
    // A duplicated click is not a second answer.
    expect(checkQuestionAnswer(multi, ['A', 'A'])).toBe(false);
  });
});

describe('true / false / not given', () => {
  const tfng = question({
    type: 'true_false_not_given',
    prompt: 'Microalgae need farmland.',
    options: ['TRUE', 'FALSE', 'NOT GIVEN'],
    correctAnswer: 'FALSE',
  });

  it('renders three radios', () => {
    const html = render(tfng);
    expect(count(html, 'type="radio"')).toBe(3);
    expect(html).toContain('NOT GIVEN');
  });

  it('marks case-insensitively but only against the real key', () => {
    expect(checkQuestionAnswer(tfng, 'FALSE')).toBe(true);
    expect(checkQuestionAnswer(tfng, 'false')).toBe(true);
    expect(checkQuestionAnswer(tfng, 'TRUE')).toBe(false);
    expect(checkQuestionAnswer(tfng, 'NOT GIVEN')).toBe(false);
  });
});

describe('fill in the blank', () => {
  const gap = question({ wordLimit: 'ONE WORD ONLY', correctAnswer: ['ponds', 'pond'] });

  it('renders a text box carrying its word limit', () => {
    const html = render(gap);
    expect(html).toContain('type="text"');
    expect(html).toContain('ONE WORD ONLY');
    expect(count(html, 'type="radio"')).toBe(0);
  });

  it('accepts any authored spelling', () => {
    expect(checkQuestionAnswer(gap, 'ponds')).toBe(true);
    expect(checkQuestionAnswer(gap, ' Pond ')).toBe(true);
    expect(checkQuestionAnswer(gap, 'lakes')).toBe(false);
  });

  it('shows what the learner typed', () => {
    expect(render(gap, 'ponds')).toContain('value="ponds"');
  });
});

describe('matching headings and sentence endings', () => {
  const headings = question({
    type: 'matching_headings',
    prompt: 'Paragraph A',
    options: ['i. A weakness', 'ii. An old explanation', 'iii. External references'],
    correctAnswer: 'ii',
  });
  const endings = question({
    type: 'matching_sentence_endings',
    prompt: 'The rivers were diverted so that',
    options: ['A. cotton could be grown.', 'B. fishing could expand.'],
    correctAnswer: 'A',
  });

  it('renders a dropdown holding every option', () => {
    const html = render(headings);
    expect(html).toContain('<select');
    expect(count(html, '<option')).toBe(4); // three headings plus the empty row
    expect(html).toContain('ii. An old explanation');
  });

  it('keeps the label as the stored value so the mapping is not lost', () => {
    const html = render(headings);
    expect(html).toContain('value="i"');
    expect(html).toContain('value="ii"');
    expect(html).toContain('value="iii"');
  });

  it('marks the chosen label', () => {
    expect(checkQuestionAnswer(headings, 'ii')).toBe(true);
    expect(checkQuestionAnswer(headings, 'i')).toBe(false);
    expect(checkQuestionAnswer(endings, 'A')).toBe(true);
    expect(checkQuestionAnswer(endings, 'B')).toBe(false);
  });

  it('renders a dropdown for every bank-answered type', () => {
    for (const type of [
      'matching',
      'matching_headings',
      'matching_information',
      'matching_features',
      'matching_sentence_endings',
    ] as QuestionType[]) {
      const html = render(question({ type, options: ['A. one', 'B. two'], correctAnswer: 'A' }));
      expect(html).toContain('<select');
    }
  });
});

describe('questions with media', () => {
  const map = question({
    type: 'map_label',
    prompt: 'The library is at ___.',
    correctAnswer: 'north gate',
    mediaRef: { assetId: 'ast_abcdefghijklmnop', kind: 'image', alt: 'Campus plan' },
  });

  it('keeps its canonical type rather than degrading to a gap fill', () => {
    expect(controlFor(map)).toBe('text');
    expect(map.type).toBe('map_label');
  });

  it('renders the image from the asset route, not a hardcoded path', () => {
    const html = renderBlock([map]);
    expect(html).toContain('src="/api/assets/ast_abcdefghijklmnop"');
    expect(html).toContain('alt="Campus plan"');
    // The learner route is the only one a signed-in learner can read.
    expect(html).not.toContain('/api/admin/assets/');
    expect(html).not.toContain('/api/uploads/');
  });

  it('renders a diagram label the same way', () => {
    const diagram = question({
      type: 'diagram_label',
      correctAnswer: 'piston',
      mediaRef: { assetId: 'ast_zyxwvutsrqponm', kind: 'image' },
    });
    const html = renderBlock([diagram]);
    expect(html).toContain('src="/api/assets/ast_zyxwvutsrqponm"');
    expect(html).toContain('type="text"');
  });

  it('renders an audio reference as a player', () => {
    const withAudio = question({
      mediaRef: { assetId: 'ast_aaaaaaaaaaaaaa1', kind: 'audio', alt: 'Section 1' },
    });
    const html = renderBlock([withAudio]);
    expect(html).toContain('<audio');
    expect(html).toContain('src="/api/assets/ast_aaaaaaaaaaaaaa1"');
  });
});

describe('grouping and layout', () => {
  const tableRows = [
    question({ id: 't1', questionNumber: 6, type: 'table_completion', prompt: 'Accommodation', correctAnswer: 'lodge', layout: 'table_row', group: 'prefs' }),
    question({ id: 't2', questionNumber: 7, type: 'table_completion', prompt: 'Food', correctAnswer: 'seafood', layout: 'table_row', group: 'prefs' }),
  ];

  it('joins consecutive questions that share a group', () => {
    const groups = groupQuestions(tableRows);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('prefs');
    expect(groups[0].questions).toHaveLength(2);
  });

  it('does not merge a group key reused later in the paper', () => {
    // Merging them would reorder the paper.
    const groups = groupQuestions([
      tableRows[0],
      question({ id: 'x', questionNumber: 8, correctAnswer: 'a' }),
      tableRows[1],
    ]);
    expect(groups).toHaveLength(3);
  });

  it('leaves an ungrouped question standing alone', () => {
    const groups = groupQuestions([question({ id: 'a' }), question({ id: 'b', questionNumber: 2 })]);
    expect(groups).toHaveLength(2);
    expect(groups[0].key).toBe('a');
  });

  it('renders a table completion as a table, not a flat list', () => {
    const html = renderBlock(tableRows);
    expect(html).toContain('<table');
    expect(count(html, '<tr')).toBe(2);
    expect(count(html, 'type="text"')).toBe(2);
    // Each row keeps its own number and its own control.
    expect(html).toContain('>6<');
    expect(html).toContain('>7<');
  });

  it('renders note and form completion as labelled lines', () => {
    for (const layout of ['note_line', 'form_row'] as const) {
      const html = renderBlock([
        question({ id: 'n1', questionNumber: 1, type: 'note_completion', prompt: 'Name:', correctAnswer: 'Helen', layout, group: 'notes' }),
        question({ id: 'n2', questionNumber: 2, type: 'note_completion', prompt: 'Email:', correctAnswer: 'helen@x', layout, group: 'notes' }),
      ]);
      expect(html).toContain('<dl');
      expect(count(html, '<dt')).toBe(2);
      expect(count(html, 'type="text"')).toBe(2);
    }
  });

  it('renders a summary gap inline with its sentence', () => {
    const html = renderBlock([
      question({ id: 's1', questionNumber: 3, type: 'summary_completion', prompt: 'The water was lost into', correctAnswer: 'sand', layout: 'summary_gap', group: 'summary' }),
    ]);
    expect(html).toContain('The water was lost into');
    expect(html).toContain('type="text"');
    expect(html).not.toContain('<table');
  });

  it('keeps answers and marking independent inside a block', () => {
    const answers: Record<string, AnswerValue> = { t1: 'lodge', t2: 'wrong' };
    const html = renderBlock(tableRows, answers);
    expect(html).toContain('value="lodge"');
    expect(html).toContain('value="wrong"');
    expect(checkQuestionAnswer(tableRows[0], answers.t1)).toBe(true);
    expect(checkQuestionAnswer(tableRows[1], answers.t2)).toBe(false);
  });

  it('shows a group rubric once, not once per row', () => {
    const html = renderBlock([
      { ...tableRows[0], instruction: 'Questions 6–7\nComplete the table.' },
      tableRows[1],
    ]);
    expect(count(html, 'Complete the table.')).toBe(1);
  });
});

describe('an unsupported question type', () => {
  // Reaching the player means it bypassed the schema, which refuses to store
  // one. The renderer still has to say so rather than invent a control.
  const alien = { ...question(), type: 'drag_and_drop_matrix' as unknown as QuestionType };

  it('has no control', () => {
    expect(controlFor(alien)).toBe(null);
  });

  it('renders a needs-review state instead of a text box', () => {
    const html = render(alien);
    expect(html).toContain('not supported yet');
    expect(html).toContain('needs review');
    expect(html).toContain('data-unsupported-question="drag_and_drop_matrix"');
    // The behaviour this replaces: quietly becoming an anonymous gap fill.
    expect(html).not.toContain('type="text"');
    expect(html).not.toContain('type="radio"');
  });

  it('treats a choice with no options the same way', () => {
    const noOptions = question({ type: 'multiple_choice', correctAnswer: 'A' });
    expect(controlFor(noOptions)).toBe(null);
    expect(render(noOptions)).toContain('not supported yet');
  });
});

describe('the built-in test still works', () => {
  const all = [
    ...MOCK_TEST_1.listening.parts.flatMap((p) => p.questions),
    ...MOCK_TEST_1.reading.passages.flatMap((p) => p.questions),
  ];

  it('renders a control for every question', () => {
    const unsupported = all.filter((q) => controlFor(q) === null);
    expect(unsupported).toEqual([]);
  });

  it('can be answered correctly through its own controls', () => {
    // Two multiple choices are keyed by option label while the radio stored the
    // full option text, so they could not be answered correctly at all.
    const unanswerable: string[] = [];
    for (const q of all) {
      const key = ([] as string[]).concat(q.correctAnswer as string | string[]);
      const control = controlFor(q);
      let entered: AnswerValue;
      if (control === 'radio' || control === 'bank' || control === 'checkbox') {
        entered = control === 'checkbox' ? key : key[0];
      } else {
        entered = key[0];
      }
      if (!checkQuestionAnswer(q, entered)) unanswerable.push(`#${q.questionNumber} ${q.type}`);
    }
    expect(unanswerable).toEqual([]);
  });

  it('leaves an unanswered question unmarked', () => {
    expect(all.filter((q) => checkQuestionAnswer(q, undefined))).toEqual([]);
  });
});

describe('answer plumbing', () => {
  it('reads a single answer and a list the same way', () => {
    expect(asAnswerList('A')).toEqual(['A']);
    expect(asAnswerList(['A', 'B'])).toEqual(['A', 'B']);
    expect(asAnswerList('')).toEqual([]);
    expect(asAnswerList(undefined)).toEqual([]);
  });

  it('does not lose acceptableAnswers, which phase 12 will use', () => {
    const q = question({ acceptableAnswers: ['a pond'] });
    expect(q.acceptableAnswers).toEqual(['a pond']);
    // Not consulted yet — widening answer matching is phase 12's work.
    expect(checkQuestionAnswer(q, 'a pond')).toBe(false);
    expect(checkQuestionAnswer(q, 'ponds')).toBe(true);
  });
});
