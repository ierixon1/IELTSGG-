import type { AnswerValue, SittingQuestion } from '../types';
import type { LearnerBundleErrorCode, LearnerBundleSummary } from '../types/bundle';
import type { PracticeMarking, PracticeSection, PracticeSource, PracticeTest } from '../types/practice';
import { MOCK_TEST_1 } from '../data/mockBank';
import type { PublicMaterialSummary } from './publicMaterialView';
import { type SittableTest, toPracticeTest } from './sittingAdapters';

export * from './sittingAdapters';

/**
 * Loads published content for the practice screens.
 *
 * Two ways in: a whole bundle, resolved by the server into exactly the
 * materials it pinned, or one published material opened by id. Either arrives
 * already adapted and without a single answer key; a submitted section is
 * marked by the server (`markPracticeSection`). A full exam does not come
 * through here at all: it is sat through an exam session.
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

export type PracticeBundleLoad =
  | ({ ok: true } & PracticeTest)
  | { ok: false; code: LearnerBundleErrorCode | 'unauthorized' | 'network'; message: string };

/** One published bundle for section practice, resolved server-side into the exact materials it pinned. */
export async function fetchPracticeBundle(id: string): Promise<PracticeBundleLoad> {
  try {
    const response = await fetch(`/api/learner/bundles/${encodeURIComponent(id)}`, { credentials: 'same-origin' });
    const body = await response.json().catch(() => null);
    if (response.status === 401) return { ok: false, code: 'unauthorized', message: 'Sign in to practise this test.' };
    if (!response.ok) {
      return {
        ok: false,
        code: (body?.code as LearnerBundleErrorCode | undefined) ?? 'invalid_bundle',
        message: body?.error || `This test could not be opened (${response.status}).`,
      };
    }
    const loaded = body as PracticeTest;
    return { ok: true, test: loaded.test, missingSections: loaded.missingSections };
  } catch {
    return { ok: false, code: 'network', message: 'This test could not be opened: the server did not answer.' };
  }
}

/**
 * The built-in demo test, with its answer keys.
 *
 * Kept whole for the server, which marks practice on it. It is reached solely by
 * picking it from the practice list by name; it is never used to fill a gap in a
 * real test, and the full exam never offers it.
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

/** The built-in demo test as the practice screens hold it: no keys, marked on the server like any other. */
export function builtInPracticeTest(): SittableTest<SittingQuestion> {
  return toPracticeTest(builtInSittableTest());
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
): Promise<PracticeTest | null> {
  try {
    const response = await fetch(`/api/learner/materials/${section}/${encodeURIComponent(id)}`, {
      credentials: 'same-origin',
    });
    if (!response.ok) return null;
    const data = (await response.json()) as Partial<PracticeTest> | null;
    if (!data?.test) return null;
    return { test: data.test, missingSections: data.missingSections ?? [] };
  } catch (error) {
    console.warn('Could not load published material:', error);
    return null;
  }
}

/** Why a submitted section could not be marked. */
export class PracticeMarkingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PracticeMarkingError';
  }
}

/** Marks a submitted Listening or Reading section on the server. Rejects with a `PracticeMarkingError`. */
export async function markPracticeSection(
  source: PracticeSource,
  section: PracticeSection,
  answers: Record<string, AnswerValue>,
): Promise<PracticeMarking> {
  let response: Response;
  try {
    response = await fetch('/api/learner/practice/mark', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, section, answers }),
    });
  } catch {
    throw new PracticeMarkingError('network', 'The answers could not be marked: the server did not answer.');
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new PracticeMarkingError(typeof body?.code === 'string' ? body.code : 'unknown', body?.error || `The answers could not be marked (${response.status}).`);
  }
  return body as PracticeMarking;
}
