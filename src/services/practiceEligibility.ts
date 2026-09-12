import { bundleStore } from './bundleStore';

/**
 * Whether a piece of content may be practised by a learner.
 *
 * Practice shows a learner the answer key after they submit, and a learner can
 * submit nothing at all — so anything that can be practised has, in effect, a
 * public key. Exam content must not: a published bundle is marked on the server
 * precisely so that nobody sits it holding its answers.
 *
 * The policy, decided here and nowhere else:
 *
 *   A material named by any component of a currently published bundle — any of
 *   its nine slots, whatever the section — is exam content, and is not
 *   practice content while that bundle stays published. A published bundle
 *   itself is never practice content.
 *
 * The rule follows the bundle's status, not history. When no published bundle
 * names a material any more (the bundle is unpublished or archived), the
 * material is ordinary published content again and can be practised. That is a
 * deliberate trade-off, not an oversight: republishing a bundle whose materials
 * were practised in between cannot take back keys learners have already seen.
 *
 * Every learner route that can return practice content or practice marking
 * decides through `practiceEligibility`. The check reads the stored bundles on
 * every call, so it does not depend on what a catalog showed or a screen
 * remembered.
 */

/** Which materials are exam content right now, and in which published bundles. */
export interface ExamUse {
  /** Material id → ids of the published bundles that pin it. */
  readonly bundlesByMaterial: ReadonlyMap<string, readonly string[]>;
}

export type PracticeEligibility = { allowed: true } | { allowed: false; reason: 'exam_content'; bundleIds: string[] };

/** Reads every published bundle once. Pass the result to `practiceEligibility` for as many materials as needed. */
export async function loadExamUse(): Promise<ExamUse> {
  const bundlesByMaterial = new Map<string, string[]>();
  for (const bundle of await bundleStore.list('published')) {
    for (const component of bundle.components) {
      const using = bundlesByMaterial.get(component.materialId) ?? [];
      if (!using.includes(bundle.id)) using.push(bundle.id);
      bundlesByMaterial.set(component.materialId, using);
    }
  }
  return { bundlesByMaterial };
}

/** The rule itself: a material any published bundle names is not practice content. */
export function practiceEligibility(materialId: string, use: ExamUse): PracticeEligibility {
  const bundleIds = use.bundlesByMaterial.get(materialId);
  return bundleIds && bundleIds.length > 0 ? { allowed: false, reason: 'exam_content', bundleIds: [...bundleIds] } : { allowed: true };
}

/** What a learner is told when practice is refused. Names no bundle and carries no content. */
export const EXAM_CONTENT_REFUSAL = {
  status: 403,
  code: 'exam_content',
  error: 'This content is part of a published exam, so it is not available for practice.',
} as const;
