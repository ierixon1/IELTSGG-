import type { AdminMaterial } from '../src/types/admin';
import type { BundleSection, BundleTiming } from '../src/types/bundle';

/**
 * Material payloads that pass the material publish gate, one per bundle slot.
 *
 * Plain data with no store imports, so suites can use them before they set up
 * their environment. Every question id is unique across the whole exam: the
 * exam engine keys answers by question id.
 */

/** Deliberately not the reference timing, so a test can tell configured minutes from assumed ones. */
export const CUSTOM_TIMING: BundleTiming = {
  listeningMinutes: 7,
  readingMinutes: 11,
  writingMinutes: 13,
  speakingMinutes: 5,
  basis: 'custom',
  allowEarlyFinish: true,
};

const question = (id: string, questionNumber: number, prompt: string, correctAnswer: string) => ({
  id,
  questionNumber,
  type: 'short_answer',
  prompt,
  correctAnswer,
});

/**
 * Full IELTS paper sizes (ielts.org test format): 10 questions in each Listening part,
 * 40 Reading questions across the three passages. The bundle gate refuses anything else.
 */
export const LISTENING_PER_PART = 10;
export const READING_PER_PASSAGE: Record<number, number> = { 1: 13, 2: 13, 3: 14 };

export const listeningAnswer = (part: number, index: number) => (index === 1 ? `alpha${part}` : index === 2 ? `beta${part}` : `lkey${part}x${index}`);
export const readingAnswer = (part: number, index: number) => (index === 1 ? `gamma${part}` : index === 2 ? `delta${part}` : `rkey${part}x${index}`);
const range = (count: number) => Array.from({ length: count }, (_, i) => i + 1);

export function listeningPayload(part: number, audioAssetId: string | undefined, module: 'academic' | 'general' = 'academic') {
  return {
    title: `Listening Part ${part}`,
    section: 'listening' as const,
    module,
    theme: 'Campus services',
    targetBand: '7.0',
    content: {
      ...(audioAssetId ? { audioAssetId } : {}),
      transcript: `The full script of part ${part}.`,
      section: {
        sectionNumber: part,
        title: `Part ${part}: an enquiry`,
        contextDescription: 'A telephone call.',
        audioTranscript: `Transcript of part ${part}.`,
        questions: range(LISTENING_PER_PART).map((index) =>
          question(`lis-p${part}-q${index}`, (part - 1) * LISTENING_PER_PART + index, `Listening part ${part}, gap ${index}`, listeningAnswer(part, index)),
        ),
      },
    },
  };
}

export function readingPayload(part: number, module: 'academic' | 'general' = 'academic') {
  return {
    title: `Reading Passage ${part}`,
    section: 'reading' as const,
    module,
    theme: 'Navigation',
    targetBand: '7.0',
    content: {
      passage: {
        passageNumber: part,
        title: `Passage ${part}: dead reckoning`,
        text: `Passage ${part} text about how animals navigate.`,
        questions: range(READING_PER_PASSAGE[part] ?? 13).map((index) =>
          question(`rea-p${part}-q${index}`, index, `Reading passage ${part}, question ${index}`, readingAnswer(part, index)),
        ),
      },
    },
  };
}

export function writingPayload(module: 'academic' | 'general' = 'academic', tasks: { task1?: boolean; task2?: boolean } = {}) {
  return {
    title: 'Writing Tasks',
    section: 'writing' as const,
    module,
    theme: 'Energy',
    targetBand: '7.0',
    content: {
      task: {
        ...(tasks.task1 === false ? {} : { task1: { title: 'Task 1', prompt: 'Summarise the chart of energy use.' } }),
        ...(tasks.task2 === false ? {} : { task2: { title: 'Task 2', prompt: 'To what extent should cities ban cars?' } }),
      },
    },
  };
}

export function speakingPayload(module: 'academic' | 'general' = 'academic') {
  return {
    title: 'Speaking Interview',
    section: 'speaking' as const,
    module,
    theme: 'Places',
    targetBand: '7.0',
    content: {
      speakingSession: {
        part1: { topic: 'Home', questions: ['Where do you live?'] },
        part2: { cueCardTopic: 'A place you visited', bulletPoints: ['where it was', 'why you went'] },
        part3: { questions: ['Why do people travel?'] },
      },
    },
  };
}

type Payload =
  | ReturnType<typeof listeningPayload>
  | ReturnType<typeof readingPayload>
  | ReturnType<typeof writingPayload>
  | ReturnType<typeof speakingPayload>;

/** A payload as a stored material, for pure tests that never touch a store. */
export function asMaterial(id: string, payload: Payload, status: AdminMaterial['status'] = 'published'): AdminMaterial {
  return {
    id,
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...payload,
  } as unknown as AdminMaterial;
}

export interface SlotPlan {
  section: BundleSection;
  part: number;
}

/** Every slot a full bundle fills, in the order the exam sits them. */
export const FULL_SLOTS: SlotPlan[] = [
  { section: 'listening', part: 1 },
  { section: 'listening', part: 2 },
  { section: 'listening', part: 3 },
  { section: 'listening', part: 4 },
  { section: 'reading', part: 1 },
  { section: 'reading', part: 2 },
  { section: 'reading', part: 3 },
  { section: 'writing', part: 1 },
  { section: 'speaking', part: 1 },
];
