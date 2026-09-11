import './env';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from './harness';
import type { ExamSitting } from '../src/types/bundle';
import {
  buildExamPlan,
  canFinishSection,
  createExamRun,
  examReducer,
  examResult,
  remainingSeconds,
  sectionReadiness,
  toExamAttempt,
  type ExamEvent,
  type ExamRunState,
} from '../src/services/examRun';
import { calculateOverallBand, objectiveSectionScore, writingSectionBand } from '../src/utils/ieltsScoring';
import {
  CUSTOM_TIMING,
  FULL_SLOTS,
  asMaterial,
  listeningAnswer,
  listeningPayload,
  readingAnswer,
  readingPayload,
  speakingPayload,
  writingPayload,
} from './bundleFixtures';

/**
 * A full exam, run through its state machine with a clock the test controls.
 *
 * The bundle's timing is deliberately not IELTS timing (7 / 11 / 13 / 5
 * minutes), so every clock assertion proves the minutes came from the
 * configuration and not from an assumption.
 */

const MINUTE = 60_000;
const T0 = Date.parse('2026-09-11T09:00:00.000Z');
const hashFor = (id: string) => id.replace(/[^a-z0-9]/g, '').padEnd(64, '0').slice(0, 64);

function sitting(over: Partial<ExamSitting['bundle']> = {}, mutate?: (components: ExamSitting['components']) => void): ExamSitting {
  const components = FULL_SLOTS.map(({ section, part }) => {
    const id = section === 'listening' ? `lis-${part}` : section === 'reading' ? `rea-${part}` : section === 'writing' ? 'wri-1' : 'spk-1';
    const payload =
      section === 'listening'
        ? listeningPayload(part, `ast_audiopart${part}000000`)
        : section === 'reading'
          ? readingPayload(part)
          : section === 'writing'
            ? writingPayload()
            : speakingPayload();
    return { section, part, materialId: id, contentHash: hashFor(id), material: asMaterial(id, payload) };
  });
  mutate?.(components);
  return {
    bundle: { id: 'cdi-run', title: 'Run Bundle', module: 'academic', publishedAt: '2026-09-10T00:00:00.000Z', timing: CUSTOM_TIMING, ...over },
    components,
  };
}

const run = (state: ExamRunState, ...events: ExamEvent[]) => events.reduce(examReducer, state);
const fresh = (bundle = sitting()) => createExamRun(buildExamPlan(bundle), 'attempt-test-1');

describe('the plan comes from the configured bundle', () => {
  it('runs Listening, Reading, Writing, Speaking with every part, task and configured minute', () => {
    const plan = buildExamPlan(sitting());
    expect(plan.sections.map((section) => section.section)).toEqual(['listening', 'reading', 'writing', 'speaking']);
    expect(plan.sections.map((section) => section.durationSeconds)).toEqual([7 * 60, 11 * 60, 13 * 60, 5 * 60]);
    expect(plan.sections[0].components.map((component) => component.part)).toEqual([1, 2, 3, 4]);
    expect(plan.sections[0].questions).toHaveLength(8);
    expect(plan.sections[1].components.map((component) => component.part)).toEqual([1, 2, 3]);
    expect(plan.sections[1].questions).toHaveLength(6);
    expect(plan.sections[2].tasks).toEqual([1, 2]);
    expect(plan.sections[3].parts).toEqual([1, 2, 3]);
  });

  it('refuses a sitting that is not a full exam', () => {
    expect(() => buildExamPlan(sitting({}, (components) => components.splice(0, components.length, ...components.filter((entry) => entry.section !== 'listening'))))).toThrow(
      'no listening',
    );
    expect(() =>
      buildExamPlan(sitting({}, (components) => {
        const writing = components.find((entry) => entry.section === 'writing')!;
        writing.material = asMaterial('wri-1', writingPayload('academic', { task2: false }));
      })),
    ).toThrow('Task 1 and Task 2');
    expect(() => buildExamPlan(sitting({ timing: { ...CUSTOM_TIMING, speakingMinutes: 0 } }))).toThrow('duration');
  });
});

describe('the clock is the bundle timing', () => {
  it('gives each section exactly its configured minutes', () => {
    let state = run(fresh(), { type: 'start', now: T0 });
    expect(remainingSeconds(state, T0)).toBe(7 * 60);
    expect(remainingSeconds(state, T0 + 3 * MINUTE)).toBe(4 * 60);

    state = run(state, { type: 'submit_answers', now: T0 + MINUTE }, { type: 'finish_section', now: T0 + 2 * MINUTE });
    expect(remainingSeconds(state, T0 + 2 * MINUTE)).toBe(11 * 60);
    expect(state.sections.reading.deadline).toBe(T0 + 2 * MINUTE + 11 * MINUTE);
  });

  it('closes a Listening section on time with the answers given so far', () => {
    let state = run(fresh(), { type: 'start', now: T0 }, { type: 'answer', questionId: 'lis-p1-q1', value: listeningAnswer(1, 1) });
    state = run(state, { type: 'tick', now: T0 + 7 * MINUTE - 1 });
    expect(state.currentIndex).toBe(0);

    state = run(state, { type: 'tick', now: T0 + 7 * MINUTE + 500 });
    expect(state.sections.listening.status).toBe('completed');
    expect(state.sections.listening.endedBy).toBe('time');
    expect(state.sections.listening.objective?.correct).toBe(1);
    expect(state.sections.listening.objective?.total).toBe(8);
    expect(state.currentIndex).toBe(1);
  });

  it('keeps a section open until its time is up when early finishing is not allowed', () => {
    let state = run(fresh(sitting({ timing: { ...CUSTOM_TIMING, allowEarlyFinish: false } })), { type: 'start', now: T0 }, { type: 'submit_answers', now: T0 + MINUTE });
    expect(canFinishSection(state, T0 + MINUTE)).toEqual({ allowed: false, reason: 'early_finish_disabled' });
    state = run(state, { type: 'finish_section', now: T0 + 2 * MINUTE });
    expect(state.currentIndex).toBe(0);
    state = run(state, { type: 'tick', now: T0 + 7 * MINUTE });
    expect(state.currentIndex).toBe(1);
  });
});

describe('a section is complete only when its configured content is', () => {
  it('marks Listening across all four parts and Reading across all three passages', () => {
    let state = run(fresh(), { type: 'start', now: T0 });
    // Answer only part 4 correctly: the section is still marked over every part.
    state = run(
      state,
      { type: 'answer', questionId: 'lis-p4-q1', value: listeningAnswer(4, 1) },
      { type: 'answer', questionId: 'lis-p4-q2', value: listeningAnswer(4, 2) },
    );
    expect(canFinishSection(state, T0 + MINUTE)).toEqual({ allowed: false, reason: 'not_ready' });
    state = run(state, { type: 'submit_answers', now: T0 + MINUTE });
    const listeningQuestions = state.plan.sections[0].questions.map((entry) => entry.question);
    expect(state.sections.listening.objective).toEqual(objectiveSectionScore('listening', listeningQuestions, state.sections.listening.answers));
    expect(state.sections.listening.objective?.correct).toBe(2);
    expect(state.sections.listening.objective?.total).toBe(8);
    state = run(state, { type: 'finish_section', now: T0 + MINUTE });

    // Reading: passage 3 only.
    state = run(
      state,
      { type: 'answer', questionId: 'rea-p3-q1', value: readingAnswer(3, 1) },
      { type: 'answer', questionId: 'rea-p1-q2', value: readingAnswer(1, 2) },
      { type: 'submit_answers', now: T0 + 2 * MINUTE },
    );
    expect(state.sections.reading.objective?.correct).toBe(2);
    expect(state.sections.reading.objective?.total).toBe(6);
  });

  it('does not end Writing after Task 1', () => {
    let state = run(fresh(), { type: 'start', now: T0 }, { type: 'submit_answers', now: T0 }, { type: 'finish_section', now: T0 });
    state = run(state, { type: 'submit_answers', now: T0 }, { type: 'finish_section', now: T0 });
    expect(state.plan.sections[state.currentIndex].section).toBe('writing');

    state = run(state, { type: 'writing_graded', task: 1, band: 7, essay: 'The chart shows energy use.' });
    expect(sectionReadiness(state, 'writing').missing).toEqual([{ kind: 'writing_task', task: 2 }]);
    state = run(state, { type: 'finish_section', now: T0 + MINUTE });
    expect(state.plan.sections[state.currentIndex].section).toBe('writing');

    state = run(state, { type: 'writing_graded', task: 2, band: 6, essay: 'Cities should not ban cars entirely.' }, { type: 'finish_section', now: T0 + 2 * MINUTE });
    expect(state.sections.writing.status).toBe('completed');
    expect(state.sections.writing.band).toBe(writingSectionBand(7, 6));
  });

  it('does not end Speaking after Part 1 or Part 2', () => {
    let state = run(
      fresh(),
      { type: 'start', now: T0 },
      { type: 'submit_answers', now: T0 },
      { type: 'finish_section', now: T0 },
      { type: 'submit_answers', now: T0 },
      { type: 'finish_section', now: T0 },
      { type: 'writing_graded', task: 1, band: 7, essay: 'one' },
      { type: 'writing_graded', task: 2, band: 7, essay: 'two' },
      { type: 'finish_section', now: T0 },
      { type: 'speaking_graded', part: 1, band: 7, transcript: 'I live in Tashkent.' },
      { type: 'speaking_graded', part: 2, band: 6.5, transcript: 'I visited Samarkand.' },
      { type: 'finish_section', now: T0 + MINUTE },
    );
    expect(state.finishedAt).toBe(undefined);
    expect(sectionReadiness(state, 'speaking').missing).toEqual([{ kind: 'speaking_part', part: 3 }]);

    state = run(state, { type: 'speaking_graded', part: 3, band: 7, transcript: 'People travel to learn.' }, { type: 'finish_section', now: T0 + 2 * MINUTE });
    expect(state.finishedAt).toBe(T0 + 2 * MINUTE);
    const result = examResult(state);
    expect(result.complete).toBe(true);
    expect(result.overall).toBe(calculateOverallBand(result.bands));
  });

  it('reports an exam whose Writing ran out of time as incomplete, with no overall band', () => {
    let state = run(
      fresh(),
      { type: 'start', now: T0 },
      { type: 'submit_answers', now: T0 },
      { type: 'finish_section', now: T0 },
      { type: 'submit_answers', now: T0 },
      { type: 'finish_section', now: T0 },
      { type: 'writing_graded', task: 1, band: 7, essay: 'Only task one.' },
    );
    state = run(state, { type: 'tick', now: T0 + 13 * MINUTE });
    expect(state.sections.writing.status).toBe('expired');
    expect(state.sections.writing.band).toBe(undefined);

    state = run(
      state,
      { type: 'speaking_graded', part: 1, band: 7, transcript: 'a' },
      { type: 'speaking_graded', part: 2, band: 7, transcript: 'b' },
      { type: 'speaking_graded', part: 3, band: 7, transcript: 'c' },
      { type: 'finish_section', now: T0 + 14 * MINUTE },
    );
    const result = examResult(state);
    expect(result.complete).toBe(false);
    expect(result.overall).toBe(undefined);
    expect(result.incomplete).toEqual(['writing']);

    const attempt = toExamAttempt(state);
    expect(attempt.status).toBe('incomplete');
    expect(attempt.scores.overall).toBe(undefined);
    expect(attempt.scores.writing).toBe(undefined);
  });
});

describe('the attempt records everything against its exact source', () => {
  it('names the bundle, material version, section, part and question or task of every response', () => {
    const state = run(
      fresh(),
      { type: 'start', now: T0 },
      { type: 'answer', questionId: 'lis-p2-q1', value: listeningAnswer(2, 1) },
      { type: 'answer', questionId: 'lis-p3-q2', value: 'wrong' },
      { type: 'submit_answers', now: T0 + MINUTE },
      { type: 'finish_section', now: T0 + MINUTE },
      { type: 'answer', questionId: 'rea-p2-q1', value: readingAnswer(2, 1) },
      { type: 'submit_answers', now: T0 + 2 * MINUTE },
      { type: 'finish_section', now: T0 + 2 * MINUTE },
      { type: 'writing_graded', task: 1, band: 6.5, essay: 'Task one essay text.' },
      { type: 'writing_graded', task: 2, band: 7, essay: 'Task two essay text here.' },
      { type: 'finish_section', now: T0 + 3 * MINUTE },
      { type: 'speaking_graded', part: 1, band: 7, transcript: 'part one' },
      { type: 'speaking_graded', part: 2, band: 7, transcript: 'part two' },
      { type: 'speaking_graded', part: 3, band: 7.5, transcript: 'part three' },
      { type: 'finish_section', now: T0 + 4 * MINUTE },
    );
    const attempt = toExamAttempt(state);

    expect(attempt.id).toBe('attempt-test-1');
    expect(attempt.testId).toBe('cdi-run');
    expect(attempt.bundleId).toBe('cdi-run');
    expect(attempt.bundlePublishedAt).toBe('2026-09-10T00:00:00.000Z');
    expect(attempt.mode).toBe('exam');
    expect(attempt.status).toBe('completed');
    expect(attempt.durationMinutes).toBe(4);

    expect(attempt.responses).toEqual([
      { section: 'listening', materialId: 'lis-2', contentHash: hashFor('lis-2'), part: 2, questionId: 'lis-p2-q1', answer: listeningAnswer(2, 1) },
      { section: 'listening', materialId: 'lis-3', contentHash: hashFor('lis-3'), part: 3, questionId: 'lis-p3-q2', answer: 'wrong' },
      { section: 'reading', materialId: 'rea-2', contentHash: hashFor('rea-2'), part: 2, questionId: 'rea-p2-q1', answer: readingAnswer(2, 1) },
    ]);
    expect(attempt.sections?.listening?.components.map((ref) => ref.materialId)).toEqual(['lis-1', 'lis-2', 'lis-3', 'lis-4']);
    expect(attempt.sections?.reading?.components.map((ref) => ref.part)).toEqual([1, 2, 3]);
    expect(attempt.writingTasks?.map((task) => [task.task, task.band, task.materialId, task.wordCount])).toEqual([
      [1, 6.5, 'wri-1', 4],
      [2, 7, 'wri-1', 5],
    ]);
    expect(attempt.speakingParts?.map((part) => [part.part, part.band, part.contentHash])).toEqual([
      [1, 7, hashFor('spk-1')],
      [2, 7, hashFor('spk-1')],
      [3, 7.5, hashFor('spk-1')],
    ]);
    expect(attempt.scores.writing?.task1Band).toBe(6.5);
    expect(attempt.scores.writing?.task2Band).toBe(7);
    expect(attempt.scores.overall).toBe(examResult(state).overall);
  });
});

describe('the exam screen holds no rules and no built-in content', () => {
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8');

  it('takes durations from the bundle, not from constants', () => {
    for (const file of ['src/components/ExamMode.tsx', 'src/services/examRun.ts']) {
      const text = read(file);
      expect(/\b165\b|60 \* 60|durationMinutes: \d/.test(text)).toBe(false);
    }
  });

  it('never reaches for the built-in test', () => {
    for (const file of ['src/components/ExamMode.tsx', 'src/services/examRun.ts', 'src/services/bundleService.ts', 'src/routes/learnerContentRoutes.ts', 'src/routes/bundleRoutes.ts']) {
      const text = read(file);
      expect(/MOCK_TEST_1|mockBank|builtInSittableTest/.test(text)).toBe(false);
    }
  });
});
