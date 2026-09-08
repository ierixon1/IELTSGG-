import React from 'react';
import { BANK_ANSWER_TYPES, Question } from '../../types';
import { cx } from '../ui';

interface QuestionFieldProps {
  question: Question;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  /** Radio groups need a name unique to the section they sit in. */
  groupName: string;
}

/**
 * Renders the answer control the paper would print for this task type.
 *
 * Computer-delivered IELTS uses three controls and no more: radio buttons for
 * a choice, a dropdown for anything answered from a lettered bank, and a text
 * box carrying its word limit. Keeping that mapping in one place is what stops
 * a matching-headings task from silently degrading into a blank text field.
 */
export const QuestionField: React.FC<QuestionFieldProps> = ({
  question,
  value,
  disabled,
  onChange,
  groupName,
}) => {
  const fromBank = BANK_ANSWER_TYPES.includes(question.type) && question.options?.length;

  if (fromBank) {
    return (
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        aria-label={question.prompt}
        className="w-full max-w-md rounded-[var(--radius-control)] border border-ink-200 bg-white px-3 py-2.5 text-sm text-ink-900 outline-none focus:border-brand-400 disabled:bg-ink-50"
      >
        <option value="">—</option>
        {question.options!.map((option, index) => (
          <option key={index} value={option.split(/[.)]\s/)[0] || option}>
            {option}
          </option>
        ))}
      </select>
    );
  }

  if (question.options?.length) {
    return (
      <div className="space-y-2">
        {question.options.map((option, index) => (
          <label
            key={index}
            className={cx(
              'flex cursor-pointer items-center gap-2.5 rounded-[var(--radius-control)] border p-2.5 text-sm transition-all',
              value === option
                ? 'border-brand-500 bg-brand-50/60 font-semibold text-ink-900'
                : 'border-ink-200 text-ink-700 hover:bg-ink-50',
              disabled && 'cursor-default opacity-80',
            )}
          >
            <input
              type="radio"
              name={`${groupName}-${question.id}`}
              value={option}
              checked={value === option}
              onChange={(event) => onChange(event.target.value)}
              disabled={disabled}
              className="accent-[var(--color-brand-500)]"
            />
            <span>{option}</span>
          </label>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <input
        type="text"
        value={value}
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
