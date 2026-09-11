import express, { Response } from 'express';
import multer from 'multer';
import path from 'node:path';
import { sourceStore } from '../services/sourceStore';
import { assetStore } from '../services/assetStore';
import { ingestSource, UnsupportedSourceError } from '../services/sourceIngest/ingest';
import { SUPPORTED_EXTENSIONS, fileKindFor } from '../services/sourceIngest/extract';
import { retrieve } from '../services/sourceIngest/retrieve';
import { validateUpload } from '../services/fileTypeSniffer';
import { adminStore } from '../services/adminStore';
import {
  generateReadingFromSource,
  GenerationRequestError,
  type GenerationOutcome,
  type ReplayedGeneration,
} from '../services/bookToTest/generate';
import { generationLog } from '../services/bookToTest/generationLog';
import { reviewInputFor } from '../services/bookToTest/reviewAdapter';
import { nanoid } from 'nanoid';
import { questionContentHash } from '../services/bookToTest/questionHash';
import { MaterialValidationError } from '../services/adminStore';
import type { StoredGenerationReview } from '../schemas/material';

/**
 * The source library: ingest a book, see what came of it, search inside it.
 *
 * Mounted under the admin router, so every route here already has an
 * authenticated admin behind it. Nothing in this file is reachable by a
 * learner: a textbook is licensed material and its extracted text is the whole
 * book in plain form.
 *
 * There is no generation endpoint, deliberately. This phase stops at "the book
 * is searchable and every passage can be traced back"; what reads those
 * passages comes later.
 *
 * Paths here are relative: the router is mounted at `/api/admin/sources` with
 * the auth and role guards attached to the mount, rather than being registered
 * openly and guarded per route. Mounting it without a path would run those
 * guards for every admin request that passed through, including the deliberately
 * anonymous `/public/*` routes.
 */
export const sourceRouter = express.Router();

type AdminRequest = express.Request & {
  adminUser?: { id: string; username: string; displayName: string; role: string };
};

const upload = multer({
  storage: multer.memoryStorage(),
  // A textbook is legitimately large; a 5MB cap would reject most of them.
  limits: { fileSize: 60 * 1024 * 1024, files: 1 },
});

const SUPPORTED = Object.keys(SUPPORTED_EXTENSIONS).sort();

function notFound(res: Response) {
  return res.status(404).json({ error: 'Source not found.' });
}

/** What the pipeline accepts, so the UI does not have to guess. */
sourceRouter.get('/supported', (_req, res) =>
  res.json({ extensions: SUPPORTED }),
);

sourceRouter.get('/', async (_req, res) => {
  try {
    return res.json({ items: await sourceStore.list() });
  } catch (error) {
    console.error('[Sources] list failed:', error);
    return res.status(500).json({ error: 'Unable to list sources.' });
  }
});

sourceRouter.get('/:id', async (req, res) => {
  try {
    const source = await sourceStore.get(req.params.id);
    return source ? res.json({ item: source }) : notFound(res);
  } catch {
    return notFound(res);
  }
});

/**
 * Uploads a book and runs it through the pipeline.
 *
 * Ingestion is awaited rather than queued. It is measured in seconds for a
 * real textbook, and a background job would need somewhere durable to record
 * failures — which, until there is a queue worth the name, means a source
 * sitting on `extracting` forever with nothing to explain it.
 */
sourceRouter.post('/', upload.single('file'), async (req: AdminRequest, res) => {
  const file = (req as unknown as { file?: { originalname: string; mimetype?: string; buffer: Buffer } })
    .file;
  if (!file?.buffer?.length) return res.status(400).json({ error: 'No file was uploaded.' });

  const extension = path.extname(file.originalname).toLowerCase();
  if (!fileKindFor(extension)) {
    return res.status(400).json({
      error: `${extension || 'That file type'} is not supported. Supported: ${SUPPORTED.join(', ')}.`,
      supported: SUPPORTED,
    });
  }

  // The same sniffing every other upload goes through: an extension is a claim,
  // and a .docx that is really an executable must not reach an extractor.
  const sniffExtension = extension === '.md' ? '.txt' : extension;
  const verdict = validateUpload({
    extension: sniffExtension,
    declaredMimeType: extension === '.md' ? 'text/plain' : file.mimetype,
    buffer: file.buffer,
  });
  if (verdict.ok !== true) return res.status(400).json({ error: verdict.error });

  try {
    const source = await ingestSource({
      filename: file.originalname,
      buffer: file.buffer,
      mimeType: verdict.mimeType,
      title: typeof req.body?.title === 'string' ? req.body.title : undefined,
      author: typeof req.body?.author === 'string' ? req.body.author : undefined,
      description: typeof req.body?.description === 'string' ? req.body.description : undefined,
      createdBy: req.adminUser?.id || 'admin',
    });

    // A source that failed is still a 200: the record exists, carries the
    // reason, and is visible in the library. A 500 here would leave the admin
    // with an error toast and a row they cannot explain.
    return res.json({ success: source.status === 'ready', item: source });
  } catch (error) {
    if (error instanceof UnsupportedSourceError) {
      return res.status(400).json({ error: error.message, supported: SUPPORTED });
    }
    console.error('[Sources] ingestion failed:', error);
    return res.status(500).json({ error: 'The source could not be ingested.' });
  }
});

/**
 * The passages of one source: browsed in reading order, or searched.
 *
 * A search always answers with a `retrieval` outcome, including when it found
 * nothing. `status: 'no_match'` and an empty `hits` array are different things
 * from a caller's point of view, and only one of them is a claim about the
 * book.
 */
sourceRouter.get('/:id/chunks', async (req, res) => {
  try {
    const source = await sourceStore.get(req.params.id);
    if (!source) return notFound(res);
    if (source.status !== 'ready') {
      return res.status(409).json({
        error: `This source is "${source.status}", so it has nothing to search yet.`,
        status: source.status,
      });
    }

    const chunks = await sourceStore.getChunks(req.params.id);
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));

    if (!query.trim()) {
      const offset = Math.max(0, Number(req.query.offset) || 0);
      return res.json({
        mode: 'browse',
        total: chunks.length,
        offset,
        items: chunks.slice(offset, offset + limit),
      });
    }

    return res.json({ mode: 'search', total: chunks.length, retrieval: retrieve(chunks, query, { limit }) });
  } catch (error) {
    console.error('[Sources] chunk read failed:', error);
    return res.status(500).json({ error: 'Unable to read the passages.' });
  }
});

/**
 * The exact span a chunk was cut from, read back out of the stored extraction.
 *
 * This is what makes a citation checkable rather than decorative: the offsets
 * are resolved against the stored text, and a mismatch is reported instead of
 * being smoothed over.
 */
sourceRouter.get('/:id/chunks/:chunkId/source', async (req, res) => {
  try {
    const source = await sourceStore.get(req.params.id);
    if (!source) return notFound(res);

    const chunk = (await sourceStore.getChunks(req.params.id)).find(
      (item) => item.id === req.params.chunkId,
    );
    if (!chunk) return res.status(404).json({ error: 'Passage not found.' });
    if (!source.extractedTextAssetId) {
      return res.status(409).json({ error: 'This source has no stored extraction to quote from.' });
    }

    const asset = await assetStore.get(source.extractedTextAssetId);
    if (!asset) return res.status(409).json({ error: 'The stored extraction is no longer available.' });

    const text = (await assetStore.readContent(asset)).toString('utf8');
    const span = text.slice(chunk.location.charStart, chunk.location.charEnd);

    return res.json({
      chunk,
      span,
      matches: span === chunk.text,
      provenance: {
        sourceId: source.id,
        sourceTitle: source.title,
        filename: source.filename,
        sourceAssetId: source.sourceAssetId,
        extractorVersion: chunk.extractorVersion,
        chunkerVersion: chunk.chunkerVersion,
        location: chunk.location,
      },
    });
  } catch (error) {
    console.error('[Sources] source span read failed:', error);
    return res.status(500).json({ error: 'Unable to read the original span.' });
  }
});

sourceRouter.delete('/:id', async (req, res) => {
  try {
    const removed = await sourceStore.delete(req.params.id);
    if (!removed) return notFound(res);
    // The assets it held are released the same way a deleted material's are:
    // anything nothing else references goes back to staged and is reaped later.
    try {
      await assetStore.reconcile();
    } catch (error) {
      console.error('[Sources] reconcile after delete failed:', error);
    }
    return res.json({ success: true });
  } catch (error) {
    console.error('[Sources] delete failed:', error);
    return res.status(500).json({ error: 'Unable to delete the source.' });
  }
});

/* -------------------------------------------------------------------------- */
/* Book → Test                                                                 */
/* -------------------------------------------------------------------------- */

/** What the admin screen needs to show a generation, and nothing it should not. */
function describeOutcome(outcome: GenerationOutcome) {
  return {
    status: outcome.status,
    requestId: outcome.requestId,
    attempts: outcome.attempts,
    replayed: false,
    materialId: outcome.material?.id,
    materialStatus: outcome.material?.status,
    generation: outcome.generationRecord,
    retrieved: outcome.retrieved.map((item) => ({
      chunkId: item.chunk.id,
      label: item.label,
      heading: item.chunk.heading,
      location: item.chunk.location,
      text: item.chunk.text,
      score: item.score,
      confidence: item.confidence,
      matchedTerms: item.matchedTerms,
    })),
    questions: outcome.questions.map((item) => ({
      generatedQuestionId: item.generatedQuestionId,
      status: item.status,
      groundingVerdict: item.groundingVerdict,
      qualityVerdict: item.qualityVerdict,
      reasons: item.reasons,
      question: item.question,
      candidate: item.candidate,
      evidence: item.evidence,
      questionEvidence: item.questionEvidence,
      answerEvidence: item.answerEvidence,
      distractorEvidence: item.distractorEvidence,
      chunkIds: item.chunkIds,
    })),
    passage: outcome.passage,
  };
}

/**
 * The draft an earlier arrival of the same request made, shaped like a fresh
 * generation so the screen shows it the same way. Read from the stored material
 * and its generation record: nothing is generated, and no chunk text is sent.
 */
function describeReplay(replay: ReplayedGeneration) {
  const record = replay.generationRecord;
  const stored = new Map(replay.material.content.passage.questions.map((question) => [question.id, question]));
  return {
    status: 'draft_created' as const,
    requestId: replay.requestId,
    attempts: record.attempts,
    replayed: true,
    materialId: replay.material.id,
    materialStatus: replay.material.status,
    generation: record,
    retrieved: record.retrieval.hits
      .flatMap((hit) => {
        const chunk = record.chunks.find((item) => item.chunkId === hit.chunkId);
        return chunk
          ? [
              {
                chunkId: hit.chunkId,
                label: chunk.label,
                location: { page: chunk.page, path: chunk.path, charStart: chunk.charStart, charEnd: chunk.charEnd },
                score: hit.score,
                confidence: hit.confidence,
                matchedTerms: hit.matchedTerms,
              },
            ]
          : [];
      })
      .sort((a, b) => String(a.label).localeCompare(String(b.label))),
    questions: record.questions.map((entry) => ({
      generatedQuestionId: entry.generatedQuestionId,
      status: entry.status,
      groundingVerdict: entry.groundingVerdict,
      qualityVerdict: entry.qualityVerdict,
      reasons: entry.reasons,
      question: stored.get(entry.generatedQuestionId),
      candidate: entry.candidate,
      evidence: entry.evidence,
      questionEvidence: entry.questionEvidence,
      answerEvidence: entry.answerEvidence,
      distractorEvidence: entry.distractorEvidence,
      chunkIds: entry.chunkIds,
    })),
  };
}

/**
 * Generates one Reading material from a source, grounded in retrieved chunks.
 *
 * 201 with a draft when at least one question survived validation. 200 with
 * `replayed: true` when this request id already produced a draft — the same
 * draft, nothing regenerated. 409 while the same request is still running, or
 * when its id was used for a different request. 422 when the source had
 * nothing relevant (the model is never called) or every question was rejected
 * (nothing is stored). Model failures carry their class: 503
 * `model_unavailable`, 504 `generation_timeout`, 429 `quota_exceeded`, 502
 * `invalid_model_response`, 500 `model_configuration_error`. Nothing here
 * publishes.
 */
sourceRouter.post('/:id/generate', async (req: AdminRequest, res) => {
  try {
    const outcome = await generateReadingFromSource({
      sourceId: req.params.id,
      requestId: req.body?.requestId ?? req.get('Idempotency-Key'),
      topic: req.body?.topic,
      questionType: req.body?.questionType,
      count: req.body?.count,
      module: req.body?.module,
      targetBand: req.body?.targetBand,
      title: req.body?.title,
      author: req.adminUser?.displayName || 'Admin',
    });
    if (outcome.status === 'replayed') return res.status(200).json(describeReplay(outcome));

    const body = describeOutcome(outcome);
    if (outcome.status === 'all_rejected') {
      return res.status(422).json({
        ...body,
        code: 'all_rejected',
        error: 'The model answered, but no generated question survived validation. No draft was created.',
      });
    }
    return res.status(201).json(body);
  } catch (error) {
    if (error instanceof GenerationRequestError) {
      return res.status(error.status).json({ error: error.message, code: error.code, ...error.details });
    }
    console.error('[BookToTest] generation failed:', error);
    return res.status(500).json({ error: 'Generation failed.', code: 'generation_failed' });
  }
});

/**
 * Recent generation runs for one source, newest first — including the ones that
 * produced no draft. Codes, attempts, models and chunk ids; no source text and
 * no prompt.
 */
sourceRouter.get('/:id/generation-runs', async (req, res) => {
  try {
    const source = await sourceStore.get(req.params.id).catch(() => null);
    if (!source) return notFound(res);
    const requested = Number(req.query.limit);
    const limit = Number.isInteger(requested) && requested >= 1 ? Math.min(requested, 50) : 20;
    return res.json({ runs: await generationLog.listRuns(source.id, limit) });
  } catch (error) {
    console.error('[BookToTest] reading the run log failed:', error);
    return res.status(500).json({ error: 'Unable to read the generation log.' });
  }
});

/**
 * A generated draft, shaped for the existing import review screen.
 *
 * Built from the material as it is now, so reopening a draft that was edited
 * shows the edits rather than the original generation output.
 */
sourceRouter.get('/generated/:materialId/review', async (req, res) => {
  try {
    const material = await adminStore.getMaterial('reading', req.params.materialId).catch(() => null);
    if (!material || material.section !== 'reading') {
      return res.status(404).json({ error: 'Material not found.' });
    }
    const record = material.content.generationRecord;
    if (!record) {
      return res.status(404).json({ error: 'This material was not generated from a source.' });
    }

    const input = reviewInputFor({
      title: material.title,
      passageText: material.content.passage.text,
      passageHtml: material.content.passage.htmlContent ?? material.content.htmlContent ?? '',
      record,
      questions: material.content.passage.questions,
    });

    // Each decision says whether its question is still in the draft, and if so
    // whether it still covers that question as stored now. An excluded question
    // is not a changed one, and the screen must not say it was.
    const storedQuestions = new Map(material.content.passage.questions.map((question) => [question.id, question]));
    const generationReviews = (material.content.generationReviews ?? []).map((review) => {
      const question = storedQuestions.get(review.generatedQuestionId);
      return {
        ...review,
        inDraft: Boolean(question),
        current: question ? questionContentHash(question) === review.questionHash : false,
      };
    });

    return res.json({
      materialId: material.id,
      status: material.status,
      generationReviews,
      classification: {
        section: 'reading',
        module: material.module,
        theme: material.theme ?? '',
        targetBand: material.targetBand ?? '',
        title: material.title,
        part: material.content.passage.passageNumber,
      },
      ...input,
    });
  } catch (error) {
    console.error('[BookToTest] review read failed:', error);
    return res.status(500).json({ error: 'Unable to open the generated draft.' });
  }
});

/**
 * A person's decision about one question machine validation flagged.
 *
 * The only way a needs-review question can become publishable. The decision is
 * appended, never overwritten; the reviewer is the admin in the session, not
 * anyone the request names; the machine verdict is copied in as it stood; and
 * the question's content hash is recorded, so editing the question afterwards
 * makes the confirmation lapse. Valid questions have nothing to confirm, and
 * rejected ones cannot be promoted at all.
 */
sourceRouter.post('/generated/:materialId/questions/:questionId/reviews', async (req: AdminRequest, res) => {
  try {
    const decision = req.body?.decision;
    if (decision !== 'confirmed' && decision !== 'rejected') {
      return res.status(400).json({ error: 'Choose to confirm the question or uphold the flag.', code: 'decision_required' });
    }
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    if (note.length < 10) {
      return res.status(400).json({ error: 'Say what you checked against the source (at least 10 characters).', code: 'note_required' });
    }
    const reviewer = req.adminUser;
    if (!reviewer?.id) return res.status(401).json({ error: 'Sign in again to record a decision.', code: 'no_reviewer' });

    const material = await adminStore.getMaterial('reading', req.params.materialId).catch(() => null);
    if (!material || material.section !== 'reading') return res.status(404).json({ error: 'Material not found.' });
    const record = material.content.generationRecord;
    if (!record) return res.status(404).json({ error: 'This material was not generated from a source.' });
    if (material.status !== 'draft') {
      return res.status(409).json({ error: 'Only a draft can be reviewed. Unpublish it first.', code: 'not_draft' });
    }

    const entry = record.questions.find((item) => item.generatedQuestionId === req.params.questionId);
    if (!entry) return res.status(404).json({ error: 'That question is not part of this generation.', code: 'question_not_found' });
    if (entry.status !== 'needs_review') {
      return res.status(409).json({
        error:
          entry.status === 'valid'
            ? 'This question already passed validation; there is nothing to confirm.'
            : 'A question rejected by validation cannot be promoted.',
        code: 'not_needs_review',
      });
    }
    const question = material.content.passage.questions.find((item) => item.id === entry.generatedQuestionId);
    if (!question) {
      return res.status(409).json({
        error: 'This question is not in the saved material. Include it and save the draft before deciding on it.',
        code: 'question_not_in_material',
      });
    }

    const review: StoredGenerationReview = {
      reviewId: `rev-${Date.now()}-${nanoid(6)}`,
      generatedQuestionId: entry.generatedQuestionId,
      decision,
      note,
      reviewer: {
        id: reviewer.id,
        username: reviewer.username,
        displayName: reviewer.displayName || reviewer.username,
      },
      reviewedAt: new Date().toISOString(),
      questionHash: questionContentHash(question),
      machineVerdict: {
        status: entry.status,
        groundingStatus: entry.groundingVerdict?.status ?? entry.status,
        qualityStatus: entry.qualityVerdict?.status ?? entry.status,
        reasonCodes: [...(entry.groundingVerdict?.reasons ?? []), ...(entry.qualityVerdict?.reasons ?? [])].map(
          (reason) => reason.code,
        ),
      },
    };

    const updated = await adminStore.appendGenerationReview('reading', material.id, review);
    return res.status(201).json({ review, item: updated });
  } catch (error) {
    if (error instanceof MaterialValidationError) {
      return res.status(400).json({ error: 'The decision could not be recorded.', issues: error.issues });
    }
    console.error('[BookToTest] review record failed:', error);
    return res.status(500).json({ error: 'Unable to record the decision.' });
  }
});
