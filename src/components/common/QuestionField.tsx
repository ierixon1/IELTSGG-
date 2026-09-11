import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { AnswerValue, MediaRef, QuestionBody, QuestionType } from '../../types';
import { learnerAssetUrl } from '../../utils/assetUrl';
import { optionValue } from '../../utils/answerMatching';
import { cx } from '../ui';

/** The control a task type is answered with. */
export type QuestionControl = 'radio' | 'checkbox' | 'bank' | 'text';

/**
 * Which control each canonical task type gets.
 *
 * Every type in the schema appears here. A type that does not is rendered as an
 * explicit "not supported" state rather than as a text box — silently turning
 * an unknown task into a gap fill is what used to hide a whole family of broken
 * questions.
 */
export const QUESTION_CONTROLS: Record<QuestionType, QuestionControl> = {
  multiple_choice: 'radio',
  multi_select: 'checkbox',
  true_false_not_given: 'radio',
  yes_no_not_given: 'radio',
  matching: 'bank',
  matching_headings: 'bank',
  matching_information: 'bank',
  matching_features: 'bank',
  matching_sentence_endings: 'bank',
  fill_in_blank: 'text',
  sentence_completion: 'text',
  summary_completion: 'text',
  note_completion: 'text',
  table_completion: 'text',
  form_completion: 'text',
  short_answer: 'text',
  diagram_label: 'text',
  map_label: 'text',
};

/** The control this question needs, or `null` when it cannot be rendered. */
export function controlFor(question: QuestionBody): QuestionControl | null {
  const control = QUESTION_CONTROLS[question.type];
  if (!control) return null;
  // A choice with nothing to choose from cannot be rendered as a choice. The
  // schema refuses to store one, so this only catches material that reached the
  // player without passing through it.
  if (control !== 'text' && !question.options?.length) return null;
  return control;
}

/** Reads a stored answer as the list a multi-select works with. */
export function asAnswerList(value: AnswerValue | undefined): string[] {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

/**
 * Adds or removes one option from a multi-select answer, keeping the printed
 * order so a stored answer reads the way the paper does.
 */
export function toggleAnswer(
  value: AnswerValue | undefined,
  option: string,
  options: string[],
): string[] {
  const current = asAnswerList(value);
  const next = current.includes(option)
    ? current.filter((entry) => entry !== option)
    : [...current, option];
  const order = options.map(optionValue);
  return next.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/** The image or audio a question cannot be answered without. */
export const QuestionMedia: React.FC<{ media: MediaRef; label?: string }> = ({ media, label }) => {
  // Built from the asset id, never a path baked into content: the learner route
  // checks that a published material actually references it before serving.
  const source = learnerAssetUrl(media.assetId);

  if (media.kind === 'audio') {
    return (
      <audio
        controls
        src={source}
        className="w-full max-w-md"
        aria-label={media.alt || label || 'Question audio'}
      />
    );
  }

  return (
    <figure className="my-2">
      <img
        src={source}
        alt={media.alt || label || 'Question diagram'}
        loading="lazy"
        className="max-h-96 w-full rounded-[var(--radius-control)] border border-ink-200 bg-white object-contain"
      />
      {media.alt && (
        <figcaption className="mt-1 text-[0.6875rem] text-ink-400">{media.alt}</figcaption>
      )}
    </figure>
  );
};

interface QuestionFieldProps {
  question: QuestionBody;
  value: AnswerValue;
  disabled: boolean;
  onChange: (value: AnswerValue) => void;
  /** Radio and checkbox groups need a name unique to the section they sit in. */
  groupName: string;
}

/**
 * Renders the answer control the paper would print for this task type.
 *
 * Computer-delivered IELTS uses four controls: radio buttons for a single
 * choice, checkboxes for a multiple answer, a dropdown for anything answered
 * from a lettered bank, and a text box carrying its word limit. Keeping that
 * mapping in one table is what stops a matching-headings task from degrading
 * into a blank text field — and what makes an unsupported type visible rather
 * than disguised as something else.
 */
export const QuestionField: React.FC<QuestionFieldProps> = ({
  question,
  value,
  disabled,
  onChange,
  groupName,
}) => {
  const control = controlFor(question);
  const options = question.options ?? [];

  if (control === null) {
    return (
      <div
        role="status"
        data-unsupported-question={String(question.type)}
        className="flex items-start gap-2 rounded-[var(--radius-control)] border border-dashed border-warning-500/50 bg-warning-50 p-3 text-xs text-warning-700"
      >
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          <strong>This question type is not supported yet.</strong> It needs review before it can be
          answered — nothing has been substituted for it.
        </span>
      </div>
    );
  }

  if (control === 'bank') {
    const selected = asAnswerList(value)[0] ?? '';
    return (
      <select
        value={selected}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        aria-label={question.prompt}
        className="w-full max-w-md rounded-[var(--radius-control)] border border-ink-200 bg-white px-3 py-2.5 text-sm text-ink-900 outline-none focus:border-brand-400 disabled:bg-ink-50"
      >
        <option value="">—</option>
        {options.map((option, index) => (
          <option key={index} value={optionValue(option)}>
            {option}
          </option>
        ))}
      </select>
    );
  }

  if (control === 'radio' || control === 'checkbox') {
    const chosen = asAnswerList(value);
    const isMulti = control === 'checkbox';
    // An exam question carries the count and no key; a practice question carries the key.
    const expectedCount =
      question.answerCount ??
      ('correctAnswer' in question && Array.isArray(question.correctAnswer) ? question.correctAnswer.length : undefined);

    return (
      <div
        className="space-y-2"
        role={isMulti ? 'group' : 'radiogroup'}
        aria-label={question.prompt}
      >
        {isMulti && (
          <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.06em] text-ink-400">
            {expectedCount ? `Choose ${expectedCount}` : 'Choose all that apply'}
          </p>
        )}
        {options.map((option, index) => {
          const stored = optionValue(option);
          const checked = chosen.includes(stored);
          return (
            <label
              key={index}
              className={cx(
                'flex cursor-pointer items-start gap-2.5 rounded-[var(--radius-control)] border p-2.5 text-sm transition-all',
                checked
                  ? 'border-brand-500 bg-brand-50/60 font-semibold text-ink-900'
                  : 'border-ink-200 text-ink-700 hover:bg-ink-50',
                disabled && 'cursor-default opacity-80',
              )}
            >
              <input
                type={isMulti ? 'checkbox' : 'radio'}
                name={`${groupName}-${question.id}`}
                value={stored}
                checked={checked}
                onChange={() => onChange(isMulti ? toggleAnswer(value, stored, options) : stored)}
                disabled={disabled}
                className="mt-0.5 accent-[var(--color-brand-500)]"
              />
              <span>{option}</span>
            </label>
          );
        })}
      </div>
    );
  }

  const typed = asAnswerList(value)[0] ?? '';
  return (
    <div className="space-y-1.5">
      <input
        type="text"
        value={typed}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        aria-label={question.prompt}
        className="w-full max-w-md rounded-[var(--radius-control)] border border-ink-200 px-3 py-2.5 text-sm text-ink-900 outline-none focus:border-brand-400 disabled:bg-ink-50"
      />
      {question.wordLimit && (
        <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.06em] text-ink-400">
          {question.wordLimit}
        </p>
      )}
    </div>
  );
};

/** The rubric that introduces a group of questions, as printed on the paper. */
export const QuestionInstruction: React.FC<{ text: string }> = ({ text }) => (
  <p className="whitespace-pre-line rounded-[var(--radius-control)] border-l-4 border-brand-300 bg-brand-50/50 px-4 py-3 text-sm leading-relaxed text-ink-700">
    {text}
  </p>
);
