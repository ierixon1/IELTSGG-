import type { AdminMaterial } from '../types/admin';
import {
  BUNDLE_SECTIONS,
  minutesKey,
  type BundleBlocker,
  type BundleBlockerCode,
  type BundleComponentRef,
  type BundleSection,
  type BundleSummary,
  type ExamSitting,
  type FullCdiBundle,
  type LearnerBundleErrorCode,
  type LearnerBundleSummary,
} from '../types/bundle';
import { describeQuestionIssue } from '../schemas/question';
import { adminStore } from './adminStore';
import { assetStore } from './assetStore';
import { bundleStore, BundleStateError } from './bundleStore';
import { bundleBlockers, type BundleGateContext, type ComponentState } from './bundleGate';
import { materialContentHash } from './materialVersion';
import { partNumberOf, questionsOf } from './publishGate';
import { toLearnerMaterial } from './sittingView';

/**
 * Bundles against the stores: building the gate's context, the lifecycle
 * transitions that need it, and resolving a published bundle into a sitting.
 *
 * Resolution is exact. A sitting contains precisely the materials the bundle
 * pinned, in the bundle's order, and only while every one of them still passes
 * the gate. When one does not, the learner gets a configuration error naming
 * the kind of problem — never the rest of the bundle with a hole in it, and
 * never content from anywhere else.
 */

const componentKey = (ref: Pick<BundleComponentRef, 'section' | 'materialId'>) => `${ref.section}:${ref.materialId}`;

/** Looks up every component the bundle names, and the asset index, once. */
export async function buildGateContext(bundle: FullCdiBundle): Promise<BundleGateContext> {
  const states = new Map<string, ComponentState>();
  for (const ref of bundle.components) {
    const key = componentKey(ref);
    if (states.has(key)) continue;
    const reviewed = await adminStore.reviewMaterial(ref.section, ref.materialId);
    if (reviewed) {
      states.set(key, {
        material: reviewed.material,
        foundInSection: null,
        needsReview: reviewed.needsReview.map(describeQuestionIssue),
        currentHash: materialContentHash(reviewed.material),
      });
      continue;
    }
    let foundInSection: BundleSection | null = null;
    for (const other of BUNDLE_SECTIONS) {
      if (other !== ref.section && (await adminStore.getMaterial(other, ref.materialId))) {
        foundInSection = other;
        break;
      }
    }
    states.set(key, { material: null, foundInSection, needsReview: [], currentHash: null });
  }

  const assets = new Map((await assetStore.list()).map((asset) => [asset.id, asset.kind as string]));
  return {
    component: (ref) => {
      const state = states.get(componentKey(ref));
      if (!state) throw new Error(`Bundle component ${componentKey(ref)} was not looked up.`);
      return state;
    },
    asset: (assetId) => ({ exists: assets.has(assetId), kind: assets.get(assetId) ?? null }),
  };
}

export async function checkBundle(bundle: FullCdiBundle): Promise<BundleBlocker[]> {
  return bundleBlockers(bundle, await buildGateContext(bundle));
}

export function summarizeBundle(bundle: FullCdiBundle): BundleSummary {
  const parts = Object.fromEntries(
    BUNDLE_SECTIONS.map((section) => [section, bundle.components.filter((ref) => ref.section === section).length]),
  ) as Record<BundleSection, number>;
  return {
    id: bundle.id,
    title: bundle.title,
    module: bundle.module,
    targetBand: bundle.targetBand,
    description: bundle.description,
    status: bundle.status,
    publishedAt: bundle.publishedAt,
    updatedAt: bundle.updatedAt,
    timing: bundle.timing,
    totalMinutes: BUNDLE_SECTIONS.reduce((sum, section) => sum + bundle.timing[minutesKey(section)], 0),
    parts,
  };
}

/** Components in the order they are sat: section order, then part. */
export function orderedComponents(bundle: FullCdiBundle): BundleComponentRef[] {
  return [...bundle.components].sort(
    (a, b) => BUNDLE_SECTIONS.indexOf(a.section) - BUNDLE_SECTIONS.indexOf(b.section) || a.part - b.part,
  );
}

export type PublishOutcome = { ok: true; bundle: FullCdiBundle } | { ok: false; blockers: BundleBlocker[] };

export async function publishBundle(id: string): Promise<PublishOutcome> {
  const bundle = await bundleStore.get(id);
  if (!bundle) throw new BundleStateError('bundle_not_found', 'Bundle not found.');
  if (bundle.status !== 'draft') {
    throw new BundleStateError(
      'invalid_transition',
      bundle.status === 'published' ? 'This bundle is already published.' : 'Restore this archived bundle before publishing it.',
    );
  }
  const blockers = await checkBundle(bundle);
  if (blockers.length > 0) return { ok: false, blockers };
  return { ok: true, bundle: await bundleStore.setStatus(id, 'published') };
}

const TRANSITIONS: Record<'unpublish' | 'archive' | 'restore', { from: FullCdiBundle['status'][]; to: FullCdiBundle['status'] }> = {
  unpublish: { from: ['published'], to: 'draft' },
  archive: { from: ['draft', 'published'], to: 'archived' },
  restore: { from: ['archived'], to: 'draft' },
};

/** Withdrawing, retiring and restoring. None of them can be refused for content reasons. */
export async function transitionBundle(id: string, action: 'unpublish' | 'archive' | 'restore'): Promise<FullCdiBundle> {
  const bundle = await bundleStore.get(id);
  if (!bundle) throw new BundleStateError('bundle_not_found', 'Bundle not found.');
  const rule = TRANSITIONS[action];
  if (!rule.from.includes(bundle.status)) {
    throw new BundleStateError('invalid_transition', `A ${bundle.status} bundle cannot be ${action === 'unpublish' ? 'unpublished' : `${action}d`}.`);
  }
  return bundleStore.setStatus(id, rule.to);
}

/** The first kind of problem, in the order a learner can do least about. */
const LEARNER_PROBLEMS: Array<[BundleBlockerCode[], LearnerBundleErrorCode]> = [
  [['component_not_found', 'section_mismatch'], 'component_missing'],
  [['component_unpublished', 'component_archived'], 'component_unpublished'],
  [['component_changed', 'component_unpinned'], 'component_changed'],
  [['audio_missing', 'asset_missing'], 'asset_unavailable'],
];

export function learnerProblem(blockers: BundleBlocker[]): LearnerBundleErrorCode {
  for (const [codes, problem] of LEARNER_PROBLEMS) {
    if (blockers.some((blocker) => codes.includes(blocker.code))) return problem;
  }
  return 'invalid_bundle';
}

const LEARNER_MESSAGES: Record<LearnerBundleErrorCode, { status: number; error: string }> = {
  bundle_not_found: { status: 404, error: 'This exam does not exist.' },
  bundle_unpublished: { status: 409, error: 'This exam has been withdrawn and is not available to sit.' },
  bundle_archived: { status: 410, error: 'This exam has been retired and can no longer be sat.' },
  component_missing: { status: 409, error: 'This exam refers to material that no longer exists, so it cannot be opened.' },
  component_unpublished: { status: 409, error: 'Part of this exam has been withdrawn, so it cannot be opened.' },
  component_changed: { status: 409, error: 'Part of this exam has changed since the exam was published, so it cannot be opened until it is checked again.' },
  asset_unavailable: { status: 409, error: 'A file this exam needs, such as Listening audio, is unavailable, so it cannot be opened.' },
  invalid_bundle: { status: 409, error: 'This exam is not configured correctly, so it cannot be opened.' },
};

export type SittingOutcome =
  | { ok: true; sitting: ExamSitting }
  | { ok: false; status: number; code: LearnerBundleErrorCode; error: string };

const refuse = (code: LearnerBundleErrorCode): SittingOutcome => ({ ok: false, code, ...LEARNER_MESSAGES[code] });

/** Resolves a published bundle into exactly the materials it pinned, or says why it cannot. */
export async function openSitting(id: string): Promise<SittingOutcome> {
  const bundle = await bundleStore.get(id);
  if (!bundle) return refuse('bundle_not_found');
  if (bundle.status === 'archived') return refuse('bundle_archived');
  if (bundle.status !== 'published' || !bundle.publishedAt) return refuse('bundle_unpublished');

  const context = await buildGateContext(bundle);
  const blockers = bundleBlockers(bundle, context);
  if (blockers.length > 0) {
    console.warn(`[Bundles] ${bundle.id} cannot be sat: ${blockers.map((blocker) => blocker.code).join(', ')}`);
    return refuse(learnerProblem(blockers));
  }

  const components = orderedComponents(bundle).map((ref) => {
    const material = context.component(ref).material;
    if (!material) throw new Error(`Component ${componentKey(ref)} passed the gate without a material.`);
    return {
      section: ref.section,
      part: ref.part,
      materialId: ref.materialId,
      contentHash: ref.contentHash,
      material: toLearnerMaterial(material, { keepTranscript: false }),
    };
  });

  return {
    ok: true,
    sitting: {
      bundle: {
        id: bundle.id,
        title: bundle.title,
        module: bundle.module,
        targetBand: bundle.targetBand,
        description: bundle.description,
        publishedAt: bundle.publishedAt,
        timing: bundle.timing,
      },
      components,
    },
  };
}

/** Published bundles, each saying whether it can be opened right now. */
export async function listLearnerBundles(): Promise<LearnerBundleSummary[]> {
  const published = await bundleStore.list('published');
  return Promise.all(
    published.map(async (bundle) => {
      const blockers = await checkBundle(bundle);
      return {
        ...summarizeBundle(bundle),
        available: blockers.length === 0,
        ...(blockers.length > 0 ? { problem: learnerProblem(blockers) } : {}),
      };
    }),
  );
}

/** What the builder shows about one material that could fill a slot. */
export interface BundleCandidate {
  id: string;
  title: string;
  section: BundleSection;
  module: 'academic' | 'general';
  status: AdminMaterial['status'];
  part: number | null;
  theme?: string;
  targetBand?: string;
  updatedAt: string;
  /** The fingerprint a pin taken now would record. */
  contentHash: string;
  questionCount: number;
  /** Writing tasks with a prompt, or Speaking parts with content. */
  taskCount: number;
  audio: { assetId: string | null; exists: boolean; kind: string | null } | null;
  assetCount: number;
}

function taskCountOf(material: AdminMaterial): number {
  if (material.section === 'writing') {
    const task = (material.content.task ?? {}) as Record<string, { prompt?: unknown } | undefined>;
    return (['task1', 'task2'] as const).filter((key) => typeof task[key]?.prompt === 'string' && String(task[key]?.prompt).trim()).length;
  }
  if (material.section === 'speaking') {
    const session = material.content.speakingSession;
    return [
      Boolean(session?.part1?.topic && session.part1.questions?.length),
      Boolean(session?.part2?.cueCardTopic),
      Boolean(session?.part3?.questions?.length),
    ].filter(Boolean).length;
  }
  return 0;
}

export function toCandidate(material: AdminMaterial, assets: Map<string, string>): BundleCandidate {
  const content = material.content as Record<string, unknown>;
  const assetIds = Array.isArray(content.assetIds) ? content.assetIds : [];
  const audioId = material.section === 'listening' ? material.content.audioAssetId ?? null : null;
  return {
    id: material.id,
    title: material.title,
    section: material.section,
    module: material.module,
    status: material.status,
    part: partNumberOf(material),
    theme: material.theme,
    targetBand: material.targetBand,
    updatedAt: material.updatedAt,
    contentHash: materialContentHash(material),
    questionCount: questionsOf(material).length,
    taskCount: taskCountOf(material),
    audio:
      material.section === 'listening'
        ? { assetId: audioId, exists: audioId ? assets.has(audioId) : false, kind: audioId ? assets.get(audioId) ?? null : null }
        : null,
    assetCount: assetIds.length,
  };
}

async function assetKinds(): Promise<Map<string, string>> {
  return new Map((await assetStore.list()).map((asset) => [asset.id, asset.kind as string]));
}

/** Published materials, per section, as the builder offers them. Only published material can be pinned. */
export async function bundleCandidates(): Promise<BundleCandidate[]> {
  const assets = await assetKinds();
  const lists = await Promise.all(BUNDLE_SECTIONS.map((section) => adminStore.listMaterials(section, 'published')));
  return lists.flat().map((material) => toCandidate(material, assets));
}

export interface ComponentDetail {
  ref: BundleComponentRef;
  material: BundleCandidate | null;
  foundInSection: BundleSection | null;
  /** Whether the pinned fingerprint is what the material hashes to now. */
  pinnedIsCurrent: boolean;
}

export async function describeBundle(bundle: FullCdiBundle) {
  const context = await buildGateContext(bundle);
  const assets = await assetKinds();
  const components: ComponentDetail[] = orderedComponents(bundle).map((ref) => {
    const state = context.component(ref);
    return {
      ref,
      material: state.material ? toCandidate(state.material, assets) : null,
      foundInSection: state.foundInSection,
      pinnedIsCurrent: Boolean(ref.contentHash) && ref.contentHash === state.currentHash,
    };
  });
  return { bundle, summary: summarizeBundle(bundle), components, blockers: bundleBlockers(bundle, context) };
}

/** Bundles of any status that name this material. */
export async function bundlesReferencing(materialId: string): Promise<FullCdiBundle[]> {
  return (await bundleStore.list()).filter((bundle) => bundle.components.some((ref) => ref.materialId === materialId));
}
