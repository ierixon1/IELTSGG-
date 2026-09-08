import {
  ListeningPart,
  MockTest,
  Question,
  QuestionType,
  ReadingPassage,
  SpeakingPartData,
  WritingTaskData,
} from '../types';
import { AdminMaterial, FullCdiBundle } from '../types/admin';
import { MOCK_TEST_1 } from '../data/mockBank';

/**
 * Bridges the admin CMS to the learner.
 *
 * The CMS could already author, sanitise and publish full CDI material, but
 * nothing in the app ever read it — the mocks screen was hard-wired to the
 * built-in test, so a published exam reached nobody. This module fetches what
 * has been published and adapts it into the shape the session screens expect.
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

interface ResolvedBundle {
  bundle: FullCdiBundle;
  materials: {
    listening: AdminMaterial | null;
    reading: AdminMaterial | null;
    writing: AdminMaterial | null;
    speaking: AdminMaterial | null;
  };
}

const KNOWN_TYPES: QuestionType[] = [
  'multiple_choice',
  'multi_select',
  'fill_in_blank',
  'sentence_completion',
  'summary_completion',
  'note_completion',
  'table_completion',
  'form_completion',
  'short_answer',
  'true_false_not_given',
  'yes_no_not_given',
  'matching',
  'matching_headings',
  'matching_information',
  'matching_features',
  'matching_sentence_endings',
  'diagram_label',
  'map_label',
];

/**
 * Authored questions arrive as loose JSON. Anything unrecognised falls back to
 * a typed gap fill rather than rendering as a broken control, and a question
 * without an answer key is dropped: an unmarkable question would silently cost
 * the learner a mark.
 */
function adaptQuestions(raw: unknown, idPrefix: string): Question[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .map((entry, index): Question | null => {
      if (!entry || typeof entry !== 'object') return null;
      const item = entry as Record<string, unknown>;

      const correctAnswer = item.correctAnswer;
      const hasAnswer =
        typeof correctAnswer === 'string'
          ? correctAnswer.trim().length > 0
          : Array.isArray(correctAnswer) && correctAnswer.length > 0;
      if (!hasAnswer) return null;

      const type = KNOWN_TYPES.includes(item.type as QuestionType)
        ? (item.type as QuestionType)
        : 'fill_in_blank';

      return {
        id: typeof item.id === 'string' && item.id ? item.id : `${idPrefix}-q${index + 1}`,
        questionNumber:
          typeof item.questionNumber === 'number' ? item.questionNumber : index + 1,
        type,
        instruction: typeof item.instruction === 'string' ? item.instruction : undefined,
        prompt: typeof item.prompt === 'string' ? item.prompt : '',
        options: Array.isArray(item.options) ? (item.options as string[]) : undefined,
        wordLimit: typeof item.wordLimit === 'string' ? item.wordLimit : undefined,
        correctAnswer: correctAnswer as string | string[],
        explanation: typeof item.explanation === 'string' ? item.explanation : undefined,
      };
    })
    .filter((question): question is Question => question !== null);
}

function adaptListening(material: AdminMaterial | null): ListeningPart[] | null {
  if (!material || material.section !== 'listening') return null;
  const section = material.content.section;
  if (!section) return null;

  const partNumber = Math.min(4, Math.max(1, Number(section.sectionNumber) || 1)) as 1 | 2 | 3 | 4;

  return [
    {
      partNumber,
      title: section.title || material.title,
      accent: 'British',
      audioDescription: section.contextDescription || material.title,
      transcript: section.audioTranscript || material.content.transcript || '',
      htmlContent: section.htmlContent || material.content.htmlContent,
      questions: adaptQuestions(section.questions, `cms-l-${material.id}`),
    },
  ];
}

function adaptReading(material: AdminMaterial | null): ReadingPassage[] | null {
  if (!material || material.section !== 'reading') return null;
  const passage = material.content.passage;
  if (!passage) return null;

  const passageNumber = Math.min(3, Math.max(1, Number(passage.passageNumber) || 1)) as 1 | 2 | 3;

  return [
    {
      passageNumber,
      title: passage.title || material.title,
      content: passage.text || '',
      htmlContent: passage.htmlContent || material.content.htmlContent,
      questions: adaptQuestions(passage.questions, `cms-r-${material.id}`),
    },
  ];
}

function adaptWritingTask(material: AdminMaterial | null, fallback: WritingTaskData): WritingTaskData {
  if (!material || material.section !== 'writing') return fallback;
  const task = material.content.task as Record<string, unknown> | undefined;
  if (!task) return fallback;

  return {
    ...fallback,
    title: typeof task.title === 'string' ? task.title : material.title,
    prompt: typeof task.prompt === 'string' ? task.prompt : fallback.prompt,
    htmlContent:
      (typeof task.htmlContent === 'string' ? task.htmlContent : undefined) ||
      material.content.htmlContent,
    minWordCount:
      typeof task.minWordCount === 'number' ? task.minWordCount : fallback.minWordCount,
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
 * Builds a sittable test from a published bundle, falling back to the built-in
 * material for any skill the bundle does not carry — a bundle with only a
 * reading passage should still open, not break the mocks screen.
 */
export function bundleToMockTest(resolved: ResolvedBundle): MockTest {
  const { bundle, materials } = resolved;

  const listening = adaptListening(materials.listening);
  const reading = adaptReading(materials.reading);
  const speaking = adaptSpeaking(materials.speaking);

  return {
    ...MOCK_TEST_1,
    id: bundle.id,
    title: bundle.title,
    listening: listening ? { parts: listening } : MOCK_TEST_1.listening,
    reading: reading ? { passages: reading } : MOCK_TEST_1.reading,
    writing: {
      task1: adaptWritingTask(materials.writing, MOCK_TEST_1.writing.task1),
      task2: adaptWritingTask(materials.writing, MOCK_TEST_1.writing.task2),
    },
    speaking: speaking ? { parts: speaking } : MOCK_TEST_1.speaking,
  };
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

export async function fetchPublishedTest(id: string): Promise<MockTest | null> {
  try {
    const response = await fetch(`/api/admin/public/bundles/${encodeURIComponent(id)}`, {
      credentials: 'same-origin',
    });
    if (!response.ok) return null;

    return bundleToMockTest((await response.json()) as ResolvedBundle);
  } catch (error) {
    console.warn('Could not load published test:', error);
    return null;
  }
}
