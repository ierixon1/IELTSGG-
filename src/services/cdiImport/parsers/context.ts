import { QuestionSchema } from '../../../schemas/question';
import type { Question } from '../../../types';
import type { ChildNode } from '../normalize';
import type { AnswerKeyEntry, QuestionGroupHeader, QuestionSite } from './shared';
import type { AnswerStatus, ImportDiagnostic, ParsedQuestion, SourceRange } from '../types';

/** Everything a family parser needs to read one question site. */
export interface ParserContext {
  root: ChildNode[];
  source: string;
  headers: QuestionGroupHeader[];
  /** Keys found in a dedicated answer-key section, by question number. */
  answerKeys: Map<number, AnswerKeyEntry>;
}

/** A family parser: reads one site, or declines it. */
export type FamilyParser = (site: QuestionSite, context: ParserContext) => ParsedQuestion | null;

export interface BuildInput {
  site: QuestionSite;
  type: Question['type'];
  prompt: string;
  options?: string[];
  instruction?: string;
  wordLimit?: string;
  layout?: Question['layout'];
  group?: string;
  mediaRef?: Question['mediaRef'];
  /** The answer as read from the page, and how certainly. */
  answer?: string | string[];
  answerStatus: AnswerStatus;
  diagnostics?: ImportDiagnostic[];
  detectedAs?: string;
}

/**
 * Turns what a parser read into a canonical question, or into an honest
 * incomplete result.
 *
 * The importer's output is the phase 4 model — there is no parallel question
 * type — so the last thing every parser does is run the real schema. Three
 * outcomes, and none of them involves inventing a value:
 *
 *   - a complete, valid question: `parsed`;
 *   - everything but the answer key: `needs_review`, with the draft carried so
 *     a reviewer sees the prompt and options the page actually had;
 *   - something the schema refuses: `needs_review` with the reason, never a
 *     silently repaired question.
 */
export function buildQuestion(input: BuildInput): ParsedQuestion {
  const diagnostics: ImportDiagnostic[] = [...(input.diagnostics ?? [])];
  const number = input.site.number;

  const draft: Partial<Question> = {
    id: `cdi-q${number}`,
    questionNumber: number,
    type: input.type,
    prompt: input.prompt,
    options: input.options?.length ? input.options : undefined,
    instruction: input.instruction,
    wordLimit: input.wordLimit,
    layout: input.layout,
    group: input.group,
    mediaRef: input.mediaRef,
  };

  if (input.answer === undefined || (Array.isArray(input.answer) && input.answer.length === 0)) {
    diagnostics.push({
      code: 'answer_key_missing',
      message: `Question ${number} has no answer key in the source. It cannot be marked until one is supplied.`,
      questionNumber: number,
      sourceRange: input.site.sourceRange,
    });
    return {
      status: 'needs_review',
      answerStatus: 'missing',
      questionNumber: number,
      sourceRange: input.site.sourceRange,
      diagnostics,
      draft,
      detectedAs: input.detectedAs ?? input.type,
    };
  }

  const parsed = QuestionSchema.safeParse({ ...draft, correctAnswer: input.answer });
  if (!parsed.success) {
    diagnostics.push({
      code: 'schema_rejected',
      message: `Question ${number}: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'question'}: ${issue.message}`)
        .join('; ')}`,
      questionNumber: number,
      sourceRange: input.site.sourceRange,
    });
    return {
      status: 'needs_review',
      answerStatus: input.answerStatus,
      questionNumber: number,
      sourceRange: input.site.sourceRange,
      diagnostics,
      draft: { ...draft, correctAnswer: input.answer },
      detectedAs: input.detectedAs ?? input.type,
    };
  }

  if (input.answerStatus === 'uncertain') {
    diagnostics.push({
      code: 'answer_key_ambiguous',
      message: `Question ${number}: the source offers more than one possible answer. Confirm it before publishing.`,
      questionNumber: number,
      sourceRange: input.site.sourceRange,
    });
  }

  return {
    question: parsed.data,
    // An uncertain key is not a finished question, however well it validates.
    status: input.answerStatus === 'uncertain' ? 'needs_review' : 'parsed',
    answerStatus: input.answerStatus,
    questionNumber: number,
    sourceRange: input.site.sourceRange,
    diagnostics,
  };
}

/** A question the parser recognised but will not attempt. */
export function unsupportedQuestion(
  number: number | undefined,
  sourceRange: SourceRange,
  construct: string,
  reason: string,
): ParsedQuestion {
  return {
    status: 'unsupported',
    answerStatus: 'missing',
    questionNumber: number,
    sourceRange,
    detectedAs: construct,
    diagnostics: [
      {
        code: 'unsupported_construct',
        message: `${construct}: ${reason}`,
        questionNumber: number,
        sourceRange,
      },
    ],
  };
}
