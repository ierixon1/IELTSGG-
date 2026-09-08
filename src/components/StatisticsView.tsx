import React from 'react';
import { UserProfile, MockAttempt, PlanTask, ChecklistWeek, SkillType } from '../types';
import { AlertCircle, BarChart3, ShieldCheck } from 'lucide-react';
import { useT } from '../i18n';
import { Badge, Button, Card, Progress, cx } from './ui';

interface StatisticsViewProps {
  profile: UserProfile;
  attempts: MockAttempt[];
  tasks: PlanTask[];
  checklist: ChecklistWeek;
  onOpenExamMode: () => void;
}

const SKILL_ORDER: SkillType[] = ['listening', 'reading', 'writing', 'speaking'];

const SKILL_ACCENT: Record<SkillType, string> = {
  listening: 'text-listening-ink',
  reading: 'text-reading-ink',
  writing: 'text-writing-ink',
  speaking: 'text-speaking-ink',
};

/** Averages the graded attempts for one skill, or `null` when there are none. */
function averageBand(attempts: MockAttempt[], skill: SkillType): number | null {
  const bands = attempts
    .map((attempt) => attempt.scores[skill]?.band)
    .filter((band): band is number => typeof band === 'number');

  if (bands.length === 0) return null;
  return bands.reduce((sum, band) => sum + band, 0) / bands.length;
}

function ratio(done: number, target: number): number {
  if (target <= 0) return 0;
  return Math.min(1, done / target);
}

export const StatisticsView: React.FC<StatisticsViewProps> = ({
  profile,
  attempts,
  tasks,
  checklist,
  onOpenExamMode,
}) => {
  const t = useT();

  const completedTasks = tasks.filter((task) => task.completed).length;
  const taskProgress = ratio(completedTasks, tasks.length);

  /**
   * Bands fall back to the self-reported starting level until a real graded
   * attempt exists — and the screen says so, rather than presenting a guess as
   * a measurement.
   */
  const measured = SKILL_ORDER.map((skill) => ({
    skill,
    band: averageBand(attempts, skill),
  }));

  const hasGradedAttempt = measured.some((entry) => entry.band !== null);

  const bands = measured.map((entry) => ({
    skill: entry.skill,
    band: entry.band ?? profile.currentLevel,
    isMeasured: entry.band !== null,
  }));

  const bottleneck = [...bands].sort((a, b) => a.band - b.band)[0];
  const targetGap = Math.max(0, profile.targetBand - bottleneck.band);

  const mockProgress = ratio(checklist.mocksDone || 0, checklist.mocksTarget || 2);
  const essayProgress = ratio(checklist.essaysDone || 0, checklist.essaysTarget || 4);
  const speakingProgress = ratio(checklist.speakingDone || 0, checklist.speakingTarget || 5);

  const readiness = Math.round(
    (mockProgress * 0.3 + essayProgress * 0.3 + speakingProgress * 0.2 + taskProgress * 0.2) * 100,
  );

  const milestones = [
    {
      label: t('stats.fullMocks'),
      done: checklist.mocksDone || 0,
      total: checklist.mocksTarget || 2,
      value: mockProgress,
    },
    {
      label: t('stats.essays'),
      done: checklist.essaysDone || 0,
      total: checklist.essaysTarget || 4,
      value: essayProgress,
    },
    {
      label: t('stats.recordings'),
      done: checklist.speakingDone || 0,
      total: checklist.speakingTarget || 5,
      value: speakingProgress,
    },
    {
      label: t('stats.roadmapTasks'),
      done: completedTasks,
      total: tasks.length,
      value: taskProgress,
    },
  ];

  return (
    <div className="space-y-6">
      <Card className="es-enter flex flex-col justify-between gap-6 p-6 sm:p-8 md:flex-row md:items-center">
        <div className="max-w-xl">
          <Badge tone="neutral">
            <BarChart3 className="h-3 w-3" />
            {t('stats.eyebrow')}
          </Badge>
          <h1 className="mt-3.5 text-display-sm text-ink-900">{t('stats.title')}</h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-500">{t('stats.subtitle')}</p>
        </div>

        <div className="es-ink-surface flex shrink-0 items-center gap-4 rounded-[var(--radius-card)] px-5 py-4">
          <span className="flex h-14 w-14 items-center justify-center rounded-[var(--radius-control)] bg-brand-500 font-mono text-lg font-bold tabular text-white">
            {readiness}%
          </span>
          <div>
            <p className="text-[0.625rem] font-bold uppercase tracking-[0.12em] text-white/50">
              {t('stats.readiness')}
            </p>
            <p className="mt-0.5 text-sm font-bold text-white">
              {readiness >= 80 ? t('stats.readyState') : t('stats.prepState')}
            </p>
          </div>
        </div>
      </Card>

      <div className="flex flex-col justify-between gap-4 rounded-[var(--radius-card)] border border-warning-500/25 bg-warning-50 p-5 sm:flex-row sm:items-center">
        <div className="flex items-start gap-3">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-warning-700" />
          <div>
            <h3 className="text-xs font-bold uppercase tracking-[0.1em] text-warning-700">
              {t('stats.bottleneckTitle')}
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-warning-700">
              {t('stats.bottleneckBody', {
                skill: t(`skills.${bottleneck.skill}`),
                band: bottleneck.band.toFixed(1),
                gap: targetGap.toFixed(1),
                target: profile.targetBand.toFixed(1),
              })}
            </p>
          </div>
        </div>

        <Button variant="secondary" size="sm" onClick={onOpenExamMode} className="shrink-0">
          {t('stats.runMock')}
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {bands.map((entry, index) => (
          <Card
            key={entry.skill}
            className="es-enter p-5"
            style={{ animationDelay: `${index * 70}ms` }}
          >
            <p className="text-[0.6875rem] font-bold uppercase tracking-[0.1em] text-ink-400">
              {t(`skills.${entry.skill}`)}
            </p>
            <p
              className={cx(
                'mt-2 font-mono text-display-md font-bold tabular',
                entry.isMeasured ? SKILL_ACCENT[entry.skill] : 'text-ink-300',
              )}
            >
              {entry.band.toFixed(1)}
            </p>
            <p className="mt-1 text-xs text-ink-400 tabular">
              {t('stats.targetLabel', { band: profile.targetBand.toFixed(1) })}
            </p>
          </Card>
        ))}
      </div>

      {!hasGradedAttempt && <p className="text-xs text-ink-400">{t('stats.noData')}</p>}

      <Card className="p-6 sm:p-8">
        <div className="flex items-start justify-between gap-4 border-b border-ink-100 pb-5">
          <div>
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-success-500" />
              <h2 className="font-display text-lg font-bold text-ink-900">
                {t('stats.checklistTitle')}
              </h2>
            </div>
            <p className="mt-1 text-sm text-ink-500">{t('stats.checklistSubtitle')}</p>
          </div>
          <span className="shrink-0 text-xs font-semibold text-ink-400">
            {t('stats.week', { number: checklist.weekNumber })}
          </span>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {milestones.map((milestone) => (
            <div key={milestone.label} className="rounded-[var(--radius-control)] bg-ink-50 p-4">
              <div className="mb-2.5 flex items-center justify-between text-sm font-semibold text-ink-800">
                <span>{milestone.label}</span>
                <span className="font-mono text-xs tabular text-ink-500">
                  {t('stats.ratio', { done: milestone.done, total: milestone.total })}
                </span>
              </div>
              <Progress value={milestone.value} />
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
};
