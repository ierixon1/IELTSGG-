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
  /**
   * English fallback text. The plan is generated with `titleKey`/`reasonKey`
   * so it can follow the interface language; these strings stay as the value
   * shown when a key is missing, and as what older saved plans carry.
   */
  title: string;
  titleKey?: string;
  titleParams?: Record<string, string | number>;
  skill: SkillType;
  taskType: TaskType;
  dueDate: string;
  completed: boolean;
  weight: number; // dynamic weight 1 to 5
  durationMins: number;
  reason: string;
  reasonKey?: string;
  reasonParams?: Record<string, string | number>;
  sectionId?: string;
}

/**
 * One item in the learner's vocabulary deck.
 *
 * Cards are never invented: each one comes from something the learner wrote or
 * said — a phrase the examiner flagged, or a word they leaned on too heavily —
 * so the deck is a record of their own work rather than a generic word list.
 */
export interface VocabCard {
  id: string;
  /** The learner's own word or phrase. */
  term: string;
  source: 'annotation' | 'repetition';
  /** The sentence it came from, when there is one. */
  context?: string;
  /** A stronger alternative, where the examiner offered one. */
  suggestion?: string;
  /** Why it was captured. */
  note?: string;
  skill: SkillType;
  /** Leitner box, 1–5. Higher means longer between reviews. */
  box: number;
  /** ISO date the card is next due. */
  dueDate: string;
  reviews: number;
  lapses: number;
  createdAt: string;
}

/** One concrete edit made when rewriting a paragraph at a higher band. */
export interface RewriteChange {
  /** What was there before. */
  before: string;
  /** What replaced it. */
  after: string;
  /** Which criterion the change serves. */
  criterion: string;
  reason: string;
}

export interface RewriteResult {
  improved: string;
  targetBand: number;
  changes: RewriteChange[];
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

/** One bullet from a Part 2 cue card, and whether the answer reached it. */
export interface CueCardPointCoverage {
  point: string;
  covered: boolean;
  /** The candidate's own words that show it was addressed. */
  evidence?: string;
}

export interface SpeakingGradingResult {
  band_overall: number;
  transcript: string;
  /**
   * Present for Part 2 only. A checklist, deliberately not a fifth band —
   * IELTS Speaking has four criteria and coverage is not among them.
   */
  cue_card_coverage?: CueCardPointCoverage[];
  criteria: {
    fluency_coherence: CriterionFeedback;
    lexical_resource: CriterionFeedback;
    grammatical_range: CriterionFeedback;
    pronunciation: CriterionFeedback; // labeled approximate
  };
  objective_metrics: SpeakingObjectiveMetrics;
  actionable_drills: string[];
}

/**
 * The task types that actually appear on the paper. The renderer picks its
 * control from this: a bank-backed type gets a dropdown, a choice gets radios,
 * everything else gets a text box with its word limit shown.
 */
export type QuestionType =
  | 'multiple_choice'
  | 'multi_select'
  | 'fill_in_blank'
  | 'sentence_completion'
  | 'summary_completion'
  | 'note_completion'
  | 'table_completion'
  | 'form_completion'
  | 'short_answer'
  | 'true_false_not_given'
  | 'yes_no_not_given'
  | 'matching'
  | 'matching_headings'
  | 'matching_information'
  | 'matching_features'
  | 'matching_sentence_endings'
  | 'diagram_label'
  | 'map_label';

/** Types answered by picking from a shared lettered bank rather than typing. */
export const BANK_ANSWER_TYPES: QuestionType[] = [
  'matching',
  'matching_headings',
  'matching_information',
  'matching_features',
  'matching_sentence_endings',
];

/**
 * How a question sits on the page.
 *
 * The paper does not print every task as a paragraph followed by a box: a table
 * completion is a grid of gaps, a note completion is an indented list, a
 * summary gap sits inside running text. Recording the intended shape is what
 * lets the renderer stop flattening all of them into one list of text fields.
 * Absent means `standalone`.
 */
export type QuestionLayout =
  | 'standalone'
  | 'table_row'
  | 'note_line'
  | 'form_row'
  | 'summary_gap'
  | 'inline_gap'
  | 'diagram_label';

/** A stored file a question needs in order to be answerable — a map, a plan. */
export interface MediaRef {
  /** An `ast_…` id from the asset store. */
  assetId: string;
  kind: 'image' | 'audio';
  alt?: string;
}

/**
 * What a learner's answer to one question looks like.
 *
 * Every task type stores a string except `multi_select`, which stores the set
 * of options chosen. Modelling that as a string is what made multi-select
 * unplayable: the control had nowhere to put a second choice.
 */
export type AnswerValue = string | string[];

/** One location a generated question was written from. */
export interface QuestionProvenanceLocation {
  chunkId: string;
  page?: number;
  path: string[];
}

/**
 * Machine-readable proof of where a generated question came from.
 *
 * Enough for a reviewer to open the exact source chunks and read the sentence
 * the answer rests on. `validation` is a display copy; the authoritative
 * verdict is the material’s write-once generation record.
 */
export interface QuestionProvenance {
  kind: 'generated';
  generationId: string;
  generatedQuestionId: string;
  generatorVersion: string;
  /** The prompt contract the question was generated under. */
  promptVersion?: string;
  model: string;
  /** The version the provider reported answering with, when it reported one. */
  modelVersion?: string;
  generatedAt: string;
  sourceId: string;
  chunkIds: string[];
  pages: number[];
  locations: QuestionProvenanceLocation[];
  evidence: Array<{ chunkId: string; quote: string }>;
  /** The sentence(s) the question is about. */
  questionEvidence?: Array<{ chunkId: string; quote: string }>;
  /** The text that establishes the answer. Empty for NOT GIVEN. */
  answerEvidence?: Array<{ chunkId: string; quote: string }>;
  /** The model’s account of why each distractor is wrong. Recorded, never trusted. */
  distractorEvidence?: Array<{ option: string; chunkId?: string; quote?: string; reason?: string }>;
  /** Display copies of the two machine verdicts; the generation record holds the originals. */
  groundingStatus?: 'valid' | 'needs_review';
  qualityStatus?: 'valid' | 'needs_review';
  validation: 'valid' | 'needs_review';
}

export interface Question {
  id: string;
  questionNumber: number;
  type: QuestionType;
  /**
   * Rubric shown above this question and the ones that follow it in the same
   * group, exactly as the paper prints it. Set on the first question of a
   * group only.
   */
  instruction?: string;
  prompt: string;
  /** Choices for a multiple choice, or the lettered bank for a matching group. */
  options?: string[];
  /** e.g. "NO MORE THAN TWO WORDS AND/OR A NUMBER" — printed beside the box. */
  wordLimit?: string;
  correctAnswer: string | string[]; // supports alternate spellings e.g. ["19", "nineteen"]
  /**
   * Further spellings that mark as correct, kept separate from
   * `correctAnswer` so the authored key stays identifiable in review.
   */
  acceptableAnswers?: string[];
  explanation?: string;
  /** How this question is printed. Absent means `standalone`. */
  layout?: QuestionLayout;
  /** An image or audio file this question cannot be answered without. */
  mediaRef?: MediaRef;
  /**
   * Questions sharing a group key are one block on the paper — the rows of a
   * table, the lines of a note, the items under a single rubric.
   */
  group?: string;
  /**
   * Where a generated question came from. Absent on hand-authored and imported
   * questions; required on every question Book → Test produced.
   */
  provenance?: QuestionProvenance;
}

/**
 * What a question looks like to the screen that renders it: everything but the
 * answer key and its explanation. A practice question is a full `Question`; an
 * exam question is a `SittingQuestion`, which never carried a key at all.
 */
export type QuestionBody = Omit<Question, 'correctAnswer' | 'acceptableAnswers' | 'explanation' | 'provenance'> & {
  /** How many answers a multi-select takes, so "Choose TWO" can be printed without the key. */
  answerCount?: number;
};

/** A question as an exam sitting delivers it: no key, no explanation, no provenance. */
export type SittingQuestion = QuestionBody & { answerCount: number };

export interface ListeningPart<Q extends QuestionBody = Question> {
  partNumber: 1 | 2 | 3 | 4;
  title: string;
  accent: 'British' | 'Australian' | 'North American' | 'Scottish/Irish';
  audioDescription: string;
  transcript: string;
  htmlContent?: string;
  questions: Q[];
  /**
   * The recorded audio for this part, served through the learner asset route.
   * Absent means there is no recording; nothing reads the transcript aloud in its place during an exam.
   */
  audioUrl?: string;
}

export interface ReadingPassage<Q extends QuestionBody = Question> {
  passageNumber: 1 | 2 | 3;
  title: string;
  subheading?: string;
  content: string; // paragraphs with [A], [B], [C] markers if matching headings
  htmlContent?: string;
  questions: Q[];
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

export type ListeningData<Q extends QuestionBody = Question> = { parts: ListeningPart<Q>[] };
export type ReadingData<Q extends QuestionBody = Question> = { passages: ReadingPassage<Q>[] };
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
  /** A full exam sat from a bundle: which bundle, and which publication of it. */
  bundleId?: string;
  bundlePublishedAt?: string;
  /** The section minutes this exam was sat under, exactly as the bundle configured them. */
  timing?: {
    listeningMinutes: number;
    readingMinutes: number;
    writingMinutes: number;
    speakingMinutes: number;
    basis: 'custom' | 'ielts_reference';
    allowEarlyFinish: boolean;
  };
  /** `incomplete` when any section ran out of time before its content was done. */
  status?: 'completed' | 'incomplete';
  startedAt?: string;
  completedAt?: string;
  sections?: Partial<Record<'listening' | 'reading' | 'writing' | 'speaking', AttemptSectionRecord>>;
  /** Every Listening and Reading answer, against the exact material version it answered. */
  responses?: AttemptResponse[];
  writingTasks?: AttemptWritingTask[];
  speakingParts?: AttemptSpeakingPart[];
}

export interface AttemptComponentRef {
  materialId: string;
  contentHash: string;
  part: number;
}

export interface AttemptSectionRecord {
  /** `awaiting_grading`: all Writing or Speaking work was submitted and a band is still to come. */
  status: 'pending' | 'in_progress' | 'completed' | 'expired' | 'awaiting_grading';
  startedAt?: string;
  endedAt?: string;
  endedBy?: 'learner' | 'time';
  band?: number;
  rawScore?: number;
  total?: number;
  components: AttemptComponentRef[];
}

export interface AttemptResponse extends AttemptComponentRef {
  section: 'listening' | 'reading';
  questionId: string;
  answer: AnswerValue;
}

export interface AttemptWritingTask {
  materialId: string;
  contentHash: string;
  task: 1 | 2;
  band?: number;
  essay: string;
  wordCount: number;
}

export interface AttemptSpeakingPart {
  materialId: string;
  contentHash: string;
  part: 1 | 2 | 3;
  band?: number;
  transcript: string;
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
