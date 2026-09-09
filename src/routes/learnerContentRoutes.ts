import express, { Response } from 'express';
import { adminStore } from '../services/adminStore';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { toPublicMaterialSummary } from '../services/publicMaterialView';

/**
 * Published content for a signed-in learner.
 *
 * This router exists to separate two things the CMS used to serve from one
 * place: the anonymous catalog view, which must not carry answer keys, and the
 * sittable test, which cannot be marked without them. Marking happens in the
 * browser, so the key has to reach a learner who is actually taking the test —
 * but it has no business reaching an anonymous request, and the `/public/*`
 * routes now withhold it.
 *
 * Mounted behind `authenticateRequest`, so `req.userId` is always present here.
 */
export const learnerContentRouter = express.Router();

const isSection = (v: unknown): v is 'speaking' | 'reading' | 'listening' | 'writing' =>
  ['speaking', 'reading', 'listening', 'writing'].includes(String(v));

function unavailable(res: Response) {
  return res.status(404).json({ error: 'Published test not found.' });
}

/** Published bundles, as summaries. */
learnerContentRouter.get('/learner/bundles', async (_req: AuthenticatedRequest, res) => {
  try {
    return res.json({ bundles: await adminStore.listBundles('published') });
  } catch (error) {
    console.error('[LearnerContent] bundle list error:', error);
    return res.status(500).json({ error: 'Unable to load published tests.' });
  }
});

/**
 * One published bundle with its materials resolved, answer keys included.
 *
 * `getResolvedBundle` already nulls out a draft material inside a published
 * bundle, so a draft cannot leak through this route either.
 */
learnerContentRouter.get('/learner/bundles/:id', async (req: AuthenticatedRequest, res) => {
  try {
    const resolved = await adminStore.getResolvedBundle(req.params.id);
    if (!resolved || resolved.bundle.status !== 'published') return unavailable(res);
    return res.json(resolved);
  } catch (error) {
    console.error('[LearnerContent] bundle read error:', error);
    return unavailable(res);
  }
});

/** Published materials in one section, as summaries — no content, no keys. */
learnerContentRouter.get('/learner/materials/:section', async (req: AuthenticatedRequest, res) => {
  if (!isSection(req.params.section)) return res.status(400).json({ error: 'Invalid section.' });
  try {
    const items = await adminStore.listMaterials(req.params.section, 'published');
    return res.json({ items: items.map(toPublicMaterialSummary) });
  } catch (error) {
    console.error('[LearnerContent] material list error:', error);
    return res.status(500).json({ error: 'Unable to load materials.' });
  }
});

/** One published material in full, answer keys included, for a sitting. */
learnerContentRouter.get('/learner/materials/:section/:id', async (req: AuthenticatedRequest, res) => {
  if (!isSection(req.params.section)) return res.status(400).json({ error: 'Invalid section.' });
  try {
    const item = await adminStore.getMaterial(req.params.section, req.params.id);
    if (!item || item.status !== 'published') return unavailable(res);
    return res.json({ item });
  } catch (error) {
    console.error('[LearnerContent] material read error:', error);
    return unavailable(res);
  }
});
