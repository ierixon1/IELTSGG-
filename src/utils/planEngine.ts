import { PlanTask, UserProfile, MockAttempt, SkillType } from '../types';

export function generateInitialPlan(profile: UserProfile): PlanTask[] {
  const weeks = 6;
  const tasks: PlanTask[] = [];
  const today = new Date();

  const skills: SkillType[] = ['writing', 'speaking', 'reading', 'listening'];
  // Prioritize user's weak section
  const prioritySkills = [profile.weakSection, ...skills.filter(s => s !== profile.weakSection)];

  let taskCounter = 1;

  for (let w = 0; w < weeks; w++) {
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() + w * 7);

    // Day 1: Priority weak section targeted drill
    const d1 = new Date(weekStart);
    d1.setDate(weekStart.getDate() + 1);
    const weakSkill = prioritySkills[0];
    tasks.push({
      id: `task-${taskCounter++}`,
      title: getWeakSkillTitle(weakSkill),
      skill: weakSkill,
      taskType: weakSkill === 'writing' ? 'writing_task2' : weakSkill === 'speaking' ? 'speaking_part2' : weakSkill === 'reading' ? 'reading_passage' : 'listening_part',
      dueDate: d1.toISOString().split('T')[0],
      completed: false,
      weight: 5,
      durationMins: 45,
      reason: `Targeting your identified weakest section (${weakSkill.toUpperCase()}) for rapid score uplift.`,
      sectionId: 'test-1',
    });

    // Day 3: Secondary skill
    const d3 = new Date(weekStart);
    d3.setDate(weekStart.getDate() + 3);
    const secondarySkill = prioritySkills[1];
    tasks.push({
      id: `task-${taskCounter++}`,
      title: secondarySkill === 'writing' ? 'Academic Writing Task 1: Chart Description & Overview' : secondarySkill === 'speaking' ? 'Speaking Part 1 & 3: Fluency & Spontaneity' : secondarySkill === 'reading' ? 'Academic Reading: True/False/Not Given Speed Mastery' : 'Listening: Multi-Accent Note Completion Practice',
      skill: secondarySkill,
      taskType: secondarySkill === 'writing' ? 'writing_task1' : secondarySkill === 'speaking' ? 'speaking_part1' : secondarySkill === 'reading' ? 'reading_passage' : 'listening_part',
      dueDate: d3.toISOString().split('T')[0],
      completed: false,
      weight: 3,
      durationMins: 40,
      reason: `Building balanced competency in ${secondarySkill.toUpperCase()} to secure target Band ${profile.targetBand}.`,
      sectionId: 'test-1',
    });

    // Day 5: Remaining skills drill / Arcade
    const d5 = new Date(weekStart);
    d5.setDate(weekStart.getDate() + 5);
    tasks.push({
      id: `task-${taskCounter++}`,
      title: 'Speaking Arcade: "Speak or Die" 5-Minute Fluency Drill',
      skill: 'speaking',
      taskType: 'criteria_drill',
      dueDate: d5.toISOString().split('T')[0],
      completed: false,
      weight: 4,
      durationMins: 15,
      reason: 'Eliminate hesitation pauses and overcome fear of silence under pressure.',
      sectionId: 'arcade',
    });

    // Day 6 or 7: Full Mock or Section Mock
    const d6 = new Date(weekStart);
    d6.setDate(weekStart.getDate() + 6);
    const isFullMock = (w + 1) % 2 === 0;
    tasks.push({
      id: `task-${taskCounter++}`,
      title: isFullMock ? `Full Academic Mock Test #${Math.floor(w / 2) + 1} (All 4 Sections)` : `Timed Section Assessment: ${weakSkill.toUpperCase()} & ${secondarySkill.toUpperCase()}`,
      skill: weakSkill,
      taskType: isFullMock ? 'full_mock' : 'section_mock',
      dueDate: d6.toISOString().split('T')[0],
      completed: false,
      weight: 5,
      durationMins: isFullMock ? 165 : 60,
      reason: isFullMock ? 'Simulation of actual test conditions without pauses.' : 'Milestone check to measure section progress.',
      sectionId: isFullMock ? 'exam-mode' : 'test-1',
    });
  }

  return tasks;
}

function getWeakSkillTitle(skill: SkillType): string {
  switch (skill) {
    case 'writing':
      return 'Writing Task 2: High-Band Essay Structure & Idea Cohesion';
    case 'speaking':
      return 'Speaking Part 2: Cue Card 2-Minute Monologue with Complex Grammatical Structures';
    case 'reading':
      return 'Academic Reading: Headings Matching & Academic Skimming Strategy';
    case 'listening':
      return 'Listening Section 3 & 4: Academic Lecture Distractors & Detail Trap Defense';
  }
}

/**
 * Dynamic Recalculation Engine:
 * Analyzes latest mock attempt scores. Identifies the lowest performing skill.
 * Re-weights upcoming tasks and injects targeted drills for the weak skill.
 */
export function recalculatePlan(
  currentTasks: PlanTask[],
  attempts: MockAttempt[],
  profile: UserProfile
): { updatedTasks: PlanTask[]; diagnosedWeakSkill: SkillType; reason: string } {
  if (attempts.length === 0) {
    return {
      updatedTasks: currentTasks,
      diagnosedWeakSkill: profile.weakSection,
      reason: 'No attempts yet. Operating on initial diagnostic baseline.',
    };
  }

  // Calculate average band per skill across recent attempts (up to last 5)
  const recent = attempts.slice(-5);
  const skillAverages: Record<SkillType, { total: number; count: number }> = {
    listening: { total: 0, count: 0 },
    reading: { total: 0, count: 0 },
    writing: { total: 0, count: 0 },
    speaking: { total: 0, count: 0 },
  };

  recent.forEach(att => {
    if (att.scores.listening) {
      skillAverages.listening.total += att.scores.listening.band;
      skillAverages.listening.count += 1;
    }
    if (att.scores.reading) {
      skillAverages.reading.total += att.scores.reading.band;
      skillAverages.reading.count += 1;
    }
    if (att.scores.writing) {
      skillAverages.writing.total += att.scores.writing.band;
      skillAverages.writing.count += 1;
    }
    if (att.scores.speaking) {
      skillAverages.speaking.total += att.scores.speaking.band;
      skillAverages.speaking.count += 1;
    }
  });

  let lowestSkill: SkillType = profile.weakSection;
  let lowestAvg = 999;

  (Object.keys(skillAverages) as SkillType[]).forEach(skill => {
    const data = skillAverages[skill];
    if (data.count > 0) {
      const avg = data.total / data.count;
      if (avg < lowestAvg) {
        lowestAvg = avg;
        lowestSkill = skill;
      }
    }
  });

  const reason = `Automated Recalculation: Recent tests reveal your lowest scoring section is ${lowestSkill.toUpperCase()} (${lowestAvg < 999 ? lowestAvg.toFixed(1) : 'needs attention'} vs target Band ${profile.targetBand}). Higher weight and focused drills have been injected into upcoming tasks.`;

  // Update future incomplete tasks
  const updatedTasks = currentTasks.map(task => {
    if (task.completed) return task;

    if (task.skill === lowestSkill) {
      return {
        ...task,
        weight: 5,
        reason: `Priority elevated: identified as your critical bottleneck (${lowestSkill.toUpperCase()}).`,
      };
    } else {
      return {
        ...task,
        weight: Math.max(1, task.weight - 1),
      };
    }
  });

  return { updatedTasks, diagnosedWeakSkill: lowestSkill, reason };
}
