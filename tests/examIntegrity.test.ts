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
  readingRawToBand,
  roundIeltsBand,
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
});

describe('raw score to band', () => {
  it('converts reading at the published boundaries', () => {
    expect(readingRawToBand(40)).toBe(9.0);
    expect(readingRawToBand(39)).toBe(9.0);
    expect(readingRawToBand(38)).toBe(8.5);
    expect(readingRawToBand(30)).toBe(7.0);
    expect(readingRawToBand(29)).toBe(6.5);
    expect(readingRawToBand(0)).toBe(2.5);
  });

  it('converts listening at the published boundaries, which differ from reading', () => {
    expect(listeningRawToBand(39)).toBe(9.0);
    expect(listeningRawToBand(30)).toBe(7.0);
    expect(listeningRawToBand(23)).toBe(6.0);
    // 30 raw is Band 7.0 in both, but 23 raw is 6.0 listening and 6.0 reading;
    // 19 separates them.
    expect(listeningRawToBand(19)).toBe(5.5);
    expect(readingRawToBand(19)).toBe(5.5);
    expect(listeningRawToBand(16)).toBe(5.0);
    expect(readingRawToBand(16)).toBe(5.0);
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

  it('stores a full-mock attempt and reads it back under the learner', async () => {
    const attempt = {
      id: 'attempt-1',
      testId: 'cdi-bundle-7',
      testTitle: 'Pipeline CDI',
      mode: 'exam',
      isFullMock: true,
      date: '2026-09-09',
      scores: {
        overall: 7.0,
        listening: { band: 7.5, rawScore: 32 },
        reading: { band: 7.0, rawScore: 30 },
        writing: { band: 6.5, task1Band: 6.0, task2Band: 7.0 },
        speaking: { band: 7.0 },
      },
      durationMinutes: 165,
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
    // The schema is strict. Phase 10 widens it deliberately, for `answers`,
    // `bundleId`, `materialRevision`, `startedAt` and `completedAt` — so this
    // assertion is the thing that will have to change, on purpose.
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
