import { AdminMaterial } from '../types/admin';
import type { ExamSitting, LearnerBundleErrorCode, LearnerBundleSummary } from '../types/bundle';
import { MOCK_TEST_1 } from '../data/mockBank';
import type { PublicMaterialSummary } from './publicMaterialView';
import { type AdaptedTest, type SittableTest, materialToSittable } from './sittingAdapters';

export * from './sittingAdapters';

/**
 * Loads published content for the practice screens.
 *
 * Two ways in: a whole bundle, resolved by the server into exactly the
 * materials it pinned, or one published material opened by id. The adapters
 * that shape either one live in `sittingAdapters`, where the exam session uses
 * them too. A full exam does not come through here at all: it is sat through an
 * exam session, which never sends an answer key to the browser.
 */

export type LearnerBundlesLoad = { ok: true; bundles: LearnerBundleSummary[] } | { ok: false; message: string };

/** Published bundles for the signed-in learner. A failed load is reported, not shown as "no exams". */
export async function fetchLearnerBundles(): Promise<LearnerBundlesLoad> {
  try {
    const response = await fetch('/api/learner/bundles', { credentials: 'same-origin' });
    const body = await response.json().catch(() => null);
    if (!response.ok) return { ok: false, message: body?.error || `The exam list could not be loaded (${response.status}).` };
    return { ok: true, bundles: Array.isArray(body?.bundles) ? (body.bundles as LearnerBundleSummary[]) : [] };
  } catch {
    return { ok: false, message: 'The exam list could not be loaded: the server did not answer.' };
  }
}

export type SittingLoad =
  | { ok: true; sitting: ExamSitting }
  | { ok: false; code: LearnerBundleErrorCode | 'unauthorized' | 'network'; message: string };

/**
 * One published bundle, resolved server-side into the exact materials it pinned.
 *
 * Reads the authenticated endpoint: marking needs the answer key, and the key
 * never goes to an anonymous request.
 */
export async function fetchExamSitting(id: string): Promise<SittingLoad> {
  try {
    const response = await fetch(`/api/learner/bundles/${encodeURIComponent(id)}`, { credentials: 'same-origin' });
    const body = await response.json().catch(() => null);
    if (response.status === 401) return { ok: false, code: 'unauthorized', message: 'Sign in to sit this exam.' };
    if (!response.ok) {
      return {
        ok: false,
        code: (body?.code as LearnerBundleErrorCode | undefined) ?? 'invalid_bundle',
        message: body?.error || `This exam could not be opened (${response.status}).`,
      };
    }
    return { ok: true, sitting: body as ExamSitting };
  } catch {
    return { ok: false, code: 'network', message: 'This exam could not be opened: the server did not answer.' };
  }
}

/**
 * The built-in demo test, as something a learner may choose on purpose for
 * section practice.
 *
 * It is reached solely by picking it from the practice list by name. It is never
 * used to fill a gap in a real test, and the full exam never offers it: exam
 * mode sits published bundles only.
 */
export function builtInSittableTest(): SittableTest {
  return {
    id: MOCK_TEST_1.id,
    title: MOCK_TEST_1.title,
    difficulty: MOCK_TEST_1.difficulty,
    listening: MOCK_TEST_1.listening,
    reading: MOCK_TEST_1.reading,
    writing: { task1: MOCK_TEST_1.writing.task1, task2: MOCK_TEST_1.writing.task2 },
    speaking: MOCK_TEST_1.speaking,
    origin: 'built_in',
  };
}

/** Published materials in one section, for the learner catalog. */
export async function fetchLearnerMaterials(
  section: 'listening' | 'reading' | 'writing' | 'speaking',
): Promise<PublicMaterialSummary[]> {
  try {
    const response = await fetch(`/api/learner/materials/${section}`, {
      credentials: 'same-origin',
    });
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data?.items) ? (data.items as PublicMaterialSummary[]) : [];
  } catch (error) {
    console.warn('Could not load published materials:', error);
    return [];
  }
}

/**
 * One published material, by the exact id the catalog listed.
 *
 * Answers null for anything that is not published — a draft, an archived
 * material, or an id that no longer exists — and the caller shows that as an
 * error rather than opening something else.
 */
export async function fetchLearnerMaterial(
  section: 'listening' | 'reading' | 'writing' | 'speaking',
  id: string,
): Promise<AdaptedTest | null> {
  try {
    const response = await fetch(`/api/learner/materials/${section}/${encodeURIComponent(id)}`, {
      credentials: 'same-origin',
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data?.item) return null;
    return materialToSittable(data.item as AdminMaterial);
  } catch (error) {
    console.warn('Could not load published material:', error);
    return null;
  }
}

