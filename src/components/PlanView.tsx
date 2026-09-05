import React from 'react';
import { 
  PlanTask, 
  UserProfile, 
  SkillType, 
  MockAttempt 
} from '../types';
import { 
  CheckCircle2, 
  Circle, 
  ArrowRight, 
  Sparkles, 
  Clock, 
  AlertCircle,
  RefreshCw,
  Zap,
  BookOpen,
  CalendarDays
} from 'lucide-react';

interface PlanViewProps {
  tasks: PlanTask[];
  profile: UserProfile;
  attempts: MockAttempt[];
  onToggleTask: (taskId: string) => void;
  onStartTask: (task: PlanTask) => void;
  onRecalculatePlan: () => void;
  lastRecalcReason?: string;
}

export const PlanView: React.FC<PlanViewProps> = ({
  tasks,
  profile,
  attempts,
  onToggleTask,
  onStartTask,
  onRecalculatePlan,
  lastRecalcReason,
}) => {
  const completedCount = tasks.filter((t) => t.completed).length;
  const progressPercent = tasks.length > 0 ? Math.round((completedCount / tasks.length) * 100) : 0;

  const getSkillColor = (skill: SkillType) => {
    switch (skill) {
      case 'writing':
        return 'bg-amber-100 text-amber-800 border-amber-200';
      case 'speaking':
        return 'bg-rose-100 text-rose-800 border-rose-200';
      case 'reading':
        return 'bg-blue-100 text-blue-800 border-blue-200';
      case 'listening':
        return 'bg-emerald-100 text-emerald-800 border-emerald-200';
    }
  };

  return (
    <div className="space-y-6">
      {/* Target & Metric Banner */}
      <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-indigo-950 text-white rounded-3xl p-6 sm:p-8 shadow-xl relative overflow-hidden">
        <div className="absolute right-0 top-0 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none" />

        <div className="relative z-10 flex flex-col md:flex-row md:items-center md:justify-between gap-6">
          <div className="space-y-2 max-w-xl">
            <div className="inline-flex items-center space-x-2 px-3 py-1 rounded-full bg-indigo-500/20 text-indigo-300 text-xs font-semibold">
              <Sparkles className="w-3.5 h-3.5" />
              <span>Adaptive IELTS Preparation Strategy</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
              Target: Band {profile.targetBand.toFixed(1)} Academic
            </h1>
            <p className="text-slate-300 text-sm leading-relaxed">
              Your personalized roadmap focuses intensely on your critical bottleneck (
              <span className="text-amber-400 font-semibold uppercase">{profile.weakSection}</span>
              ) while maintaining exam readiness across all four modules.
            </p>
          </div>

          {/* Quick Metrics */}
          <div className="grid grid-cols-3 gap-3 bg-white/5 backdrop-blur-md p-4 rounded-2xl border border-white/10 shrink-0">
            <div className="text-center">
              <div className="text-xs text-slate-400 font-medium">Starting</div>
              <div className="text-lg font-bold text-white mt-0.5">Band {profile.currentLevel.toFixed(1)}</div>
            </div>
            <div className="text-center border-x border-white/10 px-3">
              <div className="text-xs text-slate-400 font-medium">Target</div>
              <div className="text-lg font-bold text-emerald-400 mt-0.5">Band {profile.targetBand.toFixed(1)}</div>
            </div>
            <div className="text-center">
              <div className="text-xs text-slate-400 font-medium">Weekly Study</div>
              <div className="text-lg font-bold text-indigo-300 mt-0.5">{profile.hoursPerWeek}h</div>
            </div>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="mt-8 pt-6 border-t border-white/10 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex-1 max-w-md">
            <div className="flex justify-between text-xs text-slate-300 mb-1.5 font-medium">
              <span>Overall Roadmap Completion</span>
              <span>{completedCount} / {tasks.length} tasks ({progressPercent}%)</span>
            </div>
            <div className="w-full h-2.5 bg-white/10 rounded-full overflow-hidden">
              <div
                className="h-full bg-emerald-500 rounded-full transition-all duration-500"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>

          <button
            id="btn-recalculate-plan"
            onClick={onRecalculatePlan}
            className="inline-flex items-center space-x-2 px-4 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-semibold transition-all border border-white/15 cursor-pointer shrink-0"
            title="Recalculate tasks based on your latest mock test scores"
          >
            <RefreshCw className="w-3.5 h-3.5 text-indigo-300" />
            <span>Recalculate With Recent Tests</span>
          </button>
        </div>
      </div>

      {/* Recalculation Notice if trigger occurred */}
      {lastRecalcReason && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-start space-x-3 text-xs text-amber-900">
          <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <span className="font-bold">Dynamic Plan Update:</span> {lastRecalcReason}
          </div>
        </div>
      )}

      {/* Tasks List Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-slate-900">Assigned Diagnostic & Practice Tasks</h2>
          <p className="text-xs text-slate-500">
            Click any task to jump directly into the focused mock or interactive drill.
          </p>
        </div>
        <div className="text-xs font-semibold text-slate-500">
          Total: {tasks.length} tasks
        </div>
      </div>

      {/* Tasks Grid */}
      <div className="space-y-3">
        {tasks.map((task) => (
          <div
            key={task.id}
            className={`p-4 sm:p-5 rounded-2xl border transition-all ${
              task.completed
                ? 'bg-slate-50/70 border-slate-200 opacity-75'
                : 'bg-white border-slate-200 hover:border-slate-300 shadow-sm'
            }`}
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-start space-x-3 flex-1">
                {/* Completion Checkbox */}
                <button
                  id={`check-task-${task.id}`}
                  onClick={() => onToggleTask(task.id)}
                  className="mt-0.5 text-slate-400 hover:text-slate-600 transition-colors shrink-0"
                >
                  {task.completed ? (
                    <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                  ) : (
                    <Circle className="w-5 h-5" />
                  )}
                </button>

                <div className="space-y-1.5 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-md border ${getSkillColor(
                        task.skill
                      )}`}
                    >
                      {task.skill}
                    </span>

                    {task.weight >= 4 && (
                      <span className="inline-flex items-center space-x-1 text-[10px] font-bold px-2 py-0.5 rounded-md bg-rose-50 text-rose-700 border border-rose-200">
                        <Zap className="w-3 h-3 text-rose-500" />
                        <span>High Priority Focus</span>
                      </span>
                    )}

                    <span className="text-[10px] text-slate-400 flex items-center space-x-1">
                      <Clock className="w-3 h-3" />
                      <span>{task.durationMins} mins</span>
                    </span>

                    <span className="text-[10px] text-slate-400 flex items-center space-x-1">
                      <CalendarDays className="w-3 h-3" />
                      <span>Due: {task.dueDate}</span>
                    </span>
                  </div>

                  <h3
                    className={`text-sm font-bold ${
                      task.completed ? 'line-through text-slate-500' : 'text-slate-900'
                    }`}
                  >
                    {task.title}
                  </h3>

                  <p className="text-xs text-slate-500 leading-relaxed">{task.reason}</p>
                </div>
              </div>

              {/* Action Button */}
              <div className="flex items-center justify-end sm:shrink-0">
                <button
                  id={`btn-start-task-${task.id}`}
                  onClick={() => onStartTask(task)}
                  className="inline-flex items-center space-x-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-slate-900 hover:bg-slate-800 text-white transition-all shadow-sm"
                >
                  <span>{task.completed ? 'Review / Retake' : 'Start Task'}</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
