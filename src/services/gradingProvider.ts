import { readFileSync } from 'node:fs';
import path from 'node:path';
import { GoogleGenAI, type GenerateContentParameters } from '@google/genai';
import { FixtureModelError, ModelNotConfiguredError } from './bookToTest/model';

/**
 * The one request Writing and Speaking grading makes to a model, and what may
 * stand in for it.
 *
 * Everything around the request — the input checks, the quota charge, the retry
 * and timeout policy, the fallback models, parsing, and in an exam the deadline,
 * the stored submission and its grading state — is the same code whichever
 * provider answers. A provider makes exactly one request per call; attempts are
 * decided above it, in `grading.ts`.
 */
export interface GradingProvider {
  readonly name: string;
  generate(request: GenerateContentParameters): Promise<{ text: string }>;
}

let genAIClient: GoogleGenAI | null = null;
export function getGenAI(): GoogleGenAI {
  if (!genAIClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('AI service is not configured.');
    genAIClient = new GoogleGenAI({ apiKey, httpOptions: { headers: { 'User-Agent': 'PrepIELTS-server' } } });
  }
  return genAIClient;
}

const geminiProvider: GradingProvider = {
  name: 'gemini',
  async generate(request) {
    const response = await getGenAI().models.generateContent(request);
    return { text: response.text ?? '' };
  },
};

interface FixtureStep {
  delayMs?: number;
  text?: string;
  response?: unknown;
  error?: { status?: number; message?: string };
}

function scriptSteps(content: string): FixtureStep[] | null {
  if (!content.trimStart().startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || !('fixtureScript' in parsed) || !('steps' in parsed)) return null;
  const steps = parsed.steps;
  if (parsed.fixtureScript !== 1 || !Array.isArray(steps) || steps.length === 0) return null;
  return steps as FixtureStep[];
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Replays a scripted model instead of calling one.
 *
 * The file is either the model's raw text, or a script in the format Book → Test's
 * fixture model reads — `{"fixtureScript": 1, "steps": [...]}` — whose steps are
 * played one per call within a grading run, the last repeating:
 * `{"error": {"status": 503}}`, `{"delayMs": 20000, "response": {...}}`, `{"text": "..."}`.
 * That is how a slow, overloaded or rate-limited model is shown flowing through the
 * real exam session and UI, which the real model cannot be made to do on demand.
 *
 * Only the request is replaced. Refused in production, and its name is recorded as
 * the model on every band it produces.
 */
class FixtureGradingProvider implements GradingProvider {
  readonly name: string;
  private calls = 0;

  constructor(private readonly file: string) {
    this.name = `fixture:${path.basename(file)}`;
  }

  async generate(request: GenerateContentParameters): Promise<{ text: string }> {
    const content = readFileSync(this.file, 'utf8');
    const steps = scriptSteps(content);
    if (!steps) return { text: content };

    const step = steps[Math.min(this.calls, steps.length - 1)];
    this.calls += 1;
    if (typeof step.delayMs === 'number' && step.delayMs > 0) await wait(step.delayMs, request.config?.abortSignal);
    if (step.error) {
      const status = step.error.status ?? 503;
      throw new FixtureModelError(status, step.error.message ?? `Fixture model error (status ${status}).`);
    }
    if (typeof step.text === 'string') return { text: step.text };
    if (step.response !== undefined) return { text: JSON.stringify(step.response) };
    throw new Error('A fixture step needs "text", "response" or "error".');
  }
}

let override: GradingProvider | null = null;

/** Replaces the provider for the life of the process, or restores the real one with `null`. The seam tests use. */
export function setGradingProvider(provider: GradingProvider | null): void {
  override = provider;
}

/** Whether any provider could answer: a test provider, a fixture, or a Gemini key. */
export function gradingProviderConfigured(): boolean {
  return Boolean(override || process.env.GRADING_FIXTURE_RESPONSE || process.env.GEMINI_API_KEY);
}

/** The provider for one grading run. A fixture is read afresh per run, so its steps count attempts within the run. */
export function getGradingProvider(): GradingProvider {
  if (override) return override;

  const fixture = process.env.GRADING_FIXTURE_RESPONSE;
  if (fixture) {
    if (process.env.NODE_ENV === 'production') {
      throw new ModelNotConfiguredError('A fixture grading model cannot be used in production.', 'fixture_in_production');
    }
    return new FixtureGradingProvider(fixture);
  }

  if (!process.env.GEMINI_API_KEY) {
    throw new ModelNotConfiguredError('AI grading needs GEMINI_API_KEY to be configured on the server.', 'missing_api_key');
  }
  return geminiProvider;
}
