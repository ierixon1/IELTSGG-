import { after, before, describe, it } from 'node:test';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';
import {
  calculateOverallBand,
  checkAnswer,
  listeningRawToBand,
  objectiveSectionScore,
  readingRawToBand,
  roundIeltsBand,
  writingSectionBand,
} from '../src/utils/ieltsScoring';

/**
 * Scoring and attempt persistence.
 *
 * A band is the product the learner is here for, so the conversion tables and
 * the official rounding rule are pinned here, and an attempt is round-tripped
 * through the real route to prove a result survives the request.
 *
 * Phases 9 and 10 extend this file: bundle timings driving the session clocks,
 * Writing covering both tasks, Speaking covering all three parts, and answers
 * persisting so an exam can resume. Those behaviours do not hold yet and are
 * deliberately not asserted as if they did.
 */

describe('official band rounding', () => {
  it('rounds to the nearer half band, and .25/.75 upward', () => {
    expect(roundIeltsBand(6.0)).toBe(6.0);
    expect(roundIeltsBand(6.124)).toBe(6.0);
    expect(roundIeltsBand(6.25)).toBe(6.5);
    expect(roundIeltsBand(6.375)).toBe(6.5);
    expect(roundIeltsBand(6.625)).toBe(6.5);
    expect(roundIeltsBand(6.75)).toBe(7.0);
    expect(roundIeltsBand(6.875)).toBe(7.0);
  });

  it('averages the four skills the way the certificate does', () => {
    // 6.5 + 6.5 + 6.0 + 7.0 = 26 / 4 = 6.5
    expect(calculateOverallBand({ listening: 6.5, reading: 6.5, writing: 6.0, speaking: 7.0 })).toBe(6.5);
    // 7 + 7 + 6.5 + 6.5 = 27 / 4 = 6.75 -> 7.0
    expect(calculateOverallBand({ listening: 7, reading: 7, writing: 6.5, speaking: 6.5 })).toBe(7.0);
  });

  it('averages only the skills actually sat', () => {
    expect(calculateOverallBand({ reading: 7.0 })).toBe(7.0);
    expect(calculateOverallBand({ reading: 7.0, writing: 6.0 })).toBe(6.5);
    expect(calculateOverallBand({})).toBe(0);
  });

  it('follows the worked examples ielts.org publishes', () => {
    // "Test Taker A": 6.5, 6.5, 5.0, 7.0 -> 6.25 -> 6.5.
    expect(calculateOverallBand({ listening: 6.5, reading: 6.5, writing: 5.0, speaking: 7.0 })).toBe(6.5);
    // 6.0, 6.0, 6.0, 6.5 -> 6.125 -> 6.0.
    expect(calculateOverallBand({ listening: 6.0, reading: 6.0, writing: 6.0, speaking: 6.5 })).toBe(6.0);
  });

  it('counts a section band of 0 in the average instead of dropping the section', () => {
    // 8 + 9 + 5 + 0 = 22 / 4 = 5.5. Leaving the 0 out would give 7.33 -> 7.5.
    expect(calculateOverallBand({ listening: 8, reading: 9, writing: 5, speaking: 0 })).toBe(5.5);
  });
});

/**
 * Every published row, at both ends of its range (IDP IELTS, "How to calculate the
 * IELTS Listening / Reading band score"; ielts.org publishes the 5/6/7/8 anchors).
 * Rows below the last published one are not asserted: they are not official.
 */
const bandRows = (rows: Array<[number, number, number]>) =>
  rows.flatMap(([low, high, band]) => [
    [low, band],
    [high, band],
  ]);

describe('raw score to band', () => {
  it('converts Listening with the published table, Academic and General Training alike', () => {
    const rows = bandRows([
      [39, 40, 9], [37, 38, 8.5], [35, 36, 8], [32, 34, 7.5], [30, 31, 7], [26, 29, 6.5],
      [23, 25, 6], [18, 22, 5.5], [16, 17, 5], [13, 15, 4.5], [11, 12, 4],
    ]);
    for (const [raw, band] of rows) expect([raw, listeningRawToBand(raw)]).toEqual([raw, band]);
    // ielts.org anchors.
    expect([listeningRawToBand(16), listeningRawToBand(23), listeningRawToBand(30), listeningRawToBand(35)]).toEqual([5, 6, 7, 8]);
  });

  it('converts Academic Reading with the Academic table', () => {
    const rows = bandRows([
      [39, 40, 9], [37, 38, 8.5], [35, 36, 8], [33, 34, 7.5], [30, 32, 7], [27, 29, 6.5],
      [23, 26, 6], [19, 22, 5.5], [15, 18, 5], [13, 14, 4.5], [10, 12, 4], [8, 9, 3.5], [6, 7, 3], [4, 5, 2.5],
    ]);
    for (const [raw, band] of rows) expect([raw, readingRawToBand(raw, 'academic')]).toEqual([raw, band]);
    expect([15, 23, 30, 35].map((raw) => readingRawToBand(raw, 'academic'))).toEqual([5, 6, 7, 8]);
  });

  it('converts General Training Reading with its own, stricter table', () => {
    const rows = bandRows([
      [40, 40, 9], [39, 39, 8.5], [37, 38, 8], [36, 36, 7.5], [34, 35, 7], [32, 33, 6.5],
      [30, 31, 6], [27, 29, 5.5], [23, 26, 5], [19, 22, 4.5], [15, 18, 4], [12, 14, 3.5], [9, 11, 3],
    ]);
    for (const [raw, band] of rows) expect([raw, readingRawToBand(raw, 'general')]).toEqual([raw, band]);
    // ielts.org anchors: 15 -> 4, 23 -> 5, 30 -> 6, 35 -> 7.
    expect([15, 23, 30, 35].map((raw) => readingRawToBand(raw, 'general'))).toEqual([4, 5, 6, 7]);
  });

  it('does not give a raw score below the lowest published row that row’s band', () => {
    // What the band is down there is not published; that it is lower than the row
    // the score falls outside of is.
    expect(listeningRawToBand(10) < 4).toBe(true);
    expect(readingRawToBand(3, 'academic') < 2.5).toBe(true);
    expect(readingRawToBand(8, 'general') < 3).toBe(true);
  });

  it('gives the same raw Reading score a different band in each module', () => {
    expect(readingRawToBand(30, 'academic')).toBe(7);
    expect(readingRawToBand(30, 'general')).toBe(6);
  });
});

describe('section scoring', () => {
  it('weights Writing Task 2 twice as much as Task 1', () => {
    // (5 + 2 x 7) / 3 = 6.33 -> 6.5; an equal weighting would give 6.0.
    expect(writingSectionBand(5, 7)).toBe(6.5);
    // (8 + 2 x 5) / 3 = 6.0; an equal weighting would give 6.5.
    expect(writingSectionBand(8, 5)).toBe(6.0);
  });

  it('converts a 40-question Reading section directly, with the module table', () => {
    const questions = Array.from({ length: 40 }, (_, index) => ({
      id: `q${index + 1}`,
      questionNumber: index + 1,
      type: 'short_answer' as const,
      prompt: `Question ${index + 1}`,
      correctAnswer: `a${index + 1}`,
    }));
    const answers = Object.fromEntries(questions.slice(0, 30).map((question) => [question.id, question.correctAnswer]));
    expect(objectiveSectionScore('reading', questions, answers, 'academic')).toEqual({ correct: 30, total: 40, band: 7 });
    expect(objectiveSectionScore('reading', questions, answers, 'general')).toEqual({ correct: 30, total: 40, band: 6 });
    expect(objectiveSectionScore('listening', questions, answers, 'general')).toEqual({ correct: 30, total: 40, band: 7 });
  });
});

describe('answer matching', () => {
  it('ignores case and surrounding whitespace', () => {
    expect(checkAnswer('  Algae ', 'algae')).toBe(true);
    expect(checkAnswer('TRUE', 'True')).toBe(true);
  });

  it('accepts any of the authored variants', () => {
    expect(checkAnswer('nineteen', ['19', 'nineteen'])).toBe(true);
    expect(checkAnswer('19', ['19', 'nineteen'])).toBe(true);
    expect(checkAnswer('twenty', ['19', 'nineteen'])).toBe(false);
  });

  it('rejects a wrong answer and an empty one', () => {
    expect(checkAnswer('ponds', 'lakes')).toBe(false);
    expect(checkAnswer('', 'algae')).toBe(false);
    expect(checkAnswer('algae', '')).toBe(false);
  });
});

/**
 * Attempt persistence over the real route. The schema is `.strict()`, so this
 * also pins exactly which fields an attempt may carry — which is what Phase 10
 * has to widen before answers and resume state can be stored.
 */
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-attempts-'));
const originalCwd = process.cwd();
process.env.STORAGE_BACKEND = 'local';
process.env.NODE_ENV = 'test';
process.chdir(tempRoot);

const express = (await import('express')).default;
const { authService } = await import('../src/services/authService');
const { authenticateRequest } = await import('../src/middleware/authMiddleware');
const { userDataRouter } = await import('../src/routes/userDataRoutes');

let server: Server;
let origin = '';
let cookie = '';

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', authenticateRequest);
  app.use('/api', userDataRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  const registered = await authService.register({
    email: 'learner@example.com',
    username: 'learner_one',
    password: 'Str0ng-Passw0rd-For-Tests',
    name: 'Learner One',
  });
  cookie = `prep_auth=${registered.token}`;
});

after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  process.chdir(originalCwd);
  removeTempRoot(tempRoot);
});

async function post(pathname: string, body: unknown) {
  return fetch(`${origin}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

describe('attempt persistence', () => {
  it('refuses an attempt without a session', async () => {
    const response = await fetch(`${origin}/api/data/attempts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'a1', testId: 't1', date: '2026-09-09', scores: {} }),
    });
    expect(response.status).toBe(401);
  });

  it('refuses a full-mock attempt sent straight from the browser', async () => {
    // A full exam is recorded by its exam session, from state the server holds
    // (tests/examSession.test.ts). Posted directly, it is a set of bands nobody earned.
    const forged = {
      id: 'attempt-forged',
      testId: 'cdi-bundle-7',
      testTitle: 'Pipeline CDI',
      isFullMock: true,
      date: '2026-09-09',
      scores: { overall: 9.0, listening: { band: 9 }, reading: { band: 9 }, writing: { band: 9 }, speaking: { band: 9 } },
    };
    const response = await post('/api/data/attempts', forged);
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('exam_attempt_via_session');
    expect((await post('/api/data/attempts', { ...forged, isFullMock: false, mode: 'exam' })).status).toBe(403);
  });

  it('stores a practice attempt under the test it was sat from', async () => {
    const attempt = {
      id: 'attempt-1',
      testId: 'cdi-bundle-7',
      testTitle: 'Pipeline CDI',
      mode: 'practice',
      isFullMock: false,
      date: '2026-09-09',
      scores: { overall: 6.5, writing: { band: 6.5, task1Band: 6.0, task2Band: 7.0 } },
    };

    expect((await post('/api/data/attempts', attempt)).status).toBe(201);

    const data = await (await fetch(`${origin}/api/data`, { headers: { cookie } })).json();
    expect(data.attempts).toHaveLength(1);
    // The test that produced the result is identifiable — section practice used
    // to hard-code `testId: 'test-1'` for everything.
    expect(data.attempts[0].testId).toBe('cdi-bundle-7');
    expect(data.attempts[0].testTitle).toBe('Pipeline CDI');
    expect(data.attempts[0].scores.writing.task2Band).toBe(7.0);
  });

  it('rejects an out-of-range band rather than storing nonsense', async () => {
    const response = await post('/api/data/attempts', {
      id: 'attempt-bad',
      testId: 't1',
      date: '2026-09-09',
      scores: { overall: 42 },
    });
    expect(response.status).toBe(400);
  });

  it('rejects an attempt carrying unknown fields', async () => {
    // The schema is strict. Exam records have their own named fields
    // (`responses`, `writingTasks`, `speakingParts`, `sections`); a loose
    // `answers` map is still not one of them.
    const response = await post('/api/data/attempts', {
      id: 'attempt-extra',
      testId: 't1',
      date: '2026-09-09',
      scores: { overall: 7 },
      answers: { q1: 'algae' },
    });
    expect(response.status).toBe(400);
  });
});
