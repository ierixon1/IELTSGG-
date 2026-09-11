import express, { Response } from 'express';
import { adminStore } from '../services/adminStore';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { toPublicMaterialSummary } from '../services/publicMaterialView';
import { listLearnerBundles, openSitting } from '../services/bundleService';
import { toLearnerMaterial } from '../services/sittingView';
import { assetStore } from '../services/assetStore';
import { sendAsset } from './adminRoutes';

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

/** Published bundles, as summaries, each saying whether it can be opened right now. */
learnerContentRouter.get('/learner/bundles', async (_req: AuthenticatedRequest, res) => {
  try {
    return res.json({ bundles: await listLearnerBundles() });
  } catch (error) {
    console.error('[LearnerContent] bundle list error:', error);
    return res.status(500).json({ error: 'Unable to load published tests.' });
  }
});

/**
 * One published bundle, resolved to exactly the materials it pinned.
 *
 * Refused — with a code the exam screen turns into an explanation — when the
 * bundle does not exist, has been withdrawn or retired, or no longer passes the
 * bundle gate. Nothing is substituted for a component that fails.
 */
learnerContentRouter.get('/learner/bundles/:id', async (req: AuthenticatedRequest, res) => {
  try {
    const outcome = await openSitting(req.params.id);
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error, code: outcome.code });
    return res.json(outcome.sitting);
  } catch (error) {
    console.error('[LearnerContent] bundle read error:', error);
    return res.status(500).json({ error: 'The exam could not be loaded.', code: 'invalid_bundle' });
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
    return res.json({ item: toLearnerMaterial(item, { keepTranscript: true }) });
  } catch (error) {
    console.error('[LearnerContent] material read error:', error);
    return unavailable(res);
  }
});

/**
 * Serves an asset to a signed-in learner, but only one that published content
 * actually references.
 *
 * This is the narrowest rule that still lets a Listening test play its audio
 * and a Reading passage show its diagram: a staged upload, a draft's asset, or
 * a guessed id all answer 404. `sendAsset` decides the headers, so imported
 * HTML is a neutral download here too, never an executable page.
 */
learnerContentRouter.get('/assets/:id', async (req: AuthenticatedRequest, res) => {
  try {
    const asset = await assetStore.get(req.params.id);
    if (!asset) return res.status(404).json({ error: 'Asset not found.' });

    const referenced = await collectPublishedAssetIds();
    if (!referenced.has(asset.id)) return res.status(404).json({ error: 'Asset not found.' });

    return sendAsset(res, asset, await assetStore.readContent(asset));
  } catch (error) {
    console.error('[LearnerContent] asset read error:', error);
    return res.status(404).json({ error: 'Asset not found.' });
  }
});

/**
 * Asset ids reachable from a *published* material, in any section — read from
 * the learner view, so an imported document's untouched original is never among them.
 */
async function collectPublishedAssetIds(): Promise<Set<string>> {
  const { extractAssetIds } = await import('../services/assetStore');
  const { adminStore } = await import('../services/adminStore');
  const sections = ['speaking', 'reading', 'listening', 'writing'] as const;
  const lists = await Promise.all(sections.map((s) => adminStore.listMaterials(s, 'published')));
  const ids = new Set<string>();
  for (const item of lists.flat()) for (const id of extractAssetIds(toLearnerMaterial(item, { keepTranscript: true }))) ids.add(id);
  return ids;
}
