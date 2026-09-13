import React from 'react';
import { RefreshCw } from 'lucide-react';
import type { LearnerGradingView } from '../../types/examSession';
import { useT } from '../../i18n';
import { Button, cx } from '../ui';

interface GradingStatusProps {
  id: string;
  /** The work, as the learner knows it: "Writing Task 1", "Speaking Part 2". */
  label: string;
  grading: LearnerGradingView;
  onRetry: () => void;
}

/**
 * Where one submitted Writing task's or Speaking part's grading stands, in the
 * learner's terms. It says the work is kept whatever grading did, and never shows
 * a band: marks arrive with the result once the exam is over.
 */
export const GradingStatus: React.FC<GradingStatusProps> = ({ id, label, grading, onRetry }) => {
  const t = useT();
  const waiting = grading.status === 'pending' || grading.status === 'grading';
  const message = waiting
    ? t('grading.exam.inProgress', { item: label })
    : grading.status === 'graded'
      ? t('grading.exam.done', { item: label })
      : t('grading.exam.failed', { item: label, reason: t(`grading.exam.reason.${grading.reason ?? 'failed'}`) });

  return (
    <div
      id={id}
      data-grading-status={grading.status}
      data-retryable={String(grading.retryable)}
      className={cx(
        'flex flex-col gap-2 rounded-[var(--radius-control)] border p-3 text-sm sm:flex-row sm:items-center sm:justify-between',
        grading.status === 'failed' ? 'border-warning-500/25 bg-warning-50 text-warning-700' : 'border-ink-200 bg-ink-50 text-ink-700',
      )}
    >
      <span className="flex items-center gap-2 font-semibold">
        {waiting && <RefreshCw className="h-4 w-4 shrink-0 animate-spin" />}
        {message}
      </span>
      {grading.status === 'failed' &&
        (grading.retryable ? (
          <Button id={`${id}-retry`} size="sm" variant="secondary" onClick={onRetry}>
            {t('grading.exam.retry')}
          </Button>
        ) : (
          <span className="text-xs">{t('grading.exam.final')}</span>
        ))}
    </div>
  );
};
