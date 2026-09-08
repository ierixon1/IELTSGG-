import { PlanTask, UserProfile, MockAttempt, SkillType } from '../types';

/**
 * Plan text is stored as a translation key plus its parameters, never as a
 * rendered sentence: a learner who switches language should see their existing
 * plan in the new one. The plain `title` and `reason` strings are still written
 * as an English fallback, so a plan saved by an older build — or read by
 * anything that does not know about the keys — still reads correctly.
 */
const WEEKS = 6;

const FOCUS_TASK_TYPE: Record<SkillType, PlanTask['taskType']> = {
  writing: 'writing_task2',
  speaking: 'speaking_part2',
  reading: 'reading_passage',
  listening: 'listening_part',
};

const SECONDARY_TASK_TYPE: Record<SkillType, PlanTask['taskType']> = {
  writing: 'writing_task1',
  speaking: 'speaking_part1',
  reading: 'reading_passage',
  listening: 'listening_part',
};

/** English fallbacks, kept in step with `planTasks.*` in the dictionaries. */
const FALLBACK_TITLES: Record<string, string> = {
  focus_writing: 'Writing Task 2: essay structure and idea cohesion',
  focus_speaking: 'Speaking Part 2: a two-minute cue card with complex structures',
  focus_reading: 'Reading: heading matching and skimming strategy',
  focus_listening: 'Listening Sections 3 & 4: lecture distractors and detail traps',
  second_writing: 'Writing Task 1: describing a chart with a clear overview',
  second_speaking: 'Speaking Parts 1 & 3: fluency and thinking on your feet',
  second_reading: 'Reading: True / False / Not Given at speed',
  second_listening: 'Listening: note completion across accents',
  arcade: 'Speak or Die: a five-minute fluency drill',
};

function addDays(from: Date, days: number): string {
  const date = new Date(from);
  date.setDate(from.getDate() + days);
  return date.toISOString().split('T')[0];
}

export function generateInitialPlan(profile: UserProfile): PlanTask[] {
  const tasks: PlanTask[] = [];
  const today = new Date();

  const skills: SkillType[] = ['writing', 'speaking', 'reading', 'listening'];
  const prioritySkills = [profile.weakSection, ...skills.filter((s) => s !== profile.weakSection)];
  const focusSkill = prioritySkills[0];
  const secondarySkill = prioritySkills[1];

  let taskCounter = 1;

  for (let week = 0; week < WEEKS; week++) {
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() + week * 7);

    // Day 1 — the weakest module, where a band moves fastest.
    tasks.push({
      id: `task-${taskCounter++}`,
      titleKey: `planTasks.title.focus_${focusSkill}`,
      title: FALLBACK_TITLES[`focus_${focusSkill}`],
      skill: focusSkill,
      taskType: FOCUS_TASK_TYPE[focusSkill],
      dueDate: addDays(weekStart, 1),
      completed: false,
      weight: 5,
      durationMins: 45,
      reasonKey: 'planTasks.reason.focus',
      reasonParams: { skill: focusSkill },
      reason: `Aimed at your weakest module (${focusSkill}), where a band moves fastest.`,
      sectionId: 'test-1',
    });

    // Day 3 — keep the second-weakest module from slipping.
    tasks.push({
      id: `task-${taskCounter++}`,
      titleKey: `planTasks.title.second_${secondarySkill}`,
      title: FALLBACK_TITLES[`second_${secondarySkill}`],
      skill: secondarySkill,
      taskType: SECONDARY_TASK_TYPE[secondarySkill],
      dueDate: addDays(weekStart, 3),
      completed: false,
      weight: 3,
      durationMins: 40,
      reasonKey: 'planTasks.reason.second',
      reasonParams: { skill: secondarySkill, band: profile.targetBand },
      reason: `Keeping ${secondarySkill} strong enough to hold your target of Band ${profile.targetBand}.`,
      sectionId: 'test-1',
    });

    // Day 5 — fluency under pressure.
    tasks.push({
      id: `task-${taskCounter++}`,
      titleKey: 'planTasks.title.arcade',
      title: FALLBACK_TITLES.arcade,
      skill: 'speaking',
      taskType: 'criteria_drill',
      dueDate: addDays(weekStart, 5),
      completed: false,
      weight: 4,
      durationMins: 15,
      reasonKey: 'planTasks.reason.arcade',
      reason: 'Kills the hesitation pauses that cost you on Fluency.',
      sectionId: 'arcade',
    });

    // Day 6 — a full sitting every other week, a section check otherwise.
    const isFullMock = (week + 1) % 2 === 0;
    const mockNumber = Math.floor(week / 2) + 1;

    tasks.push({
      id: `task-${taskCounter++}`,
      titleKey: isFullMock ? 'planTasks.title.fullMock' : 'planTasks.title.sectionMock',
      titleParams: isFullMock
        ? { number: mockNumber }
        : { first: focusSkill, second: secondarySkill },
      title: isFullMock
        ? `Full mock test #${mockNumber}, all four sections`
        : `Timed section check: ${focusSkill} and ${secondarySkill}`,
      skill: focusSkill,
      taskType: isFullMock ? 'full_mock' : 'section_mock',
      dueDate: addDays(weekStart, 6),
      completed: false,
      weight: 5,
      durationMins: isFullMock ? 165 : 60,
      reasonKey: isFullMock ? 'planTasks.reason.fullMock' : 'planTasks.reason.sectionMock',
      reason: isFullMock
        ? 'A full sitting under real conditions, no pauses.'
        : 'A checkpoint to see whether the drills are landing.',
      sectionId: isFullMock ? 'exam-mode' : 'test-1',
    });
  }

  return tasks;
}

export interface RecalculationResult {
  updatedTasks: PlanTask[];
  diagnosedWeakSkill: SkillType;
  /** English fallback for the banner. */
  reason: string;
  reasonKey: string;
  reasonParams?: Record<string, string | number>;
}

/**
 * Reads the recent graded attempts, finds the lowest-scoring module and shifts
 * weight onto the upcoming tasks for it.
 */
export function recalculatePlan(
  currentTasks: PlanTask[],
  attempts: MockAttempt[],
  profile: UserProfile,
): RecalculationResult {
  if (attempts.length === 0) {
    return {
      updatedTasks: currentTasks,
      diagnosedWeakSkill: profile.weakSection,
      reason: 'No graded attempts yet — the plan is running on your self-assessed baseline.',
      reasonKey: 'planTasks.recalc.noAttempts',
    };
  }

  const recent = attempts.slice(-5);
  const skills: SkillType[] = ['listening', 'reading', 'writing', 'speaking'];

  const averages = skills.map((skill) => {
    const bands = recent
      .map((attempt) => attempt.scores[skill]?.band)
      .filter((band): band is number => typeof band === 'number');

    return {
      skill,
      average: bands.length > 0 ? bands.reduce((sum, band) => sum + band, 0) / bands.length : null,
    };
  });

  const scored = averages.filter(
    (entry): entry is { skill: SkillType; average: number } => entry.average !== null,
  );

  const lowest =
    scored.length > 0
      ? scored.reduce((min, entry) => (entry.average < min.average ? entry : min))
      : { skill: profile.weakSection, average: profile.currentLevel };

  const updatedTasks = currentTasks.map((task) => {
    if (task.completed) return task;

    if (task.skill === lowest.skill) {
      return {
        ...task,
        weight: 5,
        reasonKey: 'planTasks.reason.elevated',
        reasonParams: { skill: lowest.skill },
        reason: `Priority raised: this is your current bottleneck (${lowest.skill}).`,
      };
    }

    return { ...task, weight: Math.max(1, task.weight - 1) };
  });

  return {
    updatedTasks,
    diagnosedWeakSkill: lowest.skill,
    reason: `Your lowest module is ${lowest.skill} at Band ${lowest.average.toFixed(1)} against a target of ${profile.targetBand.toFixed(1)}. Upcoming tasks in it now carry more weight.`,
    reasonKey: 'planTasks.recalc.done',
    reasonParams: {
      skill: lowest.skill,
      band: lowest.average.toFixed(1),
      target: profile.targetBand.toFixed(1),
    },
  };
}
