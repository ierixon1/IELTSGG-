import express, { Response } from 'express';
import { z } from 'zod';
import { adminStore } from '../services/adminStore';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { toPublicMaterialSummary } from '../services/publicMaterialView';
import { listLearnerBundles } from '../services/bundleService';
import { markPractice, practiceTestFor, type PracticeFailure } from '../services/practiceMarking';
import { authorizeAssetRead } from '../services/assetAccess';
import { assetStore } from '../services/assetStore';
import { sendAsset } from './adminRoutes';
import { loadExamUse, practiceEligibility } from '../services/practiceEligibility';
import type { LearnerMaterialSummary } from '../types/practice';
import { guardAsyncHandlers } from '../http/asyncHandlers';

/**
 * Published content for a signed-in learner.
 *
 * No response here carries an answer key, an explanation, generation
 * provenance or an imported page's printed key section — not to an anonymous
 * request, and not to a signed-in learner either. A practice test is sent
 * without keys; when the learner submits a Listening or Reading section,
 * `POST /learner/practice/mark` marks it on the server and returns the
 * verdicts, correct answers and explanations practice shows after submission.
 * A full exam goes through an exam session (`examSessionRoutes`).
 *
 * Mounted behind `authenticateRequest`, so `req.userId` is always present here.
 */
export const learnerContentRouter = guardAsyncHandlers(express.Router());

const isSection = (v: unknown): v is 'speaking' | 'reading' | 'listening' | 'writing' =>
  ['speaking', 'reading', 'listening', 'writing'].includes(String(v));

function unavailable(res: Response) {
  return res.status(404).json({ error: 'Published test not found.' });
}

/** Published bundles, as summaries, each saying whether it can be opened right now. */
learnerContentRouter.get('/learner/bundles', async (_req: AuthenticatedRequest, res) => {
  try {
    return res.json({ bundles: await listLearnerBundles() });
  } catch (error) {
    console.error('[LearnerContent] bundle list error:', error);
    return res.status(500).json({ error: 'Unable to load published tests.' });
  }
});

const refuse = (res: Response, failure: PracticeFailure) => res.status(failure.status).json({ error: failure.error, code: failure.code });

/**
 * A bundle as practice content — which a published bundle never is.
 *
 * A bundle that does not exist, has been withdrawn or retired, or no longer
 * passes the bundle gate is refused with the gate's code, as before. A bundle
 * that would open is published, so it is exam content and is refused with
 * `exam_content` (`practiceEligibility`). No response here carries content.
 */
learnerContentRouter.get('/learner/bundles/:id', async (req: AuthenticatedRequest, res) => {
  try {
    const outcome = await practiceTestFor({ kind: 'bundle', bundleId: req.params.id });
    return outcome.ok ? res.json(outcome.value) : refuse(res, outcome);
  } catch (error) {
    console.error('[LearnerContent] bundle read error:', error);
    return res.status(500).json({ error: 'The exam could not be loaded.', code: 'invalid_bundle' });
  }
});

/**
 * Published materials in one section, as summaries — no content, no keys.
 *
 * Each says whether it can be practised. That flag is for the screen only: the
 * routes that return content or marking decide again for themselves.
 */
learnerContentRouter.get('/learner/materials/:section', async (req: AuthenticatedRequest, res) => {
  if (!isSection(req.params.section)) return res.status(400).json({ error: 'Invalid section.' });
  try {
    const [items, use] = await Promise.all([adminStore.listMaterials(req.params.section, 'published'), loadExamUse()]);
    const summaries: LearnerMaterialSummary[] = items.map((item) => ({
      ...toPublicMaterialSummary(item),
      practiceAvailable: practiceEligibility(item.id, use).allowed,
    }));
    return res.json({ items: summaries });
  } catch (error) {
    console.error('[LearnerContent] material list error:', error);
    return res.status(500).json({ error: 'Unable to load materials.' });
  }
});

/**
 * One published material, adapted for practice, with no answer key anywhere.
 * Exam content is refused with `exam_content`; anything else not published is a 404.
 */
learnerContentRouter.get('/learner/materials/:section/:id', async (req: AuthenticatedRequest, res) => {
  if (!isSection(req.params.section)) return res.status(400).json({ error: 'Invalid section.' });
  try {
    const outcome = await practiceTestFor({ kind: 'material', section: req.params.section, materialId: req.params.id });
    if (outcome.ok) return res.json(outcome.value);
    return outcome.code === 'exam_content' ? refuse(res, outcome) : unavailable(res);
  } catch (error) {
    console.error('[LearnerContent] material read error:', error);
    return unavailable(res);
  }
});

const answerValue = z.union([z.string().max(2000), z.array(z.string().max(2000)).max(50)]);
const markBody = z
  .object({
    source: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('builtin') }).strict(),
      z.object({ kind: z.literal('bundle'), bundleId: z.string().min(1).max(200) }).strict(),
      z.object({ kind: z.literal('material'), section: z.enum(['listening', 'reading', 'writing', 'speaking']), materialId: z.string().min(1).max(200) }).strict(),
    ]),
    section: z.enum(['listening', 'reading']),
    answers: z.record(z.string().min(1).max(128), answerValue).refine((answers) => Object.keys(answers).length <= 400, 'Too many answers.'),
  })
  .strict();

/**
 * Marks a submitted practice section against the test the learner opened, and
 * returns what practice shows after submission: each question's verdict, its
 * correct answer and explanation, and the section score.
 */
learnerContentRouter.post('/learner/practice/mark', async (req: AuthenticatedRequest, res) => {
  const body = markBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Invalid practice submission.' });
  try {
    const outcome = await markPractice(body.data.source, body.data.section, body.data.answers);
    return outcome.ok ? res.json(outcome.value) : refuse(res, outcome);
  } catch (error) {
    console.error('[LearnerContent] practice marking error:', error);
    return res.status(500).json({ error: 'The answers could not be marked.' });
  }
});

/**
 * Serves a file to a signed-in learner: only learner media a published material
 * renders — never an imported original, a source-library file or a private
 * upload, whoever knows its id (`authorizeAssetRead`). Every refusal is the same
 * 404 as an id that does not exist. `sendAsset` decides the headers, so no file
 * is ever an executable page.
 */
learnerContentRouter.get('/assets/:id', async (req: AuthenticatedRequest, res) => {
  try {
    const access = await authorizeAssetRead('learner', req.params.id);
    if (!access.allowed) return res.status(404).json({ error: 'Asset not found.' });
    return sendAsset(res, access.asset, await assetStore.readContent(access.asset));
  } catch (error) {
    console.error('[LearnerContent] asset read error:', error);
    return res.status(404).json({ error: 'Asset not found.' });
  }
});
