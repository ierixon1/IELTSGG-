import {
  ListeningPart,
  MockTest,
  Question,
  ReadingPassage,
  SkillType,
  SpeakingPartData,
  WritingTaskData,
} from '../types';
import { AdminMaterial, FullCdiBundle } from '../types/admin';
import { MOCK_TEST_1 } from '../data/mockBank';
import { QuestionIssue, normalizeAuthoredQuestions } from '../schemas/question';

/**
 * Bridges the admin CMS to the learner.
 *
 * The CMS could already author, sanitise and publish full CDI material, but
 * nothing in the app ever read it — the mocks screen was hard-wired to the
 * built-in test, so a published exam reached nobody. This module fetches what
 * has been published and adapts it into the shape the session screens expect.
 *
 * Every question passes through `normalizeAuthoredQuestions`, which is the one
 * place that knows how to read an authored question regardless of which editor
 * or generator wrote it. Anything it cannot convert is reported in
 * `AdaptedTest.issues` rather than quietly dropped or coerced.
 */

export interface PublishedTestSummary {
  id: string;
  title: string;
  module: 'academic' | 'general';
  description?: string;
  updatedAt: string;
  /** Which skills this bundle actually carries. */
  sections: Array<'listening' | 'reading' | 'writing' | 'speaking'>;
}

export interface ResolvedBundleMaterials {
  listening: AdminMaterial | null;
  reading: AdminMaterial | null;
  writing: AdminMaterial | null;
  speaking: AdminMaterial | null;
}

/**
 * What the server sends for one bundle. The field is named
 * `resolvedMaterials`; `materials` is accepted only because an older client
 * read that name and the mismatch is exactly the kind of bug this module now
 * guards against.
 */
export interface ResolvedBundleResponse {
  bundle: FullCdiBundle;
  resolvedMaterials?: ResolvedBundleMaterials;
  materials?: ResolvedBundleMaterials;
}

/** A sittable test plus everything that went wrong building it. */
export interface AdaptedTest {
  test: MockTest;
  /** Skills the bundle named but could not supply. */
  missingSections: SkillType[];
  /** Questions that could not be adapted, by skill. */
  issues: Partial<Record<SkillType, QuestionIssue[]>>;
}

function readMaterials(response: ResolvedBundleResponse): ResolvedBundleMaterials {
  return (
    response.resolvedMaterials ||
    response.materials || { listening: null, reading: null, writing: null, speaking: null }
  );
}

interface AdaptedQuestions {
  questions: Question[];
  issues: QuestionIssue[];
}

function adaptQuestions(raw: unknown, idPrefix: string): AdaptedQuestions {
  return normalizeAuthoredQuestions(raw, idPrefix);
}

function adaptListening(
  material: AdminMaterial | null,
): { parts: ListeningPart[]; issues: QuestionIssue[] } | null {
  if (!material || material.section !== 'listening') return null;
  const section = material.content.section;
  if (!section) return null;

  const partNumber = Math.min(4, Math.max(1, Number(section.sectionNumber) || 1)) as 1 | 2 | 3 | 4;
  const adapted = adaptQuestions(section.questions, `cms-l-${material.id}`);

  return {
    parts: [
      {
        partNumber,
        title: section.title || material.title,
        accent: 'British',
        audioDescription: section.contextDescription || material.title,
        transcript: section.audioTranscript || material.content.transcript || '',
        htmlContent: section.htmlContent || material.content.htmlContent,
        questions: adapted.questions,
      },
    ],
    issues: adapted.issues,
  };
}

function adaptReading(
  material: AdminMaterial | null,
): { passages: ReadingPassage[]; issues: QuestionIssue[] } | null {
  if (!material || material.section !== 'reading') return null;
  const passage = material.content.passage;
  if (!passage) return null;

  const passageNumber = Math.min(3, Math.max(1, Number(passage.passageNumber) || 1)) as 1 | 2 | 3;
  const adapted = adaptQuestions(passage.questions, `cms-r-${material.id}`);

  return {
    passages: [
      {
        passageNumber,
        title: passage.title || material.title,
        content: passage.text || '',
        htmlContent: passage.htmlContent || material.content.htmlContent,
        questions: adapted.questions,
      },
    ],
    issues: adapted.issues,
  };
}

/**
 * Writing materials carry both tasks under `content.task`. `taskKey` selects
 * which one, falling back to the whole object for material authored before the
 * editor split them — the prompt is the part that matters either way.
 */
function adaptWritingTask(
  material: AdminMaterial | null,
  taskKey: 'task1' | 'task2',
  fallback: WritingTaskData,
): WritingTaskData {
  if (!material || material.section !== 'writing') return fallback;
  const authored = material.content.task as Record<string, unknown> | undefined;
  if (!authored) return fallback;

  const nested = authored[taskKey];
  const task = (nested && typeof nested === 'object' ? nested : authored) as Record<string, unknown>;

  const minWords =
    typeof task.minWordCount === 'number'
      ? task.minWordCount
      : typeof task.minimumWords === 'number'
        ? task.minimumWords
        : fallback.minWordCount;

  return {
    ...fallback,
    title: typeof task.title === 'string' ? task.title : material.title,
    prompt: typeof task.prompt === 'string' ? task.prompt : fallback.prompt,
    htmlContent:
      (typeof task.htmlContent === 'string' ? task.htmlContent : undefined) ||
      material.content.htmlContent,
    minWordCount: minWords,
  };
}

function adaptSpeaking(material: AdminMaterial | null): SpeakingPartData[] | null {
  if (!material || material.section !== 'speaking') return null;
  const session = material.content.speakingSession;
  if (!session) return null;

  return [
    {
      partNumber: 1,
      topic: session.part1?.topic || material.title,
      htmlContent: session.part1?.htmlContent,
      questions: session.part1?.questions || [],
    },
    {
      partNumber: 2,
      topic: session.part2?.cueCardTopic || material.title,
      htmlContent: session.part2?.htmlContent,
      questions: [],
      cueCard: {
        topic: session.part2?.cueCardTopic || material.title,
        points: session.part2?.bulletPoints || [],
        prepTimeSeconds: 60,
        speakTimeSeconds: 120,
      },
    },
    {
      partNumber: 3,
      topic: session.part2?.cueCardTopic || material.title,
      htmlContent: session.part3?.htmlContent,
      questions: session.part3?.questions || [],
    },
  ];
}

/**
 * Builds a sittable test from a resolved bundle, and reports what the bundle
 * failed to supply.
 *
 * A skill the bundle names but cannot deliver is currently backfilled from the
 * built-in test so the screen still opens — and it is recorded in
 * `missingSections`, because serving different material than the title claims
 * is something the learner has to be told about.
 */
export function bundleToAdaptedTest(response: ResolvedBundleResponse): AdaptedTest {
  const bundle = response.bundle;
  const materials = readMaterials(response);

  const listening = adaptListening(materials.listening);
  const reading = adaptReading(materials.reading);
  const speaking = adaptSpeaking(materials.speaking);

  const requested = bundle.materials || {};
  const missingSections: SkillType[] = [];
  if (requested.listeningId && !listening) missingSections.push('listening');
  if (requested.readingId && !reading) missingSections.push('reading');
  if (requested.writingId && materials.writing === null) missingSections.push('writing');
  if (requested.speakingId && !speaking) missingSections.push('speaking');

  const issues: Partial<Record<SkillType, QuestionIssue[]>> = {};
  if (listening?.issues.length) issues.listening = listening.issues;
  if (reading?.issues.length) issues.reading = reading.issues;

  const test: MockTest = {
    ...MOCK_TEST_1,
    id: bundle.id,
    title: bundle.title,
    listening: listening ? { parts: listening.parts } : MOCK_TEST_1.listening,
    reading: reading ? { passages: reading.passages } : MOCK_TEST_1.reading,
    writing: {
      task1: adaptWritingTask(materials.writing, 'task1', MOCK_TEST_1.writing.task1),
      task2: adaptWritingTask(materials.writing, 'task2', MOCK_TEST_1.writing.task2),
    },
    speaking: speaking ? { parts: speaking } : MOCK_TEST_1.speaking,
  };

  return { test, missingSections, issues };
}

/** Kept for callers that only need the test itself. */
export function bundleToMockTest(response: ResolvedBundleResponse): MockTest {
  return bundleToAdaptedTest(response).test;
}

export async function fetchPublishedTests(): Promise<PublishedTestSummary[]> {
  try {
    const response = await fetch('/api/admin/public/bundles', { credentials: 'same-origin' });
    if (!response.ok) return [];

    const data = await response.json();
    const bundles: FullCdiBundle[] = Array.isArray(data) ? data : data?.bundles || [];

    return bundles.map((bundle) => ({
      id: bundle.id,
      title: bundle.title,
      module: bundle.module,
      description: bundle.description,
      updatedAt: bundle.updatedAt,
      sections: (['listening', 'reading', 'writing', 'speaking'] as const).filter(
        (section) => Boolean(bundle.materials?.[`${section}Id` as keyof typeof bundle.materials]),
      ),
    }));
  } catch (error) {
    console.warn('Could not load published tests:', error);
    return [];
  }
}

/**
 * Loads one published test for the signed-in learner.
 *
 * This reads the authenticated endpoint, not the public one: the public route
 * deliberately withholds answer keys, and marking needs them. A learner has to
 * be signed in to sit a test, so requiring a session here costs nothing and
 * stops an anonymous request from collecting the key.
 */
export async function fetchAdaptedTest(id: string): Promise<AdaptedTest | null> {
  try {
    const response = await fetch(`/api/learner/bundles/${encodeURIComponent(id)}`, {
      credentials: 'same-origin',
    });
    if (!response.ok) return null;

    return bundleToAdaptedTest((await response.json()) as ResolvedBundleResponse);
  } catch (error) {
    console.warn('Could not load published test:', error);
    return null;
  }
}

export async function fetchPublishedTest(id: string): Promise<MockTest | null> {
  return (await fetchAdaptedTest(id))?.test ?? null;
}
