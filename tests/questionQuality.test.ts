import './env';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';
import type { SourceChunk, StoredSource } from '../src/types/source';
import type { GenerationModel, ModelRequest } from '../src/services/bookToTest/model';
import type { ValidatedQuestion } from '../src/services/bookToTest/validate';
import type { GeneratableType } from '../src/services/bookToTest/types';

/**
 * IELTS question quality, judged separately from source grounding.
 *
 * The first half drives the validator directly over a small, controlled passage
 * about bees, where every expectation can be checked by reading three short
 * paragraphs. Each case is one a real model produces: two options the text
 * supports equally, a FALSE with a real contradiction and a FALSE without one,
 * a NOT GIVEN that is provable and one that is not, a completion with four
 * equally good answers, headings that fit two sections.
 *
 * The second half is the one promotion path — a person confirming a flagged
 * question — driven through the real routes, store and publish gate.
 */
const originalCwd = process.cwd();
const FIXTURES = path.join(originalCwd, 'tests', 'fixtures', 'sources');
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-quality-'));
process.chdir(tempRoot);

const ADMIN_USER = 'quality_admin';
const ADMIN_PASSWORD = 'Str0ng-Passw0rd-For-Quality';
process.env.SEED_DEFAULT_ACCOUNTS = 'true';
process.env.ADMIN_USER = ADMIN_USER;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;

const express = (await import('express')).default;
const { adminRouter } = await import('../src/routes/adminRoutes');
const { ingestSource } = await import('../src/services/sourceIngest/ingest');
const { adminStore } = await import('../src/services/adminStore');
const { setGenerationModel } = await import('../src/services/bookToTest/model');
const { validateGeneratedQuestions } = await import('../src/services/bookToTest/validate');
const { buildPassage } = await import('../src/services/bookToTest/passage');
const { questionContentHash } = await import('../src/services/bookToTest/questionHash');

/* -------------------------------------------------------------------------- */
/* A controlled passage                                                        */
/* -------------------------------------------------------------------------- */

const chunk = (id: string, heading: string, text: string, ordinal: number): SourceChunk => ({
  id,
  sourceId: 'src-quality',
  ordinal,
  heading,
  level: 2,
  location: { chapter: 'Bees', section: heading, path: ['Bees', heading], charStart: 0, charEnd: text.length },
  text,
  wordCount: text.split(/\s+/).length,
  extractorVersion: 'test',
  chunkerVersion: 'test',
  contentHash: 'a'.repeat(64),
});

const NAV = chunk(
  'src-quality-c00000',
  'Honey bee navigation',
  'Honey bees communicate the location of food through a waggle dance. The angle of the dance indicates the direction of the food relative to the sun. The dance lasts longer when the food is further away. Young bees do not perform the waggle dance until they are about three weeks old.',
  0,
);
const TEMP = chunk(
  'src-quality-c00001',
  'Colony temperature',
  'A colony keeps its brood nest at about 35 degrees. Worker bees cool the nest by fanning their wings near the entrance. In cold weather the bees cluster together and shiver to generate heat. Drones take no part in regulating temperature. Workers collect nectar, pollen, water and resin for the colony.',
  1,
);
const FARM = chunk(
  'src-quality-c00002',
  'Pollination and farming',
  'Almond growers in California rent millions of hives every spring. Without bees, the almond crop would fail. Wild pollinators, such as solitary bees, are also important, but farmers rarely depend on them alone.',
  2,
);

const cite = (source: SourceChunk, quote: string) => [{ chunkId: source.id, quote }];

function judge(type: GeneratableType, questions: unknown[], picked: SourceChunk[] = [NAV, TEMP, FARM]): ValidatedQuestion[] {
  const passage = buildPassage(picked, { showHeadings: type !== 'matching_headings' });
  return validateGeneratedQuestions(questions, {
    questionType: type,
    requestedCount: questions.length,
    chunks: picked,
    sections: passage.sections,
    generationId: 'gen-quality',
    promptVersion: 'reading-grounded/2.0.0',
    generatedAt: '2026-01-01T00:00:00.000Z',
    model: 'fixture',
    sourceId: 'src-quality',
  });
}

const codes = (result: ValidatedQuestion) =>
  [...result.groundingVerdict.reasons, ...result.qualityVerdict.reasons].map((reason) => reason.code);

/* -------------------------------------------------------------------------- */
/* Multiple choice                                                             */
/* -------------------------------------------------------------------------- */

describe('multiple choice', () => {
  it('is valid with one correct answer and distractors the source does not state', () => {
    const [result] = judge('multiple_choice', [
      {
        type: 'multiple_choice',
        prompt: 'According to the passage, what does the angle of the waggle dance show?',
        options: ['A. The distance to the food', 'B. The direction of the food', 'C. The age of the bee', 'D. The temperature of the nest'],
        correctAnswer: 'B',
        questionEvidence: cite(NAV, 'The angle of the dance indicates the direction of the food relative to the sun.'),
        answerEvidence: cite(NAV, 'The angle of the dance indicates the direction of the food relative to the sun.'),
        distractorEvidence: [{ option: 'A', reason: 'Distance is shown by how long the dance lasts, not its angle.' }],
      },
    ]);

    expect(result.status).toBe('valid');
    expect(result.groundingVerdict.status).toBe('valid');
    expect(result.qualityVerdict.status).toBe('valid');
    expect(codes(result)).toHaveLength(0);
    // The three kinds of evidence are kept apart, and the model's distractor
    // account is recorded without being relied on.
    expect(result.question?.provenance?.answerEvidence?.[0].quote).toContain('direction of the food');
    expect(result.question?.provenance?.distractorEvidence?.[0].option).toBe('A');
    expect(result.question?.provenance?.groundingStatus).toBe('valid');
    expect(result.question?.provenance?.qualityStatus).toBe('valid');
  });

  it('needs review when the source states two options equally directly', () => {
    const [result] = judge('multiple_choice', [
      {
        type: 'multiple_choice',
        prompt: 'What do worker bees do to control the nest temperature?',
        options: [
          'A. Fanning their wings near the entrance',
          'B. They cluster together and shiver',
          'C. Leaving the hive',
          'D. Renting new hives',
        ],
        correctAnswer: 'A',
        questionEvidence: cite(TEMP, 'Worker bees cool the nest by fanning their wings near the entrance.'),
        answerEvidence: cite(TEMP, 'Worker bees cool the nest by fanning their wings near the entrance.'),
      },
    ]);

    expect(result.status).toBe('needs_review');
    // Grounded: the keyed option really is in the source. Not a sound question.
    expect(result.groundingVerdict.status).toBe('valid');
    expect(codes(result)).toContain('multiple_correct_options');
    // Never corrected: the key is still the model's.
    expect(result.question?.correctAnswer).toBe('A');
  });

  it('needs review when a distractor is stated as true and the key is not', () => {
    const [result] = judge('multiple_choice', [
      {
        type: 'multiple_choice',
        prompt: 'Why do almond growers rent hives?',
        options: [
          'A. Without bees, the almond crop would fail',
          'B. Solitary bees are cheaper to rent',
          'C. Wild pollinators are never important',
          'D. California bans other pollinators',
        ],
        correctAnswer: 'B',
        questionEvidence: cite(FARM, 'Almond growers in California rent millions of hives every spring.'),
        answerEvidence: cite(FARM, 'Wild pollinators, such as solitary bees, are also important, but farmers rarely depend on them alone.'),
      },
    ]);

    expect(result.status).toBe('needs_review');
    expect(codes(result)).toContain('distractor_also_supported');
    expect(result.question?.correctAnswer).toBe('B');
  });

  it('does not count an option the source negates as supported', () => {
    const [result] = judge('multiple_choice', [
      {
        type: 'multiple_choice',
        prompt: 'Why do almond growers rent hives?',
        options: [
          'A. Without bees, the almond crop would fail',
          'B. Wild pollinators are never important',
          'C. Hives are required by law',
        ],
        correctAnswer: 'A',
        questionEvidence: cite(FARM, 'Almond growers in California rent millions of hives every spring.'),
        answerEvidence: cite(FARM, 'Without bees, the almond crop would fail.'),
      },
    ]);

    expect(codes(result).includes('distractor_also_supported')).toBe(false);
    expect(codes(result).includes('multiple_correct_options')).toBe(false);
  });

  it('flags a question that repeats its own correct option', () => {
    const [result] = judge('multiple_choice', [
      {
        type: 'multiple_choice',
        prompt: 'What does the angle of the dance indicate about the direction of the food?',
        options: ['A. The direction of the food', 'B. The age of the bee', 'C. The size of the colony'],
        correctAnswer: 'A',
        questionEvidence: cite(NAV, 'The angle of the dance indicates the direction of the food relative to the sun.'),
        answerEvidence: cite(NAV, 'The angle of the dance indicates the direction of the food relative to the sun.'),
      },
    ]);

    expect(result.groundingVerdict.status).toBe('valid');
    expect(codes(result)).toContain('option_leaked_in_prompt');
  });

  it('flags near-duplicate options and refuses identical ones', () => {
    const [near] = judge('multiple_choice', [
      {
        type: 'multiple_choice',
        prompt: 'What does the angle of the waggle dance show?',
        options: ['A. The direction of the food', 'B. The food direction', 'C. The age of the bee'],
        correctAnswer: 'A',
        questionEvidence: cite(NAV, 'The angle of the dance indicates the direction of the food relative to the sun.'),
        answerEvidence: cite(NAV, 'The angle of the dance indicates the direction of the food relative to the sun.'),
      },
    ]);
    expect(codes(near)).toContain('near_duplicate_options');

    const [same] = judge('multiple_choice', [
      {
        type: 'multiple_choice',
        prompt: 'What does the angle of the waggle dance show?',
        options: ['A. The direction of the food', 'B. the direction  of the food', 'C. The age of the bee'],
        correctAnswer: 'A',
        questionEvidence: cite(NAV, 'The angle of the dance indicates the direction of the food relative to the sun.'),
        answerEvidence: cite(NAV, 'The angle of the dance indicates the direction of the food relative to the sun.'),
      },
    ]);
    expect(same.status).toBe('rejected');
    expect(codes(same)).toContain('duplicate_options');
  });
});

/* -------------------------------------------------------------------------- */
/* TRUE / FALSE / NOT GIVEN                                                    */
/* -------------------------------------------------------------------------- */

const tfng = (prompt: string, correctAnswer: string, questionQuote: string, source: SourceChunk, answerQuote?: string) => ({
  type: 'true_false_not_given',
  prompt,
  correctAnswer,
  questionEvidence: cite(source, questionQuote),
  answerEvidence: answerQuote ? cite(source, answerQuote) : [],
});

describe('true / false / not given', () => {
  it('establishes FALSE from an explicit negation, without requiring the answer to overlap the source', () => {
    const quote = 'Young bees do not perform the waggle dance until they are about three weeks old.';
    const [result] = judge('true_false_not_given', [tfng('Young bees perform the waggle dance.', 'FALSE', quote, NAV, quote)]);
    expect(result.status).toBe('valid');
    expect(result.groundingVerdict.status).toBe('valid');
  });

  it('establishes FALSE from a different figure, and from an opposite term', () => {
    const results = judge('true_false_not_given', [
      tfng(
        'A colony keeps its brood nest at about 25 degrees.',
        'FALSE',
        'A colony keeps its brood nest at about 35 degrees.',
        TEMP,
        'A colony keeps its brood nest at about 35 degrees.',
      ),
      tfng(
        'The dance lasts shorter when the food is further away.',
        'FALSE',
        'The dance lasts longer when the food is further away.',
        NAV,
        'The dance lasts longer when the food is further away.',
      ),
    ]);
    expect(results.map((result) => result.status)).toEqual(['valid', 'valid']);
  });

  it('needs review for a FALSE with no explicit contradiction in its evidence', () => {
    const quote = 'Honey bees communicate the location of food through a waggle dance.';
    const [result] = judge('true_false_not_given', [tfng('Honey bees dance only at night.', 'FALSE', quote, NAV, quote)]);
    expect(result.status).toBe('needs_review');
    expect(codes(result)).toContain('false_not_provable');
    expect(result.question?.correctAnswer).toBe('FALSE');
  });

  it('does not read a negation in another clause as a contradiction', () => {
    // Found while building the browser fixture: the "not" here negates renting
    // in winter, not renting in spring.
    const quote = 'Growers do not rent hives in winter, and they rent them every spring for the almond bloom.';
    const GROW = chunk('src-quality-c00009', 'Renting hives', quote, 9);
    const [result] = judge(
      'true_false_not_given',
      [tfng('Growers rent hives every spring for the almond bloom.', 'FALSE', quote, GROW, quote)],
      [GROW],
    );
    expect(result.status).toBe('needs_review');
    expect(codes(result)).toContain('false_not_provable');
  });

  it('establishes NOT GIVEN when the statement names a detail the passage never does', () => {
    const [result] = judge('true_false_not_given', [
      tfng(
        'Honey bees were first studied in 1923.',
        'NOT GIVEN',
        'Honey bees communicate the location of food through a waggle dance.',
        NAV,
      ),
    ]);
    expect(result.status).toBe('valid');
    // No answer evidence, by definition, and none required.
    expect(result.answerEvidence).toHaveLength(0);
  });

  it('needs review for a NOT GIVEN that could still be said in other words', () => {
    const [result] = judge('true_false_not_given', [
      tfng(
        'Honey bees prefer to dance in sunny weather.',
        'NOT GIVEN',
        'Honey bees communicate the location of food through a waggle dance.',
        NAV,
      ),
    ]);
    expect(result.status).toBe('needs_review');
    expect(codes(result)).toContain('not_given_not_provable');
  });

  it('needs review for a NOT GIVEN the passage actually states', () => {
    const [result] = judge('true_false_not_given', [
      tfng(
        'Worker bees cool the nest by fanning their wings.',
        'NOT GIVEN',
        'Worker bees cool the nest by fanning their wings near the entrance.',
        TEMP,
      ),
    ]);
    expect(result.status).toBe('needs_review');
    expect(codes(result)).toContain('answer_conflicts_with_evidence');
  });

  it('needs review for a TRUE that drops the source’s hedge', () => {
    const quote = 'Wild pollinators, such as solitary bees, are also important, but farmers rarely depend on them alone.';
    const [result] = judge('true_false_not_given', [tfng('Farmers depend on wild pollinators.', 'TRUE', quote, FARM, quote)]);
    expect(result.status).toBe('needs_review');
    expect(codes(result)).toContain('ambiguous_question');
  });

  it('is source-grounded but poor quality when the statement is copied word for word', () => {
    const quote = 'Drones take no part in regulating temperature.';
    const [result] = judge('true_false_not_given', [tfng(quote, 'TRUE', quote, TEMP, quote)]);
    expect(result.groundingVerdict.status).toBe('valid');
    expect(result.qualityVerdict.status).toBe('needs_review');
    expect(result.status).toBe('needs_review');
    expect(codes(result)).toContain('answer_copied_verbatim');
  });
});

/* -------------------------------------------------------------------------- */
/* Completion and short answer                                                 */
/* -------------------------------------------------------------------------- */

describe('sentence completion and short answer', () => {
  it('is valid when the answer is in its evidence, fits the gap, and keeps the meaning', () => {
    const quote = 'The angle of the dance indicates the direction of the food relative to the sun.';
    const [result] = judge('sentence_completion', [
      {
        type: 'sentence_completion',
        prompt: 'The angle of the dance shows the ______ of the food.',
        wordLimit: 'NO MORE THAN ONE WORD',
        correctAnswer: 'direction',
        questionEvidence: cite(NAV, quote),
        answerEvidence: cite(NAV, quote),
      },
    ]);
    expect(result.status).toBe('valid');
  });

  it('needs review when the answer is one item of a list the others would also answer', () => {
    const quote = 'Workers collect nectar, pollen, water and resin for the colony.';
    const question = {
      type: 'sentence_completion',
      prompt: 'Workers collect ______ for the colony.',
      wordLimit: 'NO MORE THAN ONE WORD',
      correctAnswer: 'pollen',
      questionEvidence: cite(TEMP, quote),
      answerEvidence: cite(TEMP, quote),
    };
    const [flagged] = judge('sentence_completion', [question]);
    expect(flagged.status).toBe('needs_review');
    expect(codes(flagged)).toContain('answer_not_exclusive');

    // Represented through acceptableAnswers, the alternatives are no longer a defect.
    const [accepted] = judge('sentence_completion', [{ ...question, acceptableAnswers: ['nectar', 'water', 'resin'] }]);
    expect(accepted.status).toBe('valid');
    expect(accepted.question?.acceptableAnswers).toEqual(['nectar', 'water', 'resin']);
  });

  it('needs review when the completed sentence contradicts the source', () => {
    const quote = 'The dance lasts longer when the food is further away.';
    const [result] = judge('sentence_completion', [
      {
        type: 'sentence_completion',
        prompt: 'The dance lasts shorter when the ______ is further away.',
        wordLimit: 'NO MORE THAN ONE WORD',
        correctAnswer: 'food',
        questionEvidence: cite(NAV, quote),
        answerEvidence: cite(NAV, quote),
      },
    ]);
    expect(codes(result)).toContain('completion_changes_meaning');
  });

  it('rejects an answer that is not in the source, and one over its word limit', () => {
    const quote = 'Workers collect nectar, pollen, water and resin for the colony.';
    const results = judge('short_answer', [
      {
        type: 'short_answer',
        prompt: 'What do workers collect for the colony?',
        wordLimit: 'NO MORE THAN TWO WORDS',
        correctAnswer: 'royal jelly',
        questionEvidence: cite(TEMP, quote),
        answerEvidence: cite(TEMP, quote),
      },
      {
        type: 'short_answer',
        prompt: 'Name the things workers bring back to the colony.',
        wordLimit: 'NO MORE THAN TWO WORDS',
        correctAnswer: 'nectar, pollen, water',
        questionEvidence: cite(TEMP, quote),
        answerEvidence: cite(TEMP, quote),
      },
    ]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(codes(results[0])).toContain('answer_not_in_source');
    expect(codes(results[1])).toContain('word_limit_exceeded');
    // Quality was never judged for the ungrounded one, and the record says so.
    expect(results[0].qualityVerdict.evaluated).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Matching headings                                                           */
/* -------------------------------------------------------------------------- */

const headingSet = (headings: string[], keys: [string, string]) => [
  {
    type: 'matching_headings',
    prompt: 'Section A',
    options: headings,
    correctAnswer: keys[0],
    questionEvidence: cite(NAV, 'The angle of the dance indicates the direction of the food relative to the sun.'),
    answerEvidence: cite(NAV, 'The angle of the dance indicates the direction of the food relative to the sun.'),
  },
  {
    type: 'matching_headings',
    prompt: 'Section B',
    options: headings,
    correctAnswer: keys[1],
    questionEvidence: cite(TEMP, 'A colony keeps its brood nest at about 35 degrees.'),
    answerEvidence: cite(TEMP, 'A colony keeps its brood nest at about 35 degrees.'),
  },
];

describe('matching headings', () => {
  it('is valid when each heading fits its own section best and the spare one is a near miss', () => {
    const results = judge(
      'matching_headings',
      headingSet(['i. How bees show where food is', 'ii. Keeping the nest at the right temperature', 'iii. How bees choose a new home'], ['i', 'ii']),
      [NAV, TEMP],
    );
    expect(results.map((result) => result.status)).toEqual(['valid', 'valid']);
  });

  it('needs review when a heading fits two sections equally well', () => {
    const results = judge(
      'matching_headings',
      headingSet(['i. Bees and their behaviour', 'ii. Temperature control in the colony', 'iii. How bees choose a new home'], ['i', 'ii']),
      [NAV, TEMP],
    );
    expect(results[0].status).toBe('needs_review');
    expect(codes(results[0])).toContain('headings_ambiguous_between_sections');
  });

  it('flags a heading that copies the book’s own section title, and a spare heading that is noise', () => {
    const results = judge(
      'matching_headings',
      headingSet(['i. Honey bee navigation', 'ii. Keeping the nest at the right temperature', 'iii. Medieval castle architecture'], ['i', 'ii']),
      [NAV, TEMP],
    );
    expect(codes(results[0])).toContain('heading_leaks_source_heading');
    expect(codes(results[1])).toContain('unused_heading_implausible');
  });

  it('flags one heading used for two sections', () => {
    const results = judge(
      'matching_headings',
      headingSet(['i. How bees show where food is', 'ii. Keeping the nest at the right temperature', 'iii. How bees choose a new home'], ['i', 'i']),
      [NAV, TEMP],
    );
    expect(codes(results[0])).toContain('heading_used_twice');
    expect(codes(results[1])).toContain('heading_used_twice');
  });
});

/* -------------------------------------------------------------------------- */
/* Human promotion, through the real routes and gate                           */
/* -------------------------------------------------------------------------- */

class FakeModel implements GenerationModel {
  readonly name = 'fake-model';
  constructor(private readonly respond: (request: ModelRequest) => string) {}
  async generate(request: ModelRequest) {
    return { text: this.respond(request), model: 'fake-model', modelVersion: 'fake-model-002' };
  }
}

const SCANNING_TOPIC = 'scanning for dates and proper nouns';
const SCANNING_QUOTE =
  'Numbers, dates, proper nouns and capitalised terms are the easiest targets because they stand out visually.';
const OPPOSITE_QUOTE =
  'Scanning is the opposite movement: you already know what you are looking for, and you are searching the page for it.';

function promotionResponse(request: ModelRequest): string {
  const pattern = /<<<EXCERPT chunkId="([^"]+)" section="([A-Z])"[^>]*>\n([\s\S]*?)\n>>>/g;
  const scan = [...request.prompt.matchAll(pattern)].find((match) => match[3].includes('proper nouns'));
  if (!scan) throw new Error('the scanning excerpt was not in the prompt');
  const at = (quote: string) => [{ chunkId: scan[1], quote }];
  return JSON.stringify({
    questions: [
      {
        type: 'short_answer',
        prompt: 'What does the book call numbers, dates, proper nouns and capitalised terms?',
        wordLimit: 'NO MORE THAN THREE WORDS',
        correctAnswer: 'the easiest targets',
        questionEvidence: at(SCANNING_QUOTE),
        answerEvidence: at(SCANNING_QUOTE),
      },
      {
        // Correct, but its answer evidence cites the wrong sentence: exactly the
        // kind of question a person can check and confirm.
        type: 'short_answer',
        prompt: 'What does the book call scanning, compared with skimming?',
        wordLimit: 'NO MORE THAN THREE WORDS',
        correctAnswer: 'opposite movement',
        questionEvidence: at(OPPOSITE_QUOTE),
        answerEvidence: at(SCANNING_QUOTE),
      },
      {
        type: 'short_answer',
        prompt: 'What should candidates underline while scanning?',
        wordLimit: 'NO MORE THAN THREE WORDS',
        correctAnswer: 'bold typography',
        questionEvidence: at(SCANNING_QUOTE),
        answerEvidence: at(SCANNING_QUOTE),
      },
    ],
  });
}

let server: Server;
let origin = '';
let adminCookie = '';
let source: StoredSource;

const api = (url: string, init: RequestInit = {}) =>
  fetch(`${origin}${url}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', cookie: adminCookie, ...(init.headers || {}) },
  });

before(async () => {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/admin', adminRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  const login = await fetch(`${origin}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASSWORD }),
  });
  adminCookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  expect(adminCookie).toContain('prep_admin_auth=');

  source = await ingestSource({
    filename: 'study-skills.md',
    buffer: readFileSync(path.join(FIXTURES, 'study-skills.md')),
    mimeType: 'text/plain',
    createdBy: 'test',
  });
  expect(source.status).toBe('ready');
});

after(async () => {
  setGenerationModel(null);
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  process.chdir(originalCwd);
  removeTempRoot(tempRoot);
});

describe('a person can promote a flagged question, and only that way', () => {
  let materialId = '';
  let adminId = '';

  before(async () => {
    setGenerationModel(new FakeModel(promotionResponse));
    const response = await api(`/api/admin/sources/${source.id}/generate`, {
      method: 'POST',
      body: JSON.stringify({
        requestId: 'quality-promotion-0001',
        topic: SCANNING_TOPIC,
        questionType: 'short_answer',
        count: 3,
        module: 'academic',
        targetBand: '7.0',
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    materialId = body.materialId;
    expect(body.questions.map((item: { status: string }) => item.status)).toEqual(['valid', 'needs_review', 'rejected']);
    adminId = (await (await api('/api/admin/me')).json()).admin.id;
  });

  const stored = async () => {
    const material = await adminStore.getMaterial('reading', materialId);
    if (!material || material.section !== 'reading' || !material.content.generationRecord) {
      throw new Error('expected a generated reading material');
    }
    return material;
  };
  const idWith = async (status: 'valid' | 'needs_review' | 'rejected') =>
    (await stored()).content.generationRecord!.questions.find((entry) => entry.status === status)!.generatedQuestionId;
  const decide = (questionId: string, body: Record<string, unknown>) =>
    api(`/api/admin/sources/generated/${materialId}/questions/${questionId}/reviews`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  const publish = () => api(`/api/admin/materials/reading/${materialId}/publish`, { method: 'POST' });
  const put = async (material: unknown) =>
    api(`/api/admin/materials/reading/${materialId}`, { method: 'PUT', body: JSON.stringify(material) });

  it('blocks publication while the flagged question has no decision', async () => {
    const response = await publish();
    expect(response.status).toBe(409);
    const codes = (await response.json()).blockers.map((blocker: { code: string }) => blocker.code);
    expect(codes).toContain('generation_unverified');
  });

  it('refuses a decision without a note, or about a question that was not flagged', async () => {
    const flagged = await idWith('needs_review');
    expect((await decide(flagged, { decision: 'confirmed', note: 'ok' })).status).toBe(400);
    expect((await decide(await idWith('valid'), { decision: 'confirmed', note: 'Checked against the book.' })).status).toBe(409);
    const rejected = await decide(await idWith('rejected'), { decision: 'confirmed', note: 'Checked against the book.' });
    expect(rejected.status).toBe(409);
    expect((await rejected.json()).code).toBe('not_needs_review');
  });

  it('will not let a save forge a confirmation', async () => {
    const material = await stored();
    const flagged = await idWith('needs_review');
    const question = material.content.passage.questions.find((item) => item.id === flagged)!;
    const forged = structuredClone(material) as typeof material & { content: { generationReviews?: unknown[] } };
    forged.content.generationReviews = [
      {
        reviewId: 'rev-forged',
        generatedQuestionId: flagged,
        decision: 'confirmed',
        note: 'Nobody actually checked this question.',
        reviewer: { id: 'someone-else', username: 'forger', displayName: 'Forger' },
        reviewedAt: '2026-01-01T00:00:00.000Z',
        questionHash: questionContentHash(question),
        machineVerdict: { status: 'needs_review', groundingStatus: 'needs_review', qualityStatus: 'needs_review', reasonCodes: [] },
      },
    ];
    expect((await put(forged)).status).toBe(200);
    expect((await stored()).content.generationReviews ?? []).toHaveLength(0);
    expect((await publish()).status).toBe(409);
  });

  it('records the reviewer from the session, never from the request', async () => {
    const response = await decide(await idWith('needs_review'), {
      decision: 'confirmed',
      note: 'Checked the book: it calls scanning the opposite movement.',
      reviewer: { id: 'someone-else', username: 'forger', displayName: 'Forger' },
      reviewedAt: '1999-01-01T00:00:00.000Z',
      machineVerdict: { status: 'valid' },
    });
    expect(response.status).toBe(201);
    const { review } = await response.json();

    expect(review.reviewer.id).toBe(adminId);
    expect(review.reviewer.username).toBe(ADMIN_USER);
    expect(review.reviewedAt === '1999-01-01T00:00:00.000Z').toBe(false);
    expect(review.decision).toBe('confirmed');
    expect(review.machineVerdict.status).toBe('needs_review');
    expect(review.machineVerdict.reasonCodes).toContain('answer_not_in_evidence');
  });

  it('leaves the original machine verdict and the question’s provenance intact', async () => {
    const material = await stored();
    const flagged = await idWith('needs_review');
    const entry = material.content.generationRecord!.questions.find((item) => item.generatedQuestionId === flagged)!;
    expect(entry.status).toBe('needs_review');
    expect(entry.groundingVerdict?.status).toBe('needs_review');
    expect(entry.groundingVerdict?.reasons.map((reason) => reason.code)).toContain('answer_not_in_evidence');

    const question = material.content.passage.questions.find((item) => item.id === flagged)!;
    expect(question.provenance?.validation).toBe('needs_review');
    expect(question.provenance?.groundingStatus).toBe('needs_review');
    expect(material.content.generationReviews).toHaveLength(1);
  });

  it('will not let a save erase a decision', async () => {
    const material = structuredClone(await stored()) as Awaited<ReturnType<typeof stored>>;
    material.content.generationReviews = [];
    expect((await put(material)).status).toBe(200);
    expect((await stored()).content.generationReviews).toHaveLength(1);
  });

  it('tells a question excluded after the decision apart from an edited one', async () => {
    const original = structuredClone(await stored()) as Awaited<ReturnType<typeof stored>>;
    const flagged = await idWith('needs_review');
    const without = structuredClone(original);
    without.content.passage.questions = without.content.passage.questions.filter((item) => item.id !== flagged);
    expect((await put(without)).status).toBe(200);

    const excluded = await (await api(`/api/admin/sources/generated/${materialId}/review`)).json();
    expect(excluded.generationReviews[0].inDraft).toBe(false);
    expect(excluded.generationReviews[0].current).toBe(false);

    expect((await put(original)).status).toBe(200);
    const restored = await (await api(`/api/admin/sources/generated/${materialId}/review`)).json();
    expect(restored.generationReviews[0].inDraft).toBe(true);
    expect(restored.generationReviews[0].current).toBe(true);
  });

  it('lets the confirmation lapse when the question is edited afterwards', async () => {
    const material = structuredClone(await stored()) as Awaited<ReturnType<typeof stored>>;
    const flagged = await idWith('needs_review');
    const question = material.content.passage.questions.find((item) => item.id === flagged)!;
    question.prompt = 'What does the book call scanning when it compares it with skimming?';
    expect((await put(material)).status).toBe(200);

    const refused = await publish();
    expect(refused.status).toBe(409);
    const blockers = (await refused.json()).blockers as Array<{ code: string }>;
    expect(blockers.map((blocker) => blocker.code)).toContain('generation_confirmation_stale');

    const review = await (await api(`/api/admin/sources/generated/${materialId}/review`)).json();
    expect(review.generationReviews[0].inDraft).toBe(true);
    expect(review.generationReviews[0].current).toBe(false);
  });

  it('publishes once the current version is confirmed', async () => {
    const response = await decide(await idWith('needs_review'), {
      decision: 'confirmed',
      note: 'Rechecked after the prompt was reworded; the answer still holds.',
    });
    expect(response.status).toBe(201);

    const published = await publish();
    expect(published.status).toBe(200);

    const review = await (await api(`/api/admin/sources/generated/${materialId}/review`)).json();
    expect(review.generationReviews.map((item: { current: boolean }) => item.current)).toEqual([false, true]);
  });

  it('refuses decisions once the material is no longer a draft', async () => {
    const response = await decide(await idWith('needs_review'), {
      decision: 'rejected',
      note: 'Too late to change my mind here.',
    });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('not_draft');
  });
});
