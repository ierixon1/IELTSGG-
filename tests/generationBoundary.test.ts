import './env';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';
import type { StoredSource } from '../src/types/source';
import type { GenerationModel, ModelRequest } from '../src/services/bookToTest/model';

/**
 * The Book → Test generation boundary: what happens around the model call.
 *
 * Retries, time limits, failure classes, request identity and the run log are
 * exercised through the real route, the real store and the real review state
 * machine, with only the model replaced — by a scripted double that fails,
 * hangs or answers on cue, or by the fixture model the dev server uses. The
 * point of the fixture cases is parity: a fixture response and the same text
 * from any other model must end in the same stored draft and the same gate.
 */
const originalCwd = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-generation-boundary-'));
process.chdir(tempRoot);

const ADMIN_USER = 'boundary_admin';
const ADMIN_PASSWORD = 'Str0ng-Passw0rd-For-Boundary';
process.env.SEED_DEFAULT_ACCOUNTS = 'true';
process.env.ADMIN_USER = ADMIN_USER;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;

const express = (await import('express')).default;
const { adminRouter } = await import('../src/routes/adminRoutes');
const { ingestSource } = await import('../src/services/sourceIngest/ingest');
const { sourceStore } = await import('../src/services/sourceStore');
const { adminStore } = await import('../src/services/adminStore');
const { setGenerationModel } = await import('../src/services/bookToTest/model');
const { setGenerationPolicy } = await import('../src/services/bookToTest/reliability');
const { generationLog, decideClaim } = await import('../src/services/bookToTest/generationLog');
const { questionContentHash } = await import('../src/services/bookToTest/questionHash');
const { GENERATOR_VERSION, PROMPT_VERSION, GENERATION_MODEL } = await import('../src/services/bookToTest/version');
const { smokeVerdict, SMOKE_EXIT_CODES } = await import('../src/services/bookToTest/smokeVerdict');
const retry = await import('../prompts/geminiRetry');
const { buildReviewState, setClassification } = await import('../src/services/cdiImport/review');
const { importCdiHtml } = await import('../src/services/cdiImport');
const { AdminImportReview } = await import('../src/components/admin/AdminImportReview');

/* -------------------------------------------------------------------------- */
/* Models                                                                      */
/* -------------------------------------------------------------------------- */

type Step =
  | { throws: unknown }
  | { hangs: true }
  | { answers: (request: ModelRequest) => string; afterMs?: number };

/** Plays one step per call — the last one repeats — and remembers what it was given. */
class ScriptedModel implements GenerationModel {
  readonly name = 'scripted-model';
  calls = 0;
  readonly signals: AbortSignal[] = [];
  constructor(private readonly steps: Step[]) {}

  async generate(request: ModelRequest) {
    const step = this.steps[Math.min(this.calls, this.steps.length - 1)];
    this.calls += 1;
    if (request.signal) this.signals.push(request.signal);
    if ('throws' in step) throw step.throws;
    if ('hangs' in step) return new Promise<never>(() => {});
    if (step.afterMs) await new Promise((resolve) => setTimeout(resolve, step.afterMs));
    return { text: step.answers(request), model: this.name, modelVersion: 'scripted-001' };
  }
}

/** An error shaped like the Gemini SDK's: the API body as the message, and a numeric status. */
const apiError = (status: number, statusText: string, message = 'upstream said no') =>
  Object.assign(new Error(JSON.stringify({ error: { code: status, message, status: statusText } })), { status });

const SCANNING_TOPIC = 'scanning for dates and proper nouns';
const SCANNING_QUOTE =
  'Numbers, dates, proper nouns and capitalised terms are the easiest targets because they stand out visually.';

function scanningChunkIdIn(prompt: string): string {
  const pattern = /<<<EXCERPT chunkId="([^"]+)" section="([A-Z])"[^>]*>\n([\s\S]*?)\n>>>/g;
  for (const match of prompt.matchAll(pattern)) {
    if (match[3].includes('proper nouns')) return match[1];
  }
  throw new Error('the scanning excerpt was not in the prompt');
}

const goodResponseFor = (chunkId: string) =>
  JSON.stringify({
    questions: [
      {
        type: 'short_answer',
        prompt: 'What does the book call numbers, dates, proper nouns and capitalised terms?',
        wordLimit: 'NO MORE THAN THREE WORDS',
        correctAnswer: 'the easiest targets',
        questionEvidence: [{ chunkId, quote: SCANNING_QUOTE }],
        answerEvidence: [{ chunkId, quote: SCANNING_QUOTE }],
      },
    ],
  });

const answersWell = (request: ModelRequest) => goodResponseFor(scanningChunkIdIn(request.prompt));

/* -------------------------------------------------------------------------- */
/* Server                                                                      */
/* -------------------------------------------------------------------------- */

let server: Server;
let origin = '';
let adminCookie = '';
let source: StoredSource;

const FAST = { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 5, attemptTimeoutMs: 2000, totalTimeoutMs: 5000 };

const api = (url: string, init: RequestInit = {}) =>
  fetch(`${origin}${url}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', cookie: adminCookie, ...(init.headers || {}) },
  });

const scanningRequest = { topic: SCANNING_TOPIC, questionType: 'short_answer', count: 1, module: 'academic', targetBand: '7.0' };

const generate = (body: Record<string, unknown>) =>
  api(`/api/admin/sources/${source.id}/generate`, { method: 'POST', body: JSON.stringify(body) });

const generateNew = (over: Record<string, unknown> = {}) => generate({ requestId: randomUUID(), ...scanningRequest, ...over });

const readingCount = async () => (await adminStore.listMaterials('reading')).length;

const latestRun = async () => {
  const response = await api(`/api/admin/sources/${source.id}/generation-runs?limit=1`);
  expect(response.status).toBe(200);
  return (await response.json()).runs[0];
};

before(async () => {
  setGenerationPolicy(FAST);
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
    buffer: readFileSync(path.join(originalCwd, 'tests', 'fixtures', 'sources', 'study-skills.md')),
    mimeType: 'text/plain',
    createdBy: 'test',
  });
  expect(source.status).toBe('ready');
});

after(async () => {
  setGenerationModel(null);
  setGenerationPolicy(null);
  delete process.env.BOOK_TO_TEST_FIXTURE_RESPONSE;
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  process.chdir(originalCwd);
  removeTempRoot(tempRoot);
});

/* -------------------------------------------------------------------------- */
/* The retry policy                                                            */
/* -------------------------------------------------------------------------- */

describe('failures are classified by what they are', () => {
  it('reads the status the provider reports', () => {
    const cases: Array<[unknown, string]> = [
      [apiError(503, 'UNAVAILABLE'), 'unavailable'],
      [apiError(500, 'INTERNAL'), 'unavailable'],
      [apiError(502, 'BAD_GATEWAY'), 'unavailable'],
      [apiError(504, 'DEADLINE_EXCEEDED'), 'timeout'],
      [apiError(408, 'REQUEST_TIMEOUT'), 'timeout'],
      [apiError(429, 'RESOURCE_EXHAUSTED'), 'quota'],
      [apiError(400, 'INVALID_ARGUMENT'), 'permanent'],
      [apiError(401, 'UNAUTHENTICATED'), 'permanent'],
      [apiError(403, 'PERMISSION_DENIED'), 'permanent'],
      [apiError(404, 'NOT_FOUND'), 'permanent'],
    ];
    for (const [error, expected] of cases) expect(retry.classifyModelError(error).failureClass).toBe(expected);
  });

  it('classifies errors that carry no status', () => {
    const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const timedOut = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
    const bodyOnly = new Error('{"error":{"code":503,"message":"high demand","status":"UNAVAILABLE"}}');
    expect(retry.classifyModelError(abort).failureClass).toBe('timeout');
    expect(retry.classifyModelError(reset).failureClass).toBe('unavailable');
    expect(retry.classifyModelError(timedOut).failureClass).toBe('timeout');
    expect(retry.classifyModelError(bodyOnly)).toEqual({ failureClass: 'unavailable', status: 503, message: bodyOnly.message });
    expect(retry.classifyModelError(new Error('API key not valid. Please pass a valid API key.')).failureClass).toBe('permanent');
    expect(retry.classifyModelError(new retry.AiQuotaExceededError('Daily AI limit reached (10).')).failureClass).toBe('quota');
    expect(retry.classifyModelError(new retry.ModelTimeoutError(50)).failureClass).toBe('timeout');
    expect(retry.classifyModelError(new TypeError("Cannot read properties of undefined (reading 'text')")).failureClass).toBe('unknown');
  });
});

describe('the retry policy is bounded', () => {
  const policy = (over: Partial<import('../prompts/geminiRetry').RetryPolicy> = {}) => ({
    maxAttempts: 3,
    initialDelayMs: 1,
    maxDelayMs: 4,
    retryOn: ['unavailable', 'timeout'] as const,
    ...over,
  });

  it('retries a transient failure and returns the answer', async () => {
    let calls = 0;
    const { value, report } = await retry.callWithRetryPolicy(async () => {
      calls += 1;
      if (calls < 3) throw apiError(503, 'UNAVAILABLE');
      return 'answer';
    }, policy());
    expect(value).toBe('answer');
    expect(report.attempts).toBe(3);
    expect(report.attemptLog.map((entry) => entry.failureClass ?? 'ok')).toEqual(['unavailable', 'unavailable', 'ok']);
  });

  it('stops at the attempt limit however long the failure lasts', async () => {
    let calls = 0;
    let failure: unknown;
    try {
      await retry.callWithRetryPolicy(async () => {
        calls += 1;
        throw apiError(503, 'UNAVAILABLE');
      }, policy());
    } catch (error) {
      failure = error;
    }
    expect(calls).toBe(3);
    expect(failure instanceof retry.ModelCallFailure).toBe(true);
    expect((failure as InstanceType<typeof retry.ModelCallFailure>).report.attempts).toBe(3);
  });

  it('never exceeds the hard cap, whatever the policy asks for', async () => {
    let calls = 0;
    await retry
      .callWithRetryPolicy(async () => {
        calls += 1;
        throw apiError(503, 'UNAVAILABLE');
      }, policy({ maxAttempts: 1000 }))
      .catch(() => undefined);
    expect(calls).toBe(retry.HARD_MAX_ATTEMPTS);
  });

  it('never retries a permanent failure or a quota error', async () => {
    for (const error of [apiError(403, 'PERMISSION_DENIED'), apiError(400, 'INVALID_ARGUMENT'), apiError(429, 'RESOURCE_EXHAUSTED')]) {
      let calls = 0;
      await retry
        .callWithRetryPolicy(async () => {
          calls += 1;
          throw error;
        }, policy())
        .catch(() => undefined);
      expect(calls).toBe(1);
    }
  });

  it('abandons an attempt that never answers, and aborts it', async () => {
    const signals: AbortSignal[] = [];
    const started = Date.now();
    let failure: unknown;
    try {
      await retry.callWithRetryPolicy((signal) => {
        signals.push(signal);
        return new Promise<never>(() => {});
      }, policy({ maxAttempts: 2, attemptTimeoutMs: 30 }));
    } catch (error) {
      failure = error;
    }
    expect(Date.now() - started).toBeLessThan(1500);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect((failure as InstanceType<typeof retry.ModelCallFailure>).failureClass).toBe('timeout');
  });

  it('starts no attempt past the total deadline', async () => {
    let calls = 0;
    await retry
      .callWithRetryPolicy(() => {
        calls += 1;
        return new Promise<never>(() => {});
      }, policy({ maxAttempts: 3, attemptTimeoutMs: 1000, totalTimeoutMs: 60 }))
      .catch(() => undefined);
    expect(calls).toBe(1);
  });

  it('keeps the contract of the entry point grading and chat use', async () => {
    let calls = 0;
    const answered = await retry.executeGeminiWithRetry(async () => {
      calls += 1;
      if (calls === 1) throw apiError(503, 'UNAVAILABLE');
      return 'graded';
    }, 2, 1);
    expect(answered).toBe('graded');

    calls = 0;
    let unavailable: unknown;
    try {
      await retry.executeGeminiWithRetry(async () => {
        calls += 1;
        throw apiError(503, 'UNAVAILABLE');
      }, 2, 1);
    } catch (error) {
      unavailable = error;
    }
    expect(calls).toBe(3);
    expect(unavailable instanceof retry.AiUnavailableError).toBe(true);

    calls = 0;
    let refused: unknown;
    try {
      await retry.executeGeminiWithRetry(async () => {
        calls += 1;
        throw apiError(400, 'INVALID_ARGUMENT');
      }, 2, 1);
    } catch (error) {
      refused = error;
    }
    expect(calls).toBe(1);
    expect(refused instanceof retry.AiUnavailableError).toBe(false);
    expect((refused as Error).message).toContain('AI generation error');
  });
});

/* -------------------------------------------------------------------------- */
/* The generation boundary                                                     */
/* -------------------------------------------------------------------------- */

describe('the generation route reports each failure for what it is', () => {
  it('retries a transient 503 and creates exactly one draft', async () => {
    const model = new ScriptedModel([{ throws: apiError(503, 'UNAVAILABLE') }, { throws: apiError(503, 'UNAVAILABLE') }, { answers: answersWell }]);
    setGenerationModel(model);
    const beforeCount = await readingCount();

    const response = await generateNew();
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.attempts).toBe(3);
    expect(body.generation.attempts).toBe(3);
    expect(model.calls).toBe(3);
    expect(await readingCount()).toBe(beforeCount + 1);

    const run = await latestRun();
    expect(run.outcome).toBe('draft_created');
    expect(run.attempts).toBe(3);
    expect(run.attemptLog.map((entry: { failureClass?: string }) => entry.failureClass ?? 'ok')).toEqual([
      'unavailable',
      'unavailable',
      'ok',
    ]);
    expect(run.materialId).toBe(body.materialId);
  });

  it('gives up after the attempt limit with model_unavailable, and creates nothing', async () => {
    const model = new ScriptedModel([{ throws: apiError(503, 'UNAVAILABLE', 'This model is currently experiencing high demand.') }]);
    setGenerationModel(model);
    const beforeCount = await readingCount();

    const response = await generateNew();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.code).toBe('model_unavailable');
    expect(body.failureClass).toBe('unavailable');
    expect(body.attempts).toBe(3);
    expect(body.model).toBe('scripted-model');
    expect(body.error).toContain('after 3 attempts');
    expect(body.materialId).toBe(undefined);
    expect(model.calls).toBe(3);
    expect(await readingCount()).toBe(beforeCount);
  });

  it('does not retry a permanent failure', async () => {
    const model = new ScriptedModel([{ throws: apiError(403, 'PERMISSION_DENIED', 'Method doesn\'t allow unregistered callers.') }]);
    setGenerationModel(model);
    const response = await generateNew();
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.code).toBe('model_configuration_error');
    expect(body.failureClass).toBe('permanent');
    expect(body.worthRetrying).toBe(false);
    expect(model.calls).toBe(1);
  });

  it('does not retry a quota error', async () => {
    const model = new ScriptedModel([{ throws: apiError(429, 'RESOURCE_EXHAUSTED') }]);
    setGenerationModel(model);
    const response = await generateNew();
    expect(response.status).toBe(429);
    expect((await response.json()).code).toBe('quota_exceeded');
    expect(model.calls).toBe(1);
  });

  it('times out a model that never answers, within the bound', async () => {
    const model = new ScriptedModel([{ hangs: true }]);
    setGenerationModel(model);
    setGenerationPolicy({ ...FAST, attemptTimeoutMs: 50, totalTimeoutMs: 1000 });
    const started = Date.now();
    try {
      const response = await generateNew();
      expect(response.status).toBe(504);
      const body = await response.json();
      expect(body.code).toBe('generation_timeout');
      expect(body.failureClass).toBe('timeout');
      expect(body.attempts).toBe(3);
    } finally {
      setGenerationPolicy(FAST);
    }
    expect(Date.now() - started).toBeLessThan(3000);
    expect(model.calls).toBe(3);
    expect(model.signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('reports an unusable answer as invalid_model_response without retrying it', async () => {
    const model = new ScriptedModel([{ answers: () => 'Here are three lovely questions about scanning!' }]);
    setGenerationModel(model);
    const response = await generateNew();
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.code).toBe('invalid_model_response');
    expect(body.reason).toBe('invalid_json');
    expect(model.calls).toBe(1);
  });

  it('reports an unclassifiable model error as model_failed without retrying it', async () => {
    const model = new ScriptedModel([{ throws: new TypeError("Cannot read properties of undefined (reading 'candidates')") }]);
    setGenerationModel(model);
    const response = await generateNew();
    expect(response.status).toBe(502);
    expect((await response.json()).code).toBe('model_failed');
    expect(model.calls).toBe(1);
  });

  it('reports a server with no model key as a configuration error', async () => {
    setGenerationModel(null);
    const saved = { key: process.env.GEMINI_API_KEY, fixture: process.env.BOOK_TO_TEST_FIXTURE_RESPONSE };
    delete process.env.GEMINI_API_KEY;
    delete process.env.BOOK_TO_TEST_FIXTURE_RESPONSE;
    try {
      const response = await generateNew();
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.code).toBe('model_configuration_error');
      expect(body.reason).toBe('missing_api_key');
    } finally {
      if (saved.key !== undefined) process.env.GEMINI_API_KEY = saved.key;
      if (saved.fixture !== undefined) process.env.BOOK_TO_TEST_FIXTURE_RESPONSE = saved.fixture;
    }
  });

  it('refuses a request without a usable request id', async () => {
    setGenerationModel(new ScriptedModel([{ answers: answersWell }]));
    const beforeCount = await readingCount();
    const missing = await generate(scanningRequest);
    expect(missing.status).toBe(400);
    expect((await missing.json()).code).toBe('request_id_required');
    const malformed = await generate({ ...scanningRequest, requestId: 'short' });
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).code).toBe('invalid_request_id');
    expect(await readingCount()).toBe(beforeCount);
  });
});

describe('a failed generation leaves no draft, and a run an operator can read', () => {
  it('records when, what, which source, how it failed, how many attempts and which model', async () => {
    setGenerationModel(new ScriptedModel([{ throws: apiError(503, 'UNAVAILABLE') }]));
    const requestId = randomUUID();
    const beforeCount = await readingCount();
    const response = await generate({ requestId, ...scanningRequest });
    expect(response.status).toBe(503);
    expect(await readingCount()).toBe(beforeCount);

    const run = await latestRun();
    expect(run.requestId).toBe(requestId);
    expect(run.sourceId).toBe(source.id);
    expect(run.sourceTitle).toBe(source.title);
    expect(run.request).toEqual({ topic: SCANNING_TOPIC, questionType: 'short_answer', count: 1, module: 'academic', targetBand: '7.0' });
    expect(run.outcome).toBe('failed');
    expect(run.failure.code).toBe('model_unavailable');
    expect(run.failure.failureClass).toBe('unavailable');
    expect(run.attempts).toBe(3);
    expect(run.modelCalled).toBe(true);
    expect(run.model).toBe('scripted-model');
    expect(run.generatorVersion).toBe(GENERATOR_VERSION);
    expect(run.promptVersion).toBe(PROMPT_VERSION);
    expect(run.materialId).toBe(undefined);
    expect(Date.parse(run.finishedAt) >= Date.parse(run.startedAt)).toBe(true);
    expect(run.retrieval.hits.length).toBeGreaterThan(0);
  });

  it('logs a request that never reached the model, and says so', async () => {
    const model = new ScriptedModel([{ answers: answersWell }]);
    setGenerationModel(model);
    const response = await generateNew({ topic: 'photosynthesis in marine algae' });
    expect(response.status).toBe(422);
    const run = await latestRun();
    expect(run.failure.code).toBe('no_relevant_source');
    expect(run.modelCalled).toBe(false);
    expect(model.calls).toBe(0);
  });

  it('withholds a provider message that quotes the source text', async () => {
    setGenerationModel(new ScriptedModel([{ throws: apiError(400, 'INVALID_ARGUMENT', `Request contains an invalid part: ${SCANNING_QUOTE}`) }]));
    const response = await generateNew();
    const body = await response.json();
    expect(body.code).toBe('model_configuration_error');
    expect(body.error).toContain('withheld');
    expect(JSON.stringify(body).includes(SCANNING_QUOTE)).toBe(false);
  });

  it('keeps no source text and no prompt in the stored log', async () => {
    const stored = readFileSync(path.join(tempRoot, 'data', 'admin_content', 'generation_runs.json'), 'utf8');
    expect(stored.includes(SCANNING_QUOTE)).toBe(false);
    expect(stored.includes('<<<EXCERPT')).toBe(false);
    for (const chunk of await sourceStore.getChunks(source.id)) {
      expect(stored.includes(chunk.text.slice(0, 60))).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Request identity                                                            */
/* -------------------------------------------------------------------------- */

describe('the same request never creates a second draft', () => {
  it('replays the existing draft when the same request arrives again', async () => {
    const model = new ScriptedModel([{ answers: answersWell }]);
    setGenerationModel(model);
    const requestId = randomUUID();
    const beforeCount = await readingCount();

    const first = await generate({ requestId, ...scanningRequest });
    expect(first.status).toBe(201);
    const created = await first.json();

    const again = await generate({ requestId, ...scanningRequest });
    expect(again.status).toBe(200);
    const replayed = await again.json();
    expect(replayed.replayed).toBe(true);
    expect(replayed.materialId).toBe(created.materialId);
    expect(replayed.generation.generationId).toBe(created.generation.generationId);
    expect(replayed.questions.map((item: { status: string }) => item.status)).toEqual(
      created.questions.map((item: { status: string }) => item.status),
    );

    expect(model.calls).toBe(1);
    expect(await readingCount()).toBe(beforeCount + 1);
  });

  it('lets only one of two simultaneous arrivals run', async () => {
    const model = new ScriptedModel([{ answers: answersWell, afterMs: 150 }]);
    setGenerationModel(model);
    const requestId = randomUUID();
    const beforeCount = await readingCount();

    const responses = await Promise.all([
      generate({ requestId, ...scanningRequest }),
      generate({ requestId, ...scanningRequest }),
    ]);
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([201, 409]);
    const blocked = await responses.find((response) => response.status === 409)!.json();
    expect(blocked.code).toBe('generation_in_progress');
    expect(model.calls).toBe(1);
    expect(await readingCount()).toBe(beforeCount + 1);

    const later = await generate({ requestId, ...scanningRequest });
    expect(later.status).toBe(200);
    expect(await readingCount()).toBe(beforeCount + 1);
  });

  it('treats two deliberate requests for the same thing as two requests', async () => {
    const model = new ScriptedModel([{ answers: answersWell }]);
    setGenerationModel(model);
    const beforeCount = await readingCount();
    const one = await (await generateNew()).json();
    const two = await (await generateNew()).json();
    expect(one.materialId === two.materialId).toBe(false);
    expect(model.calls).toBe(2);
    expect(await readingCount()).toBe(beforeCount + 2);
  });

  it('refuses a request id reused for a different request', async () => {
    const model = new ScriptedModel([{ answers: answersWell }]);
    setGenerationModel(model);
    const requestId = randomUUID();
    expect((await generate({ requestId, ...scanningRequest })).status).toBe(201);
    const beforeCount = await readingCount();

    const reused = await generate({ requestId, ...scanningRequest, count: 2 });
    expect(reused.status).toBe(409);
    expect((await reused.json()).code).toBe('request_id_reused');
    expect(model.calls).toBe(1);
    expect(await readingCount()).toBe(beforeCount);
  });

  it('runs a failed request again when it is retried, and then only once', async () => {
    const model = new ScriptedModel([
      { throws: apiError(503, 'UNAVAILABLE') },
      { throws: apiError(503, 'UNAVAILABLE') },
      { throws: apiError(503, 'UNAVAILABLE') },
      { answers: answersWell },
    ]);
    setGenerationModel(model);
    const requestId = randomUUID();
    const beforeCount = await readingCount();

    expect((await generate({ requestId, ...scanningRequest })).status).toBe(503);
    expect((await generate({ requestId, ...scanningRequest })).status).toBe(201);
    expect((await generate({ requestId, ...scanningRequest })).status).toBe(200);

    expect(model.calls).toBe(4);
    expect(await readingCount()).toBe(beforeCount + 1);
    expect((await generationLog.getRequest(requestId))?.runs).toBe(2);
  });

  it('runs a request again once the draft it made has been deleted', async () => {
    setGenerationModel(new ScriptedModel([{ answers: answersWell }]));
    const requestId = randomUUID();
    const first = await (await generate({ requestId, ...scanningRequest })).json();
    expect(await adminStore.deleteMaterial('reading', first.materialId)).toBe(true);

    const again = await generate({ requestId, ...scanningRequest });
    expect(again.status).toBe(201);
    const second = await again.json();
    expect(second.materialId === first.materialId).toBe(false);
  });

  it('lets a run that died stop blocking its request once its lease lapses', () => {
    const request = { requestId: 'request-lease-0001', fingerprint: 'f'.repeat(64), sourceId: 'src-1' };
    const running = decideClaim(undefined, request, 1_000, 500);
    expect(running.kind).toBe('claimed');
    expect(decideClaim(running.entry, request, 1_400, 500).kind).toBe('in_progress');
    expect(decideClaim(running.entry, request, 1_600, 500).kind).toBe('claimed');
    expect(decideClaim(running.entry, { ...request, fingerprint: 'e'.repeat(64) }, 1_400, 500).kind).toBe('conflict');
  });
});

/* -------------------------------------------------------------------------- */
/* Fixture parity                                                              */
/* -------------------------------------------------------------------------- */

describe('the fixture model is only a replacement for the call', () => {
  const publishCodes = async (materialId: string) => {
    const response = await api(`/api/admin/materials/reading/${materialId}/publish`, { method: 'POST' });
    const body = await response.json();
    return { status: response.status, codes: (body.blockers ?? []).map((blocker: { code: string }) => blocker.code).sort() };
  };

  it('ends a fixture response and the same text from another model in the same draft and the same gate', async () => {
    const chunk = (await sourceStore.getChunks(source.id)).find((item) => item.text.includes('proper nouns'))!;
    const text = goodResponseFor(chunk.id);
    const fixtureFile = path.join(tempRoot, 'parity-response.json');
    writeFileSync(fixtureFile, text);

    setGenerationModel(new ScriptedModel([{ answers: () => text }]));
    const viaDouble = await (await generateNew({ targetBand: '6.5' })).json();

    setGenerationModel(null);
    process.env.BOOK_TO_TEST_FIXTURE_RESPONSE = fixtureFile;
    let viaFixture;
    try {
      const response = await generateNew({ targetBand: '6.5' });
      expect(response.status).toBe(201);
      viaFixture = await response.json();
    } finally {
      delete process.env.BOOK_TO_TEST_FIXTURE_RESPONSE;
    }

    expect(viaFixture.generation.model).toBe('fixture:parity-response.json');
    const shape = (body: typeof viaDouble) =>
      body.generation.questions.map((entry: { status: string; groundingVerdict?: unknown; qualityVerdict?: unknown }) => [
        entry.status,
        entry.groundingVerdict,
        entry.qualityVerdict,
      ]);
    expect(shape(viaFixture)).toEqual(shape(viaDouble));

    const stored = async (id: string) => {
      const material = await adminStore.getMaterial('reading', id);
      if (!material || material.section !== 'reading') throw new Error('expected a reading draft');
      return material;
    };
    const [a, b] = [await stored(viaDouble.materialId), await stored(viaFixture.materialId)];
    expect(a.status).toBe('draft');
    expect(b.status).toBe('draft');
    expect(b.content.passage.questions.map(questionContentHash)).toEqual(a.content.passage.questions.map(questionContentHash));
    expect(await publishCodes(b.id)).toEqual(await publishCodes(a.id));
  });

  it('puts a scripted fixture through the same retries as any other model', async () => {
    const chunk = (await sourceStore.getChunks(source.id)).find((item) => item.text.includes('proper nouns'))!;
    const fixtureFile = path.join(tempRoot, 'retry-script.json');
    writeFileSync(
      fixtureFile,
      JSON.stringify({ fixtureScript: 1, steps: [{ error: { status: 503, message: 'UNAVAILABLE' } }, { text: goodResponseFor(chunk.id) }] }),
    );
    setGenerationModel(null);
    process.env.BOOK_TO_TEST_FIXTURE_RESPONSE = fixtureFile;
    try {
      const response = await generateNew({ targetBand: '5.5' });
      expect(response.status).toBe(201);
      expect((await response.json()).attempts).toBe(2);
    } finally {
      delete process.env.BOOK_TO_TEST_FIXTURE_RESPONSE;
    }
  });

  it('has no fixture branch anywhere past the model call', () => {
    const files = [
      'src/services/bookToTest/generate.ts',
      'src/services/bookToTest/validate.ts',
      'src/services/bookToTest/reviewAdapter.ts',
      'src/services/bookToTest/reliability.ts',
      'src/services/publishGate.ts',
      'src/services/adminStore.ts',
      'src/routes/sourceRoutes.ts',
    ];
    for (const file of files) {
      const text = readFileSync(path.join(originalCwd, file), 'utf8');
      expect(/BOOK_TO_TEST_FIXTURE|FixtureGenerationModel|fixture:/.test(text)).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Provenance, versions and review labels                                      */
/* -------------------------------------------------------------------------- */

describe('a reviewer can tell which implementation produced a question', () => {
  let materialId = '';
  let requestId = '';

  /**
   * The good question, and one whose answer is in the passage but not in the text
   * it cites — flagged, not rejected — so the review screen opens a row, as it
   * does for anything needing attention, and shows that question's own stamp.
   */
  const answersWithOneFlagged = (request: ModelRequest) => {
    const chunkId = scanningChunkIdIn(request.prompt);
    const good: unknown = JSON.parse(goodResponseFor(chunkId)).questions[0];
    const flagged = {
      type: 'short_answer',
      prompt: 'How does the book describe scanning compared with skimming?',
      wordLimit: 'NO MORE THAN THREE WORDS',
      correctAnswer: 'opposite movement',
      questionEvidence: [{ chunkId, quote: SCANNING_QUOTE }],
      answerEvidence: [{ chunkId, quote: SCANNING_QUOTE }],
    };
    return JSON.stringify({ questions: [good, flagged] });
  };

  before(async () => {
    setGenerationModel(new ScriptedModel([{ answers: answersWithOneFlagged }]));
    requestId = randomUUID();
    const response = await generate({ requestId, ...scanningRequest, count: 2, targetBand: '8.0' });
    expect(response.status).toBe(201);
    materialId = (await response.json()).materialId;
  });

  const stored = async () => {
    const material = await adminStore.getMaterial('reading', materialId);
    if (!material || material.section !== 'reading' || !material.content.generationRecord) throw new Error('expected a generated draft');
    return material;
  };

  it('records generator, prompt and model versions on the generation and on every question', async () => {
    const material = await stored();
    const record = material.content.generationRecord!;
    expect(record.generatorVersion).toBe(GENERATOR_VERSION);
    expect(record.promptVersion).toBe(PROMPT_VERSION);
    expect(record.model).toBe('scripted-model');
    expect(record.modelVersion).toBe('scripted-001');
    expect(record.requestId).toBe(requestId);
    expect(record.attempts).toBe(1);
    for (const question of material.content.passage.questions) {
      expect(question.provenance?.generatorVersion).toBe(GENERATOR_VERSION);
      expect(question.provenance?.promptVersion).toBe(PROMPT_VERSION);
      expect(question.provenance?.model).toBe('scripted-model');
      expect(question.provenance?.modelVersion).toBe('scripted-001');
    }
  });

  it('keeps the record’s versions when the draft is saved with different ones', async () => {
    const material = structuredClone(await stored());
    material.content.generationRecord = { ...material.content.generationRecord!, generatorVersion: 'forged/9.9.9', model: 'forged-model' };
    const response = await api(`/api/admin/materials/reading/${materialId}`, { method: 'PUT', body: JSON.stringify(material) });
    expect(response.status).toBe(200);
    const record = (await stored()).content.generationRecord!;
    expect(record.generatorVersion).toBe(GENERATOR_VERSION);
    expect(record.model).toBe('scripted-model');
  });

  const renderReview = (state: ReturnType<typeof buildReviewState>) =>
    renderToStaticMarkup(
      createElement(AdminImportReview, { state, onChange: () => {}, onSaveDraft: async () => {}, onCancel: () => {} }),
    );

  it('shows those versions, and calls it a generated draft, on the review screen', async () => {
    const response = await api(`/api/admin/sources/generated/${materialId}/review`);
    expect(response.status).toBe(200);
    const input = await response.json();
    const state = setClassification(
      buildReviewState(input.result, {
        sourceHtml: input.sourceHtml,
        materialId: input.materialId,
        generationRecord: input.generationRecord,
        generationReviews: input.generationReviews,
      }),
      { section: 'reading', ...input.classification },
    );
    const html = renderReview(state);

    expect(html).toContain('data-review-kind="generated"');
    expect(html).toContain('Generated draft');
    expect(html).toContain('Review generated draft');
    expect(html).toContain(`data-generator-version="${GENERATOR_VERSION}"`);
    expect(html).toContain(`data-prompt-version="${PROMPT_VERSION}"`);
    expect(html).toContain('data-model-version="scripted-001"');
    expect(html).toContain('data-question-versions');
    for (const wording of ['Review imported material', 'Imported material', 'Discard import', 'This import', 'What the parser reported']) {
      expect(html.includes(wording)).toBe(false);
    }
  });

  it('still calls an imported page imported material', () => {
    const html = readFileSync(path.join(originalCwd, 'tests', 'fixtures', 'cdi', 'reading-markers.html'), 'utf8');
    let counter = 0;
    const result = importCdiHtml(html, {
      resolveAsset: (asset) => (asset.origin === 'inline' ? `ast_boundary${String(++counter).padStart(8, '0')}` : null),
    });
    const markup = renderReview(buildReviewState(result, { sourceHtml: html, sourceAssetId: 'ast_source000000001' }));
    expect(markup).toContain('data-review-kind="imported"');
    expect(markup).toContain('Imported material');
    expect(markup).toContain('Review imported material');
    expect(markup.includes('Generated draft')).toBe(false);
    expect(markup.includes('data-generation-versions')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The real-model smoke verdict                                                */
/* -------------------------------------------------------------------------- */

describe('a real-model smoke run never reports an outage as a pass', () => {
  const passingBody = {
    status: 'draft_created',
    materialId: 'adm-rea-1-abc',
    materialStatus: 'draft',
    generation: { model: GENERATION_MODEL, modelVersion: 'gemini-3.8-flash-001', generatorVersion: GENERATOR_VERSION, promptVersion: PROMPT_VERSION, attempts: 1 },
    retrieved: [{ chunkId: 'c1' }],
    questions: [{ status: 'valid' }],
  };

  it('calls a 503, a timeout or a quota error unavailable', () => {
    for (const [status, code] of [[503, 'model_unavailable'], [504, 'generation_timeout'], [429, 'quota_exceeded']] as const) {
      const verdict = smokeVerdict(status, { code, error: 'busy', attempts: 2 }, GENERATION_MODEL);
      expect(verdict.result).toBe('real_model_unavailable');
      expect(verdict.result === 'real_model_passed').toBe(false);
    }
  });

  it('passes only a real-model draft that went through retrieval and validation', () => {
    expect(smokeVerdict(201, passingBody, GENERATION_MODEL).result).toBe('real_model_passed');
    expect(smokeVerdict(201, { ...passingBody, generation: { ...passingBody.generation, model: 'fixture:x.json' } }, GENERATION_MODEL).result).toBe('real_model_failed');
    expect(smokeVerdict(201, { ...passingBody, retrieved: [] }, GENERATION_MODEL).result).toBe('real_model_failed');
    expect(smokeVerdict(201, { ...passingBody, materialStatus: 'published' }, GENERATION_MODEL).result).toBe('real_model_failed');
    expect(smokeVerdict(200, { ...passingBody, replayed: true }, GENERATION_MODEL).result).toBe('real_model_failed');
  });

  it('separates a broken pipeline and a missing key from an outage', () => {
    expect(smokeVerdict(422, { code: 'all_rejected' }, GENERATION_MODEL).result).toBe('real_model_failed');
    expect(smokeVerdict(502, { code: 'invalid_model_response', reason: 'invalid_json' }, GENERATION_MODEL).result).toBe('real_model_failed');
    expect(smokeVerdict(500, { code: 'model_configuration_error', reason: 'missing_api_key' }, GENERATION_MODEL).result).toBe('real_model_not_configured');
    expect(new Set(Object.values(SMOKE_EXIT_CODES)).size).toBe(4);
    expect(SMOKE_EXIT_CODES.real_model_passed).toBe(0);
  });
});
