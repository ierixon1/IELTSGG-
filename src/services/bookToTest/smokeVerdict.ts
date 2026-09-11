/**
 * What a real-model smoke run proved, decided from the generation endpoint's
 * answer alone.
 *
 * The distinction this exists for: a run that reached Gemini and came back
 * with a validated draft has passed. A run where Gemini was overloaded, timed
 * out or was out of quota has not failed the pipeline — but it has not passed
 * either, because nothing past the model call was exercised. A 503 is never a
 * pass, and neither is a draft written by anything other than the real model.
 */

export type SmokeResult =
  | 'real_model_passed'
  | 'real_model_unavailable'
  | 'real_model_failed'
  | 'real_model_not_configured';

/** Distinct exit codes, so a script can tell "Gemini was busy" from "the pipeline is broken". */
export const SMOKE_EXIT_CODES: Record<SmokeResult, number> = {
  real_model_passed: 0,
  real_model_failed: 1,
  real_model_unavailable: 75,
  real_model_not_configured: 78,
};

export interface SmokeVerdict {
  result: SmokeResult;
  reason: string;
  code?: string;
  model?: string;
  modelVersion?: string;
  generatorVersion?: string;
  promptVersion?: string;
  attempts?: number;
  materialId?: string;
  materialStatus?: string;
  questionStatuses?: string[];
  retrievedChunks?: number;
}

const UNAVAILABLE = new Set(['model_unavailable', 'generation_timeout', 'quota_exceeded']);

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const number = (value: unknown) => (typeof value === 'number' ? value : undefined);

export function smokeVerdict(httpStatus: number, body: unknown, expectedModel: string): SmokeVerdict {
  const data = asRecord(body);
  const code = text(data.code) || undefined;
  const attempts = number(data.attempts);

  if (code && UNAVAILABLE.has(code)) {
    return { result: 'real_model_unavailable', reason: text(data.error) || code, code, attempts, model: text(data.model) || undefined };
  }
  if (code === 'model_configuration_error' && data.reason === 'missing_api_key') {
    return { result: 'real_model_not_configured', reason: text(data.error), code };
  }
  if (httpStatus !== 201) {
    return {
      result: 'real_model_failed',
      reason: code ? `${code}: ${text(data.error)}` : `HTTP ${httpStatus}${data.replayed ? ' (replayed an earlier draft)' : ''}`,
      code,
      attempts,
    };
  }

  const generation = asRecord(data.generation);
  const questions = Array.isArray(data.questions) ? data.questions.map(asRecord) : [];
  const retrieved = Array.isArray(data.retrieved) ? data.retrieved.length : 0;
  const observed: SmokeVerdict = {
    result: 'real_model_failed',
    reason: '',
    model: text(generation.model) || undefined,
    modelVersion: text(generation.modelVersion) || undefined,
    generatorVersion: text(generation.generatorVersion) || undefined,
    promptVersion: text(generation.promptVersion) || undefined,
    attempts: number(generation.attempts) ?? attempts,
    materialId: text(data.materialId) || undefined,
    materialStatus: text(data.materialStatus) || undefined,
    questionStatuses: questions.map((question) => text(question.status)),
    retrievedChunks: retrieved,
  };

  const problems: string[] = [];
  if (observed.model !== expectedModel) problems.push(`the draft was written by "${observed.model}", not ${expectedModel}`);
  if (retrieved < 1) problems.push('no retrieved chunks were reported');
  if (questions.length < 1) problems.push('no validated questions were reported');
  if (questions.some((question) => !['valid', 'needs_review', 'rejected'].includes(text(question.status)))) {
    problems.push('a question has no validation status');
  }
  if (!observed.materialId) problems.push('no draft id was returned');
  if (observed.materialStatus !== 'draft') problems.push(`the material is "${observed.materialStatus}", not a draft`);

  return problems.length > 0
    ? { ...observed, reason: problems.join('; ') }
    : { ...observed, result: 'real_model_passed', reason: 'retrieval → Gemini → validation → draft' };
}
