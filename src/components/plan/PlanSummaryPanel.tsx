import React from 'react';
import { RefreshCw, Sparkles, Target } from 'lucide-react';
import { SkillType, UserProfile } from '../../types';
import { useT } from '../../i18n';
import { Badge, Button, Progress } from '../ui';

interface PlanSummaryPanelProps {
  profile: UserProfile;
  completedCount: number;
  totalCount: number;
  /** 0–1. */
  progress: number;
  onRecalculatePlan: () => void;
  /**
   * The weakness the last recalculation diagnosed from graded attempts. Falls
   * back to the profile's own value, which is the learner's self-assessment
   * from onboarding.
   */
  diagnosedWeakSkill?: SkillType;
}

/**
 * The plan's standing summary and its one control.
 *
 * This used to be a full-width banner above the task list. As a sidebar it has
 * to work at 320px, so the three figures stack rather than sitting in a
 * three-column row, and the panel owns no state of its own: every value is
 * derived from `tasks` and `profile` by the caller, which is why moving it
 * carried no risk of duplicating summary logic.
 */
export const PlanSummaryPanel: React.FC<PlanSummaryPanelProps> = ({
  profile,
  completedCount,
  totalCount,
  progress,
  onRecalculatePlan,
  diagnosedWeakSkill,
}) => {
  const t = useT();
  const focusSkill = diagnosedWeakSkill || profile.weakSection;

  const figures: Array<{ label: string; value: string; accent?: boolean }> = [
    { label: t('plan.starting'), value: profile.currentLevel.toFixed(1) },
    { label: t('plan.target'), value: profile.targetBand.toFixed(1), accent: true },
    { label: t('plan.weekly'), value: t('plan.hours', { count: profile.hoursPerWeek }) },
  ];

  return (
    <section className="es-ink-surface es-enter relative overflow-hidden rounded-[1.5rem] p-5 sm:rounded-[2rem] sm:p-6">
      {/* The eyebrow is a full sentence in some languages, so it has to be able
          to wrap rather than setting the panel's minimum width. */}
      <Badge tone="brand" className="max-w-full items-start whitespace-normal bg-white/10 text-left text-brand-100">
        <Sparkles className="mt-[0.15rem] h-3 w-3 shrink-0" />
        {t('plan.eyebrow')}
      </Badge>

      <h1 className="mt-4 text-display-sm text-white">
        {t('plan.title', { band: profile.targetBand.toFixed(1) })}
      </h1>

      <p className="mt-2.5 text-sm leading-relaxed text-ink-300">
        {t('plan.subtitle', { skill: t(`skills.${focusSkill}`) })}
      </p>

      {/* One column on a phone, three across a tablet, and back to one in the
          sidebar. A fixed three-column grid cannot shrink below the min-content
          width of its longest label, which is what pushed the whole panel past
          a 320px viewport. */}
      <dl className="es-glass mt-6 grid grid-cols-1 gap-3 rounded-[var(--radius-card)] px-4 py-4 sm:grid-cols-3 sm:gap-4 lg:grid-cols-1 lg:gap-3">
        {figures.map((figure) => (
          <div
            key={figure.label}
            className="flex min-w-0 items-baseline justify-between gap-3 sm:block lg:flex"
          >
            <dt className="min-w-0 text-[0.625rem] font-bold uppercase tracking-[0.12em] text-white/50">
              {figure.label}
            </dt>
            <dd
              className={`shrink-0 font-mono text-xl font-bold tabular sm:mt-1 lg:mt-0 ${
                figure.accent ? 'text-brand-200' : 'text-white'
              }`}
            >
              {figure.value}
            </dd>
          </div>
        ))}
      </dl>

      <div className="mt-6 border-t border-white/10 pt-5">
        <div className="mb-2 flex items-center justify-between gap-3 text-xs font-medium text-white/70">
          <span>{t('plan.completion')}</span>
          <span className="shrink-0 tabular">
            {t('plan.tasksProgress', { done: completedCount, total: totalCount })}
          </span>
        </div>
        <Progress value={progress} tone="light" />
      </div>

      <p className="mt-5 flex items-start gap-2 text-xs leading-relaxed text-white/65">
        <Target className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-200" />
        <span>
          {t('plan.currentFocus')}:{' '}
          <span className="font-semibold text-white">{t(`skills.${focusSkill}`)}</span>
          {diagnosedWeakSkill ? ` · ${t('plan.focusFromResults')}` : ` · ${t('plan.focusSelfAssessed')}`}
        </span>
      </p>

      <Button
        id="btn-recalculate-plan"
        variant="ghost"
        size="sm"
        fullWidth
        wrap
        onClick={onRecalculatePlan}
        className="mt-5 border border-white/15 text-white/85 hover:bg-white/10 hover:text-white"
      >
        <RefreshCw className="h-3.5 w-3.5" />
        {t('plan.recalculate')}
      </Button>
    </section>
  );
};
