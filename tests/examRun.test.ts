import './env';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from './harness';
import type { ExamSitting } from '../src/types/bundle';
import {
  buildExamPlan,
  canFinishSection,
  claimGrading,
  createExamRun,
  examReducer,
  examResult,
  gradingOf,
  gradingOutstanding,
  gradingUnsettled,
  MAX_GRADING_RUNS,
  progressOf,
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
const LEASE = 5 * MINUTE;
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

/** A Writing task submitted at `now` and graded by its first run. */
const writingDone = (task: 1 | 2, band: number, essay: string, now = T0): ExamEvent[] => [
  { type: 'writing_submitted', task, essay, now },
  { type: 'writing_grading_started', task, now, leaseUntil: now + LEASE },
  { type: 'writing_graded', task, run: 1, band, now },
];

/** A Speaking part submitted at `now` and graded by its first run. */
const speakingDone = (part: 1 | 2 | 3, band: number, transcript: string, now = T0): ExamEvent[] => [
  { type: 'speaking_submitted', part, transcriptProvided: transcript, now },
  { type: 'speaking_grading_started', part, now, leaseUntil: now + LEASE },
  { type: 'speaking_graded', part, run: 1, band, transcript, now },
];

/** Listening and Reading done at T0, so Writing runs from T0 to T0 + 13 minutes. */
const toWriting = (bundle = sitting()) =>
  run(fresh(bundle), { type: 'start', now: T0 }, { type: 'submit_answers', now: T0 }, { type: 'finish_section', now: T0 }, { type: 'submit_answers', now: T0 }, { type: 'finish_section', now: T0 });
const WRITING_DEADLINE = T0 + 13 * MINUTE;

/** Writing done at T0, so Speaking runs from T0 to T0 + 5 minutes. */
const toSpeaking = () => run(toWriting(), ...writingDone(1, 7, 'one'), ...writingDone(2, 7, 'two'), { type: 'finish_section', now: T0 });

describe('the plan comes from the configured bundle', () => {
  it('runs Listening, Reading, Writing, Speaking with every part, task and configured minute', () => {
    const plan = buildExamPlan(sitting());
    expect(plan.sections.map((section) => section.section)).toEqual(['listening', 'reading', 'writing', 'speaking']);
    expect(plan.sections.map((section) => section.durationSeconds)).toEqual([7 * 60, 11 * 60, 13 * 60, 5 * 60]);
    expect(plan.sections[0].components.map((component) => component.part)).toEqual([1, 2, 3, 4]);
    expect(plan.sections[0].questions).toHaveLength(40);
    expect(plan.sections[1].components.map((component) => component.part)).toEqual([1, 2, 3]);
    expect(plan.sections[1].questions).toHaveLength(40);
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
    expect(state.sections.listening.objective?.total).toBe(40);
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
    expect(state.sections.listening.objective).toEqual(objectiveSectionScore('listening', listeningQuestions, state.sections.listening.answers, 'academic'));
    expect(state.sections.listening.objective?.correct).toBe(2);
    expect(state.sections.listening.objective?.total).toBe(40);
    state = run(state, { type: 'finish_section', now: T0 + MINUTE });

    // Reading: passage 3 only.
    state = run(
      state,
      { type: 'answer', questionId: 'rea-p3-q1', value: readingAnswer(3, 1) },
      { type: 'answer', questionId: 'rea-p1-q2', value: readingAnswer(1, 2) },
      { type: 'submit_answers', now: T0 + 2 * MINUTE },
    );
    expect(state.sections.reading.objective?.correct).toBe(2);
    expect(state.sections.reading.objective?.total).toBe(40);
  });

  it('does not end Writing after Task 1', () => {
    let state = toWriting();
    expect(state.plan.sections[state.currentIndex].section).toBe('writing');

    state = run(state, ...writingDone(1, 7, 'The chart shows energy use.'));
    expect(sectionReadiness(state, 'writing').missing).toEqual([{ kind: 'writing_task', task: 2 }]);
    state = run(state, { type: 'finish_section', now: T0 + MINUTE });
    expect(state.plan.sections[state.currentIndex].section).toBe('writing');

    state = run(state, ...writingDone(2, 6, 'Cities should not ban cars entirely.'), { type: 'finish_section', now: T0 + 2 * MINUTE });
    expect(state.sections.writing.status).toBe('completed');
    expect(state.sections.writing.band).toBe(writingSectionBand(7, 6));
  });

  it('does not end Speaking after Part 1 or Part 2', () => {
    let state = run(toSpeaking(), ...speakingDone(1, 7, 'I live in Tashkent.'), ...speakingDone(2, 6.5, 'I visited Samarkand.'), { type: 'finish_section', now: T0 + MINUTE });
    expect(state.finishedAt).toBe(undefined);
    expect(sectionReadiness(state, 'speaking').missing).toEqual([{ kind: 'speaking_part', part: 3 }]);

    state = run(state, ...speakingDone(3, 7, 'People travel to learn.'), { type: 'finish_section', now: T0 + 2 * MINUTE });
    expect(state.finishedAt).toBe(T0 + 2 * MINUTE);
    const result = examResult(state);
    expect(result.complete).toBe(true);
    expect(result.overall).toBe(calculateOverallBand(result.bands));
  });

  it('reports an exam whose Writing ran out of time as incomplete, with no overall band', () => {
    let state = run(toWriting(), ...writingDone(1, 7, 'Only task one.'));
    state = run(state, { type: 'tick', now: WRITING_DEADLINE });
    expect(state.sections.writing.status).toBe('expired');
    expect(state.sections.writing.band).toBe(undefined);

    state = run(
      state,
      ...speakingDone(1, 7, 'a', WRITING_DEADLINE),
      ...speakingDone(2, 7, 'b', WRITING_DEADLINE),
      ...speakingDone(3, 7, 'c', WRITING_DEADLINE),
      { type: 'finish_section', now: WRITING_DEADLINE + MINUTE },
    );
    const result = examResult(state);
    expect(result.complete).toBe(false);
    expect(result.overall).toBe(undefined);
    expect(result.incomplete).toEqual(['writing']);
    expect(result.awaitingGrading).toEqual([]);

    const attempt = toExamAttempt(state);
    expect(attempt.status).toBe('incomplete');
    expect(attempt.scores.overall).toBe(undefined);
    expect(attempt.scores.writing).toBe(undefined);
  });
});

describe('submission and grading are separate facts (H6)', () => {
  it('stores a submitted task with its grading pending, and counts it toward the section before any band', () => {
    const state = run(toWriting(), { type: 'writing_submitted', task: 1, essay: 'kept as written', now: WRITING_DEADLINE - 1_000 });
    const work = state.sections.writing.writing[1];
    expect(work?.essay).toBe('kept as written');
    expect(work?.submittedAt).toBe(WRITING_DEADLINE - 1_000);
    expect(work?.grading).toEqual({ status: 'pending', runs: 0 });
    expect(work?.band).toBe(undefined);
    expect(sectionReadiness(state, 'writing').missing).toEqual([{ kind: 'writing_task', task: 2 }]);
  });

  it('refuses a submission once the section clock has closed the section', () => {
    let state = run(toWriting(), { type: 'tick', now: WRITING_DEADLINE });
    expect(state.sections.writing.status).toBe('expired');
    state = run(state, { type: 'writing_submitted', task: 1, essay: 'too late', now: WRITING_DEADLINE + 1 });
    expect(state.sections.writing.writing[1]).toBe(undefined);

    const speaking = run(toSpeaking(), { type: 'tick', now: T0 + 5 * MINUTE });
    expect(run(speaking, { type: 'speaking_submitted', part: 1, transcriptProvided: 'too late', now: T0 + 5 * MINUTE }).sections.speaking.speaking[1]).toBe(undefined);
  });

  it('never replaces submitted work', () => {
    const writing = run(toWriting(), { type: 'writing_submitted', task: 1, essay: 'first', now: T0 }, { type: 'writing_submitted', task: 1, essay: 'second', now: T0 + 1 });
    expect(writing.sections.writing.writing[1]?.essay).toBe('first');
    const speaking = run(toSpeaking(), { type: 'speaking_submitted', part: 1, transcriptProvided: 'first', now: T0 }, { type: 'speaking_submitted', part: 1, transcriptProvided: 'second', now: T0 + 1 });
    expect(speaking.sections.speaking.speaking[1]?.transcript).toBe('first');
  });

  it('records a band that arrives after the deadline on work submitted before it, and completes the waiting section then', () => {
    let state = run(
      toWriting(),
      ...writingDone(1, 7, 'one', WRITING_DEADLINE - MINUTE),
      { type: 'writing_submitted', task: 2, essay: 'two', now: WRITING_DEADLINE - 1_000 },
      { type: 'writing_grading_started', task: 2, now: WRITING_DEADLINE - 900, leaseUntil: WRITING_DEADLINE + LEASE },
      { type: 'tick', now: WRITING_DEADLINE + 5_000 },
    );
    expect(state.sections.writing.status).toBe('awaiting_grading');
    expect(state.sections.writing.band).toBe(undefined);
    expect(state.plan.sections[state.currentIndex].section).toBe('speaking');
    expect(examResult(state).awaitingGrading).toEqual(['writing']);

    state = run(state, { type: 'writing_graded', task: 2, run: 1, band: 6, now: WRITING_DEADLINE + 90_000 });
    expect(state.sections.writing.status).toBe('completed');
    expect(state.sections.writing.band).toBe(writingSectionBand(7, 6));
    expect(state.sections.writing.writing[2]?.essay).toBe('two');
    expect(state.sections.writing.writing[2]?.grading?.status).toBe('graded');
    expect(examResult(state).awaitingGrading).toEqual([]);
  });

  it('keeps the essay and gives no band when grading fails, and lets a later run grade it', () => {
    let state = run(
      toWriting(),
      { type: 'writing_submitted', task: 1, essay: 'kept', now: T0 },
      { type: 'writing_grading_started', task: 1, now: T0, leaseUntil: T0 + LEASE },
      { type: 'writing_grading_failed', task: 1, run: 1, failure: 'unavailable', now: T0 + 1_000 },
    );
    const failed = state.sections.writing.writing[1];
    expect(failed?.essay).toBe('kept');
    expect(failed?.band).toBe(undefined);
    expect(gradingOf(failed ?? {}, T0 + 1_000)).toEqual({ status: 'failed', runs: 1, failure: 'unavailable' });

    state = run(state, { type: 'writing_grading_started', task: 1, now: T0 + 2_000, leaseUntil: T0 + 2_000 + LEASE }, { type: 'writing_graded', task: 1, run: 2, band: 6.5, now: T0 + 3_000 });
    expect(state.sections.writing.writing[1]?.band).toBe(6.5);
    expect(state.sections.writing.writing[1]?.grading?.runs).toBe(2);
  });

  it('counts a run whose lease passed as interrupted, and ignores a result from a run that is no longer current', () => {
    let state = run(toWriting(), { type: 'writing_submitted', task: 1, essay: 'e', now: T0 }, { type: 'writing_grading_started', task: 1, now: T0, leaseUntil: T0 + LEASE });
    const claimed = state.sections.writing.writing[1] ?? {};
    expect(gradingOf(claimed, T0 + LEASE - 1).status).toBe('grading');
    expect(gradingOf(claimed, T0 + LEASE)).toEqual({ status: 'failed', runs: 1, failure: 'interrupted' });

    state = run(state, { type: 'writing_grading_started', task: 1, now: T0 + LEASE, leaseUntil: T0 + 2 * LEASE });
    expect(state.sections.writing.writing[1]?.grading?.runs).toBe(2);
    // Run 1's request comes back after all: its result is not the current run's.
    state = run(state, { type: 'writing_graded', task: 1, run: 1, band: 9, now: T0 + LEASE + 1 });
    expect(state.sections.writing.writing[1]?.band).toBe(undefined);
    state = run(state, { type: 'writing_grading_failed', task: 1, run: 1, failure: 'timeout', now: T0 + LEASE + 2 });
    expect(state.sections.writing.writing[1]?.grading?.status).toBe('grading');

    state = run(state, { type: 'writing_graded', task: 1, run: 2, band: 6, now: T0 + LEASE + 3 });
    expect(state.sections.writing.writing[1]?.band).toBe(6);
    // Graded work keeps its band: no later result replaces it.
    state = run(state, { type: 'writing_graded', task: 1, run: 2, band: 8, now: T0 + LEASE + 4 });
    expect(state.sections.writing.writing[1]?.band).toBe(6);
  });

  it('claims no run while one is out, none on graded work, and none past the run limit', () => {
    const submitted = run(toWriting(), { type: 'writing_submitted', task: 1, essay: 'e', now: T0 });
    const claimed = claimGrading(submitted.sections.writing.writing[1], T0, T0 + LEASE);
    expect(claimed?.grading).toEqual({ status: 'grading', runs: 1, startedAt: T0, leaseUntil: T0 + LEASE });
    expect(claimGrading(claimed ?? undefined, T0 + 1, T0 + LEASE)).toBe(null);
    expect(claimGrading(undefined, T0, T0 + LEASE)).toBe(null);

    const graded = run(submitted, { type: 'writing_grading_started', task: 1, now: T0, leaseUntil: T0 + LEASE }, { type: 'writing_graded', task: 1, run: 1, band: 7, now: T0 });
    expect(claimGrading(graded.sections.writing.writing[1], T0 + 1, T0 + LEASE)).toBe(null);

    let state = submitted;
    for (let attempt = 1; attempt <= MAX_GRADING_RUNS; attempt++) {
      state = run(
        state,
        { type: 'writing_grading_started', task: 1, now: T0 + attempt, leaseUntil: T0 + LEASE },
        { type: 'writing_grading_failed', task: 1, run: attempt, failure: 'timeout', now: T0 + attempt },
      );
    }
    expect(state.sections.writing.writing[1]?.grading?.runs).toBe(MAX_GRADING_RUNS);
    expect(claimGrading(state.sections.writing.writing[1], T0 + 10, T0 + LEASE)).toBe(null);
    const more = run(state, { type: 'writing_grading_started', task: 1, now: T0 + 10, leaseUntil: T0 + LEASE });
    expect(more.sections.writing.writing[1]?.grading).toEqual(state.sections.writing.writing[1]?.grading);
  });

  it('records no band outside 0–9, whatever a grader returns', () => {
    const state = run(
      toWriting(),
      { type: 'writing_submitted', task: 1, essay: 'e', now: T0 },
      { type: 'writing_grading_started', task: 1, now: T0, leaseUntil: T0 + LEASE },
      { type: 'writing_graded', task: 1, run: 1, band: 11, now: T0 },
      { type: 'writing_graded', task: 1, run: 1, band: Number.NaN, now: T0 },
    );
    expect(state.sections.writing.writing[1]?.band).toBe(undefined);
    expect(state.sections.writing.writing[1]?.grading?.status).toBe('grading');
  });

  it('reads work stored before grading was recorded apart: with a band it is graded, without one it is not', () => {
    expect(gradingOf({ band: 7 }, T0)).toEqual({ status: 'graded', runs: 1 });
    expect(gradingOf({}, T0)).toEqual({ status: 'failed', runs: MAX_GRADING_RUNS, failure: 'interrupted' });
  });
});

describe('the overall band waits for every band, and is never made up (H6)', () => {
  it('gives no overall band while Speaking awaits grading, and the full result once its last band is in', () => {
    let state = run(
      toSpeaking(),
      ...speakingDone(1, 7, 'part one'),
      ...speakingDone(2, 7, 'part two'),
      { type: 'speaking_submitted', part: 3, transcriptProvided: 'part three', now: T0 + 1_000 },
      { type: 'speaking_grading_started', part: 3, now: T0 + 1_000, leaseUntil: T0 + LEASE },
      { type: 'finish_section', now: T0 + 2_000 },
    );
    expect(state.finishedAt).toBe(T0 + 2_000);
    expect(state.sections.speaking.status).toBe('awaiting_grading');
    const waiting = examResult(state);
    expect(waiting.complete).toBe(false);
    expect(waiting.overall).toBe(undefined);
    expect(waiting.bands.speaking).toBe(undefined);
    expect(waiting.awaitingGrading).toEqual(['speaking']);
    expect(gradingUnsettled(progressOf(state), T0 + 2_000)).toBe(true);

    const early = toExamAttempt(state);
    expect(early.status).toBe('incomplete');
    expect(early.scores.overall).toBe(undefined);
    expect(early.speakingParts?.[2]).toEqual({ materialId: 'spk-1', contentHash: hashFor('spk-1'), part: 3, transcript: 'part three' });

    state = run(state, { type: 'speaking_graded', part: 3, run: 1, band: 8, transcript: 'part three, transcribed', now: T0 + MINUTE });
    const result = examResult(state);
    expect(state.sections.speaking.status).toBe('completed');
    expect(result.complete).toBe(true);
    expect(result.overall).toBe(calculateOverallBand(result.bands));
    expect(result.awaitingGrading).toEqual([]);
    expect(gradingUnsettled(progressOf(state), T0 + MINUTE)).toBe(false);
    expect(toExamAttempt(state).speakingParts?.[2]?.band).toBe(8);
  });

  it('leaves a section whose grading failed for good without a band, keeping what was said', () => {
    let state = run(
      toSpeaking(),
      ...speakingDone(1, 7, 'part one'),
      ...speakingDone(2, 7, 'part two'),
      { type: 'speaking_submitted', part: 3, transcriptProvided: 'part three', now: T0 },
      { type: 'finish_section', now: T0 },
    );
    for (let attempt = 1; attempt <= MAX_GRADING_RUNS; attempt++) {
      state = run(
        state,
        { type: 'speaking_grading_started', part: 3, now: T0 + attempt, leaseUntil: T0 + LEASE },
        { type: 'speaking_grading_failed', part: 3, run: attempt, failure: 'unavailable', now: T0 + attempt },
      );
    }
    expect(gradingUnsettled(progressOf(state), T0 + MINUTE)).toBe(false);
    expect(gradingOutstanding(progressOf(state), T0 + MINUTE)).toBe(false);
    const result = examResult(state);
    expect(result.complete).toBe(false);
    expect(result.overall).toBe(undefined);
    const attempt = toExamAttempt(state);
    expect(attempt.status).toBe('incomplete');
    expect(attempt.scores.speaking).toBe(undefined);
    expect(attempt.speakingParts?.[2]?.band).toBe(undefined);
    expect(attempt.speakingParts?.[2]?.transcript).toBe('part three');
  });
});

describe('IELTS rules the run applies', () => {
  const answerReading = (state: ExamRunState, correct: number) => {
    const questions = state.plan.sections[1].questions.slice(0, correct);
    return run(state, ...questions.map(({ question }) => ({ type: 'answer' as const, questionId: question.id, value: String(question.correctAnswer) })));
  };
  const toReading = (state: ExamRunState) => run(state, { type: 'start', now: T0 }, { type: 'submit_answers', now: T0 }, { type: 'finish_section', now: T0 });

  it('converts Reading with the General Training table in a General Training exam', () => {
    // ielts.org: 30/40 is band 7 in Academic Reading and band 6 in General Training Reading.
    const academic = run(answerReading(toReading(fresh()), 30), { type: 'submit_answers', now: T0 + MINUTE });
    const general = run(answerReading(toReading(fresh(sitting({ module: 'general' }))), 30), { type: 'submit_answers', now: T0 + MINUTE });
    expect(academic.sections.reading.objective).toEqual({ correct: 30, total: 40, band: 7 });
    expect(general.sections.reading.objective).toEqual({ correct: 30, total: 40, band: 6 });
    // Listening is one test for both modules.
    const generalListening = run(fresh(sitting({ module: 'general' })), { type: 'start', now: T0 }, { type: 'submit_answers', now: T0 });
    const academicListening = run(fresh(), { type: 'start', now: T0 }, { type: 'submit_answers', now: T0 });
    expect(generalListening.sections.listening.objective).toEqual(academicListening.sections.listening.objective);
  });

  it('lets each Listening recording start once only, and only during Listening', () => {
    let state = run(fresh(), { type: 'start', now: T0 }, { type: 'audio_started', part: 2, now: T0 + 1_000 });
    state = run(state, { type: 'audio_started', part: 2, now: T0 + 90_000 });
    expect(state.sections.listening.audioStarted).toEqual({ 2: T0 + 1_000 });
    // A part the plan does not have is not recorded.
    state = run(state, { type: 'audio_started', part: 7, now: T0 + 2_000 });
    expect(state.sections.listening.audioStarted).toEqual({ 2: T0 + 1_000 });

    state = run(state, { type: 'submit_answers', now: T0 + MINUTE }, { type: 'finish_section', now: T0 + MINUTE });
    const afterListening = run(state, { type: 'audio_started', part: 3, now: T0 + 2 * MINUTE });
    expect(afterListening.sections.listening.audioStarted).toEqual({ 2: T0 + 1_000 });
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
      ...writingDone(1, 6.5, 'Task one essay text.', T0 + 2 * MINUTE),
      ...writingDone(2, 7, 'Task two essay text here.', T0 + 2 * MINUTE),
      { type: 'finish_section', now: T0 + 3 * MINUTE },
      ...speakingDone(1, 7, 'part one', T0 + 3 * MINUTE),
      ...speakingDone(2, 7, 'part two', T0 + 3 * MINUTE),
      ...speakingDone(3, 7.5, 'part three', T0 + 3 * MINUTE),
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
    for (const file of ['src/components/ExamMode.tsx', 'src/services/examRun.ts', 'src/services/examSession.ts', 'src/routes/examSessionRoutes.ts']) {
      const text = read(file);
      expect(/\b165\b|60 \* 60|durationMinutes: \d|Minutes: \d/.test(text)).toBe(false);
    }
  });

  it('shows the section clock from the plan and the server deadline, and decides nothing in the browser', () => {
    const screen = read('src/components/ExamMode.tsx');
    // The clock on screen: the section's configured duration, counting down to the deadline the server set.
    expect(screen).toContain('data-section-duration={section.durationSeconds}');
    expect(screen).toContain('remainingSeconds(run, serverNow)');
    // No state machine, no marking, no grading state and no attempt building in the browser: the session does all of it.
    expect(/examReducer|objectiveSectionScore|toExamAttempt|createExamRun|correctAnswer|claimGrading|gradingOf/.test(screen)).toBe(false);
  });

  it('never reaches for the built-in test', () => {
    for (const file of [
      'src/components/ExamMode.tsx',
      'src/services/examRun.ts',
      'src/services/examSession.ts',
      'src/services/sittingAdapters.ts',
      'src/routes/examSessionRoutes.ts',
      'src/services/bundleService.ts',
      'src/routes/learnerContentRoutes.ts',
      'src/routes/bundleRoutes.ts',
    ]) {
      const text = read(file);
      expect(/MOCK_TEST_1|mockBank|builtInSittableTest/.test(text)).toBe(false);
    }
  });
});
