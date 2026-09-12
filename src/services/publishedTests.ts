import type { AnswerValue, SittingQuestion } from '../types';
import type { LearnerBundleSummary } from '../types/bundle';
import type { LearnerMaterialSummary, PracticeMarking, PracticeSection, PracticeSource, PracticeTest } from '../types/practice';
import { MOCK_TEST_1 } from '../data/mockBank';
import { type SittableTest, toPracticeTest } from './sittingAdapters';

export * from './sittingAdapters';

/**
 * Loads published content for the practice screens, and the exam list.
 *
 * Practice has two ways in: the built-in test, or one published material
 * opened by id, which arrives already adapted and without a single answer key;
 * a submitted section is marked by the server (`markPracticeSection`). A
 * published bundle is exam content: it is listed for Exam mode and sat through
 * an exam session, never practised.
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
    listening: MOCK_TEST_1.listening,
    reading: MOCK_TEST_1.reading,
    writing: { task1: MOCK_TEST_1.writing.task1, task2: MOCK_TEST_1.writing.task2 },
    speaking: MOCK_TEST_1.speaking,
    origin: 'built_in',
    // The built-in test is an Academic paper ("Academic Practice Test 1").
    module: 'academic',
  };
}

/** The built-in demo test as the practice screens hold it: no keys, marked on the server like any other. */
export function builtInPracticeTest(): SittableTest<SittingQuestion> {
  return toPracticeTest(builtInSittableTest());
}

/** Published materials in one section, for the learner catalog, each saying whether it can be practised. */
export async function fetchLearnerMaterials(
  section: 'listening' | 'reading' | 'writing' | 'speaking',
): Promise<LearnerMaterialSummary[]> {
  try {
    const response = await fetch(`/api/learner/materials/${section}`, {
      credentials: 'same-origin',
    });
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data?.items) ? (data.items as LearnerMaterialSummary[]) : [];
  } catch (error) {
    console.warn('Could not load published materials:', error);
    return [];
  }
}

export type LearnerMaterialLoad = ({ ok: true } & PracticeTest) | { ok: false; code: string };

/**
 * One published material, by the exact id the catalog listed.
 *
 * Refused for anything that is not published — a draft, an archived material,
 * an id that no longer exists — and for exam content (`exam_content`); the
 * caller shows the reason rather than opening something else.
 */
export async function fetchLearnerMaterial(
  section: 'listening' | 'reading' | 'writing' | 'speaking',
  id: string,
): Promise<LearnerMaterialLoad> {
  try {
    const response = await fetch(`/api/learner/materials/${section}/${encodeURIComponent(id)}`, {
      credentials: 'same-origin',
    });
    const data = (await response.json().catch(() => null)) as (Partial<PracticeTest> & { code?: unknown }) | null;
    if (!response.ok) return { ok: false, code: typeof data?.code === 'string' ? data.code : 'not_found' };
    if (!data?.test) return { ok: false, code: 'not_found' };
    return { ok: true, test: data.test, missingSections: data.missingSections ?? [] };
  } catch (error) {
    console.warn('Could not load published material:', error);
    return { ok: false, code: 'network' };
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
