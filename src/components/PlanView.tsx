import React, { useMemo, useState } from 'react';
import { PlanTask, UserProfile, SkillType, MockAttempt } from '../types';
import { RecalculationResult } from '../utils/planEngine';
import {
  AlertCircle,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  Circle,
  Clock,
  RefreshCw,
  Sparkles,
  Zap,
} from 'lucide-react';
import { useT, useI18n } from '../i18n';
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

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function parseDueDate(value: string): number {
  const [year, month, day] = value.split('-').map(Number);
  return Number.isFinite(year) ? new Date(year, (month || 1) - 1, day || 1).getTime() : NaN;
}

interface PlanWeek {
  index: number;
  tasks: PlanTask[];
  done: number;
  isCurrent: boolean;
}

/**
 * Six weeks of tasks arrive as one flat list. Bucketing them into weeks from
 * the plan's own start date — rather than showing all twenty-four at once —
 * is the difference between a study plan and a wall.
 */
function groupIntoWeeks(tasks: PlanTask[]): PlanWeek[] {
  if (tasks.length === 0) return [];

  const dated = [...tasks].sort((a, b) => parseDueDate(a.dueDate) - parseDueDate(b.dueDate));
  const planStart = parseDueDate(dated[0].dueDate);
  const today = startOfDay(new Date());

  const buckets = new Map<number, PlanTask[]>();
  for (const task of dated) {
    const due = parseDueDate(task.dueDate);
    const weekIndex = Number.isFinite(due) ? Math.max(0, Math.floor((due - planStart) / (7 * DAY_MS))) : 0;
    const bucket = buckets.get(weekIndex);
    if (bucket) bucket.push(task);
    else buckets.set(weekIndex, [task]);
  }

  const currentWeekIndex = Math.max(0, Math.floor((today - planStart) / (7 * DAY_MS)));

  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, weekTasks]) => ({
      index,
      tasks: weekTasks,
      done: weekTasks.filter((task) => task.completed).length,
      isCurrent: index === currentWeekIndex,
    }));
}

export const PlanView: React.FC<PlanViewProps> = ({
  tasks,
  profile,
  onToggleTask,
  onStartTask,
  onRecalculatePlan,
  lastRecalc,
}) => {
  const t = useT();
  const { locale } = useI18n();
  const taskText = useTaskText();

  const completedCount = tasks.filter((task) => task.completed).length;
  const progress = tasks.length > 0 ? completedCount / tasks.length : 0;

  const weeks = useMemo(() => groupIntoWeeks(tasks), [tasks]);

  /** The nearest unfinished task — the one thing to do right now. */
  const nextTask = useMemo(
    () =>
      [...tasks]
        .filter((task) => !task.completed)
        .sort((a, b) => parseDueDate(a.dueDate) - parseDueDate(b.dueDate))[0],
    [tasks],
  );

  // Only the current week is open on arrival; the rest stay folded away.
  const [openWeeks, setOpenWeeks] = useState<Set<number> | null>(null);
  const effectiveOpenWeeks =
    openWeeks ?? new Set(weeks.filter((week) => week.isCurrent).map((week) => week.index));

  const toggleWeek = (index: number) => {
    const next = new Set(effectiveOpenWeeks);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    setOpenWeeks(next);
  };

  /** "Today", "Tomorrow", "Overdue", or a short date. */
  const describeDue = (task: PlanTask): { label: string; overdue: boolean } => {
    const due = parseDueDate(task.dueDate);
    if (!Number.isFinite(due)) return { label: task.dueDate, overdue: false };

    const days = Math.round((due - startOfDay(new Date())) / DAY_MS);
    if (task.completed) return { label: '', overdue: false };
    if (days < 0) return { label: t('plan.overdue'), overdue: true };
    if (days === 0) return { label: t('plan.today'), overdue: false };
    if (days === 1) return { label: t('plan.tomorrow'), overdue: false };

    return {
      label: new Date(due).toLocaleDateString(locale, { day: 'numeric', month: 'short' }),
      overdue: false,
    };
  };

  const renderTask = (task: PlanTask, index: number) => {
    const due = describeDue(task);

    return (
      <li
        key={task.id}
        className={cx(
          'es-card es-card-interactive es-enter p-4 sm:p-5',
          task.completed && 'bg-ink-50 shadow-none',
        )}
        style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
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

                {!task.completed && task.weight >= 4 && (
                  <Badge tone="danger">
                    <Zap className="h-3 w-3" />
                    {t('plan.highPriority')}
                  </Badge>
                )}

                <span className="inline-flex items-center gap-1 text-xs text-ink-400">
                  <Clock className="h-3 w-3" />
                  {t('common.minutes', { count: task.durationMins })}
                </span>

                {due.label && (
                  <span
                    className={cx(
                      'inline-flex items-center gap-1 text-xs tabular',
                      due.overdue ? 'font-semibold text-danger-700' : 'text-ink-400',
                    )}
                  >
                    <CalendarDays className="h-3 w-3" />
                    {due.label}
                  </span>
                )}
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
    );
  };

  return (
    <div className="space-y-6">
      {/* Roadmap banner — the one dark surface on this screen. */}
      <section className="es-ink-surface es-enter relative overflow-hidden rounded-[2rem] p-6 sm:p-9">
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
        <div className="es-enter flex items-start gap-3 rounded-[var(--radius-card)] border border-warning-500/25 bg-warning-50 p-4 text-sm text-warning-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            <span className="font-bold">{t('plan.updateNotice')}:</span>{' '}
            {taskText(lastRecalc.reasonKey, lastRecalc.reasonParams, lastRecalc.reason)}
          </p>
        </div>
      )}

      {tasks.length === 0 ? (
        <div className="es-card es-enter p-10 text-center">
          <h3 className="text-lg font-bold text-ink-900">{t('plan.emptyTitle')}</h3>
          <p className="mt-2 text-sm text-ink-500">{t('plan.emptyBody')}</p>
        </div>
      ) : (
        <>
          {/* One task, front and centre, so arriving never means choosing. */}
          <section className="es-enter" style={{ animationDelay: '60ms' }}>
            <p className="es-eyebrow mb-3">{t('plan.nextUp')}</p>

            {nextTask ? (
              <div className="es-card border-brand-200 bg-brand-50/40 p-5 sm:p-6">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={SKILL_TONE[nextTask.skill]}>
                        {t(`skills.${nextTask.skill}`)}
                      </Badge>
                      <span className="inline-flex items-center gap-1 text-xs text-ink-500">
                        <Clock className="h-3 w-3" />
                        {t('common.minutes', { count: nextTask.durationMins })}
                      </span>
                      {describeDue(nextTask).label && (
                        <span
                          className={cx(
                            'inline-flex items-center gap-1 text-xs tabular',
                            describeDue(nextTask).overdue
                              ? 'font-semibold text-danger-700'
                              : 'text-ink-500',
                          )}
                        >
                          <CalendarDays className="h-3 w-3" />
                          {describeDue(nextTask).label}
                        </span>
                      )}
                    </div>

                    <h2 className="mt-2.5 font-display text-lg font-bold text-ink-900">
                      {taskText(nextTask.titleKey, nextTask.titleParams, nextTask.title)}
                    </h2>
                    <p className="mt-1.5 text-sm leading-relaxed text-ink-600">
                      {taskText(nextTask.reasonKey, nextTask.reasonParams, nextTask.reason)}
                    </p>
                  </div>

                  <Button
                    size="lg"
                    onClick={() => onStartTask(nextTask)}
                    className="shrink-0 self-start sm:self-auto"
                  >
                    {t('plan.start')}
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ) : (
              <div className="es-card p-6 text-center">
                <h2 className="font-display text-lg font-bold text-ink-900">
                  {t('plan.nextUpEmpty')}
                </h2>
                <p className="mt-1.5 text-sm text-ink-500">{t('plan.nextUpEmptyBody')}</p>
              </div>
            )}
          </section>

          {/* The rest, folded by week. */}
          <section className="es-enter space-y-3" style={{ animationDelay: '120ms' }}>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-display-sm text-ink-900">{t('plan.tasksTitle')}</h2>
                <p className="mt-1 text-sm text-ink-500">{t('plan.tasksSubtitle')}</p>
              </div>
              <span className="text-sm font-semibold text-ink-400 tabular">
                {t('plan.totalTasks', { count: tasks.length })}
              </span>
            </div>

            {weeks.map((week) => {
              const isOpen = effectiveOpenWeeks.has(week.index);
              const complete = week.done === week.tasks.length;

              return (
                <div key={week.index} className="es-card overflow-hidden p-0">
                  <button
                    onClick={() => toggleWeek(week.index)}
                    aria-expanded={isOpen}
                    className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-ink-50"
                  >
                    <span className="flex flex-wrap items-center gap-2.5">
                      <span className="font-display text-base font-bold text-ink-900">
                        {t('plan.week', { number: week.index + 1 })}
                      </span>
                      {week.isCurrent && <Badge tone="brand">{t('plan.thisWeek')}</Badge>}
                      {complete && <Badge tone="success">{t('plan.allDone')}</Badge>}
                    </span>

                    <span className="flex shrink-0 items-center gap-3">
                      <span className="hidden w-24 sm:block">
                        <Progress value={week.done / week.tasks.length} />
                      </span>
                      <span className="font-mono text-xs tabular text-ink-400">
                        {t('plan.weekProgress', { done: week.done, total: week.tasks.length })}
                      </span>
                      <ChevronDown
                        className={cx(
                          'h-4 w-4 text-ink-400 transition-transform duration-300',
                          isOpen && 'rotate-180',
                        )}
                      />
                    </span>
                  </button>

                  {isOpen && (
                    <ul className="space-y-3 border-t border-ink-100 bg-ink-50/50 p-4">
                      {week.tasks.map(renderTask)}
                    </ul>
                  )}
                </div>
              );
            })}
          </section>
        </>
      )}
    </div>
  );
};
