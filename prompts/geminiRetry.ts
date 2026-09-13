import { requestContext } from '../src/middleware/authMiddleware';
import { aiRateLimitService, AiOperationType } from '../src/services/aiRateLimitService';

/**
 * The reliability boundary every Gemini call on this server goes through.
 *
 * Two jobs, kept apart:
 *
 * - `classifyModelError` says what kind of failure an error is, from the
 *   status the SDK reports rather than from words in a message where it can.
 * - `callWithRetryPolicy` runs an operation under an explicit policy: how many
 *   attempts in total, how long each may take, how long the whole call may
 *   take, and which failure classes are worth another attempt at all.
 *
 * A permanent failure — a rejected key, a model that does not exist, a request
 * the API calls invalid — is never retried: the second attempt is the same
 * request and gets the same answer. Every loop here ends after a fixed number
 * of attempts whatever the error says.
 */

export type ModelFailureClass =
  /** Overloaded, 5xx, or the connection dropped: worth another attempt. */
  | 'unavailable'
  /** An attempt, or the whole call, ran out of time. */
  | 'timeout'
  /** A quota or rate limit, the provider's or this server's own. */
  | 'quota'
  /** The model answered with something that is not a usable response. */
  | 'invalid_response'
  /** Configuration or request errors that no retry can fix. */
  | 'permanent'
  | 'unknown';

const FAILURE_CLASSES: readonly ModelFailureClass[] = [
  'unavailable',
  'timeout',
  'quota',
  'invalid_response',
  'permanent',
  'unknown',
];

/**
 * Raised when the model itself is unreachable — overloaded, rate limited or
 * timing out — as opposed to the request being wrong. Callers use this to tell
 * a learner "try again in a minute" instead of "grading failed".
 */
export class AiUnavailableError extends Error {
  constructor(
    message: string,
    readonly failureClass: ModelFailureClass = 'unavailable',
  ) {
    super(message);
    this.name = 'AiUnavailableError';
  }
}

/** This server's own per-user AI allowance said no. The model was never called. */
export class AiQuotaExceededError extends Error {
  readonly failureClass = 'quota' as const;
  constructor(message: string) {
    super(message);
    this.name = 'AiQuotaExceededError';
  }
}

/** One attempt ran past its time budget and was abandoned. */
export class ModelTimeoutError extends Error {
  readonly failureClass = 'timeout' as const;
  constructor(readonly timeoutMs: number) {
    super(`The model did not answer within ${timeoutMs} ms.`);
    this.name = 'ModelTimeoutError';
  }
}

export interface ModelErrorInfo {
  failureClass: ModelFailureClass;
  /** The HTTP status the provider reported, when there was one. */
  status?: number;
  message: string;
}

const TIMEOUT_STATUSES = new Set([408, 504]);
const TRANSIENT_STATUSES = new Set([500, 502, 503]);
const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 405, 409, 412, 413, 422]);
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET']);

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value ? (value as Record<string, unknown>)[key] : undefined;
}

function statusOf(error: unknown, message: string): number | undefined {
  for (const key of ['status', 'statusCode', 'code']) {
    const value = field(error, key);
    if (typeof value === 'number' && value >= 100 && value <= 599) return value;
  }
  // The SDK's error message is the API's JSON body when no status field made it through.
  const match = message.match(/"code"\s*:\s*(\d{3})\b/) ?? message.match(/\bstatus(?: code)?:?\s+(\d{3})\b/i);
  return match ? Number(match[1]) : undefined;
}

export function isFailureClass(value: unknown): value is ModelFailureClass {
  return typeof value === 'string' && (FAILURE_CLASSES as readonly string[]).includes(value);
}

/** What kind of failure an error from a model call is. */
export function classifyModelError(error: unknown): ModelErrorInfo {
  const message = (error instanceof Error ? error.message : String(error ?? '')).slice(0, 2000);
  const name = error instanceof Error ? error.name : '';
  const status = statusOf(error, message);
  const code = String(field(error, 'code') ?? field(field(error, 'cause'), 'code') ?? '');
  const info = (failureClass: ModelFailureClass): ModelErrorInfo => ({ failureClass, status, message });

  // An error that already knows what it is — raised by this boundary, or by a
  // model adapter that checked for itself — is taken at its word.
  const declared = field(error, 'failureClass');
  if (isFailureClass(declared)) return info(declared);

  if (name === 'AbortError' || name === 'TimeoutError' || TIMEOUT_CODES.has(code)) return info('timeout');
  if (status !== undefined && TIMEOUT_STATUSES.has(status)) return info('timeout');
  if (status === 429 || /RESOURCE_EXHAUSTED/.test(message)) return info('quota');
  if (status !== undefined && PERMANENT_STATUSES.has(status)) return info('permanent');
  if (/INVALID_ARGUMENT|PERMISSION_DENIED|UNAUTHENTICATED|API_KEY_INVALID|API key not valid|FAILED_PRECONDITION/.test(message)) {
    return info('permanent');
  }
  if (status !== undefined && TRANSIENT_STATUSES.has(status)) return info('unavailable');
  if (NETWORK_CODES.has(code) || /UNAVAILABLE|overloaded|high demand|socket hang up|fetch failed|ECONNRESET/i.test(message)) {
    return info('unavailable');
  }
  if (/DEADLINE_EXCEEDED|\btime(?:d)? ?out\b/i.test(message)) return info('timeout');
  return info('unknown');
}

export interface RetryPolicy {
  /** Every attempt counts, the first included. Capped at `HARD_MAX_ATTEMPTS`. */
  maxAttempts: number;
  initialDelayMs: number;
  /** The backoff doubles after each failure, up to this. */
  maxDelayMs: number;
  /** Abandon a single attempt after this long. Omitted: no per-attempt limit. */
  attemptTimeoutMs?: number;
  /** Start no attempt, and cut the running one short, once the call has taken this long. */
  totalTimeoutMs?: number;
  /** Failure classes worth another attempt. Anything else ends the call at once. */
  retryOn: readonly ModelFailureClass[];
}

/** No policy, however configured, makes more attempts than this. */
export const HARD_MAX_ATTEMPTS = 6;

export interface AttemptRecord {
  attempt: number;
  ok: boolean;
  failureClass?: ModelFailureClass;
  status?: number;
  elapsedMs: number;
}

export interface CallReport {
  attempts: number;
  attemptLog: AttemptRecord[];
  elapsedMs: number;
}

/** The call gave up: the last failure's class, and every attempt that led there. */
export class ModelCallFailure extends Error {
  constructor(
    readonly info: ModelErrorInfo,
    readonly report: CallReport,
    readonly lastError: unknown,
  ) {
    super(info.message);
    this.name = 'ModelCallFailure';
  }

  get failureClass(): ModelFailureClass {
    return this.info.failureClass;
  }
}

export interface RetryHooks {
  /** Replaced in tests so a backoff does not have to be waited out. */
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (event: { attempt: number; info: ModelErrorInfo; delayMs: number }) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function runAttempt<T>(
  operation: (signal: AbortSignal, attempt: number) => Promise<T>,
  attempt: number,
  budgetMs: number | undefined,
): Promise<T> {
  const controller = new AbortController();
  if (budgetMs === undefined) return operation(controller.signal, attempt);

  return new Promise<T>((resolve, reject) => {
    const limit = Math.max(0, Math.round(budgetMs));
    // The race does not rely on the operation honouring the signal: an attempt
    // that ignores it is still abandoned on time.
    const timer = setTimeout(() => {
      const timeout = new ModelTimeoutError(limit);
      controller.abort(timeout);
      reject(timeout);
    }, limit);
    operation(controller.signal, attempt).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Runs `operation` under `policy`. Resolves with the value and a report of the
 * attempts it took; rejects with a `ModelCallFailure` carrying the same report.
 */
export async function callWithRetryPolicy<T>(
  operation: (signal: AbortSignal, attempt: number) => Promise<T>,
  policy: RetryPolicy,
  hooks: RetryHooks = {},
): Promise<{ value: T; report: CallReport }> {
  const maxAttempts = Math.max(1, Math.min(HARD_MAX_ATTEMPTS, Math.floor(policy.maxAttempts)));
  const sleep = hooks.sleep ?? defaultSleep;
  const started = Date.now();
  const attemptLog: AttemptRecord[] = [];
  let delay = Math.max(0, policy.initialDelayMs);

  for (let attempt = 1; ; attempt++) {
    const attemptStarted = Date.now();
    const remaining =
      policy.totalTimeoutMs === undefined ? undefined : policy.totalTimeoutMs - (attemptStarted - started);
    const budget =
      remaining === undefined
        ? policy.attemptTimeoutMs
        : policy.attemptTimeoutMs === undefined
          ? remaining
          : Math.min(policy.attemptTimeoutMs, remaining);

    try {
      const value = await runAttempt(operation, attempt, budget);
      attemptLog.push({ attempt, ok: true, elapsedMs: Date.now() - attemptStarted });
      return { value, report: { attempts: attempt, attemptLog, elapsedMs: Date.now() - started } };
    } catch (error) {
      const info = classifyModelError(error);
      attemptLog.push({
        attempt,
        ok: false,
        failureClass: info.failureClass,
        status: info.status,
        elapsedMs: Date.now() - attemptStarted,
      });

      const wait = Math.min(delay, Math.max(0, policy.maxDelayMs));
      const outOfTime =
        policy.totalTimeoutMs !== undefined && Date.now() - started + wait >= policy.totalTimeoutMs;
      if (attempt >= maxAttempts || !policy.retryOn.includes(info.failureClass) || outOfTime) {
        throw new ModelCallFailure(
          info,
          { attempts: attempt, attemptLog, elapsedMs: Date.now() - started },
          error,
        );
      }

      hooks.onRetry?.({ attempt, info, delayMs: wait });
      await sleep(wait);
      delay *= 2;
    }
  }
}

/**
 * Execute Gemini API calls with exponential backoff and a server-side AI guard.
 *
 * The long-standing entry point for grading, chat and mock generation. Its
 * contract is unchanged — `maxRetries` retries after the first attempt, an
 * `AiUnavailableError` when the model is unavailable, rate limited or timing
 * out, a plain error otherwise — but it now runs on the shared policy, so a
 * permanent failure is never retried and transient 5xx responses are.
 *
 * Every call is bounded (H7): no attempt outlasts `EXECUTE_ATTEMPT_TIMEOUT_MS`
 * and no call `EXECUTE_TOTAL_TIMEOUT_MS`. A rate limit is not retried: the next
 * attempt meets the same limit and spends a request finding out.
 */
export const EXECUTE_ATTEMPT_TIMEOUT_MS = 45_000;
export const EXECUTE_TOTAL_TIMEOUT_MS = 100_000;
export async function executeGeminiWithRetry<T>(operation: () => Promise<T>, maxRetries = 3, initialDelayMs = 1500, quotaOperation: AiOperationType = 'ai_request', quotaAlreadyChecked = false, activeModelForLog = 'gemini-3.8-flash'): Promise<T> {
  const userId = requestContext.getStore()?.userId;
  if (userId && !quotaAlreadyChecked) {
    const guard = await aiRateLimitService.checkLimit(userId, quotaOperation);
    if (!guard.allowed) throw new AiQuotaExceededError(guard.reason ?? 'AI limit reached.');
  }

  const recordUsage = async (success: boolean, notes: string) => {
    if (!userId) return;
    try {
      await aiRateLimitService.recordUsage({ userId, operation: quotaOperation, model: activeModelForLog, success, notes });
    } catch (logError) {
      console.error('[AI usage log]', logError);
    }
  };

  try {
    const { value, report } = await callWithRetryPolicy(() => operation(), {
      maxAttempts: maxRetries + 1,
      initialDelayMs,
      maxDelayMs: 30_000,
      attemptTimeoutMs: EXECUTE_ATTEMPT_TIMEOUT_MS,
      totalTimeoutMs: EXECUTE_TOTAL_TIMEOUT_MS,
      retryOn: ['unavailable', 'timeout'],
    }, {
      onRetry: ({ attempt, info, delayMs }) =>
        console.warn(
          `[Gemini API] Transient error (status ${info.status ?? info.failureClass}). Retrying attempt ${attempt}/${maxRetries} in ${delayMs}ms...`,
        ),
    });
    await recordUsage(true, `completed_after_${report.attempts} attempt${report.attempts === 1 ? '' : 's'}`);
    return value;
  } catch (error) {
    if (!(error instanceof ModelCallFailure)) throw error;
    const { attempts } = error.report;
    const message = error.info.message;
    await recordUsage(false, `failed_after_${attempts}_attempt${attempts === 1 ? '' : 's'}:${message.slice(0, 240) || 'unknown'}`);

    if (error.failureClass === 'quota') {
      throw new AiUnavailableError('Gemini API quota or rate limit reached. Please wait a moment before trying again.', 'quota');
    }
    if (error.failureClass === 'unavailable' || error.failureClass === 'timeout') {
      throw new AiUnavailableError(`AI model unavailable: ${message || 'upstream did not respond.'}`, error.failureClass);
    }
    throw new Error(`AI generation error: ${message || 'Unknown error occurred during synthesis.'}`);
  }
}
