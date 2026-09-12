import {
  ListeningPart,
  ListeningData,
  ReadingData,
  SpeakingData,
  Question,
  QuestionBody,
  ReadingPassage,
  SittingQuestion,
  SkillType,
  SpeakingPartData,
  WritingTaskData,
} from '../types';
import { AdminMaterial } from '../types/admin';
import type { ExamSitting } from '../types/bundle';
import type { ExamPaper } from '../types/examSession';
import { QuestionIssue, normalizeAuthoredQuestions } from '../schemas/question';

/**
 * Published content, shaped for the session screens.
 *
 * Pure, and free of any built-in content, so the server can build an exam paper
 * with exactly the same adapters the practice screens use. Every question passes
 * through `normalizeAuthoredQuestions`, and anything it cannot convert is
 * reported rather than dropped.
 *
 * Nothing here fills a gap. A bundle that cannot supply a section is refused by
 * the server before it gets this far, and a material that does not carry its
 * section produces a null section the screen refuses to open.
 */

/**
 * A sittable test, and everything it failed to supply.
 *
 * `MockTest` requires all four skills, which is why a missing component used to
 * be backfilled from the built-in test. `SittableTest` can say a section is not
 * there, and a null section is a configuration error the learner is shown.
 */
export interface SittableTest<Q extends QuestionBody = Question> {
  id: string;
  title: string;
  listening: ListeningData<Q> | null;
  reading: ReadingData<Q> | null;
  writing: { task1: WritingTaskData | null; task2: WritingTaskData | null };
  speaking: SpeakingData | null;
  /** Where this came from, so a screen can say what the learner is sitting. */
  origin: 'bundle' | 'material' | 'built_in';
  /** Academic or General Training: Reading is converted, and Writing Task 1 set and graded, by module. */
  module: 'academic' | 'general';
}

/** A sittable test plus everything that went wrong building it. */
export interface AdaptedTest {
  test: SittableTest;
  /** Skills that were asked for but could not be supplied. */
  missingSections: SkillType[];
  /** Questions that could not be adapted, by skill. */
  issues: Partial<Record<SkillType, QuestionIssue[]>>;
}

/** Whether a sittable test can actually open this skill. */
export function sectionAvailable(test: SittableTest<QuestionBody>, skill: SkillType): boolean {
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

interface Adapted<T> {
  value: T;
  issues: QuestionIssue[];
}

function toPartNumber<T extends number>(raw: unknown, max: T): T | null {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= max ? (value as T) : null;
}

function adaptListeningPart(material: AdminMaterial | null, part?: number): Adapted<ListeningPart> | null {
  if (!material || material.section !== 'listening') return null;
  const section = material.content.section;
  if (!section) return null;
  const partNumber = toPartNumber<1 | 2 | 3 | 4>(part ?? section.sectionNumber, 4);
  if (!partNumber) return null;

  const adapted = normalizeAuthoredQuestions(section.questions, `cms-l-${material.id}`);
  return {
    value: {
      partNumber,
      title: section.title || material.title,
      accent: 'British',
      audioDescription: section.contextDescription || material.title,
      transcript: section.audioTranscript || material.content.transcript || '',
      htmlContent: section.htmlContent || material.content.htmlContent,
      questions: adapted.questions,
      ...(material.content.audioUrl ? { audioUrl: material.content.audioUrl } : {}),
    },
    issues: adapted.issues,
  };
}

function adaptReadingPassage(material: AdminMaterial | null, part?: number): Adapted<ReadingPassage> | null {
  if (!material || material.section !== 'reading') return null;
  const passage = material.content.passage;
  if (!passage) return null;
  const passageNumber = toPartNumber<1 | 2 | 3>(part ?? passage.passageNumber, 3);
  if (!passageNumber) return null;

  const adapted = normalizeAuthoredQuestions(passage.questions, `cms-r-${material.id}`);
  return {
    value: {
      passageNumber,
      title: passage.title || material.title,
      content: passage.text || '',
      htmlContent: passage.htmlContent || material.content.htmlContent,
      questions: adapted.questions,
    },
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
function adaptWritingTask(material: AdminMaterial | null, taskKey: 'task1' | 'task2'): WritingTaskData | null {
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
    htmlContent: (typeof task.htmlContent === 'string' ? task.htmlContent : undefined) || material.content.htmlContent,
    // The IELTS minimum word counts and the paper's suggested split of the
    // hour: guidance printed with every task, not a section clock.
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
 * A resolved sitting as the session screens read it: all four Listening parts,
 * all three Reading passages, both Writing tasks and the three Speaking parts,
 * each from the exact material the bundle pinned.
 */
export function sittingToAdaptedTest(sitting: ExamSitting): AdaptedTest {
  const ordered = [...sitting.components].sort((a, b) => a.part - b.part);
  const listening = ordered
    .filter((entry) => entry.section === 'listening')
    .map((entry) => adaptListeningPart(entry.material, entry.part));
  const reading = ordered
    .filter((entry) => entry.section === 'reading')
    .map((entry) => adaptReadingPassage(entry.material, entry.part));
  const writing = ordered.find((entry) => entry.section === 'writing')?.material ?? null;
  const speaking = ordered.find((entry) => entry.section === 'speaking')?.material ?? null;

  const listeningParts = listening.filter((part): part is Adapted<ListeningPart> => Boolean(part));
  const readingPassages = reading.filter((passage): passage is Adapted<ReadingPassage> => Boolean(passage));
  const speakingParts = adaptSpeaking(speaking);
  const task1 = adaptWritingTask(writing, 'task1');
  const task2 = adaptWritingTask(writing, 'task2');

  const missingSections: SkillType[] = [];
  if (listening.length === 0 || listeningParts.length !== listening.length) missingSections.push('listening');
  if (reading.length === 0 || readingPassages.length !== reading.length) missingSections.push('reading');
  if (!task1 || !task2) missingSections.push('writing');
  if (!speakingParts) missingSections.push('speaking');

  const issues: Partial<Record<SkillType, QuestionIssue[]>> = {};
  const listeningIssues = listeningParts.flatMap((part) => part.issues);
  const readingIssues = readingPassages.flatMap((passage) => passage.issues);
  if (listeningIssues.length) issues.listening = listeningIssues;
  if (readingIssues.length) issues.reading = readingIssues;

  return {
    test: {
      id: sitting.bundle.id,
      title: sitting.bundle.title,
      listening: listeningParts.length ? { parts: listeningParts.map((part) => part.value) } : null,
      reading: readingPassages.length ? { passages: readingPassages.map((passage) => passage.value) } : null,
      writing: { task1, task2 },
      speaking: speakingParts ? { parts: speakingParts } : null,
      origin: 'bundle',
      module: sitting.bundle.module,
    },
    missingSections,
    issues,
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
  const listening = adaptListeningPart(material);
  const reading = adaptReadingPassage(material);
  const speaking = adaptSpeaking(material);
  const task1 = adaptWritingTask(material, 'task1');
  const task2 = adaptWritingTask(material, 'task2');

  const issues: Partial<Record<SkillType, QuestionIssue[]>> = {};
  if (listening?.issues.length) issues.listening = listening.issues;
  if (reading?.issues.length) issues.reading = reading.issues;

  const test: SittableTest = {
    id: material.id,
    title: material.title,
    listening: listening ? { parts: [listening.value] } : null,
    reading: reading ? { passages: [reading.value] } : null,
    writing: { task1, task2 },
    speaking: speaking ? { parts: speaking } : null,
    origin: 'material',
    module: material.module === 'general' ? 'general' : 'academic',
  };

  const missingSections = sectionAvailable(test, material.section as SkillType) ? [] : [material.section as SkillType];
  return { test, missingSections, issues };
}

/** A question with its key, explanation and provenance removed — all an exam paper may carry. */
export function toSittingQuestion(question: Question): SittingQuestion {
  const { correctAnswer, acceptableAnswers: _acceptable, explanation: _explanation, provenance: _provenance, ...body } = question;
  return { ...body, answerCount: Array.isArray(correctAnswer) ? correctAnswer.length : 1 };
}

/**
 * The exam paper for an adapted bundle: every section, every question without
 * its key. Null when any section is missing — a paper is never partial.
 */
export function toExamPaper(test: SittableTest): ExamPaper | null {
  const { listening, reading, speaking } = test;
  const { task1, task2 } = test.writing;
  if (!listening || !reading || !speaking || !task1 || !task2) return null;
  return {
    listening: { parts: listening.parts.map((part) => ({ ...part, transcript: '', questions: part.questions.map(toSittingQuestion) })) },
    reading: { passages: reading.passages.map((passage) => ({ ...passage, questions: passage.questions.map(toSittingQuestion) })) },
    writing: { task1, task2 },
    speaking,
  };
}

/**
 * A test as the practice screens receive it: every section the test carries,
 * every question without its key, explanation or provenance.
 *
 * Practice is marked on the server (`POST /api/learner/practice/mark`), which
 * returns the verdicts and the correct answers only once the learner submits.
 * Unlike an exam paper, a practice test may carry only some sections, and a
 * Listening part keeps its transcript for reading along.
 */
export function toPracticeTest(test: SittableTest): SittableTest<SittingQuestion> {
  return {
    ...test,
    listening: test.listening ? { parts: test.listening.parts.map((part) => ({ ...part, questions: part.questions.map(toSittingQuestion) })) } : null,
    reading: test.reading ? { passages: test.reading.passages.map((passage) => ({ ...passage, questions: passage.questions.map(toSittingQuestion) })) } : null,
  };
}
