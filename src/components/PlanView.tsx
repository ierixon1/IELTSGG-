import React from 'react';
import { PlanTask, UserProfile, SkillType, MockAttempt } from '../types';
import { RecalculationResult } from '../utils/planEngine';
import {
  AlertCircle,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  Circle,
  Clock,
  RefreshCw,
  Sparkles,
  Zap,
} from 'lucide-react';
import { useT } from '../i18n';
import { Badge, BadgeTone, Button, Progress, cx } from './ui';

interface PlanViewProps {
  tasks: PlanTask[];
  profile: UserProfile;
  attempts: MockAttempt[];
  onToggleTask: (taskId: string) => void;
  onStartTask: (task: PlanTask) => void;
  onRecalculatePlan: () => void;
  lastRecalc?: RecalculationResult;
}

/**
 * Plans generated before task text was translatable carry only `title` and
 * `reason`; newer ones carry a key plus parameters. Prefer the key, fall back
 * to the stored sentence.
 */
function useTaskText(): (
  key: string | undefined,
  params: Record<string, string | number> | undefined,
  fallback: string,
) => string {
  const t = useT();
  return (key, params, fallback) => {
    if (!key) return fallback;
    const resolvedParams = params
      ? Object.fromEntries(
          Object.entries(params).map(([name, value]) => [
            name,
            // Skill names are themselves translated.
            name === 'skill' || name === 'first' || name === 'second'
              ? t(`skills.${value}`)
              : value,
          ]),
        )
      : undefined;

    const text = t(key, resolvedParams);
    return text === key ? fallback : text;
  };
}

/** Each IELTS module carries its own tint/ink pair from the design tokens. */
const SKILL_TONE: Record<SkillType, BadgeTone> = {
  listening: 'listening',
  reading: 'reading',
  writing: 'writing',
  speaking: 'speaking',
};

export const PlanView: React.FC<PlanViewProps> = ({
  tasks,
  profile,
  onToggleTask,
  onStartTask,
  onRecalculatePlan,
  lastRecalc,
}) => {
  const t = useT();
  const taskText = useTaskText();
  const completedCount = tasks.filter((task) => task.completed).length;
  const progress = tasks.length > 0 ? completedCount / tasks.length : 0;

  return (
    <div className="space-y-6">
      {/* Roadmap banner — the one dark surface on this screen. */}
      <section className="es-ink-surface relative overflow-hidden rounded-[2rem] p-6 sm:p-9">
        <div className="relative flex flex-col gap-8 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-xl">
            <Badge tone="brand" className="bg-white/10 text-brand-100">
              <Sparkles className="h-3 w-3" />
              {t('plan.eyebrow')}
            </Badge>

            <h1 className="mt-4 text-display-sm text-white sm:text-display-md">
              {t('plan.title', { band: profile.targetBand.toFixed(1) })}
            </h1>

            <p className="mt-3 text-sm leading-relaxed text-ink-300">
              {t('plan.subtitle', { skill: t(`skills.${profile.weakSection}`) })}
            </p>
          </div>

          <dl className="es-glass grid shrink-0 grid-cols-3 gap-6 rounded-[var(--radius-card)] px-6 py-5">
            <div>
              <dt className="text-[0.625rem] font-bold uppercase tracking-[0.12em] text-white/50">
                {t('plan.starting')}
              </dt>
              <dd className="mt-1 font-mono text-xl font-bold tabular text-white">
                {profile.currentLevel.toFixed(1)}
              </dd>
            </div>
            <div>
              <dt className="text-[0.625rem] font-bold uppercase tracking-[0.12em] text-white/50">
                {t('plan.target')}
              </dt>
              <dd className="mt-1 font-mono text-xl font-bold tabular text-brand-200">
                {profile.targetBand.toFixed(1)}
              </dd>
            </div>
            <div>
              <dt className="text-[0.625rem] font-bold uppercase tracking-[0.12em] text-white/50">
                {t('plan.weekly')}
              </dt>
              <dd className="mt-1 font-mono text-xl font-bold tabular text-white">
                {t('plan.hours', { count: profile.hoursPerWeek })}
              </dd>
            </div>
          </dl>
        </div>

        <div className="mt-8 flex flex-col gap-4 border-t border-white/10 pt-6 sm:flex-row sm:items-end sm:justify-between">
          <div className="w-full max-w-md">
            <div className="mb-2 flex items-center justify-between text-xs font-medium text-white/70">
              <span>{t('plan.completion')}</span>
              <span className="tabular">
                {t('plan.tasksProgress', { done: completedCount, total: tasks.length })}
              </span>
            </div>
            <Progress value={progress} tone="light" />
          </div>

          <Button
            id="btn-recalculate-plan"
            variant="ghost"
            size="sm"
            onClick={onRecalculatePlan}
            className="shrink-0 border border-white/15 text-white/85 hover:bg-white/10 hover:text-white"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t('plan.recalculate')}
          </Button>
        </div>
      </section>

      {lastRecalc && (
        <div className="flex items-start gap-3 rounded-[var(--radius-card)] border border-warning-500/25 bg-warning-50 p-4 text-sm text-warning-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            <span className="font-bold">{t('plan.updateNotice')}:</span>{' '}
            {taskText(lastRecalc.reasonKey, lastRecalc.reasonParams, lastRecalc.reason)}
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-display-sm text-ink-900">{t('plan.tasksTitle')}</h2>
          <p className="mt-1 text-sm text-ink-500">{t('plan.tasksSubtitle')}</p>
        </div>
        <span className="text-sm font-semibold text-ink-400 tabular">
          {t('plan.totalTasks', { count: tasks.length })}
        </span>
      </div>

      {tasks.length === 0 ? (
        <div className="es-card p-10 text-center">
          <h3 className="text-lg font-bold text-ink-900">{t('plan.emptyTitle')}</h3>
          <p className="mt-2 text-sm text-ink-500">{t('plan.emptyBody')}</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {tasks.map((task) => (
            <li
              key={task.id}
              className={cx(
                'es-card es-card-interactive p-5',
                task.completed && 'bg-ink-50 shadow-none',
              )}
            >
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-1 items-start gap-3.5">
                  <button
                    id={`check-task-${task.id}`}
                    onClick={() => onToggleTask(task.id)}
                    className="mt-0.5 shrink-0 text-ink-300 transition-colors hover:text-ink-500"
                    aria-pressed={task.completed}
                  >
                    {task.completed ? (
                      <CheckCircle2 className="h-5 w-5 text-success-500" />
                    ) : (
                      <Circle className="h-5 w-5" />
                    )}
                  </button>

                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={SKILL_TONE[task.skill]}>{t(`skills.${task.skill}`)}</Badge>

                      {task.weight >= 4 && (
                        <Badge tone="danger">
                          <Zap className="h-3 w-3" />
                          {t('plan.highPriority')}
                        </Badge>
                      )}

                      <span className="inline-flex items-center gap-1 text-xs text-ink-400">
                        <Clock className="h-3 w-3" />
                        {t('common.minutes', { count: task.durationMins })}
                      </span>

                      <span className="inline-flex items-center gap-1 text-xs text-ink-400 tabular">
                        <CalendarDays className="h-3 w-3" />
                        {t('plan.due', { date: task.dueDate })}
                      </span>
                    </div>

                    <h3
                      className={cx(
                        'font-display text-base font-bold',
                        task.completed ? 'text-ink-400 line-through' : 'text-ink-900',
                      )}
                    >
                      {taskText(task.titleKey, task.titleParams, task.title)}
                    </h3>

                    <p className="text-sm leading-relaxed text-ink-500">
                      {taskText(task.reasonKey, task.reasonParams, task.reason)}
                    </p>
                  </div>
                </div>

                <Button
                  id={`btn-start-task-${task.id}`}
                  variant={task.completed ? 'secondary' : 'primary'}
                  size="sm"
                  onClick={() => onStartTask(task)}
                  className="shrink-0 self-start sm:self-auto"
                >
                  {task.completed ? t('plan.review') : t('plan.start')}
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
