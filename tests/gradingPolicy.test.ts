import './env';
import { after, beforeEach, describe, it } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GenerateContentParameters } from '@google/genai';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';

/**
 * The grading policy (H7): every Writing and Speaking grading call is bounded in
 * time and in attempts, a rate limit or a permanent refusal is never tried again,
 * the fallback models are the retries rather than a loop around them, and one
 * call charges the learner's AI allowance once.
 *
 * Only the provider's request is replaced. Everything above it — the input checks,
 * the allowance, `callWithRetryPolicy`, parsing and the refusal a caller sees — is
 * the production code.
 */
const originalCwd = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-grading-policy-'));
process.chdir(tempRoot);

const grading = await import('../src/services/grading');
const retry = await import('../prompts/geminiRetry');
const { aiRateLimitService } = await import('../src/services/aiRateLimitService');

/* ------------------------------------------------------------------ allowance */

const charged: string[] = [];
let allowanceLeft = true;
const originalCheck = aiRateLimitService.checkLimit.bind(aiRateLimitService);
aiRateLimitService.checkLimit = async (userId, operation) => {
  charged.push(operation);
  const outcome = await originalCheck(userId, operation);
  return allowanceLeft ? outcome : { ...outcome, allowed: false, reason: 'Hourly AI limit reached (4).' };
};
let learner = 0;
/** A learner of their own per test, so the real hourly allowance never runs out under the suite. */
const context = () => ({ userId: `usr_policyLearner${String(++learner).padStart(3, '0')}` });

/* ------------------------------------------------------------------- provider */

interface ProviderCall {
  model: string;
  signal?: AbortSignal;
}
const calls: ProviderCall[] = [];
let behave: (call: number, request: GenerateContentParameters) => Promise<{ text: string }> = async () => ({ text: '' });
const testProvider = {
  name: 'test',
  generate: (request: GenerateContentParameters) => {
    calls.push({ model: request.model, signal: request.config?.abortSignal });
    return behave(calls.length, request);
  },
};
grading.setGradingProvider(testProvider);

const apiError = (status: number, statusText: string) =>
  Object.assign(new Error(JSON.stringify({ error: { code: status, message: 'upstream said no', status: statusText } })), { status });
/** A request that answers only by failing when it is aborted. */
const hang = (request: GenerateContentParameters) =>
  new Promise<{ text: string }>((_resolve, reject) => {
    const signal = request.config?.abortSignal;
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
/** A request that ignores its abort signal and never settles. */
const never = () => new Promise<{ text: string }>(() => undefined);
const assessment = (band: unknown) => JSON.stringify({ band_overall: band, criteria: [], annotated_text: [], general_commentary: 'Fixture.' });

const ESSAY =
  'Energy use rose steadily across the period shown in the chart, with coal falling from almost half of all supply to under a fifth, while wind rose sharply after 2010 and overtook gas by the final year, so the overall mix became far cleaner than it had been at the start.';
const writing = { taskType: 'task1', prompt: 'Summarise the chart of energy use.', essay: ESSAY, module: 'academic' };
const MODELS = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash'];

beforeEach(() => {
  calls.length = 0;
  charged.length = 0;
  allowanceLeft = true;
  behave = async () => ({ text: assessment(6.5) });
  grading.setGradingPolicy({ attemptTimeoutMs: 200, totalTimeoutMs: 2_000, initialDelayMs: 0, maxDelayMs: 0 });
});

after(() => {
  grading.setGradingPolicy(null);
  grading.setGradingProvider(null);
  aiRateLimitService.checkLimit = originalCheck;
  process.chdir(originalCwd);
  removeTempRoot(tempRoot);
});

const refusalOf = <T>(outcome: { ok: true; result: T } | { ok: false; status: number; body: { code?: string }; failure: string }) =>
  outcome.ok ? ['ok'] : [outcome.status, outcome.body.code, outcome.failure];

describe('a grading call is bounded in time', () => {
  it('abandons each attempt at its timeout, aborts its request, and ends well inside the total budget', async () => {
    grading.setGradingPolicy({ attemptTimeoutMs: 60, totalTimeoutMs: 1_500, initialDelayMs: 0, maxDelayMs: 0 });
    behave = (_call, request) => hang(request);
    const started = Date.now();
    const outcome = await grading.gradeWritingSubmission(writing, context());
    expect(refusalOf(outcome)).toEqual([504, 'grading_timeout', 'timeout']);
    expect(calls.map((entry) => entry.model)).toEqual(MODELS);
    expect(calls.map((entry) => entry.signal?.aborted)).toEqual([true, true, true]);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(charged).toEqual(['writing_grade']);
  });

  it('abandons a request that ignores its abort signal just the same', async () => {
    grading.setGradingPolicy({ attemptTimeoutMs: 60, totalTimeoutMs: 1_500, initialDelayMs: 0, maxDelayMs: 0 });
    behave = never;
    const started = Date.now();
    expect(refusalOf(await grading.gradeWritingSubmission(writing, context()))).toEqual([504, 'grading_timeout', 'timeout']);
    expect(calls).toHaveLength(3);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('cuts the running attempt short when the total budget runs out, and starts no other', async () => {
    grading.setGradingPolicy({ attemptTimeoutMs: 60_000, totalTimeoutMs: 150, initialDelayMs: 0, maxDelayMs: 0 });
    behave = never;
    const started = Date.now();
    expect(refusalOf(await grading.gradeWritingSubmission(writing, context()))).toEqual([504, 'grading_timeout', 'timeout']);
    expect(calls).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('asks the next model when an attempt times out, and records the model that answered', async () => {
    grading.setGradingPolicy({ attemptTimeoutMs: 60, totalTimeoutMs: 1_500, initialDelayMs: 0, maxDelayMs: 0 });
    behave = (call, request) => (call === 1 ? hang(request) : Promise.resolve({ text: assessment(6.5) }));
    const outcome = await grading.gradeWritingSubmission(writing, context());
    expect(outcome.ok && [outcome.result.band_overall, outcome.model]).toEqual([6.5, 'test/gemini-3.7-flash']);
    expect(calls.map((entry) => entry.model)).toEqual(MODELS.slice(0, 2));
  });

  it('bounds Speaking grading the same way', async () => {
    grading.setGradingPolicy({ attemptTimeoutMs: 60, totalTimeoutMs: 1_500, initialDelayMs: 0, maxDelayMs: 0 });
    behave = (_call, request) => hang(request);
    const outcome = await grading.gradeSpeakingSubmission(
      { partNumber: 1, topic: 'Home', transcriptProvided: 'I live in a small flat near the river, and I like the quiet evenings there most of all.' },
      context(),
    );
    expect(refusalOf(outcome)).toEqual([504, 'grading_timeout', 'timeout']);
    expect(charged).toEqual(['speaking_grade']);
  });

  it('keeps the production policy inside its bounds, and a grading lease longer than the call', () => {
    grading.setGradingPolicy(null);
    const policy = grading.getGradingPolicy();
    expect([policy.maxAttempts, policy.attemptTimeoutMs, policy.totalTimeoutMs]).toEqual([3, 45_000, 100_000]);
    expect(policy.retryOn).toEqual(['unavailable', 'timeout']);
    expect(grading.gradingLeaseMs()).toBeGreaterThan(policy.totalTimeoutMs);
    grading.setGradingPolicy({ attemptTimeoutMs: 10_000_000, totalTimeoutMs: 10_000_000, maxAttempts: 50 });
    const clamped = grading.getGradingPolicy();
    expect([clamped.maxAttempts, clamped.attemptTimeoutMs, clamped.totalTimeoutMs]).toEqual([3, 120_000, 180_000]);
  });
});

describe('retries are bounded, and a rate limit is never retried', () => {
  it('tries a 503 once per fallback model, three at most, for one allowance unit', async () => {
    behave = async () => {
      throw apiError(503, 'UNAVAILABLE');
    };
    expect(refusalOf(await grading.gradeWritingSubmission(writing, context()))).toEqual([503, 'ai_unavailable', 'unavailable']);
    expect(calls.map((entry) => entry.model)).toEqual(MODELS);
    expect(charged).toEqual(['writing_grade']);
  });

  it('grades on the next model after a 503', async () => {
    behave = async (call) => {
      if (call === 1) throw apiError(503, 'UNAVAILABLE');
      return { text: assessment(7) };
    };
    const outcome = await grading.gradeWritingSubmission(writing, context());
    expect(outcome.ok && [outcome.result.band_overall, outcome.model]).toEqual([7, 'test/gemini-3.7-flash']);
    expect(charged).toEqual(['writing_grade']);
  });

  it('makes no more attempts than there are models, however it is configured', async () => {
    grading.setGradingPolicy({ maxAttempts: 10, attemptTimeoutMs: 200, totalTimeoutMs: 2_000, initialDelayMs: 0, maxDelayMs: 0 });
    behave = async () => {
      throw apiError(503, 'UNAVAILABLE');
    };
    await grading.gradeWritingSubmission(writing, context());
    expect(calls).toHaveLength(3);
  });

  it('does not retry a 429, and says it was the rate limit', async () => {
    behave = async () => {
      throw apiError(429, 'RESOURCE_EXHAUSTED');
    };
    expect(refusalOf(await grading.gradeWritingSubmission(writing, context()))).toEqual([429, 'quota_exceeded', 'quota']);
    expect(calls).toHaveLength(1);
    expect(charged).toEqual(['writing_grade']);
  });

  it('does not retry a permanent refusal', async () => {
    for (const [status, text] of [[400, 'INVALID_ARGUMENT'], [401, 'UNAUTHENTICATED'], [403, 'PERMISSION_DENIED']] as const) {
      calls.length = 0;
      behave = async () => {
        throw apiError(status, text);
      };
      const outcome = await grading.gradeWritingSubmission(writing, context());
      expect([status, outcome.ok, calls.length]).toEqual([status, false, 1]);
    }
  });

  it('asks no model when the learner’s allowance is used up, and says it was the allowance', async () => {
    allowanceLeft = false;
    expect(refusalOf(await grading.gradeWritingSubmission(writing, context()))).toEqual([429, 'quota_exceeded', 'quota']);
    expect(calls).toHaveLength(0);
  });

  it('charges nothing and asks no model for work too short to grade', async () => {
    const outcome = await grading.gradeWritingSubmission({ ...writing, essay: 'Far too short to grade.' }, context());
    expect(refusalOf(outcome)).toEqual([400, 'too_short', 'rejected']);
    expect([calls.length, charged.length]).toEqual([0, 0]);
  });

  it('turns an unusable answer from a fallback model into a refusal, never a band', async () => {
    for (const answer of [assessment(11), assessment('7'), assessment(null), 'not json at all']) {
      calls.length = 0;
      behave = async (call) => {
        if (call === 1) throw apiError(503, 'UNAVAILABLE');
        return { text: answer };
      };
      const outcome = await grading.gradeWritingSubmission(writing, context());
      expect([answer, ...refusalOf(outcome)]).toEqual([answer, 502, 'invalid_model_response', 'invalid_response']);
      expect(calls).toHaveLength(2);
    }
  });
});

describe('the other grading-class calls, and the shared entry point', () => {
  it('ends a rewrite or transcription on a 429 at once, and on exhaustion as unavailable', async () => {
    let attempts = 0;
    const quota = await grading
      .gradeWithFallback(async () => {
        attempts += 1;
        throw apiError(429, 'RESOURCE_EXHAUSTED');
      }, 'writing_grade')
      .catch((error: unknown) => error);
    expect([quota instanceof retry.AiQuotaExceededError, attempts]).toEqual([true, 1]);

    attempts = 0;
    const busy = await grading
      .gradeWithFallback(async () => {
        attempts += 1;
        throw apiError(503, 'UNAVAILABLE');
      }, 'writing_grade')
      .catch((error: unknown) => error);
    expect([busy instanceof retry.AiUnavailableError, attempts]).toEqual([true, 3]);

    grading.setGradingPolicy({ attemptTimeoutMs: 60, totalTimeoutMs: 1_500, initialDelayMs: 0, maxDelayMs: 0 });
    const slow = await grading.gradeWithFallback(() => never(), 'writing_grade').catch((error: unknown) => error);
    expect(slow instanceof retry.AiUnavailableError && slow.failureClass).toBe('timeout');
  });

  it('does not retry a rate limit in executeGeminiWithRetry either', async () => {
    let attempts = 0;
    const refused = await retry
      .executeGeminiWithRetry(async () => {
        attempts += 1;
        throw apiError(429, 'RESOURCE_EXHAUSTED');
      }, 2, 1)
      .catch((error: unknown) => error);
    expect(attempts).toBe(1);
    expect(refused instanceof retry.AiUnavailableError && refused.failureClass).toBe('quota');
    expect(retry.EXECUTE_ATTEMPT_TIMEOUT_MS).toBeLessThan(retry.EXECUTE_TOTAL_TIMEOUT_MS);
  });
});

describe('the fixture model stands in for the provider request only', () => {
  it('replays a scripted 503 then an answer through the real policy, and is refused in production', async () => {
    const script = path.join(tempRoot, 'grading-script.json');
    writeFileSync(
      script,
      JSON.stringify({ fixtureScript: 1, steps: [{ error: { status: 503 } }, { response: { band_overall: 6, criteria: [], annotated_text: [], general_commentary: 'Scripted.' } }] }),
      'utf8',
    );
    grading.setGradingProvider(null);
    process.env.GRADING_FIXTURE_RESPONSE = script;
    try {
      const outcome = await grading.gradeWritingSubmission(writing, context());
      expect(outcome.ok && [outcome.result.band_overall, outcome.model]).toEqual([6, 'fixture:grading-script.json/gemini-3.7-flash']);
      expect(charged).toEqual(['writing_grade']);

      process.env.NODE_ENV = 'production';
      const refused = await grading.gradeWritingSubmission(writing);
      expect(refused.ok).toBe(false);
    } finally {
      process.env.NODE_ENV = 'test';
      delete process.env.GRADING_FIXTURE_RESPONSE;
      grading.setGradingProvider(testProvider);
    }
  });
});
