import type { ModelFailureClass, RetryPolicy } from '../../../prompts/geminiRetry';

/**
 * How hard Book → Test tries before telling an admin the model is not answering,
 * and what it calls each way of failing.
 *
 * Retries live here, at the generation boundary, rather than inside the Gemini
 * adapter: the adapter makes one call, and every model — Gemini, the fixture,
 * a test double — gets the same attempts, the same time limits and the same
 * failure codes around it.
 *
 * Only `unavailable` and `timeout` are retried. A quota error is not: the next
 * attempt a second later meets the same limit and spends a request finding
 * out. A permanent error is not: it is the same request and gets the same
 * answer.
 */

export interface GenerationPolicy extends RetryPolicy {
  attemptTimeoutMs: number;
  totalTimeoutMs: number;
}

type Tunable = 'maxAttempts' | 'initialDelayMs' | 'maxDelayMs' | 'attemptTimeoutMs' | 'totalTimeoutMs';

const RETRY_ON: readonly ModelFailureClass[] = ['unavailable', 'timeout'];

export const DEFAULT_GENERATION_POLICY: Readonly<GenerationPolicy> = {
  maxAttempts: 3,
  initialDelayMs: 1500,
  maxDelayMs: 6000,
  attemptTimeoutMs: 60_000,
  totalTimeoutMs: 100_000,
  retryOn: RETRY_ON,
};

/** Whatever the environment or a test asks for, the policy stays inside these. */
const BOUNDS: Record<Tunable, readonly [number, number]> = {
  maxAttempts: [1, 4],
  initialDelayMs: [0, 10_000],
  maxDelayMs: [0, 30_000],
  attemptTimeoutMs: [1, 120_000],
  totalTimeoutMs: [1, 180_000],
};

const ENVIRONMENT: Record<Tunable, string> = {
  maxAttempts: 'BOOK_TO_TEST_MAX_ATTEMPTS',
  initialDelayMs: 'BOOK_TO_TEST_RETRY_DELAY_MS',
  maxDelayMs: 'BOOK_TO_TEST_MAX_RETRY_DELAY_MS',
  attemptTimeoutMs: 'BOOK_TO_TEST_ATTEMPT_TIMEOUT_MS',
  totalTimeoutMs: 'BOOK_TO_TEST_TOTAL_TIMEOUT_MS',
};

let override: Partial<Record<Tunable, number>> | null = null;

/** Replaces parts of the policy for the life of the process, or restores it with `null`. */
export function setGenerationPolicy(next: Partial<Record<Tunable, number>> | null): void {
  override = next;
}

const clamp = (value: number, [min, max]: readonly [number, number]) => Math.min(max, Math.max(min, value));

export function getGenerationPolicy(): GenerationPolicy {
  const policy: GenerationPolicy = { ...DEFAULT_GENERATION_POLICY, retryOn: RETRY_ON };
  for (const key of Object.keys(BOUNDS) as Tunable[]) {
    const raw = process.env[ENVIRONMENT[key]];
    const fromEnvironment = raw !== undefined && raw.trim() !== '' && Number.isFinite(Number(raw)) ? Number(raw) : undefined;
    const chosen = override?.[key] ?? fromEnvironment;
    if (chosen !== undefined) policy[key] = clamp(chosen, BOUNDS[key]);
  }
  policy.maxAttempts = Math.floor(policy.maxAttempts);
  // An attempt can never outlast the request it belongs to.
  policy.attemptTimeoutMs = Math.min(policy.attemptTimeoutMs, policy.totalTimeoutMs);
  return policy;
}

/**
 * How long a started request holds its id. Past this, a run that never
 * finished — the process died mid-call — no longer blocks the same request.
 */
export const leaseMsFor = (policy: GenerationPolicy) => policy.totalTimeoutMs + 60_000;

export interface FailurePresentation {
  /** The code the API returns and the admin screen shows. */
  code: string;
  httpStatus: number;
  /** Whether trying the same request again later could plausibly work. */
  worthRetrying: boolean;
}

export const MODEL_FAILURES: Record<ModelFailureClass, FailurePresentation> = {
  unavailable: { code: 'model_unavailable', httpStatus: 503, worthRetrying: true },
  timeout: { code: 'generation_timeout', httpStatus: 504, worthRetrying: true },
  quota: { code: 'quota_exceeded', httpStatus: 429, worthRetrying: true },
  invalid_response: { code: 'invalid_model_response', httpStatus: 502, worthRetrying: true },
  permanent: { code: 'model_configuration_error', httpStatus: 500, worthRetrying: false },
  unknown: { code: 'model_failed', httpStatus: 502, worthRetrying: false },
};

const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`;

/** The sentence an admin reads. Never includes the prompt or source text. */
export function describeModelFailure(
  failureClass: ModelFailureClass,
  context: { attempts: number; model: string; policy: GenerationPolicy; detail: string },
): string {
  const tries = `${context.attempts} attempt${context.attempts === 1 ? '' : 's'}`;
  const detail = context.detail.slice(0, 300);
  switch (failureClass) {
    case 'unavailable':
      return `The model (${context.model}) is unavailable — overloaded or unreachable — after ${tries}. No draft was created; try again in a few minutes.`;
    case 'timeout':
      return `The model (${context.model}) did not answer in time (${seconds(context.policy.attemptTimeoutMs)} per attempt, ${seconds(context.policy.totalTimeoutMs)} in total; ${tries}). No draft was created.`;
    case 'quota':
      return `The model's quota or rate limit was reached (${context.model}). No draft was created and the request was not retried automatically; try again later.`;
    case 'permanent':
      return `The model call was refused, and retrying will not change that: ${detail} Check the Gemini configuration (GEMINI_API_KEY, model name).`;
    case 'invalid_response':
      return `The model answered, but not with usable questions: ${detail}`;
    default:
      return `The model call failed after ${tries}: ${detail}`;
  }
}
