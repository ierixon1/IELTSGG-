import { nanoid } from 'nanoid';
import type { AdminReadingMaterial } from '../../types/admin';
import type { SourceChunk, StoredSource } from '../../types/source';
import type { StoredGenerationRecord } from '../../schemas/material';
import {
  callWithRetryPolicy,
  isFailureClass,
  ModelCallFailure,
  type AttemptRecord,
} from '../../../prompts/geminiRetry';
import { adminStore } from '../adminStore';
import { sourceStore } from '../sourceStore';
import { retrieve, type RetrievalHit, type RetrievalOutcome } from '../sourceIngest/retrieve';
import {
  blockingReasons,
  buildReviewState,
  setClassification,
  toSavePayload,
} from '../cdiImport/review';
import { buildPassage } from './passage';
import { buildGenerationPrompt } from './prompt';
import {
  getGenerationModel,
  ModelNotConfiguredError,
  type GenerationModel,
  type ModelRequest,
  type ModelResponse,
} from './model';
import { ModelOutputError, parseModelOutput, validateGeneratedQuestions, type ValidatedQuestion } from './validate';
import { reviewInputFor } from './reviewAdapter';
import { isGeneratableType, MAX_GENERATED_QUESTIONS, type GeneratableType } from './types';
import {
  GENERATOR_VERSION,
  MAX_CHUNKS_PER_GENERATION,
  MAX_PASSAGE_CHARACTERS,
  PROMPT_VERSION,
} from './version';
import {
  describeModelFailure,
  getGenerationPolicy,
  leaseMsFor,
  MODEL_FAILURES,
  type GenerationPolicy,
} from './reliability';
import { generationFingerprint, REQUEST_ID_PATTERN } from './requestIdentity';
import { generationLog, type GenerationRun, type GenerationRunFailure } from './generationLog';

/**
 * Book → Test, for one Reading material:
 *
 *   identify request → select source → choose target → retrieve → generate →
 *   validate → draft → review
 *
 * The grounding rule is structural rather than a line in a prompt. The model is
 * never handed the book: it is handed a prompt, and the only source text in that
 * prompt is the set of chunks retrieval returned for this request. If retrieval
 * finds nothing sufficiently relevant, the model is not called at all — there is
 * no fallback to "the first few chunks", because that is how a question about
 * skimming ends up written from the chapter on spelling.
 *
 * A request is identified before anything runs: the same request id arriving
 * twice produces one draft, not two. The model call runs under a bounded retry
 * policy with per-attempt and total time limits, and every run — the ones that
 * produce no draft included — leaves an entry in the run log.
 *
 * Nothing is published. A successful generation becomes a draft through the same
 * review state machine and the same write path an imported page uses.
 */

export class GenerationRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'GenerationRequestError';
  }
}

export interface GenerateReadingInput {
  sourceId: string;
  /** Minted by the client for one deliberate request; a repeat of it replays instead of regenerating. */
  requestId: unknown;
  topic: unknown;
  questionType: unknown;
  count: unknown;
  module: unknown;
  targetBand?: unknown;
  title?: unknown;
  author: string;
}

export interface RetrievedForGeneration {
  chunk: SourceChunk;
  score: number;
  confidence: number;
  matchedTerms: string[];
  label: string;
}

export interface GenerationOutcome {
  /** `all_rejected` means the model answered but nothing survived validation. */
  status: 'draft_created' | 'all_rejected';
  requestId: string;
  /** Model calls this generation took, the successful one included. */
  attempts: number;
  generationRecord: StoredGenerationRecord;
  questions: ValidatedQuestion[];
  retrieved: RetrievedForGeneration[];
  passage: { text: string; html: string };
  material?: AdminReadingMaterial;
}

/** The request already produced a draft; this is that draft, and nothing new was generated. */
export interface ReplayedGeneration {
  status: 'replayed';
  requestId: string;
  material: AdminReadingMaterial;
  generationRecord: StoredGenerationRecord;
}

interface ValidRequest {
  requestId: string;
  author: string;
  topic: string;
  questionType: GeneratableType;
  count: number;
  module: 'academic' | 'general';
  targetBand?: string;
  title?: string;
}

/** What one run did, filled in as it goes, so a failure can be logged as precisely as a success. */
interface RunTrace {
  modelCalled: boolean;
  model?: string;
  modelVersion?: string;
  attempts: number;
  attemptLog: AttemptRecord[];
  retrieval?: GenerationRun['retrieval'];
  generationId?: string;
  materialId?: string;
}

function readRequest(input: GenerateReadingInput): ValidRequest {
  const requestId = typeof input.requestId === 'string' ? input.requestId.trim() : '';
  if (!requestId) {
    throw new GenerationRequestError(
      'A generation request needs a request id, so that submitting it twice cannot create two drafts.',
      400,
      'request_id_required',
    );
  }
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new GenerationRequestError('The request id must be 8–64 letters, digits, "-" or "_".', 400, 'invalid_request_id');
  }
  const topic = typeof input.topic === 'string' ? input.topic.trim() : '';
  if (!topic) {
    throw new GenerationRequestError('Describe what the questions should be about.', 400, 'topic_required');
  }
  if (topic.length > 300) {
    throw new GenerationRequestError('The topic is too long (300 characters at most).', 400, 'topic_too_long');
  }
  if (!isGeneratableType(input.questionType)) {
    throw new GenerationRequestError(
      `"${String(input.questionType)}" is not a question type Book → Test generates.`,
      400,
      'unsupported_question_type',
    );
  }
  const count = Number(input.count);
  if (!Number.isInteger(count) || count < 1 || count > MAX_GENERATED_QUESTIONS) {
    throw new GenerationRequestError(
      `Ask for between 1 and ${MAX_GENERATED_QUESTIONS} questions.`,
      400,
      'invalid_count',
    );
  }
  if (input.module !== 'academic' && input.module !== 'general') {
    throw new GenerationRequestError('Choose the Academic or General Training module.', 400, 'module_required');
  }
  const targetBand = typeof input.targetBand === 'string' && input.targetBand.trim() ? input.targetBand.trim() : undefined;
  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : undefined;
  return { requestId, author: input.author, topic, questionType: input.questionType, count, module: input.module, targetBand, title };
}

/**
 * Chooses the chunks for the prompt from what retrieval ranked, and nothing else.
 *
 * Ranked order, capped by count and by total length. Never padded with
 * unranked neighbours: a prompt with less source text is a prompt that can
 * support fewer questions, and the model is told to return fewer.
 */
function selectHits(hits: RetrievalHit[]): RetrievalHit[] {
  const selected: RetrievalHit[] = [];
  let length = 0;
  for (const hit of hits.slice(0, MAX_CHUNKS_PER_GENERATION)) {
    if (selected.length > 0 && length + hit.chunk.text.length > MAX_PASSAGE_CHARACTERS) break;
    selected.push(hit);
    length += hit.chunk.text.length;
  }
  return selected;
}

const WITHHELD = '[the provider message quoted the source text and is withheld]';

/**
 * A provider error, or a model's malformed answer, can quote the request back.
 * What is shown and logged must not become a copy of the book, so a message
 * containing any stretch of the supplied source text is withheld.
 */
function withoutSourceText(message: string, chunks: SourceChunk[]): string {
  const window = 60;
  for (const chunk of chunks) {
    const text = chunk.text;
    if (text.length < window) {
      if (text.length >= 20 && message.includes(text)) return WITHHELD;
      continue;
    }
    for (let at = 0; at + window <= text.length; at += window / 2) {
      if (message.includes(text.slice(at, at + window))) return WITHHELD;
    }
  }
  return message;
}

export async function generateReadingFromSource(
  input: GenerateReadingInput,
): Promise<GenerationOutcome | ReplayedGeneration> {
  const request = readRequest(input);

  // Select the source.
  const source = await sourceStore.get(input.sourceId).catch(() => null);
  if (!source) throw new GenerationRequestError('Source not found.', 404, 'source_not_found');
  if (source.status !== 'ready') {
    throw new GenerationRequestError(
      `This source is "${source.status}", so there is nothing to generate from.`,
      409,
      'source_not_ready',
    );
  }

  // Identify the request before anything is generated.
  const policy = getGenerationPolicy();
  const claimRequest = {
    requestId: request.requestId,
    sourceId: source.id,
    fingerprint: generationFingerprint({
      sourceId: source.id,
      section: 'reading',
      module: request.module,
      targetBand: request.targetBand,
      title: request.title,
      topic: request.topic,
      questionType: request.questionType,
      count: request.count,
      generatorVersion: GENERATOR_VERSION,
      promptVersion: PROMPT_VERSION,
    }),
  };

  let claim = await generationLog.claim(claimRequest, leaseMsFor(policy));
  if (claim.kind === 'completed') {
    const material = claim.entry.materialId ? await adminStore.getMaterial('reading', claim.entry.materialId) : null;
    if (material?.section === 'reading' && material.content.generationRecord) {
      return {
        status: 'replayed',
        requestId: request.requestId,
        material,
        generationRecord: material.content.generationRecord,
      };
    }
    // The draft this request made has been deleted since: running it again
    // cannot put a second copy beside it.
    claim = await generationLog.claim(claimRequest, leaseMsFor(policy), true);
  }
  if (claim.kind === 'conflict') {
    throw new GenerationRequestError(
      'This request id was already used for a different generation request. Nothing was generated.',
      409,
      'request_id_reused',
      { requestId: request.requestId },
    );
  }
  if (claim.kind !== 'claimed') {
    throw new GenerationRequestError(
      'This generation request is already running and will produce at most one draft. Wait for it to finish.',
      409,
      'generation_in_progress',
      { requestId: request.requestId },
    );
  }

  return runClaimed(request, source, policy);
}

async function runClaimed(request: ValidRequest, source: StoredSource, policy: GenerationPolicy): Promise<GenerationOutcome> {
  const runId = generationLog.newRunId();
  const started = Date.now();
  const trace: RunTrace = { modelCalled: false, attempts: 0, attemptLog: [] };

  const record = async (outcome: GenerationRun['outcome'], failure?: GenerationRunFailure) => {
    const finished = Date.now();
    await generationLog.recordRun({
      runId,
      requestId: request.requestId,
      sourceId: source.id,
      sourceTitle: source.title,
      request: {
        topic: request.topic,
        questionType: request.questionType,
        count: request.count,
        module: request.module,
        targetBand: request.targetBand,
      },
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date(finished).toISOString(),
      durationMs: finished - started,
      outcome,
      failure,
      modelCalled: trace.modelCalled,
      model: trace.model,
      modelVersion: trace.modelVersion,
      attempts: trace.attempts,
      attemptLog: trace.attemptLog,
      generatorVersion: GENERATOR_VERSION,
      promptVersion: PROMPT_VERSION,
      generationId: trace.generationId,
      materialId: trace.materialId,
      retrieval: trace.retrieval,
    });
    await generationLog.finish(request.requestId, {
      status: outcome === 'draft_created' ? 'succeeded' : outcome === 'all_rejected' ? 'rejected' : 'failed',
      materialId: trace.materialId,
    });
  };

  // Writing the log must neither turn a created draft into a reported failure
  // nor replace the failure being reported with its own.
  const recordSafely = async (outcome: GenerationRun['outcome'], failure?: GenerationRunFailure) => {
    try {
      await record(outcome, failure);
    } catch (logError) {
      console.error('[BookToTest] could not record the generation run:', logError);
    }
  };

  try {
    const outcome = await runPipeline(request, source, policy, trace);
    await recordSafely(
      outcome.status,
      outcome.status === 'all_rejected'
        ? { code: 'all_rejected', httpStatus: 422, message: 'The model answered, but no generated question survived validation.' }
        : undefined,
    );
    return outcome;
  } catch (error) {
    const failure: GenerationRunFailure =
      error instanceof GenerationRequestError
        ? {
            code: error.code,
            httpStatus: error.status,
            message: error.message.slice(0, 600),
            failureClass: isFailureClass(error.details.failureClass) ? error.details.failureClass : undefined,
            reason: typeof error.details.reason === 'string' ? error.details.reason : undefined,
          }
        : { code: 'generation_failed', httpStatus: 500, message: 'Generation failed.' };
    await recordSafely('failed', failure);
    throw error;
  }
}

async function runPipeline(
  request: ValidRequest,
  source: StoredSource,
  policy: GenerationPolicy,
  trace: RunTrace,
): Promise<GenerationOutcome> {
  // Retrieve — before the model exists as far as this request is concerned.
  const chunks = await sourceStore.getChunks(source.id);
  const retrieval: RetrievalOutcome = retrieve(chunks, request.topic, { limit: MAX_CHUNKS_PER_GENERATION });
  if (retrieval.status !== 'ok') {
    trace.retrieval = { status: retrieval.status, hits: [] };
    throw new GenerationRequestError(
      `Nothing in "${source.title}" is relevant enough to generate from: ${retrieval.reason}`,
      422,
      'no_relevant_source',
      { retrieval },
    );
  }

  const hits = selectHits(retrieval.hits);
  trace.retrieval = { status: retrieval.status, hits: hits.map((hit) => ({ chunkId: hit.chunk.id, score: hit.score })) };
  if (request.questionType === 'matching_headings' && hits.length < 2) {
    throw new GenerationRequestError(
      'Matching headings needs at least two relevant sections, and retrieval found one. Broaden the topic or choose another question type.',
      422,
      'not_enough_sections',
      { retrieval },
    );
  }

  const selectedChunks = hits.map((hit) => hit.chunk);
  const passage = buildPassage(selectedChunks, { showHeadings: request.questionType !== 'matching_headings' });
  const labelFor = new Map(passage.sections.map((section) => [section.chunkId, section.label]));

  const retrieved: RetrievedForGeneration[] = hits
    .map((hit) => ({
      chunk: hit.chunk,
      score: hit.score,
      confidence: hit.confidence,
      matchedTerms: hit.matchedTerms,
      label: labelFor.get(hit.chunk.id) ?? '?',
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const prompt: ModelRequest = buildGenerationPrompt({
    topic: request.topic,
    questionType: request.questionType,
    count: request.count,
    excerpts: retrieved.map((item) => ({
      chunkId: item.chunk.id,
      label: item.label,
      text: item.chunk.text,
      page: item.chunk.location.page,
      path: item.chunk.location.path,
    })),
  });

  // Generate.
  let model: GenerationModel;
  try {
    model = getGenerationModel();
  } catch (error) {
    if (error instanceof ModelNotConfiguredError) {
      const presentation = MODEL_FAILURES.permanent;
      throw new GenerationRequestError(error.message, presentation.httpStatus, presentation.code, {
        failureClass: 'permanent',
        reason: error.reason,
        worthRetrying: presentation.worthRetrying,
      });
    }
    throw error;
  }
  trace.model = model.name;
  trace.modelCalled = true;

  let response: ModelResponse;
  try {
    const call = await callWithRetryPolicy((signal) => model.generate({ ...prompt, signal }), policy, {
      onRetry: ({ attempt, info, delayMs }) =>
        console.warn(
          `[BookToTest] ${model.name} attempt ${attempt} failed (${info.failureClass}${info.status ? ` ${info.status}` : ''}); retrying in ${delayMs} ms.`,
        ),
    });
    response = call.value;
    trace.attempts = call.report.attempts;
    trace.attemptLog = call.report.attemptLog;
  } catch (error) {
    if (!(error instanceof ModelCallFailure)) throw error;
    trace.attempts = error.report.attempts;
    trace.attemptLog = error.report.attemptLog;
    const presentation = MODEL_FAILURES[error.failureClass];
    throw new GenerationRequestError(
      describeModelFailure(error.failureClass, {
        attempts: error.report.attempts,
        model: model.name,
        policy,
        detail: withoutSourceText(error.info.message, selectedChunks),
      }),
      presentation.httpStatus,
      presentation.code,
      {
        failureClass: error.failureClass,
        attempts: error.report.attempts,
        model: model.name,
        providerStatus: error.info.status,
        worthRetrying: presentation.worthRetrying,
      },
    );
  }
  trace.modelVersion = response.modelVersion;

  let raw: unknown[];
  try {
    raw = parseModelOutput(response.text);
  } catch (error) {
    if (error instanceof ModelOutputError) {
      const presentation = MODEL_FAILURES.invalid_response;
      throw new GenerationRequestError(
        describeModelFailure('invalid_response', {
          attempts: trace.attempts,
          model: model.name,
          policy,
          detail: withoutSourceText(error.message, selectedChunks),
        }),
        presentation.httpStatus,
        presentation.code,
        {
          failureClass: 'invalid_response',
          reason: error.kind,
          attempts: trace.attempts,
          model: model.name,
          worthRetrying: presentation.worthRetrying,
        },
      );
    }
    throw error;
  }

  // Validate.
  const generationId = `gen-${Date.now()}-${nanoid(6)}`;
  trace.generationId = generationId;
  const generatedAt = new Date().toISOString();
  const validated = validateGeneratedQuestions(raw, {
    questionType: request.questionType,
    requestedCount: request.count,
    chunks: selectedChunks,
    sections: passage.sections,
    generationId,
    generatedAt,
    model: response.model,
    modelVersion: response.modelVersion,
    promptVersion: PROMPT_VERSION,
    sourceId: source.id,
  });

  // Usable questions are numbered contiguously; rejected ones get no number.
  let next = 1;
  for (const item of validated) {
    if (item.question) item.question = { ...item.question, questionNumber: next++ };
  }

  const count = (status: string) => validated.filter((item) => item.status === status).length;
  const summary = {
    requested: request.count,
    returned: raw.length,
    valid: count('valid'),
    needsReview: count('needs_review'),
    rejected: count('rejected'),
    complete: count('valid') + count('needs_review') >= request.count,
  };

  const generationRecord: StoredGenerationRecord = {
    generationId,
    generatorVersion: GENERATOR_VERSION,
    promptVersion: PROMPT_VERSION,
    model: response.model,
    modelVersion: response.modelVersion,
    requestId: request.requestId,
    attempts: trace.attempts,
    generatedAt,
    source: {
      sourceId: source.id,
      title: source.title,
      filename: source.filename,
      // Named so `extractAssetIds` does not read them as asset references. If it
      // did, publishing this material would make the learner asset route serve
      // the whole original book to any signed-in learner.
      originalAsset: source.sourceAssetId,
      extractionAsset: source.extractedTextAssetId,
      extractorVersion: source.extractorVersion,
      chunkerVersion: source.chunkerVersion,
    },
    request: {
      topic: request.topic,
      questionType: request.questionType,
      requestedCount: request.count,
    },
    retrieval: {
      query: retrieval.query,
      terms: retrieval.terms,
      hits: hits.map((hit) => ({
        chunkId: hit.chunk.id,
        score: hit.score,
        confidence: hit.confidence,
        matchedTerms: hit.matchedTerms,
      })),
    },
    chunks: passage.sections.map((section) => {
      const chunk = selectedChunks.find((item) => item.id === section.chunkId) as SourceChunk;
      return {
        chunkId: chunk.id,
        ordinal: chunk.ordinal,
        label: section.label,
        page: chunk.location.page,
        path: chunk.location.path,
        charStart: chunk.location.charStart,
        charEnd: chunk.location.charEnd,
        contentHash: chunk.contentHash,
        passageStart: section.start,
        passageEnd: section.end,
      };
    }),
    questions: validated.map((item) => ({
      generatedQuestionId: item.generatedQuestionId,
      questionNumber: item.question?.questionNumber,
      status: item.status,
      reasons: item.reasons,
      chunkIds: item.chunkIds,
      evidence: item.evidence,
      candidate: item.status === 'rejected' ? item.candidate : undefined,
      groundingVerdict: item.groundingVerdict,
      qualityVerdict: item.qualityVerdict,
      questionEvidence: item.questionEvidence,
      answerEvidence: item.answerEvidence,
      distractorEvidence: item.distractorEvidence,
    })),
    summary,
  };

  const outcomeBase = {
    requestId: request.requestId,
    attempts: trace.attempts,
    generationRecord,
    questions: validated,
    retrieved,
    passage: { text: passage.text, html: passage.html },
  };

  const usable = validated
    .map((item) => item.question)
    .filter((question): question is NonNullable<typeof question> => Boolean(question));

  if (usable.length === 0) {
    // The model answered, and nothing it said survived. No draft is stored:
    // there is nothing to half-create and nothing to clean up afterwards.
    return { status: 'all_rejected', ...outcomeBase };
  }

  // Draft — through the review state machine, so a generated material is saved
  // by exactly the rules an imported one is.
  const title = request.title ?? `${source.title} — ${request.topic}`.slice(0, 480);
  const { result, sourceHtml, generationRecord: reviewRecord } = reviewInputFor({
    title,
    passageText: passage.text,
    passageHtml: passage.html,
    record: generationRecord,
    questions: usable,
  });
  const state = setClassification(buildReviewState(result, { sourceHtml, generationRecord: reviewRecord }), {
    section: 'reading',
    module: request.module,
    title,
    theme: request.topic.slice(0, 190),
    targetBand: request.targetBand ?? '',
    part: 1,
  });

  const payload = toSavePayload(state);
  if (!payload) {
    throw new GenerationRequestError(
      `The generated questions could not form a draft: ${blockingReasons(state).join(' ')}`,
      422,
      'draft_blocked',
    );
  }

  const saved = await adminStore.saveMaterial('reading', payload, request.author);
  if (saved.section !== 'reading') {
    throw new GenerationRequestError('The draft was not stored as a Reading material.', 500, 'draft_not_stored');
  }
  trace.materialId = saved.id;
  return { status: 'draft_created', ...outcomeBase, material: saved };
}
