import {
  ListeningPart,
  ListeningData,
  ReadingData,
  SpeakingData,
  MockTest,
  Question,
  ReadingPassage,
  SkillType,
  SpeakingPartData,
  WritingTaskData,
} from '../types';
import { AdminMaterial, FullCdiBundle } from '../types/admin';
import { MOCK_TEST_1 } from '../data/mockBank';
import type { PublicMaterialSummary } from './publicMaterialView';
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

/**
 * A sittable test, and everything the bundle failed to supply.
 *
 * `MockTest` requires all four skills, which is why a missing component used to
 * be backfilled from the built-in test: the type left no way to say "this bundle
 * has no Listening". `SittableTest` says it. A null section is a configuration
 * error the learner is shown — never a section quietly filled with material the
 * title does not describe.
 */
export interface SittableTest {
  id: string;
  title: string;
  difficulty: MockTest['difficulty'];
  listening: ListeningData | null;
  reading: ReadingData | null;
  writing: { task1: WritingTaskData | null; task2: WritingTaskData | null };
  speaking: SpeakingData | null;
  /** Where this came from, so a screen can say what the learner is sitting. */
  origin: 'bundle' | 'material' | 'built_in';
}

/** A sittable test plus everything that went wrong building it. */
export interface AdaptedTest {
  test: SittableTest;
  /** Skills the bundle named but could not supply. */
  missingSections: SkillType[];
  /** Questions that could not be adapted, by skill. */
  issues: Partial<Record<SkillType, QuestionIssue[]>>;
}

/** Whether a sittable test can actually open this skill. */
export function sectionAvailable(test: SittableTest, skill: SkillType): boolean {
  switch (skill) {
    case 'listening':
      return (test.listening?.parts.length ?? 0) > 0;
    case 'reading':
      return (test.reading?.passages.length ?? 0) > 0;
    case 'writing':
      return Boolean(test.writing.task1 || test.writing.task2);
    case 'speaking':
      return (test.speaking?.parts.length ?? 0) > 0;
    default:
      return false;
  }
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
 * editor split them.
 *
 * Returns null when the material has no such task. It used to take a fallback
 * task and return that, which is how a bundle with no Writing material still
 * sat a learner down in front of the built-in prompt.
 */
function adaptWritingTask(
  material: AdminMaterial | null,
  taskKey: 'task1' | 'task2',
): WritingTaskData | null {
  if (!material || material.section !== 'writing') return null;
  const authored = material.content.task as Record<string, unknown> | undefined;
  if (!authored) return null;

  const nested = authored[taskKey];
  const task = (nested && typeof nested === 'object' ? nested : authored) as Record<string, unknown>;
  const prompt = typeof task.prompt === 'string' ? task.prompt.trim() : '';
  if (!prompt) return null;

  const authoredMinimum =
    typeof task.minWordCount === 'number'
      ? task.minWordCount
      : typeof task.minimumWords === 'number'
        ? task.minimumWords
        : null;

  return {
    taskNumber: taskKey === 'task1' ? 1 : 2,
    title: typeof task.title === 'string' ? task.title : material.title,
    prompt,
    htmlContent:
      (typeof task.htmlContent === 'string' ? task.htmlContent : undefined) ||
      material.content.htmlContent,
    // The IELTS minimums and timings, not content borrowed from another test:
    // they are the same for every Task 1 and every Task 2 ever set.
    minWordCount: authoredMinimum ?? (taskKey === 'task1' ? 150 : 250),
    recommendedMinutes: taskKey === 'task1' ? 20 : 40,
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
 * Nothing is substituted. A skill the bundle names but cannot deliver comes
 * back null and is listed in `missingSections`; the screen refuses to open it
 * and says why. Backfilling from the built-in test so the screen still opened
 * meant a learner could sit forty questions of material that had nothing to do
 * with the test they chose, and the only trace was a banner above it.
 */
export function bundleToAdaptedTest(response: ResolvedBundleResponse): AdaptedTest {
  const bundle = response.bundle;
  const materials = readMaterials(response);

  const listening = adaptListening(materials.listening);
  const reading = adaptReading(materials.reading);
  const speaking = adaptSpeaking(materials.speaking);
  const task1 = adaptWritingTask(materials.writing, 'task1');
  const task2 = adaptWritingTask(materials.writing, 'task2');

  const requested = bundle.materials || {};
  const missingSections: SkillType[] = [];
  if (requested.listeningId && !listening) missingSections.push('listening');
  if (requested.readingId && !reading) missingSections.push('reading');
  if (requested.writingId && !task1 && !task2) missingSections.push('writing');
  if (requested.speakingId && !speaking) missingSections.push('speaking');

  const issues: Partial<Record<SkillType, QuestionIssue[]>> = {};
  if (listening?.issues.length) issues.listening = listening.issues;
  if (reading?.issues.length) issues.reading = reading.issues;

  const test: SittableTest = {
    id: bundle.id,
    title: bundle.title,
    difficulty: 'Standard Academic',
    listening: listening ? { parts: listening.parts } : null,
    reading: reading ? { passages: reading.passages } : null,
    writing: { task1, task2 },
    speaking: speaking ? { parts: speaking } : null,
    origin: 'bundle',
  };

  return { test, missingSections, issues };
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



/**
 * The built-in demo test, as something a learner may choose on purpose.
 *
 * This is the only remaining use of `MOCK_TEST_1`, and it is reached solely by
 * picking it from the list by name. It is never used to fill a gap in a real
 * test: a bundle missing its Reading now says so instead of borrowing this.
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

/**
 * One published material, as a test with exactly that one section.
 *
 * This is how the learner catalog opens a single material: by its own id, into
 * its own section, with every other section null so nothing else can be opened
 * from it by accident.
 */
export function materialToSittable(material: AdminMaterial): AdaptedTest {
  const listening = adaptListening(material);
  const reading = adaptReading(material);
  const speaking = adaptSpeaking(material);
  const task1 = adaptWritingTask(material, 'task1');
  const task2 = adaptWritingTask(material, 'task2');

  const issues: Partial<Record<SkillType, QuestionIssue[]>> = {};
  if (listening?.issues.length) issues.listening = listening.issues;
  if (reading?.issues.length) issues.reading = reading.issues;

  const test: SittableTest = {
    id: material.id,
    title: material.title,
    difficulty: 'Standard Academic',
    listening: listening ? { parts: listening.parts } : null,
    reading: reading ? { passages: reading.passages } : null,
    writing: { task1, task2 },
    speaking: speaking ? { parts: speaking } : null,
    origin: 'material',
  };

  const missingSections = sectionAvailable(test, material.section as SkillType)
    ? []
    : [material.section as SkillType];

  return { test, missingSections, issues };
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
    const response = await fetch(
      `/api/learner/materials/${section}/${encodeURIComponent(id)}`,
      { credentials: 'same-origin' },
    );
    if (!response.ok) return null;
    const data = await response.json();
    if (!data?.item) return null;
    return materialToSittable(data.item as AdminMaterial);
  } catch (error) {
    console.warn('Could not load published material:', error);
    return null;
  }
}