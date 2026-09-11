import { readFileSync } from 'node:fs';
import path from 'node:path';
import { GoogleGenAI, type Schema } from '@google/genai';
import { GENERATION_MODEL } from './version';

/**
 * The boundary between this pipeline and the model.
 *
 * Everything above this file deals in a prompt going in and text coming out.
 * Nothing above it imports the Gemini SDK, which is what lets the whole
 * pipeline — retrieval, prompt contract, parsing, validation, draft creation —
 * be exercised in tests with the model replaced, and nothing else.
 *
 * A model here makes exactly one call. How many attempts a generation gets,
 * how long each may take and what a failure is called are decided once, at the
 * generation boundary (`reliability.ts`), so Gemini, the fixture and a test
 * double all go through the same retries, limits and failure codes.
 *
 * The request carries the prompt and nothing more. There is no file upload, no
 * cached context and no "the book" handle: the model can only see the chunks the
 * prompt contains, which is the whole point of the grounding rule.
 */

export interface ModelRequest {
  systemInstruction: string;
  prompt: string;
  responseSchema: Schema;
  /** Aborted when the generation boundary abandons this attempt. */
  signal?: AbortSignal;
}

export interface ModelResponse {
  text: string;
  /** The model that was asked, as configured. */
  model: string;
  /** The version the API reports having answered with, when it reports one. */
  modelVersion?: string;
}

export interface GenerationModel {
  readonly name: string;
  generate(request: ModelRequest): Promise<ModelResponse>;
}

/** No model can be used at all. Permanent: nothing about a retry changes it. */
export class ModelNotConfiguredError extends Error {
  readonly failureClass = 'permanent' as const;
  constructor(
    message: string,
    readonly reason: 'missing_api_key' | 'fixture_in_production',
  ) {
    super(message);
    this.name = 'ModelNotConfiguredError';
  }
}

class GeminiGenerationModel implements GenerationModel {
  readonly name = GENERATION_MODEL;

  constructor(private readonly apiKey: string) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const ai = new GoogleGenAI({
      apiKey: this.apiKey,
      httpOptions: { headers: { 'User-Agent': 'PrepIELTS-server' } },
    });

    // One call. The per-learner AI allowance in `executeGeminiWithRetry` never
    // applied here — it keys on a learner session, and this route runs under
    // an admin one — so nothing is lost by calling the SDK directly.
    const response = await ai.models.generateContent({
      model: GENERATION_MODEL,
      contents: request.prompt,
      config: {
        systemInstruction: request.systemInstruction,
        // Low, because this is extraction dressed as writing: the questions
        // should be the ones the text supports, not the most inventive ones.
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: request.responseSchema,
        abortSignal: request.signal,
      },
    });

    return { text: response.text ?? '', model: GENERATION_MODEL, modelVersion: response.modelVersion };
  }
}

/** An error a fixture step raises, shaped like the SDK's: a message and an HTTP status. */
export class FixtureModelError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'FixtureModelError';
  }
}

interface FixtureStep {
  delayMs?: number;
  text?: string;
  response?: unknown;
  error?: { status?: number; message?: string };
}

function readScript(content: string): FixtureStep[] | null {
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
 * Replays a stored response instead of calling the model.
 *
 * The file is either the model's raw text, or a script — `{"fixtureScript": 1,
 * "steps": [...]}` — whose steps are played one per call within a request (the
 * last repeats): `{"error": {"status": 503}}`, `{"delayMs": 5000}`, `{"text": "..."}`
 * or `{"response": {...}}`. That is how an overloaded, slow or rate-limited model
 * is shown flowing through the real server and UI, which the real model cannot
 * be made to do on demand.
 *
 * Only the call is replaced: parsing, validation, the review adapter, storage
 * and the publish gate are the same code a Gemini response goes through.
 * Refused in production, and its name is recorded as the model on anything it
 * produces, so a fixture-generated draft can never be mistaken for a Gemini one.
 */
class FixtureGenerationModel implements GenerationModel {
  readonly name: string;
  private calls = 0;

  constructor(private readonly file: string) {
    this.name = `fixture:${path.basename(file)}`;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const content = readFileSync(this.file, 'utf8');
    const steps = readScript(content);
    if (!steps) return { text: content, model: this.name };

    const step = steps[Math.min(this.calls, steps.length - 1)];
    this.calls += 1;
    if (typeof step.delayMs === 'number' && step.delayMs > 0) await wait(step.delayMs, request.signal);
    if (step.error) {
      const status = step.error.status ?? 503;
      throw new FixtureModelError(status, step.error.message ?? `Fixture model error (status ${status}).`);
    }
    if (typeof step.text === 'string') return { text: step.text, model: this.name };
    if (step.response !== undefined) return { text: JSON.stringify(step.response), model: this.name };
    throw new Error('A fixture step needs "text", "response" or "error".');
  }
}

let override: GenerationModel | null = null;

/**
 * Replaces the model for the life of the process, or restores the real one with
 * `null`. The seam tests use to mock generation at the API boundary.
 */
export function setGenerationModel(model: GenerationModel | null): void {
  override = model;
}

export function getGenerationModel(): GenerationModel {
  if (override) return override;

  const fixture = process.env.BOOK_TO_TEST_FIXTURE_RESPONSE;
  if (fixture) {
    if (process.env.NODE_ENV === 'production') {
      throw new ModelNotConfiguredError('A fixture generation model cannot be used in production.', 'fixture_in_production');
    }
    return new FixtureGenerationModel(fixture);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new ModelNotConfiguredError('Book → Test needs GEMINI_API_KEY to be configured on the server.', 'missing_api_key');
  }
  return new GeminiGenerationModel(apiKey);
}
