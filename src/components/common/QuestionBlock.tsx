import React from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { AnswerValue, QuestionBody, QuestionLayout } from '../../types';
import { QuestionField, QuestionInstruction, QuestionMedia } from './QuestionField';
import { cx } from '../ui';

/**
 * Questions rendered together, the way the paper prints them.
 *
 * Every task used to render as its own numbered card with a control underneath,
 * so a table completion arrived as a flat list of text boxes and a note
 * completion lost the shape that tells the learner what they are filling in.
 * `layout` and `group` on the canonical question carry that structure; this is
 * what reads them.
 *
 * Grouping never changes numbering, ids or answers: a block is a presentation
 * decision, and each question inside it is still answered and marked on its own.
 */

export interface QuestionGroup {
  /** The group key, or the question id when a question stands alone. */
  key: string;
  layout: QuestionLayout;
  questions: QuestionBody[];
}

const layoutOf = (question: QuestionBody): QuestionLayout => question.layout ?? 'standalone';

/**
 * Splits a list into the blocks it should render as.
 *
 * Only *consecutive* questions sharing a group key join up: a group key reused
 * further down the paper is a different block, and merging them would reorder
 * the paper. A question with no group is its own block.
 */
export function groupQuestions(questions: QuestionBody[]): QuestionGroup[] {
  const groups: QuestionGroup[] = [];

  for (const question of questions) {
    const previous = groups[groups.length - 1];
    const key = question.group;

    if (key && previous && previous.key === key && previous.layout === layoutOf(question)) {
      previous.questions.push(question);
      continue;
    }

    groups.push({ key: key || question.id, layout: layoutOf(question), questions: [question] });
  }

  return groups;
}

/** Layouts that render as one composite block rather than separate cards. */
const COMPOSITE_LAYOUTS: QuestionLayout[] = ['table_row', 'note_line', 'form_row', 'summary_gap', 'inline_gap'];

export const isCompositeLayout = (layout: QuestionLayout) => COMPOSITE_LAYOUTS.includes(layout);

interface QuestionBlockProps {
  group: QuestionGroup;
  answers: Record<string, AnswerValue>;
  disabled: boolean;
  onChange: (questionId: string, value: AnswerValue) => void;
  groupName: string;
  /** After submission, whether each question was answered correctly. */
  results?: Record<string, boolean>;
  /** Rendered under a question once the paper has been submitted. */
  renderFeedback?: (question: QuestionBody, isCorrect: boolean) => React.ReactNode;
}

const Marker: React.FC<{ number: number; state?: boolean }> = ({ number, state }) => (
  <span
    className={cx(
      'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold tabular',
      state === undefined
        ? 'bg-ink-100 text-ink-700'
        : state
          ? 'bg-success-50 text-success-700'
          : 'bg-danger-50 text-danger-700',
    )}
  >
    {number}
  </span>
);

const Verdict: React.FC<{ correct: boolean }> = ({ correct }) =>
  correct ? (
    <CheckCircle2 className="h-4 w-4 shrink-0 text-success-500" />
  ) : (
    <XCircle className="h-4 w-4 shrink-0 text-danger-500" />
  );

/**
 * Renders one block.
 *
 * A table becomes a real table with a row per gap; notes and form rows become
 * a labelled list with the control beside the label; a summary or inline gap
 * puts the control in the flow of its own sentence. Anything else keeps the
 * standalone card, which is what most tasks want.
 */
export const QuestionBlock: React.FC<QuestionBlockProps> = ({
  group,
  answers,
  disabled,
  onChange,
  groupName,
  results,
  renderFeedback,
}) => {
  const { layout, questions } = group;
  // The rubric is authored on the first question of a group.
  const instruction = questions.find((question) => question.instruction)?.instruction;
  const media = questions.find((question) => question.mediaRef)?.mediaRef;

  const field = (question: QuestionBody) => (
    <QuestionField
      question={question}
      value={answers[question.id] ?? ''}
      disabled={disabled}
      onChange={(value) => onChange(question.id, value)}
      groupName={groupName}
    />
  );

  const feedback = (question: QuestionBody) => {
    if (!results || !renderFeedback) return null;
    return renderFeedback(question, results[question.id] === true);
  };

  if (layout === 'table_row') {
    return (
      <section className="space-y-3">
        {instruction && <QuestionInstruction text={instruction} />}
        {media && <QuestionMedia media={media} label={questions[0]?.prompt} />}
        <div className="overflow-x-auto rounded-[var(--radius-control)] border border-ink-200">
          <table className="w-full border-collapse text-sm">
            <tbody>
              {questions.map((question) => (
                <tr key={question.id} className="border-b border-ink-100 last:border-b-0">
                  <td className="w-10 px-3 py-2.5 align-top">
                    <Marker number={question.questionNumber} state={results?.[question.id]} />
                  </td>
                  <th
                    scope="row"
                    className="px-3 py-2.5 text-left align-top font-medium text-ink-800"
                  >
                    {question.prompt}
                  </th>
                  <td className="px-3 py-2.5 align-top">
                    {field(question)}
                    {feedback(question)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    );
  }

  if (layout === 'note_line' || layout === 'form_row') {
    return (
      <section className="space-y-3">
        {instruction && <QuestionInstruction text={instruction} />}
        {media && <QuestionMedia media={media} label={questions[0]?.prompt} />}
        <dl className="space-y-2.5 rounded-[var(--radius-control)] border border-ink-200 bg-ink-50/40 p-4">
          {questions.map((question) => (
            <div
              key={question.id}
              className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-4"
            >
              <dt className="flex min-w-0 flex-1 items-start gap-2.5 text-sm text-ink-800">
                <Marker number={question.questionNumber} state={results?.[question.id]} />
                <span className="pt-0.5">{question.prompt}</span>
              </dt>
              <dd className="sm:w-64 sm:shrink-0">
                {field(question)}
                {feedback(question)}
              </dd>
            </div>
          ))}
        </dl>
      </section>
    );
  }

  if (layout === 'summary_gap' || layout === 'inline_gap') {
    return (
      <section className="space-y-3">
        {instruction && <QuestionInstruction text={instruction} />}
        {media && <QuestionMedia media={media} label={questions[0]?.prompt} />}
        <div className="rounded-[var(--radius-control)] border border-ink-200 bg-white p-4 text-sm leading-loose text-ink-800">
          {questions.map((question) => (
            <span key={question.id} className="mr-1 inline-flex flex-wrap items-baseline gap-2">
              <Marker number={question.questionNumber} state={results?.[question.id]} />
              <span>{question.prompt}</span>
              <span className="inline-block w-44 align-baseline">{field(question)}</span>
              {feedback(question)}
            </span>
          ))}
        </div>
      </section>
    );
  }

  // Standalone: one card per question, which is what most tasks want.
  return (
    <>
      {questions.map((question) => {
        const state = results?.[question.id];
        return (
          <React.Fragment key={question.id}>
            {question.instruction && <QuestionInstruction text={question.instruction} />}
            <div
              className={cx(
                'rounded-xl border p-4 transition-all',
                state === undefined
                  ? 'border-ink-200 bg-white'
                  : state
                    ? 'border-success-500 bg-success-50/40'
                    : 'border-danger-500 bg-danger-50/40',
              )}
            >
              <div className="flex items-start gap-3">
                <Marker number={question.questionNumber} state={state} />
                <div className="min-w-0 flex-1 space-y-2.5">
                  <p className="text-sm font-semibold text-ink-900">{question.prompt}</p>
                  {question.mediaRef && (
                    <QuestionMedia media={question.mediaRef} label={question.prompt} />
                  )}
                  {field(question)}
                  {feedback(question)}
                </div>
              </div>
            </div>
          </React.Fragment>
        );
      })}
    </>
  );
};

/**
 * The standard correct/incorrect line, shared by both session screens. It shows
 * the feedback the server returned after submission; the screen holds no key of
 * its own to show.
 */
export const AnswerVerdict: React.FC<{
  feedback: { explanation?: string };
  correct: boolean;
  correctLabel: string;
  incorrectLabel: string;
}> = ({ feedback, correct, correctLabel, incorrectLabel }) => (
  <div className="mt-2 space-y-1 border-t border-ink-200/60 pt-2 text-xs">
    <div className="flex items-center gap-1.5 font-bold">
      <Verdict correct={correct} />
      <span className={correct ? 'text-success-700' : 'text-danger-700'}>
        {correct ? correctLabel : incorrectLabel}
      </span>
    </div>
    {feedback.explanation && (
      <p className="leading-relaxed text-ink-600">{feedback.explanation}</p>
    )}
  </div>
);
