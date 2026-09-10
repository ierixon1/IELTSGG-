/**
 * What an unauthenticated caller is allowed to see of a material.
 *
 * The admin CMS stores the answer key, the acceptable-answer variants, the
 * marking explanation and (for Listening) the full audio transcript alongside
 * the questions. All four give the test away, and the `/public/*` routes used
 * to return the stored material verbatim — so an anonymous `curl` could
 * collect the key for every published test without even signing in.
 *
 * Two views are defined here:
 *
 *   - `toPublicMaterialSummary` — metadata only, which is all a catalog needs.
 *   - `redactAnswerKeys` — the full material with every answer-revealing field
 *     removed, for surfaces that need to show the content itself.
 *
 * Both are allowlist-shaped on the fields that matter: a new answer field added
 * to a question in future is dropped by `redactAnswerKeys` only if it is named
 * here, so the summary view is the one to prefer when in doubt.
 */

/** Question fields that reveal the answer and must never leave the server. */
export const ANSWER_REVEALING_QUESTION_FIELDS = [
  'correctAnswer',
  'acceptableAnswers',
  'alternativeAnswers',
  'acceptedAnswers',
  'answer',
  'explanation',
  'paragraphLocation',
  // A generated question's evidence is the sentence its answer comes from.
  'provenance',
] as const;

/**
 * Material fields that reveal the answers wholesale. A Listening transcript is
 * the script the questions are drawn from, so publishing it is publishing the
 * key.
 */
export const ANSWER_REVEALING_CONTENT_FIELDS = [
  'audioTranscript',
  'transcript',
  'customGradingCriteria',
] as const;

export interface PublicMaterialSummary {
  id: string;
  title: string;
  section: string;
  module: string;
  status: string;
  theme?: string;
  targetBand?: string;
  createdAt?: string;
  updatedAt?: string;
  /**
   * The passage or section number this material is printed with.
   *
   * Part of the classification a publish requires, so the catalog can say
   * "Passage 2" rather than leaving a learner to guess which one they opened.
   */
  part?: number;
  /** How many questions the material carries, without carrying them. */
  questionCount: number;
  hasAudio: boolean;
  hasHtml: boolean;
}

function partNumber(material: any): number | undefined {
  const content = material?.content || {};
  const raw =
    material?.section === 'reading'
      ? content.passage?.passageNumber
      : material?.section === 'listening'
        ? content.section?.sectionNumber
        : undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : undefined;
}

function countQuestions(content: any): number {
  if (!content || typeof content !== 'object') return 0;
  const lists = [content.passage?.questions, content.section?.questions, content.questions];
  for (const list of lists) if (Array.isArray(list)) return list.length;
  return 0;
}

export function toPublicMaterialSummary(material: any): PublicMaterialSummary {
  const content = material?.content || {};
  return {
    id: String(material?.id || ''),
    title: String(material?.title || ''),
    section: String(material?.section || ''),
    module: String(material?.module || 'academic'),
    status: String(material?.status || 'draft'),
    theme: typeof material?.theme === 'string' ? material.theme : undefined,
    targetBand: typeof material?.targetBand === 'string' ? material.targetBand : undefined,
    createdAt: typeof material?.createdAt === 'string' ? material.createdAt : undefined,
    updatedAt: typeof material?.updatedAt === 'string' ? material.updatedAt : undefined,
    part: partNumber(material),
    questionCount: countQuestions(content),
    hasAudio: Boolean(content.audioUrl || content.audioFileName),
    hasHtml: Boolean(content.htmlContent || content.passage?.htmlContent || content.section?.htmlContent),
  };
}

function redactQuestion(question: any): any {
  if (!question || typeof question !== 'object') return question;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(question)) {
    if ((ANSWER_REVEALING_QUESTION_FIELDS as readonly string[]).includes(key)) continue;
    out[key] = value;
  }
  return out;
}

function redactValue(value: any, key?: string): any {
  if (Array.isArray(value)) {
    return key === 'questions' ? value.map(redactQuestion) : value.map((v) => redactValue(v));
  }
  if (!value || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if ((ANSWER_REVEALING_CONTENT_FIELDS as readonly string[]).includes(childKey)) continue;
    if ((ANSWER_REVEALING_QUESTION_FIELDS as readonly string[]).includes(childKey)) continue;
    out[childKey] = redactValue(childValue, childKey);
  }
  return out;
}

/** The full material with every answer-revealing field stripped, recursively. */
export function redactAnswerKeys<T>(material: T): T {
  return redactValue(material) as T;
}
