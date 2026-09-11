import express, { type RequestHandler, type Response } from 'express';
import { BundleDraftInputSchema, StoredBundleError } from '../schemas/bundle';
import { bundleStore, BundleStateError, type BundleStateCode } from '../services/bundleStore';
import {
  bundleCandidates,
  checkBundle,
  describeBundle,
  publishBundle,
  summarizeBundle,
  transitionBundle,
} from '../services/bundleService';
import type { BundleLifecycleStatus } from '../types/bundle';

/**
 * The admin side of Full CDI bundles: the catalog, the builder's data, and the
 * lifecycle verbs.
 *
 * Saving creates or updates a draft and nothing else — a `status` in the body is
 * dropped by the schema. `publish` is the only way to publish, and it answers
 * 409 with the gate's reasons when the bundle is not fit. A published bundle is
 * not edited in place: it is unpublished first.
 *
 * Built as a factory so the role guard can be handed in: importing it from the
 * admin router would make the two modules import each other.
 */

const STATE_STATUS: Record<BundleStateCode, number> = {
  bundle_not_found: 404,
  bundle_not_draft: 409,
  bundle_published: 409,
  bundle_was_published: 409,
  invalid_transition: 409,
};

const STATUSES: Array<BundleLifecycleStatus | 'all'> = ['all', 'draft', 'published', 'archived'];

function fail(res: Response, error: unknown, context: string) {
  if (error instanceof BundleStateError) {
    return res.status(STATE_STATUS[error.code]).json({ error: error.message, code: error.code });
  }
  if (error instanceof StoredBundleError) {
    console.error(`[Bundles] ${context}:`, error);
    return res.status(500).json({ error: 'This bundle is stored in a form that cannot be read.', code: 'bundle_unreadable', issues: error.issues });
  }
  console.error(`[Bundles] ${context}:`, error);
  return res.status(500).json({ error: 'The bundle request failed.' });
}

export function createBundleRouter(requireAdminRole: RequestHandler) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      const requested = String(req.query.status ?? 'all');
      const status = STATUSES.find((value) => value === requested) ?? 'all';
      const bundles = await bundleStore.list(status);
      return res.json({ bundles: bundles.map((bundle) => ({ ...summarizeBundle(bundle), components: bundle.components, firstPublishedAt: bundle.firstPublishedAt })) });
    } catch (error) {
      return fail(res, error, 'list');
    }
  });

  /** Published materials that can be pinned into a slot, with the fingerprint a pin would take. */
  router.get('/candidates', async (_req, res) => {
    try {
      return res.json({ candidates: await bundleCandidates() });
    } catch (error) {
      return fail(res, error, 'candidates');
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      const bundle = await bundleStore.get(req.params.id);
      if (!bundle) return res.status(404).json({ error: 'Bundle not found.', code: 'bundle_not_found' });
      return res.json(await describeBundle(bundle));
    } catch (error) {
      return fail(res, error, 'read');
    }
  });

  router.get('/:id/check', async (req, res) => {
    try {
      const bundle = await bundleStore.get(req.params.id);
      if (!bundle) return res.status(404).json({ error: 'Bundle not found.', code: 'bundle_not_found' });
      const blockers = await checkBundle(bundle);
      return res.json({ publishable: blockers.length === 0, blockers });
    } catch (error) {
      return fail(res, error, 'check');
    }
  });

  router.post('/', requireAdminRole, async (req, res) => {
    const parsed = BundleDraftInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'The bundle draft is not well formed.',
        issues: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'bundle'}: ${issue.message}`),
      });
    }
    try {
      const bundle = await bundleStore.create(parsed.data);
      return res.status(201).json(await describeBundle(bundle));
    } catch (error) {
      return fail(res, error, 'create');
    }
  });

  router.put('/:id', requireAdminRole, async (req, res) => {
    const parsed = BundleDraftInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'The bundle draft is not well formed.',
        issues: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'bundle'}: ${issue.message}`),
      });
    }
    try {
      const bundle = await bundleStore.updateDraft(req.params.id, parsed.data);
      return res.json(await describeBundle(bundle));
    } catch (error) {
      return fail(res, error, 'update');
    }
  });

  router.post('/:id/publish', requireAdminRole, async (req, res) => {
    try {
      const outcome = await publishBundle(req.params.id);
      if (!outcome.ok) {
        return res.status(409).json({ error: 'This bundle is not ready to be published.', code: 'bundle_blocked', blockers: outcome.blockers });
      }
      return res.json(await describeBundle(outcome.bundle));
    } catch (error) {
      return fail(res, error, 'publish');
    }
  });

  router.post('/:id/:action(unpublish|archive|restore)', requireAdminRole, async (req, res) => {
    try {
      const action = req.params.action as 'unpublish' | 'archive' | 'restore';
      const bundle = await transitionBundle(req.params.id, action);
      return res.json(await describeBundle(bundle));
    } catch (error) {
      return fail(res, error, req.params.action);
    }
  });

  router.delete('/:id', requireAdminRole, async (req, res) => {
    try {
      await bundleStore.remove(req.params.id);
      return res.json({ success: true });
    } catch (error) {
      return fail(res, error, 'delete');
    }
  });

  return router;
}
