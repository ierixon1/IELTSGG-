import { readFileSync } from 'node:fs';
import path from 'node:path';
import { GoogleGenAI, type Schema } from '@google/genai';
import { executeGeminiWithRetry } from '../../../prompts/geminiRetry';
import { GENERATION_MODEL } from './version';

/**
 * The boundary between this pipeline and the model.
 *
 * Everything above this file deals in a prompt going in and text coming out.
 * Nothing above it imports the Gemini SDK, which is what lets the whole
 * pipeline — retrieval, prompt contract, parsing, validation, draft creation —
 * be exercised in tests with the model replaced, and nothing else.
 *
 * The request carries the prompt and nothing more. There is no file upload, no
 * cached context and no "the book" handle: the model can only see the chunks the
 * prompt contains, which is the whole point of the grounding rule.
 */

export interface ModelRequest {
  systemInstruction: string;
  prompt: string;
  responseSchema: Schema;
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

export class ModelNotConfiguredError extends Error {
  constructor(message: string) {
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

    // The same retry and quota guard every other Gemini call on this server goes
    // through, under the existing generation quota.
    const response = await executeGeminiWithRetry(
      () =>
        ai.models.generateContent({
          model: GENERATION_MODEL,
          contents: request.prompt,
          config: {
            systemInstruction: request.systemInstruction,
            // Low, because this is extraction dressed as writing: the questions
            // should be the ones the text supports, not the most inventive ones.
            temperature: 0.2,
            responseMimeType: 'application/json',
            responseSchema: request.responseSchema,
          },
        }),
      2,
      1500,
      'mock_generation',
      false,
      GENERATION_MODEL,
    );

    return { text: response.text ?? '', model: GENERATION_MODEL, modelVersion: response.modelVersion };
  }
}

/**
 * Replays a stored response instead of calling the model.
 *
 * Exists for one purpose: showing a known-bad model response flowing through the
 * real server and UI, which cannot be arranged with the real model on demand.
 * Refused in production, and its name is recorded as the model on anything it
 * produces, so a fixture-generated draft can never be mistaken for a Gemini one.
 */
class FixtureGenerationModel implements GenerationModel {
  readonly name: string;

  constructor(private readonly file: string) {
    this.name = `fixture:${path.basename(file)}`;
  }

  async generate(): Promise<ModelResponse> {
    return { text: readFileSync(this.file, 'utf8'), model: this.name };
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
      throw new ModelNotConfiguredError('A fixture generation model cannot be used in production.');
    }
    return new FixtureGenerationModel(fixture);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new ModelNotConfiguredError('Book → Test needs GEMINI_API_KEY to be configured on the server.');
  }
  return new GeminiGenerationModel(apiKey);
}
