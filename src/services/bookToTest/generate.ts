import { nanoid } from 'nanoid';
import type { AdminMaterial } from '../../types/admin';
import type { SourceChunk } from '../../types/source';
import type { StoredGenerationRecord } from '../../schemas/material';
import { AiUnavailableError } from '../../../prompts/geminiRetry';
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
import { getGenerationModel, ModelNotConfiguredError, type ModelRequest } from './model';
import { ModelOutputError, parseModelOutput, validateGeneratedQuestions, type ValidatedQuestion } from './validate';
import { reviewInputFor } from './reviewAdapter';
import { isGeneratableType, MAX_GENERATED_QUESTIONS, type GeneratableType } from './types';
import {
  GENERATOR_VERSION,
  MAX_CHUNKS_PER_GENERATION,
  MAX_PASSAGE_CHARACTERS,
  PROMPT_VERSION,
} from './version';

/**
 * Book → Test, for one Reading material:
 *
 *   select source → choose target → retrieve → generate → validate → draft → review
 *
 * The grounding rule is structural rather than a line in a prompt. The model is
 * never handed the book: it is handed a prompt, and the only source text in that
 * prompt is the set of chunks retrieval returned for this request. If retrieval
 * finds nothing sufficiently relevant, the model is not called at all — there is
 * no fallback to "the first few chunks", because that is how a question about
 * skimming ends up written from the chapter on spelling.
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
  generationRecord: StoredGenerationRecord;
  questions: ValidatedQuestion[];
  retrieved: RetrievedForGeneration[];
  passage: { text: string; html: string };
  material?: AdminMaterial;
}

interface ValidRequest {
  topic: string;
  questionType: GeneratableType;
  count: number;
  module: 'academic' | 'general';
  targetBand?: string;
  title?: string;
}

function readRequest(input: GenerateReadingInput): ValidRequest {
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
  return { topic, questionType: input.questionType, count, module: input.module, targetBand, title };
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

export async function generateReadingFromSource(input: GenerateReadingInput): Promise<GenerationOutcome> {
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

  // Retrieve — before the model exists as far as this request is concerned.
  const chunks = await sourceStore.getChunks(source.id);
  const retrieval: RetrievalOutcome = retrieve(chunks, request.topic, { limit: MAX_CHUNKS_PER_GENERATION });
  if (retrieval.status !== 'ok') {
    throw new GenerationRequestError(
      `Nothing in "${source.title}" is relevant enough to generate from: ${retrieval.reason}`,
      422,
      'no_relevant_source',
      { retrieval },
    );
  }

  const hits = selectHits(retrieval.hits);
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
  let model;
  try {
    model = getGenerationModel();
  } catch (error) {
    if (error instanceof ModelNotConfiguredError) {
      throw new GenerationRequestError(error.message, 503, 'model_not_configured');
    }
    throw error;
  }

  let response;
  try {
    response = await model.generate(prompt);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The model call failed.';
    throw new GenerationRequestError(
      `Generation failed before any questions came back: ${message}`,
      error instanceof AiUnavailableError ? 503 : 502,
      error instanceof AiUnavailableError ? 'model_unavailable' : 'model_failed',
    );
  }

  let raw: unknown[];
  try {
    raw = parseModelOutput(response.text);
  } catch (error) {
    if (error instanceof ModelOutputError) {
      throw new GenerationRequestError(error.message, 502, `model_output_${error.kind}`);
    }
    throw error;
  }

  // Validate.
  const generationId = `gen-${Date.now()}-${nanoid(6)}`;
  const generatedAt = new Date().toISOString();
  const validated = validateGeneratedQuestions(raw, {
    questionType: request.questionType,
    requestedCount: request.count,
    chunks: selectedChunks,
    sections: passage.sections,
    generationId,
    generatedAt,
    model: response.model,
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

  const record: StoredGenerationRecord = {
    generationId,
    generatorVersion: GENERATOR_VERSION,
    promptVersion: PROMPT_VERSION,
    model: response.model,
    modelVersion: response.modelVersion,
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
    generationRecord: record,
    questions: validated,
    retrieved,
    passage: { text: passage.text, html: passage.html },
  };

  const usable = validated
    .map((item) => item.question)
    .filter((question): question is NonNullable<typeof question> => Boolean(question));

  if (usable.length === 0) {
    // The model answered, and nothing it said survived. Nothing is stored: there
    // is no draft to half-create and nothing to clean up afterwards.
    return { status: 'all_rejected', ...outcomeBase };
  }

  // Draft — through the review state machine, so a generated material is saved
  // by exactly the rules an imported one is.
  const title = request.title ?? `${source.title} — ${request.topic}`.slice(0, 480);
  const { result, sourceHtml, generationRecord } = reviewInputFor({
    title,
    passageText: passage.text,
    passageHtml: passage.html,
    record,
    questions: usable,
  });
  const state = setClassification(buildReviewState(result, { sourceHtml, generationRecord }), {
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

  const material = await adminStore.saveMaterial('reading', payload, input.author);
  return { status: 'draft_created', ...outcomeBase, material };
}
