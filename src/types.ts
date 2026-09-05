export type SkillType = 'listening' | 'reading' | 'writing' | 'speaking';

export type TaskType = 
  | 'full_mock'
  | 'section_mock'
  | 'writing_task1'
  | 'writing_task2'
  | 'speaking_part1'
  | 'speaking_part2'
  | 'speaking_part3'
  | 'reading_passage'
  | 'listening_part'
  | 'criteria_drill';

export interface UserProfile {
  id: string;
  targetBand: number; // e.g. 7.5
  currentLevel: number; // e.g. 6.0
  examDate?: string; // YYYY-MM-DD
  hoursPerWeek: number; // e.g. 10
  weakSection: SkillType;
  isOnboarded: boolean;
  name?: string;
}

export interface PlanTask {
  id: string;
  title: string;
  skill: SkillType;
  taskType: TaskType;
  dueDate: string;
  completed: boolean;
  weight: number; // dynamic weight 1 to 5
  durationMins: number;
  reason: string;
  sectionId?: string;
}

export interface CriterionFeedback {
  name: string;
  band: number;
  justification: string;
  improvement_tips: string[];
}

export interface TextAnnotation {
  span: string;
  issue_type: 'grammar' | 'lexical' | 'cohesion' | 'task_achievement';
  comment: string;
  suggestion: string;
}

export interface WritingGradingResult {
  band_overall: number;
  criteria: CriterionFeedback[];
  annotated_text: TextAnnotation[];
  word_count: number;
  meets_word_limit: boolean;
  general_commentary: string;
}

export interface SpeakingObjectiveMetrics {
  durationSeconds: number;
  wordsPerMinute: number;
  pausesCount: number;
  totalPauseDurationSeconds: number;
  fillerWords: { word: string; count: number }[];
}

export interface SpeakingGradingResult {
  band_overall: number;
  transcript: string;
  criteria: {
    fluency_coherence: CriterionFeedback;
    lexical_resource: CriterionFeedback;
    grammatical_range: CriterionFeedback;
    pronunciation: CriterionFeedback; // labeled approximate
  };
  objective_metrics: SpeakingObjectiveMetrics;
  actionable_drills: string[];
}

export interface Question {
  id: string;
  questionNumber: number;
  type: 'multiple_choice' | 'fill_in_blank' | 'true_false_not_given' | 'matching';
  prompt: string;
  options?: string[];
  correctAnswer: string | string[]; // supports alternate spellings e.g. ["19", "nineteen"]
  explanation?: string;
}

export interface ListeningPart {
  partNumber: 1 | 2 | 3 | 4;
  title: string;
  accent: 'British' | 'Australian' | 'North American' | 'Scottish/Irish';
  audioDescription: string;
  transcript: string;
  htmlContent?: string;
  questions: Question[];
}

export interface ReadingPassage {
  passageNumber: 1 | 2 | 3;
  title: string;
  subheading?: string;
  content: string; // paragraphs with [A], [B], [C] markers if matching headings
  htmlContent?: string;
  questions: Question[];
}

export interface WritingTaskData {
  taskNumber: 1 | 2;
  title: string;
  prompt: string;
  htmlContent?: string;
  chartType?: 'line_graph' | 'bar_chart' | 'pie_chart' | 'process_diagram' | 'table';
  chartDescription?: string;
  chartDataSummary?: string;
  minWordCount: number;
  recommendedMinutes: number;
  sampleBand9Excerpt?: string;
}

export interface SpeakingPartData {
  partNumber: 1 | 2 | 3;
  topic: string;
  htmlContent?: string;
  questions: string[];
  cueCard?: {
    topic: string;
    points: string[];
    prepTimeSeconds: number;
    speakTimeSeconds: number;
  };
}

export type ListeningData = { parts: ListeningPart[] };
export type ReadingData = { passages: ReadingPassage[] };
export type SpeakingData = { parts: SpeakingPartData[] };

export interface MockTest {
  id: string;
  testNumber: number;
  title: string;
  difficulty: 'Standard Academic' | 'Challenging' | 'High-Band Target';
  listening: ListeningData;
  reading: ReadingData;
  writing: {
    task1: WritingTaskData;
    task2: WritingTaskData;
  };
  speaking: SpeakingData;
}

export interface MockAttempt {
  id: string;
  testId: string;
  testTitle?: string;
  mode?: 'practice' | 'exam';
  isFullMock?: boolean;
  date: string;
  overallBand?: number;
  scores: {
    overall?: number;
    listening?: { band: number; raw?: number; rawScore?: number; total?: number };
    reading?: { band: number; raw?: number; rawScore?: number; total?: number };
    writing?: { band: number; task1Band?: number; task2Band?: number };
    speaking?: { band: number; transcriptSnippet?: string };
  };
  durationMinutes?: number;
  notes?: string;
}

export interface ChecklistWeek {
  weekNumber: number;
  weekStart: string;
  mocksDone: number;
  mocksTarget: number;
  essaysDone: number;
  essaysTarget: number;
  speakingDone: number;
  speakingTarget: number;
}

export interface ArcadeLeaderboardEntry {
  date: string;
  difficulty: 'easy' | 'medium' | 'hard' | 'extra_hard';
  topic: string;
  durationSeconds: number;
  wordsSpoken: number;
  status: 'survived_2min' | 'eaten_by_saw';
}
