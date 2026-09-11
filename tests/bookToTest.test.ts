import './env';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect } from './harness';
import { removeTempRoot } from './tempDir';
import type { Question } from '../src/types';
import type { SourceChunk, StoredSource } from '../src/types/source';
import type { GenerationModel, ModelRequest } from '../src/services/bookToTest/model';

/**
 * Book → Test, driven through the real routes, the real store and the real
 * review state machine, with only the model replaced.
 *
 * The model is mocked at the boundary the pipeline actually has — the
 * `GenerationModel` it calls — so retrieval, the prompt contract, parsing,
 * validation, draft creation, the write schema and the publish gate all run
 * for real. Every "bad model" case below is a response a real model can and
 * does produce: text that is not JSON, a type that was not asked for, an
 * answer that is not in the book, a citation to a chunk that does not exist.
 */
const originalCwd = process.cwd();
const FIXTURES = path.join(originalCwd, 'tests', 'fixtures', 'sources');
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'everstudy-book-to-test-'));
process.chdir(tempRoot);

const ADMIN_USER = 'btt_admin';
const ADMIN_PASSWORD = 'Str0ng-Passw0rd-For-BookToTest';
process.env.SEED_DEFAULT_ACCOUNTS = 'true';
process.env.ADMIN_USER = ADMIN_USER;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;

const express = (await import('express')).default;
const { adminRouter } = await import('../src/routes/adminRoutes');
const { learnerContentRouter } = await import('../src/routes/learnerContentRoutes');
const { authRouter } = await import('../src/routes/authRoutes');
const { authenticateRequest } = await import('../src/middleware/authMiddleware');
const { ingestSource } = await import('../src/services/sourceIngest/ingest');
const { sourceStore } = await import('../src/services/sourceStore');
const { adminStore } = await import('../src/services/adminStore');
const { assetStore, extractAssetIds } = await import('../src/services/assetStore');
const { setGenerationModel } = await import('../src/services/bookToTest/model');
const { setGenerationPolicy } = await import('../src/services/bookToTest/reliability');
const { redactAnswerKeys } = await import('../src/services/publicMaterialView');
const { buildReviewState, setClassification, setDecision, toSavePayload } = await import(
  '../src/services/cdiImport/review'
);
const { AdminImportReview } = await import('../src/components/admin/AdminImportReview');

/* -------------------------------------------------------------------------- */
/* The model, replaced at its boundary                                         */
/* -------------------------------------------------------------------------- */

class FakeModel implements GenerationModel {
  readonly name = 'fake-model';
  readonly calls: ModelRequest[] = [];
  constructor(private readonly respond: (request: ModelRequest) => string) {}
  async generate(request: ModelRequest) {
    this.calls.push(request);
    return { text: this.respond(request), model: 'fake-model', modelVersion: 'fake-model-001' };
  }
}

class FailingModel implements GenerationModel {
  readonly name = 'failing-model';
  calls = 0;
  async generate(): Promise<never> {
    this.calls += 1;
    throw new Error('ECONNRESET: socket hang up');
  }
}

interface Excerpt {
  chunkId: string;
  label: string;
  text: string;
}

/** Reads the excerpts back out of the prompt, exactly as the model would see them. */
function excerptsOf(prompt: string): Excerpt[] {
  const found: Excerpt[] = [];
  const pattern = /<<<EXCERPT chunkId="([^"]+)" section="([A-Z])"[^>]*>\n([\s\S]*?)\n>>>/g;
  for (const match of prompt.matchAll(pattern)) {
    found.push({ chunkId: match[1], label: match[2], text: match[3] });
  }
  return found;
}

function excerptWith(request: ModelRequest, needle: string): Excerpt {
  const excerpt = excerptsOf(request.prompt).find((item) => item.text.includes(needle));
  if (!excerpt) throw new Error(`the excerpt containing "${needle}" was not in the prompt`);
  return excerpt;
}

const SCANNING_TOPIC = 'scanning for dates and proper nouns';
const SCANNING_QUOTE =
  'Numbers, dates, proper nouns and capitalised terms are the easiest targets because they stand out visually.';

/**
 * Four questions a real model could plausibly return for the scanning topic:
 * one sound, one with an answer the book never mentions, one whose answer is in
 * the chunk but not in its own quote, and one citing a chunk nobody supplied.
 */
function mixedScanningResponse(request: ModelRequest): string {
  const scan = excerptWith(request, 'proper nouns');
  const cite = (quote: string) => [{ chunkId: scan.chunkId, quote }];
  const invented = [
    {
      chunkId: 'src-invented-c00099',
      quote: 'Examiners place a plausible wrong answer near the correct one deliberately.',
    },
  ];
  return JSON.stringify({
    questions: [
      {
        type: 'short_answer',
        prompt: 'What does the book call numbers, dates, proper nouns and capitalised terms?',
        wordLimit: 'NO MORE THAN THREE WORDS',
        correctAnswer: 'the easiest targets',
        questionEvidence: cite(SCANNING_QUOTE),
        answerEvidence: cite(SCANNING_QUOTE),
      },
      {
        type: 'short_answer',
        prompt: 'What should candidates underline while scanning?',
        wordLimit: 'NO MORE THAN THREE WORDS',
        correctAnswer: 'bold typography',
        questionEvidence: cite(SCANNING_QUOTE),
        answerEvidence: cite(SCANNING_QUOTE),
      },
      {
        type: 'short_answer',
        prompt: 'How does the book describe scanning compared with skimming?',
        wordLimit: 'NO MORE THAN THREE WORDS',
        correctAnswer: 'opposite movement',
        questionEvidence: cite('Numbers, dates, proper nouns and capitalised terms are the easiest targets'),
        answerEvidence: cite('Numbers, dates, proper nouns and capitalised terms are the easiest targets'),
      },
      {
        type: 'short_answer',
        prompt: 'Where do examiners place distractors?',
        wordLimit: 'NO MORE THAN THREE WORDS',
        correctAnswer: 'near the answer',
        questionEvidence: invented,
        answerEvidence: invented,
      },
    ],
  });
}

/* -------------------------------------------------------------------------- */
/* Server                                                                      */
/* -------------------------------------------------------------------------- */

let server: Server;
let origin = '';
let adminCookie = '';
let learnerCookie = '';
let source: StoredSource;
let chunks: SourceChunk[] = [];

const api = (url: string, init: RequestInit = {}) =>
  fetch(`${origin}${url}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', cookie: adminCookie, ...(init.headers || {}) },
  });

// Every call is its own deliberate request, so each gets a fresh request id.
const generate = (body: Record<string, unknown>, sourceId = source.id) =>
  api(`/api/admin/sources/${sourceId}/generate`, {
    method: 'POST',
    body: JSON.stringify({ requestId: randomUUID(), ...body }),
  });

const readingCount = async () => (await adminStore.listMaterials('reading')).length;

const scanningRequest = {
  topic: SCANNING_TOPIC,
  questionType: 'short_answer',
  count: 4,
  module: 'academic',
  targetBand: '7.0',
};

// The real retry policy, with delays short enough not to be waited out.
before(async () => {
  setGenerationPolicy({ initialDelayMs: 1, maxDelayMs: 5, attemptTimeoutMs: 5000, totalTimeoutMs: 10000 });
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/auth', authRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api', authenticateRequest, learnerContentRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  const login = await fetch(`${origin}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASSWORD }),
  });
  adminCookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  expect(adminCookie).toContain('prep_admin_auth=');

  const registered = await fetch(`${origin}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'btt_learner',
      email: 'btt-learner@example.com',
      password: 'Str0ng-Passw0rd-For-Learners',
      name: 'BTT Learner',
    }),
  });
  learnerCookie = (registered.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

  source = await ingestSource({
    filename: 'study-skills.md',
    buffer: readFileSync(path.join(FIXTURES, 'study-skills.md')),
    mimeType: 'text/plain',
    createdBy: 'test',
  });
  expect(source.status).toBe('ready');
  chunks = await sourceStore.getChunks(source.id);
});

after(async () => {
  setGenerationModel(null);
  setGenerationPolicy(null);
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  process.chdir(originalCwd);
  removeTempRoot(tempRoot);
});

/* -------------------------------------------------------------------------- */
/* Retrieval → generation                                                      */
/* -------------------------------------------------------------------------- */

describe('retrieval comes first, and bounds what the model sees', () => {
  it('gives the model only the retrieved chunks, with their provenance and the no-invention rule', async () => {
    const model = new FakeModel(mixedScanningResponse);
    setGenerationModel(model);

    const response = await generate(scanningRequest);
    expect(response.status).toBe(201);
    const body = await response.json();

    expect(model.calls).toHaveLength(1);
    const request = model.calls[0];
    const supplied = excerptsOf(request.prompt).map((excerpt) => excerpt.chunkId);

    // Exactly what the record says was supplied, and exactly what retrieval ranked.
    expect(supplied).toEqual(body.generation.chunks.map((chunk: { chunkId: string }) => chunk.chunkId));
    for (const id of supplied) {
      expect(body.generation.retrieval.hits.some((hit: { chunkId: string }) => hit.chunkId === id)).toBe(true);
    }

    // Each excerpt is the stored chunk text verbatim, with its location.
    for (const excerpt of excerptsOf(request.prompt)) {
      const chunk = chunks.find((item) => item.id === excerpt.chunkId);
      expect(chunk?.text).toBe(excerpt.text);
    }
    expect(request.prompt).toContain('location="');

    // Nothing unretrieved leaked in — the clock chapter has nothing to do with scanning.
    expect(request.prompt.includes('Sixty minutes, three passages')).toBe(false);

    // The contract.
    expect(request.systemInstruction).toContain('Use ONLY the text inside the SOURCE EXCERPTS');
    expect(request.systemInstruction).toContain('Never state, imply or test a fact that the excerpts do not contain');
    expect(request.prompt).toContain('QUESTION FAMILY: short_answer');
    expect(request.prompt).toContain('NUMBER OF QUESTIONS: at most 4.');
  });

  it('refuses when retrieval finds nothing relevant, without calling the model or storing anything', async () => {
    const model = new FakeModel(mixedScanningResponse);
    setGenerationModel(model);
    const before = await readingCount();

    const response = await generate({ ...scanningRequest, topic: 'photosynthesis in marine algae' });
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.code).toBe('no_relevant_source');
    expect(body.retrieval.status === 'ok').toBe(false);

    expect(model.calls).toHaveLength(0);
    expect(await readingCount()).toBe(before);
  });

  it('answers 404 for a source that does not exist', async () => {
    setGenerationModel(new FakeModel(mixedScanningResponse));
    const response = await generate(scanningRequest, 'src-does-not-exist');
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe('source_not_found');
  });

  it('refuses a question type it does not generate, before retrieving or calling anything', async () => {
    const model = new FakeModel(mixedScanningResponse);
    setGenerationModel(model);
    const response = await generate({ ...scanningRequest, questionType: 'diagram_label' });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('unsupported_question_type');
    expect(model.calls).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Structured output, validation, draft                                        */
/* -------------------------------------------------------------------------- */

describe('what survives validation, and what becomes the draft', () => {
  let body: Record<string, any>;
  let materialId = '';

  before(async () => {
    setGenerationModel(new FakeModel(mixedScanningResponse));
    const response = await generate(scanningRequest);
    expect(response.status).toBe(201);
    body = await response.json();
    materialId = body.materialId;
  });

  it('classifies every returned question, with a reason for anything short of valid', () => {
    const statuses = body.questions.map((item: { status: string }) => item.status);
    expect(statuses).toEqual(['valid', 'rejected', 'needs_review', 'rejected']);

    const [valid, hallucinated, unverified, fabricated] = body.questions;
    expect(valid.reasons).toHaveLength(0);
    expect(hallucinated.reasons[0]).toContain('does not appear anywhere in the source text');
    expect(unverified.reasons[0]).toContain('not in the text cited as answer evidence');
    expect(unverified.groundingVerdict.reasons[0].code).toBe('answer_not_in_evidence');
    expect(fabricated.reasons[0]).toContain('was not supplied to the model');

    expect(body.generation.summary).toEqual({
      requested: 4,
      returned: 4,
      valid: 1,
      needsReview: 1,
      rejected: 2,
      complete: false,
    });
  });

  it('creates a draft — never a published material — from the questions that survived', async () => {
    expect(body.materialStatus).toBe('draft');
    const material = await adminStore.getMaterial('reading', materialId);
    expect(material?.status).toBe('draft');
    if (!material || material.section !== 'reading') throw new Error('expected a reading material');

    const prompts = material.content.passage.questions.map((question) => question.prompt);
    expect(prompts).toEqual([
      'What does the book call numbers, dates, proper nouns and capitalised terms?',
      'How does the book describe scanning compared with skimming?',
    ]);
    // The rejected answers never entered the material.
    expect(JSON.stringify(material.content.passage.questions).includes('bold typography')).toBe(false);
    expect(JSON.stringify(material.content.passage.questions).includes('src-invented')).toBe(false);
  });

  it('presents the source text itself as the passage', async () => {
    const material = await adminStore.getMaterial('reading', materialId);
    if (!material || material.section !== 'reading') throw new Error('expected a reading material');
    const scanChunk = chunks.find((chunk) => chunk.text.includes('proper nouns')) as SourceChunk;
    expect(material.content.passage.text.includes(scanChunk.text)).toBe(true);
  });

  it('puts machine-readable provenance on every generated question', async () => {
    const material = await adminStore.getMaterial('reading', materialId);
    if (!material || material.section !== 'reading') throw new Error('expected a reading material');
    const scanChunk = chunks.find((chunk) => chunk.text.includes('proper nouns')) as SourceChunk;

    for (const question of material.content.passage.questions) {
      const provenance = question.provenance;
      expect(provenance === undefined).toBe(false);
      expect(provenance?.kind).toBe('generated');
      expect(provenance?.sourceId).toBe(source.id);
      expect(provenance?.chunkIds).toEqual([scanChunk.id]);
      expect(provenance?.model).toBe('fake-model');
      expect(provenance?.generationId).toBe(body.generation.generationId);
      expect(typeof provenance?.generatedAt).toBe('string');
      expect(provenance?.locations[0].path).toEqual(scanChunk.location.path);
      expect(provenance?.evidence[0].chunkId).toBe(scanChunk.id);
    }
    expect(material.content.passage.questions.map((q) => q.provenance?.validation)).toEqual([
      'valid',
      'needs_review',
    ]);
  });

  it('persists a generation record that reconstructs source, chunks, model, prompt version and verdicts', async () => {
    const material = await adminStore.getMaterial('reading', materialId);
    if (!material || material.section !== 'reading') throw new Error('expected a reading material');
    const record = material.content.generationRecord;
    expect(record === undefined).toBe(false);
    if (!record) return;

    expect(record.source.sourceId).toBe(source.id);
    expect(record.source.originalAsset).toBe(source.sourceAssetId);
    expect(record.model).toBe('fake-model');
    expect(record.modelVersion).toBe('fake-model-001');
    expect(record.promptVersion).toBe('reading-grounded/2.0.0');
    expect(record.request.questionType).toBe('short_answer');
    expect(record.retrieval.query).toBe(SCANNING_TOPIC);
    expect(record.questions.map((entry) => entry.status)).toEqual(['valid', 'rejected', 'needs_review', 'rejected']);
    // The rejected ones are recorded, with what the model said, but only here.
    expect(record.questions[1].candidate?.correctAnswer).toBe('bold typography');
  });

  it('does not let a published generated material expose the book file to learners', async () => {
    const material = await adminStore.getMaterial('reading', materialId);
    const referenced = extractAssetIds(material);
    expect(referenced.includes(source.sourceAssetId)).toBe(false);
    expect(referenced.includes(String(source.extractedTextAssetId))).toBe(false);
  });

  it('strips provenance, with its evidence quotes, from the public view', async () => {
    const material = await adminStore.getMaterial('reading', materialId);
    const redacted = JSON.stringify(redactAnswerKeys(material));
    expect(redacted.includes('"provenance"')).toBe(false);
  });

  it('refuses to publish while a question validation could not verify is included', async () => {
    const response = await api(`/api/admin/materials/reading/${materialId}/publish`, { method: 'POST' });
    expect(response.status).toBe(409);
    const codes = (await response.json()).blockers.map((blocker: { code: string }) => blocker.code);
    expect(codes.includes('generation_unverified')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Failures                                                                    */
/* -------------------------------------------------------------------------- */

describe('failure leaves nothing behind', () => {
  const sourceSnapshot = async () => ({
    chunks: JSON.stringify(await sourceStore.getChunks(source.id)),
    original: (await assetStore.readContent((await assetStore.get(source.sourceAssetId))!)).toString('base64'),
    record: JSON.stringify(await sourceStore.get(source.id)),
  });

  it('retries a dropped connection within the bound, reports the model unavailable, creates no draft, and leaves the source untouched', async () => {
    const model = new FailingModel();
    setGenerationModel(model);
    const beforeCount = await readingCount();
    const beforeSource = await sourceSnapshot();

    const response = await generate(scanningRequest);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.code).toBe('model_unavailable');
    expect(body.failureClass).toBe('unavailable');
    expect(body.attempts).toBe(3);

    // A dropped connection is transient, so it is retried — and only up to the bound.
    expect(model.calls).toBe(3);
    expect(await readingCount()).toBe(beforeCount);
    expect(JSON.stringify(await sourceSnapshot())).toBe(JSON.stringify(beforeSource));
  });

  it('treats a response that is not JSON as a failed generation', async () => {
    setGenerationModel(new FakeModel(() => 'Sure! Here are some great questions:\n1. What is scanning?'));
    const beforeCount = await readingCount();
    const response = await generate(scanningRequest);
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.code).toBe('invalid_model_response');
    expect(body.reason).toBe('invalid_json');
    expect(await readingCount()).toBe(beforeCount);
  });

  it('treats JSON of the wrong shape as a failed generation', async () => {
    setGenerationModel(new FakeModel(() => JSON.stringify({ items: [{ q: 'What is scanning?' }] })));
    const beforeCount = await readingCount();
    const response = await generate(scanningRequest);
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.code).toBe('invalid_model_response');
    expect(body.reason).toBe('invalid_shape');
    expect(await readingCount()).toBe(beforeCount);
  });

  it('stores nothing when every returned question is rejected', async () => {
    setGenerationModel(
      new FakeModel((request) => {
        const scan = excerptWith(request, 'proper nouns');
        return JSON.stringify({
          questions: [
            // Wrong family.
            {
              type: 'multiple_choice',
              prompt: 'Which is easiest to scan for?',
              options: ['A. Verbs', 'B. Proper nouns'],
              correctAnswer: 'B',
              evidence: [{ chunkId: scan.chunkId, quote: SCANNING_QUOTE }],
            },
            // No provenance at all.
            { type: 'short_answer', prompt: 'What stands out visually?', correctAnswer: 'proper nouns' },
          ],
        });
      }),
    );
    const beforeCount = await readingCount();
    const response = await generate({ ...scanningRequest, count: 2 });
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.code).toBe('all_rejected');
    expect(body.materialId).toBe(undefined);
    expect(body.questions.map((item: { status: string }) => item.status)).toEqual(['rejected', 'rejected']);
    expect(body.questions[0].reasons[0]).toContain('only short_answer was requested');
    expect(body.questions[1].reasons[0]).toContain('no question evidence');
    expect(await readingCount()).toBe(beforeCount);
  });
});

/* -------------------------------------------------------------------------- */
/* Review, persistence, publication                                            */
/* -------------------------------------------------------------------------- */

describe('the generated draft goes through the existing review and lifecycle', () => {
  let materialId = '';

  before(async () => {
    setGenerationModel(new FakeModel(mixedScanningResponse));
    const response = await generate(scanningRequest);
    materialId = (await response.json()).materialId;
  });

  const openReview = async () => {
    const response = await api(`/api/admin/sources/generated/${materialId}/review`);
    expect(response.status).toBe(200);
    const input = await response.json();
    return setClassification(
      buildReviewState(input.result, {
        sourceHtml: input.sourceHtml,
        materialId: input.materialId,
        generationRecord: input.generationRecord,
      }),
      { section: 'reading', ...input.classification },
    );
  };

  it('opens in the import review screen with the verdicts it was generated with', async () => {
    const state = await openReview();
    expect(state.materialId).toBe(materialId);
    expect(state.questions.map((question) => question.originalStatus)).toEqual([
      'parsed',
      'unsupported',
      'needs_review',
      'unsupported',
    ]);
    // Rejected questions are shown, and kept out by default.
    expect(state.questions.map((question) => question.decision)).toEqual([
      'include',
      'mark_unsupported',
      'include',
      'mark_unsupported',
    ]);

    const html = renderToStaticMarkup(
      createElement(AdminImportReview, {
        state,
        onChange: () => {},
        onSaveDraft: async () => {},
        onCancel: () => {},
      }),
    );
    expect(html).toContain('import-learner-preview');
    expect(html).toContain('What does the book call numbers, dates, proper nouns and capitalised terms?');
  });

  it('will not let review include a rejected question', async () => {
    const state = await openReview();
    const rejected = state.questions.find((question) => question.originalStatus === 'unsupported');
    const forced = setDecision(state, rejected!.key, 'include');
    expect(toSavePayload(forced)).toBe(null);
  });

  it('keeps provenance and the generation record through review → save → reread', async () => {
    const before = await adminStore.getMaterial('reading', materialId);
    if (!before || before.section !== 'reading') throw new Error('expected a reading material');

    const payload = toSavePayload(await openReview());
    expect(payload?.id).toBe(materialId);
    const response = await api(`/api/admin/materials/reading/${materialId}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    expect(response.status).toBe(200);

    const after = await adminStore.getMaterial('reading', materialId);
    if (!after || after.section !== 'reading') throw new Error('expected a reading material');
    expect(after.id).toBe(materialId);
    expect(after.status).toBe('draft');
    expect(JSON.stringify(after.content.passage.questions.map((q) => q.provenance))).toBe(
      JSON.stringify(before.content.passage.questions.map((q) => q.provenance)),
    );
    expect(JSON.stringify(after.content.generationRecord)).toBe(JSON.stringify(before.content.generationRecord));
    // Saved as an update, not as a second copy.
    const copies = (await adminStore.listMaterials('reading')).filter(
      (item) => item.section === 'reading' && item.content.generationRecord?.generationId === before.content.generationRecord?.generationId,
    );
    expect(copies).toHaveLength(1);
  });

  it('refuses a write that removes provenance from a generated question', async () => {
    const material = await adminStore.getMaterial('reading', materialId);
    if (!material || material.section !== 'reading') throw new Error('expected a reading material');
    const stripped = structuredClone(material);
    delete (stripped.content.passage.questions[0] as Partial<Question>).provenance;

    const response = await api(`/api/admin/materials/reading/${materialId}`, {
      method: 'PUT',
      body: JSON.stringify(stripped),
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain('provenance cannot be removed');
  });

  it('refuses a write that smuggles a rejected question into the material', async () => {
    const material = await adminStore.getMaterial('reading', materialId);
    if (!material || material.section !== 'reading' || !material.content.generationRecord) {
      throw new Error('expected a generated reading material');
    }
    const rejectedId = material.content.generationRecord.questions.find((entry) => entry.status === 'rejected')!
      .generatedQuestionId;
    const smuggled = structuredClone(material);
    const template = smuggled.content.passage.questions[0];
    smuggled.content.passage.questions.push({
      ...template,
      id: rejectedId,
      questionNumber: 3,
      prompt: 'What should candidates underline while scanning?',
      correctAnswer: 'bold typography',
      provenance: { ...template.provenance!, generatedQuestionId: rejectedId },
    });

    const response = await api(`/api/admin/materials/reading/${materialId}`, {
      method: 'PUT',
      body: JSON.stringify(smuggled),
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain('rejected by validation');
  });

  it('refuses to let a request rewrite the verdicts in the generation record', async () => {
    const material = await adminStore.getMaterial('reading', materialId);
    if (!material || material.section !== 'reading' || !material.content.generationRecord) {
      throw new Error('expected a generated reading material');
    }
    const forged = structuredClone(material);
    for (const entry of forged.content.generationRecord!.questions) entry.status = 'valid';

    await api(`/api/admin/materials/reading/${materialId}`, { method: 'PUT', body: JSON.stringify(forged) });
    const reread = await adminStore.getMaterial('reading', materialId);
    if (!reread || reread.section !== 'reading') throw new Error('expected a reading material');
    expect(reread.content.generationRecord?.questions.map((entry) => entry.status)).toEqual([
      'valid',
      'rejected',
      'needs_review',
      'rejected',
    ]);
  });

  it('publishes once the unverifiable question is excluded, and provenance reaches the learner', async () => {
    const state = await openReview();
    const unverified = state.questions.find((question) => question.originalStatus === 'needs_review')!;
    const payload = toSavePayload(setDecision(state, unverified.key, 'exclude'));
    const saved = await api(`/api/admin/materials/reading/${materialId}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    expect(saved.status).toBe(200);

    const published = await api(`/api/admin/materials/reading/${materialId}/publish`, { method: 'POST' });
    expect(published.status).toBe(200);
    expect((await published.json()).item.status).toBe('published');

    const learner = await fetch(`${origin}/api/learner/materials/reading/${materialId}`, {
      headers: { cookie: learnerCookie },
    });
    expect(learner.status).toBe(200);
    const item = (await learner.json()).item;
    expect(item.content.passage.questions).toHaveLength(1);
    expect(item.content.passage.questions[0].provenance.sourceId).toBe(source.id);
    expect(item.content.passage.questions[0].provenance.validation).toBe('valid');
  });
});
