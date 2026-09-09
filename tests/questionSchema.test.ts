import { after, before, describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { expect } from './harness';
import {
  CANONICAL_QUESTION_TYPES,
  QUESTION_TYPE_ALIASES,
  QuestionSchema,
  answerMatchesOptions,
  canonicalQuestionType,
  isCanonicalQuestionType,
  normalizeAuthoredQuestion,
  normalizeAuthoredQuestions,
  optionLabel,
} from '../src/schemas/question';
import { migrateStoredMaterial, parseMaterialForWrite } from '../src/schemas/material';
import { MOCK_TEST_1 } from '../src/data/mockBank';
import type { Question } from '../src/types';

/**
 * The canonical question model.
 *
 * `questions: any[]` was the storage type for all four sections, which is why
 * nothing noticed that the editors wrote `questionText` while the learner read
 * `prompt`, or that an unrecognised task type was quietly turned into a gap
 * fill. These tests pin the replacement: one schema, one vocabulary, validation
 * at the write boundary, and legacy shapes converted in exactly one place.
 */

const valid = (over: Partial<Question> = {}): Record<string, unknown> => ({
  id: 'q-1',
  questionNumber: 1,
  type: 'fill_in_blank',
  prompt: 'Algae are grown in ___.',
  correctAnswer: 'ponds',
  ...over,
});

describe('canonical vocabulary', () => {
  it('has no duplicate spellings of the same concept', () => {
    // The four-way split (diagram_label_completion / diagram_label /
    // map_diagram_labelling / map_label) is what this replaces.
    expect(new Set(CANONICAL_QUESTION_TYPES).size).toBe(CANONICAL_QUESTION_TYPES.length);
    for (const alias of Object.keys(QUESTION_TYPE_ALIASES)) {
      // An alias must never also be canonical, or two names would both be legal.
      expect(isCanonicalQuestionType(alias)).toBe(false);
    }
    for (const target of Object.values(QUESTION_TYPE_ALIASES)) {
      expect(isCanonicalQuestionType(target)).toBe(true);
    }
  });

  it('resolves every spelling that exists in this codebase', () => {
    expect(canonicalQuestionType('diagram_label_completion')).toBe('diagram_label');
    expect(canonicalQuestionType('map_diagram_labelling')).toBe('map_label');
    expect(canonicalQuestionType('fill_in_the_blank')).toBe('fill_in_blank');
    expect(canonicalQuestionType('matching_options')).toBe('matching');
    expect(canonicalQuestionType('True-False-Not-Given')).toBe('true_false_not_given');
    expect(canonicalQuestionType('  MCQ ')).toBe('multiple_choice');
  });

  it('refuses to invent a type it does not recognise', () => {
    expect(canonicalQuestionType('interpretive_dance')).toBe(null);
    expect(canonicalQuestionType(undefined)).toBe(null);
    expect(canonicalQuestionType(7)).toBe(null);
  });

  it('reads an option by its printed label as well as its text', () => {
    expect(optionLabel('A. to give an example')).toBe('A');
    expect(optionLabel('ii. An old explanation')).toBe('ii');
    expect(optionLabel('no label here')).toBe('');
    // The built-in test answers multiple choices both ways, so both must match.
    expect(answerMatchesOptions('B', ['A. Land', 'B. Cost'])).toBe(true);
    expect(answerMatchesOptions('B. Cost', ['A. Land', 'B. Cost'])).toBe(true);
    expect(answerMatchesOptions('E', ['A. Land', 'B. Cost'])).toBe(false);
  });
});

describe('QuestionSchema: a valid question', () => {
  it('accepts the minimum a markable question needs', () => {
    const parsed = QuestionSchema.safeParse(valid());
    expect(parsed.success).toBe(true);
  });

  it('accepts every optional field the model defines', () => {
    const parsed = QuestionSchema.safeParse(
      valid({
        instruction: 'Questions 1–5\nComplete the notes below.',
        wordLimit: 'ONE WORD ONLY',
        acceptableAnswers: ['open ponds', 'a pond'],
        explanation: 'Paragraph B names the ponds.',
        layout: 'note_line',
        group: 'notes-1-5',
        mediaRef: { assetId: 'ast_abcdefghijklmnop', kind: 'image', alt: 'Site plan' },
      }),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.instruction).toContain('Complete the notes');
      expect(parsed.data.acceptableAnswers).toEqual(['open ponds', 'a pond']);
      expect(parsed.data.layout).toBe('note_line');
      expect(parsed.data.group).toBe('notes-1-5');
      expect(parsed.data.mediaRef?.assetId).toBe('ast_abcdefghijklmnop');
    }
  });

  it('accepts a list of acceptable spellings as the answer key', () => {
    const parsed = QuestionSchema.safeParse(valid({ correctAnswer: ['19', 'nineteen'] }));
    expect(parsed.success).toBe(true);
  });

  it('drops fields nothing renders instead of storing them', () => {
    // The generators emit paragraphLocation and targetSkill.
    const parsed = QuestionSchema.safeParse({
      ...valid(),
      paragraphLocation: 'Paragraph C',
      targetSkill: 'scanning',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.keys(parsed.data)).not.toContain('paragraphLocation');
      expect(Object.keys(parsed.data)).not.toContain('targetSkill');
    }
  });
});

describe('QuestionSchema: an invalid question', () => {
  const rejects = (over: Record<string, unknown>, expected: string) => {
    const parsed = QuestionSchema.safeParse({ ...valid(), ...over });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.message).join(' | ')).toContain(expected);
    }
  };

  it('requires a prompt, an id and an answer', () => {
    expect(QuestionSchema.safeParse({ ...valid(), prompt: '' }).success).toBe(false);
    expect(QuestionSchema.safeParse({ ...valid(), id: '' }).success).toBe(false);
    const noAnswer = { ...valid() } as Record<string, unknown>;
    delete noAnswer.correctAnswer;
    expect(QuestionSchema.safeParse(noAnswer).success).toBe(false);
  });

  it('requires a question number that could appear on a paper', () => {
    expect(QuestionSchema.safeParse({ ...valid(), questionNumber: 0 }).success).toBe(false);
    expect(QuestionSchema.safeParse({ ...valid(), questionNumber: 1.5 }).success).toBe(false);
    expect(QuestionSchema.safeParse({ ...valid(), questionNumber: '3' }).success).toBe(false);
    expect(QuestionSchema.safeParse({ ...valid(), questionNumber: 40 }).success).toBe(true);
  });

  it('rejects a type outside the canonical enum', () => {
    rejects({ type: 'diagram_label_completion' }, 'Invalid');
    rejects({ type: 'drag_and_drop' }, 'Invalid');
  });

  it('requires a choice to have something to choose from', () => {
    rejects({ type: 'multiple_choice', correctAnswer: 'A' }, 'needs at least two options');
    rejects(
      { type: 'matching_headings', correctAnswer: 'i', options: ['i. Only one'] },
      'needs at least two options',
    );
  });

  it('requires the answer to name one of the options', () => {
    rejects(
      { type: 'multiple_choice', options: ['A. Land', 'B. Cost'], correctAnswer: 'C. Water' },
      'is not one of the options',
    );
    // Matching by label is legitimate and must still pass.
    expect(
      QuestionSchema.safeParse(
        valid({ type: 'multiple_choice', options: ['A. Land', 'B. Cost'], correctAnswer: 'B' }),
      ).success,
    ).toBe(true);
  });

  it('keeps single choice and multi-select apart', () => {
    rejects(
      { type: 'multiple_choice', options: ['A. x', 'B. y'], correctAnswer: ['A', 'B'] },
      'exactly one answer',
    );
    rejects(
      { type: 'multi_select', options: ['A. x', 'B. y'], correctAnswer: 'A' },
      'at least two answers',
    );
    expect(
      QuestionSchema.safeParse(
        valid({ type: 'multi_select', options: ['A. x', 'B. y', 'C. z'], correctAnswer: ['A', 'C'] }),
      ).success,
    ).toBe(true);
  });

  it('allows only the three legal answers for TRUE/FALSE/NOT GIVEN', () => {
    for (const answer of ['TRUE', 'FALSE', 'NOT GIVEN']) {
      expect(
        QuestionSchema.safeParse(valid({ type: 'true_false_not_given', correctAnswer: answer }))
          .success,
      ).toBe(true);
    }
    rejects({ type: 'true_false_not_given', correctAnswer: 'MAYBE' }, 'allows only');
    rejects({ type: 'true_false_not_given', correctAnswer: 'YES' }, 'allows only');
    // YES/NO/NOT GIVEN is a different set, and they do not mix.
    rejects({ type: 'yes_no_not_given', correctAnswer: 'TRUE' }, 'allows only');
    expect(
      QuestionSchema.safeParse(valid({ type: 'yes_no_not_given', correctAnswer: 'NO' })).success,
    ).toBe(true);
  });

  it('rejects a malformed acceptableAnswers list', () => {
    expect(QuestionSchema.safeParse({ ...valid(), acceptableAnswers: 'ponds' }).success).toBe(false);
    expect(QuestionSchema.safeParse({ ...valid(), acceptableAnswers: [''] }).success).toBe(false);
    expect(QuestionSchema.safeParse({ ...valid(), acceptableAnswers: [7] }).success).toBe(false);
    rejects({ acceptableAnswers: ['ponds'] }, 'already appears in correctAnswer');
  });

  it('rejects a layout, group or media reference it does not understand', () => {
    expect(QuestionSchema.safeParse({ ...valid(), layout: 'freeform' }).success).toBe(false);
    expect(QuestionSchema.safeParse({ ...valid(), group: 'not a slug' }).success).toBe(false);
    expect(
      QuestionSchema.safeParse({ ...valid(), mediaRef: { assetId: 'nope', kind: 'image' } }).success,
    ).toBe(false);
    expect(
      QuestionSchema.safeParse({
        ...valid(),
        mediaRef: { assetId: 'ast_abcdefghijklmnop', kind: 'video' },
      }).success,
    ).toBe(false);
    rejects(
      {
        type: 'map_label',
        mediaRef: { assetId: 'ast_abcdefghijklmnop', kind: 'audio' },
      },
      'references an image',
    );
  });
});

describe('legacy migration', () => {
  it('reads the field names the old editors wrote', () => {
    const result = normalizeAuthoredQuestion(
      {
        id: 1,
        type: 'fill_in_the_blank',
        questionText: 'The gap is ___.',
        instructions: 'Write ONE WORD ONLY.',
        answer: 'algae',
        alternativeAnswers: ['alga'],
      },
      'fallback-id',
      3,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.question.prompt).toBe('The gap is ___.');
      expect(result.question.instruction).toBe('Write ONE WORD ONLY.');
      expect(result.question.type).toBe('fill_in_blank');
      expect(result.question.correctAnswer).toBe('algae');
      expect(result.question.acceptableAnswers).toEqual(['alga']);
      // A numeric editor id is a row counter, not an identifier.
      expect(result.question.id).toBe('fallback-id');
      expect(result.question.questionNumber).toBe(3);
    }
  });

  it('canonicalises the case of a TRUE/FALSE answer without inventing one', () => {
    const ok = normalizeAuthoredQuestion(
      { type: 'tfng', questionText: 'A claim.', correctAnswer: 'false' },
      'x',
      1,
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.question.correctAnswer).toBe('FALSE');

    // Anything outside the legal set is left as written, so the schema sees it.
    const bad = normalizeAuthoredQuestion(
      { type: 'tfng', questionText: 'A claim.', correctAnswer: 'probably' },
      'x',
      1,
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issue.reason).toBe('invalid');
  });

  it('reports rather than guesses when something is missing', () => {
    const noAnswer = normalizeAuthoredQuestion({ type: 'short_answer', prompt: 'How many?' }, 'x', 1);
    expect(noAnswer.ok).toBe(false);
    if (!noAnswer.ok) expect(noAnswer.issue.reason).toBe('missing_answer');

    const noPrompt = normalizeAuthoredQuestion({ type: 'short_answer', correctAnswer: '9' }, 'x', 1);
    expect(noPrompt.ok).toBe(false);
    if (!noPrompt.ok) expect(noPrompt.issue.reason).toBe('missing_prompt');

    // The behaviour this replaces: silently becoming a gap fill.
    const unknown = normalizeAuthoredQuestion(
      { type: 'drag_and_drop_matrix', prompt: 'Place them.', correctAnswer: 'A' },
      'x',
      1,
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.issue.reason).toBe('unknown_type');
      expect(unknown.issue.rawType).toBe('drag_and_drop_matrix');
    }
  });

  it('keeps the good questions when one of their siblings is broken', () => {
    const { questions, issues } = normalizeAuthoredQuestions(
      [
        { type: 'nonsense', questionText: 'bad', correctAnswer: 'x' },
        { type: 'true_false_not_given', questionText: 'good', correctAnswer: 'TRUE' },
      ],
      'p',
    );
    expect(questions).toHaveLength(1);
    expect(questions[0].prompt).toBe('good');
    expect(questions[0].questionNumber).toBe(2);
    expect(issues).toHaveLength(1);
    expect(issues[0].index).toBe(0);
  });

  it('migrates a stored material and flags what it cannot convert', () => {
    const { material, needsReview } = migrateStoredMaterial({
      id: 'adm-rea-legacy',
      section: 'reading',
      content: {
        passage: {
          passageNumber: 1,
          title: 'Legacy',
          text: 'Body.',
          questions: [
            { id: 1, type: 'true_false_not_given', questionText: 'Claim.', correctAnswer: 'FALSE' },
            { id: 2, type: 'mystery_task', questionText: 'Unknown.', correctAnswer: 'x' },
          ],
        },
      },
    });
    expect(material.content.passage.questions).toHaveLength(1);
    expect(material.content.passage.questions[0].prompt).toBe('Claim.');
    // Nothing is invented to fill the gap: the second question needs a human.
    expect(needsReview).toHaveLength(1);
    expect(needsReview[0].reason).toBe('unknown_type');
  });
});

describe('existing content is compatible', () => {
  it('validates every question in the built-in test', () => {
    const all = [
      ...MOCK_TEST_1.listening.parts.flatMap((p) => p.questions),
      ...MOCK_TEST_1.reading.passages.flatMap((p) => p.questions),
    ];
    expect(all.length).toBeGreaterThan(60);

    const rejected = all
      .map((question) => ({ question, parsed: QuestionSchema.safeParse(question) }))
      .filter((entry) => !entry.parsed.success)
      .map((entry) => `#${entry.question.questionNumber} ${entry.question.type}`);
    expect(rejected).toEqual([]);
  });
});

describe('parseMaterialForWrite', () => {
  const readingBody = (questions: unknown[]) => ({
    title: 'Schema Reading',
    section: 'reading',
    module: 'academic',
    status: 'published',
    content: { passage: { passageNumber: 1, title: 'P', text: 'Body.', questions } },
  });

  it('accepts a canonical material and returns canonical questions', () => {
    const result = parseMaterialForWrite('reading', readingBody([valid()]));
    expect(result.ok).toBe(true);
    if (result.ok && result.material.section === 'reading') {
      expect(result.material.content.passage.questions).toHaveLength(1);
      expect(result.material.content.passage.questions[0].prompt).toBe('Algae are grown in ___.');
    }
  });

  it('accepts a legacy material and converts it on the way in', () => {
    const result = parseMaterialForWrite(
      'reading',
      readingBody([{ id: 1, type: 'fill_in_the_blank', questionText: 'Gap ___.', correctAnswer: 'x' }]),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.material.section === 'reading') {
      expect(result.material.content.passage.questions[0].prompt).toBe('Gap ___.');
      expect(result.material.content.passage.questions[0].type).toBe('fill_in_blank');
    }
  });

  it('refuses a material whose question cannot be made canonical', () => {
    const result = parseMaterialForWrite(
      'reading',
      readingBody([{ type: 'mystery', prompt: 'x', correctAnswer: 'y' }]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join(' ')).toContain('unrecognised task type');
  });

  it('refuses a material with no title', () => {
    const body = readingBody([valid()]) as Record<string, any>;
    body.title = '';
    expect(parseMaterialForWrite('reading', body).ok).toBe(false);
  });

  it('validates the other three sections too', () => {
    expect(
      parseMaterialForWrite('listening', {
        title: 'L',
        section: 'listening',
        content: {
          section: { sectionNumber: 1, title: 'S', contextDescription: '', questions: [valid()] },
        },
      }).ok,
    ).toBe(true);

    expect(
      parseMaterialForWrite('speaking', {
        title: 'S',
        section: 'speaking',
        content: {
          speakingSession: {
            part1: { topic: 'Home', questions: ['Where do you live?'] },
            part2: { cueCardTopic: 'A place', bulletPoints: ['where it is'] },
            part3: { questions: ['Why do cities grow?'] },
          },
        },
      }).ok,
    ).toBe(true);

    expect(
      parseMaterialForWrite('writing', {
        title: 'W',
        section: 'writing',
        content: { task: { task1: { prompt: 'Describe the chart.' }, task2: { prompt: 'Agree?' } } },
      }).ok,
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Write boundary, over HTTP                                                   */
/* -------------------------------------------------------------------------- */

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-schema-'));
const originalCwd = process.cwd();
process.env.STORAGE_BACKEND = 'local';
process.env.NODE_ENV = 'test';
process.chdir(tempRoot);

const ADMIN_USER = 'schema_admin';
const ADMIN_PASSWORD = 'Str0ng-Passw0rd-For-Tests';
process.env.SEED_DEFAULT_ACCOUNTS = 'true';
process.env.ADMIN_USER = ADMIN_USER;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;

const express = (await import('express')).default;
const { adminRouter } = await import('../src/routes/adminRoutes');
const { adminStore } = await import('../src/services/adminStore');
const { bundleToAdaptedTest } = await import('../src/services/publishedTests');

let server: Server;
let origin = '';
let cookie = '';

async function admin(pathname: string, init: RequestInit = {}) {
  return fetch(`${origin}${pathname}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', cookie, ...(init.headers || {}) },
  });
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  const login = await admin('/api/admin/login', {
    method: 'POST',
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASSWORD }),
  });
  cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  expect(cookie).toContain('prep_admin_auth=');
});

after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  process.chdir(originalCwd);
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('the write boundary refuses what it cannot store', () => {
  const body = (questions: unknown[]) => ({
    title: 'Boundary Reading',
    section: 'reading',
    module: 'academic',
    status: 'published',
    content: { passage: { passageNumber: 1, title: 'P', text: 'Body.', questions } },
  });

  it('answers 400 and names the offending question', async () => {
    const response = await admin('/api/admin/materials', {
      method: 'POST',
      body: JSON.stringify(
        body([
          valid(),
          { type: 'multiple_choice', prompt: 'Which?', options: ['A. x', 'B. y'], correctAnswer: 'C' },
        ]),
      ),
    });
    expect(response.status).toBe(400);

    const payload = await response.json();
    expect(payload.error).toContain('failed validation');
    expect(payload.issues.join(' ')).toContain('Question 2');
    expect(payload.issues.join(' ')).toContain('not one of the options');
  });

  it('refuses a question with no answer key rather than storing it unmarkable', async () => {
    const response = await admin('/api/admin/materials', {
      method: 'POST',
      body: JSON.stringify(body([{ type: 'short_answer', prompt: 'How many?' }])),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).issues.join(' ')).toContain('cannot be marked');
  });

  it('stores nothing when validation fails', async () => {
    expect(await adminStore.listMaterials('reading')).toHaveLength(0);
  });

  it('round-trips a full material through storage to the learner', async () => {
    const saved = await admin('/api/admin/materials', {
      method: 'POST',
      body: JSON.stringify(
        body([
          {
            id: 'rt-1',
            questionNumber: 1,
            type: 'matching_headings',
            instruction: 'Questions 1–2\nChoose the correct heading.',
            prompt: 'Paragraph A',
            options: ['i. First heading', 'ii. Second heading', 'iii. Third heading'],
            correctAnswer: 'ii',
            explanation: 'Paragraph A introduces the second idea.',
            layout: 'standalone',
            group: 'headings-1-2',
          },
          {
            id: 'rt-2',
            questionNumber: 2,
            type: 'note_completion',
            prompt: 'Water was diverted to grow ___.',
            wordLimit: 'ONE WORD ONLY',
            correctAnswer: 'cotton',
            acceptableAnswers: ['cotton crops'],
            layout: 'note_line',
            group: 'notes-2',
            mediaRef: { assetId: 'ast_abcdefghijklmnop', kind: 'image', alt: 'Map' },
          },
        ]),
      ),
    });
    expect(saved.status).toBe(200);
    const material = (await saved.json()).item;

    const bundle = await (
      await admin('/api/admin/bundles', {
        method: 'POST',
        body: JSON.stringify({
          title: 'Schema CDI',
          status: 'published',
          materials: { readingId: material.id },
        }),
      })
    ).json();

    const resolved = await (await admin(`/api/admin/bundles/${bundle.bundle.id}`)).json();
    const adapted = bundleToAdaptedTest(resolved);
    const questions = adapted.test.reading.passages[0].questions;

    expect(adapted.issues.reading).toBeUndefined();
    expect(questions).toHaveLength(2);

    // Everything the model defines survives storage and adaptation.
    expect(questions[0].type).toBe('matching_headings');
    expect(questions[0].instruction).toContain('Choose the correct heading');
    expect(questions[0].options).toHaveLength(3);
    expect(questions[0].correctAnswer).toBe('ii');
    expect(questions[0].group).toBe('headings-1-2');

    expect(questions[1].type).toBe('note_completion');
    expect(questions[1].wordLimit).toBe('ONE WORD ONLY');
    expect(questions[1].acceptableAnswers).toEqual(['cotton crops']);
    expect(questions[1].layout).toBe('note_line');
    expect(questions[1].mediaRef?.assetId).toBe('ast_abcdefghijklmnop');
    expect(questions[1].mediaRef?.alt).toBe('Map');
  });

  it('reports a legacy material that still needs a human', async () => {
    // Written straight to disk, bypassing the write boundary, the way a row
    // saved by an older build looks.
    await adminStore.saveMaterial('listening', {
      title: 'Legacy Listening',
      section: 'listening',
      module: 'academic',
      status: 'draft',
      content: {
        section: {
          sectionNumber: 1,
          title: 'S',
          contextDescription: '',
          questions: [valid({ type: 'form_completion' })],
        },
      },
    });

    const items = (await (await admin('/api/admin/materials?section=listening')).json()).items;
    expect(items).toHaveLength(1);
    // A clean material carries no review flag.
    expect(items[0].needsReview).toBeUndefined();
  });

  it('flags a row written before the schema existed', async () => {
    // Rows like this exist on disk from older builds. They bypass the write
    // boundary entirely, so the read boundary is what has to notice them.
    const file = path.join(tempRoot, 'data', 'admin_content', 'writing.json');
    writeFileSync(
      file,
      JSON.stringify([
        {
          id: 'adm-wri-legacy',
          section: 'writing',
          title: 'Legacy Writing',
          module: 'academic',
          status: 'draft',
          content: { task: { task1: { prompt: 'Old task.' } } },
        },
      ]),
      'utf8',
    );

    // A writing material carries no questions, so nothing needs review.
    const writing = (await (await admin('/api/admin/materials?section=writing')).json()).items;
    expect(writing).toHaveLength(1);
    expect(writing[0].needsReview).toBeUndefined();

    const readingFile = path.join(tempRoot, 'data', 'admin_content', 'reading.json');
    writeFileSync(
      readingFile,
      JSON.stringify([
        {
          id: 'adm-rea-legacy',
          section: 'reading',
          title: 'Legacy Reading',
          module: 'academic',
          status: 'draft',
          content: {
            passage: {
              passageNumber: 1,
              title: 'Old',
              text: 'Body.',
              questions: [
                // Converts cleanly.
                { id: 1, type: 'fill_in_the_blank', questionText: 'Gap ___.', correctAnswer: 'x' },
                // Cannot: no answer key, so it is unmarkable.
                { id: 2, type: 'short_answer', questionText: 'How many?' },
                // Cannot: a task type nothing recognises.
                { id: 3, type: 'drag_and_drop', questionText: 'Place them.', correctAnswer: 'A' },
              ],
            },
          },
        },
      ]),
      'utf8',
    );

    const reading = (await (await admin('/api/admin/materials?section=reading')).json()).items;
    expect(reading).toHaveLength(1);
    // The convertible question is usable; the other two are named, not dropped
    // in silence and not repaired by guesswork.
    expect(reading[0].content.passage.questions).toHaveLength(1);
    expect(reading[0].content.passage.questions[0].prompt).toBe('Gap ___.');
    expect(reading[0].needsReview).toHaveLength(2);
    expect(reading[0].needsReview.join(' ')).toContain('cannot be marked');
    expect(reading[0].needsReview.join(' ')).toContain('unrecognised task type');
  });
});
