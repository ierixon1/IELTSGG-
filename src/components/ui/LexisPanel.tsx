import React from 'react';
import { LexisMetrics, levelOf, MetricLevel } from '../../utils/textMetrics';
import { useT } from '../../i18n';
import { cx } from './index';

interface LexisPanelProps {
  metrics: LexisMetrics;
  /** Grammar issues the examiner flagged, when the screen has them. */
  flaggedIssues?: number;
  className?: string;
}

const LEVEL_CLASS: Record<MetricLevel, string> = {
  low: 'text-danger-700 bg-danger-50',
  mid: 'text-warning-700 bg-warning-50',
  high: 'text-success-700 bg-success-50',
};

const Metric: React.FC<{
  label: string;
  value: string;
  level: MetricLevel;
  note: string;
}> = ({ label, value, level, note }) => (
  <div className="flex flex-col gap-1.5">
    <p className="text-[0.625rem] font-bold uppercase tracking-[0.1em] text-ink-400">{label}</p>
    <div className="flex items-baseline gap-2">
      <span className="font-mono text-xl font-bold tabular text-ink-900">{value}</span>
      <span
        className={cx(
          'rounded px-1.5 py-0.5 text-[0.625rem] font-bold uppercase tracking-[0.06em]',
          LEVEL_CLASS[level],
        )}
      >
        {note}
      </span>
    </div>
  </div>
);

/**
 * Measurements taken from the candidate's own words rather than asked of the
 * model. They sit beside the band, never inside it: the four criteria are the
 * examiner's judgement, these are arithmetic.
 */
export const LexisPanel: React.FC<LexisPanelProps> = ({ metrics, flaggedIssues, className }) => {
  const t = useT();

  if (metrics.totalWords === 0) return null;

  const complexityLevel = levelOf(metrics.complexity, 0.08, 0.16, true);
  const repetitionLevel = levelOf(metrics.repetition, 0.06, 0.14, false);

  return (
    <section
      className={cx(
        'rounded-[var(--radius-card)] border border-ink-100 bg-ink-50 p-5',
        className,
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-display text-sm font-bold text-ink-900">{t('lexis.title')}</h3>
        <p className="text-xs text-ink-400">{t('lexis.note')}</p>
      </div>

      <div className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label={t('lexis.complexity')}
          value={`${Math.round(metrics.complexity * 100)}%`}
          level={complexityLevel}
          note={t(`lexis.level.${complexityLevel}`)}
        />
        <Metric
          label={t('lexis.repetition')}
          value={`${Math.round(metrics.repetition * 100)}%`}
          level={repetitionLevel}
          note={t(`lexis.level.${repetitionLevel}`)}
        />
        <div className="flex flex-col gap-1.5">
          <p className="text-[0.625rem] font-bold uppercase tracking-[0.1em] text-ink-400">
            {t('lexis.variety')}
          </p>
          <span className="font-mono text-xl font-bold tabular text-ink-900">
            {metrics.uniqueWords}
            <span className="text-sm font-medium text-ink-400"> / {metrics.totalWords}</span>
          </span>
        </div>
        {flaggedIssues !== undefined && (
          <div className="flex flex-col gap-1.5">
            <p className="text-[0.625rem] font-bold uppercase tracking-[0.1em] text-ink-400">
              {t('lexis.flagged')}
            </p>
            <span className="font-mono text-xl font-bold tabular text-ink-900">
              {flaggedIssues}
            </span>
          </div>
        )}
      </div>

      {metrics.topRepeated.length > 0 && (
        <div className="mt-5 border-t border-ink-200 pt-4">
          <p className="text-[0.625rem] font-bold uppercase tracking-[0.1em] text-ink-400">
            {t('lexis.leaningOn')}
          </p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {metrics.topRepeated.map((entry) => (
              <li
                key={entry.word}
                className="inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] border border-ink-200 bg-white px-2.5 py-1 text-xs"
              >
                <span className="font-medium text-ink-700">{entry.word}</span>
                <span className="font-mono text-[0.6875rem] tabular text-ink-400">
                  ×{entry.count}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
};
