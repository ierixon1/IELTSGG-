import React from 'react';
import { UserProfile, MockAttempt, PlanTask, ChecklistWeek, SkillType } from '../types';
import { 
  BarChart3, 
  TrendingUp, 
  CheckCircle2, 
  AlertCircle, 
  ShieldCheck, 
  Target,
  Award,
  Sparkles,
  Calendar,
  Flame
} from 'lucide-react';

interface StatisticsViewProps {
  profile: UserProfile;
  attempts: MockAttempt[];
  tasks: PlanTask[];
  checklist: ChecklistWeek;
  onOpenExamMode: () => void;
}

export const StatisticsView: React.FC<StatisticsViewProps> = ({
  profile,
  attempts,
  tasks,
  checklist,
  onOpenExamMode,
}) => {
  // Compute metrics
  const completedTasks = tasks.filter((t) => t.completed).length;
  const totalTasks = tasks.length || 1;
  const taskCompletionPct = Math.round((completedTasks / totalTasks) * 100);

  // Compute skill averages from attempts
  const skillAvgs: Record<SkillType, number> = {
    listening: 0,
    reading: 0,
    writing: 0,
    speaking: 0,
  };
  const skillCounts: Record<SkillType, number> = {
    listening: 0,
    reading: 0,
    writing: 0,
    speaking: 0,
  };

  attempts.forEach((att) => {
    if (att.scores.listening) {
      skillAvgs.listening += att.scores.listening.band;
      skillCounts.listening += 1;
    }
    if (att.scores.reading) {
      skillAvgs.reading += att.scores.reading.band;
      skillCounts.reading += 1;
    }
    if (att.scores.writing) {
      skillAvgs.writing += att.scores.writing.band;
      skillCounts.writing += 1;
    }
    if (att.scores.speaking) {
      skillAvgs.speaking += att.scores.speaking.band;
      skillCounts.speaking += 1;
    }
  });

  const listeningBand = skillCounts.listening > 0 ? (skillAvgs.listening / skillCounts.listening).toFixed(1) : profile.currentLevel.toFixed(1);
  const readingBand = skillCounts.reading > 0 ? (skillAvgs.reading / skillCounts.reading).toFixed(1) : profile.currentLevel.toFixed(1);
  const writingBand = skillCounts.writing > 0 ? (skillAvgs.writing / skillCounts.writing).toFixed(1) : (profile.currentLevel - 0.5).toFixed(1);
  const speakingBand = skillCounts.speaking > 0 ? (skillAvgs.speaking / skillCounts.speaking).toFixed(1) : profile.currentLevel.toFixed(1);

  // Find lowest skill
  const skillScores: { skill: SkillType; score: number }[] = [
    { skill: 'listening', score: parseFloat(listeningBand) },
    { skill: 'reading', score: parseFloat(readingBand) },
    { skill: 'writing', score: parseFloat(writingBand) },
    { skill: 'speaking', score: parseFloat(speakingBand) },
  ];
  skillScores.sort((a, b) => a.score - b.score);
  const lowestSkill = skillScores[0];
  const targetGap = (profile.targetBand - lowestSkill.score).toFixed(1);

  // Readiness Score calculation
  const mockProgress = Math.min(100, Math.round(((attempts.length || 0) / (checklist.mocksTarget || 2)) * 100));
  const essayProgress = Math.min(100, Math.round(((checklist.essaysDone || 0) / (checklist.essaysTarget || 4)) * 100));
  const speakingProgress = Math.min(100, Math.round(((checklist.speakingDone || 0) / (checklist.speakingTarget || 5)) * 100));
  const overallReadiness = Math.min(100, Math.round((mockProgress * 0.3 + essayProgress * 0.3 + speakingProgress * 0.2 + taskCompletionPct * 0.2)));

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="bg-white p-6 sm:p-8 rounded-3xl border border-slate-200 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div className="space-y-1">
          <div className="inline-flex items-center space-x-1.5 px-3 py-1 rounded-full bg-slate-100 text-slate-700 text-xs font-semibold">
            <BarChart3 className="w-3.5 h-3.5 text-slate-500" />
            <span>Preparation Diagnostics & Readiness Index</span>
          </div>
          <h1 className="text-2xl font-extrabold text-slate-900">Personal Performance Analytics</h1>
          <p className="text-xs text-slate-500 max-w-xl">
            Real-time tracking against Cambridge/IDP standards with automated bottleneck diagnosis.
          </p>
        </div>

        {/* Readiness Pill */}
        <div className="bg-slate-900 text-white p-5 rounded-2xl flex items-center space-x-4 shrink-0 shadow-md">
          <div className="w-12 h-12 rounded-xl bg-emerald-500 text-slate-950 flex items-center justify-center font-black text-lg">
            {overallReadiness}%
          </div>
          <div>
            <div className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider">
              Exam Readiness Index
            </div>
            <div className="text-xs font-bold text-white mt-0.5">
              {overallReadiness >= 80 ? 'Ready for Target Band' : 'In Preparation Phase'}
            </div>
          </div>
        </div>
      </div>

      {/* Bottleneck Diagnostic Banner */}
      <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-start space-x-3">
          <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <h3 className="text-xs font-bold text-amber-900 uppercase tracking-wider">
              Diagnostic Bottleneck Insight
            </h3>
            <p className="text-xs text-amber-800 leading-relaxed">
              Your primary bottleneck is currently{' '}
              <strong className="text-amber-950 uppercase">{lowestSkill.skill}</strong> (Band {lowestSkill.score.toFixed(1)}),
              which is <strong>{targetGap} bands below your target of {profile.targetBand.toFixed(1)}</strong>.
              The adaptive roadmap has concentrated priority drills onto this skill.
            </p>
          </div>
        </div>

        <button
          onClick={onOpenExamMode}
          className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-xl text-xs font-bold shrink-0 shadow-sm"
        >
          Run Full Mock Test
        </button>
      </div>

      {/* Section Band Comparisons */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: 'Listening', current: listeningBand, color: 'text-emerald-600', bg: 'bg-emerald-50 border-emerald-200' },
          { label: 'Reading', current: readingBand, color: 'text-blue-600', bg: 'bg-blue-50 border-blue-200' },
          { label: 'Writing', current: writingBand, color: 'text-amber-600', bg: 'bg-amber-50 border-amber-200' },
          { label: 'Speaking', current: speakingBand, color: 'text-rose-600', bg: 'bg-rose-50 border-rose-200' },
        ].map((sec) => (
          <div key={sec.label} className={`p-5 rounded-2xl border ${sec.bg} space-y-2`}>
            <div className="text-xs font-bold text-slate-600 uppercase tracking-wider">{sec.label}</div>
            <div className="flex items-baseline space-x-2">
              <span className={`text-3xl font-black ${sec.color}`}>Band {sec.current}</span>
            </div>
            <div className="text-[11px] text-slate-500">
              Target: <span className="font-bold text-slate-800">Band {profile.targetBand.toFixed(1)}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Preparation Checklist */}
      <div className="bg-white p-6 sm:p-8 rounded-3xl border border-slate-200 shadow-sm space-y-6">
        <div className="flex items-center justify-between pb-4 border-b border-slate-100">
          <div className="space-y-1">
            <div className="flex items-center space-x-2">
              <ShieldCheck className="w-5 h-5 text-emerald-600" />
              <h2 className="text-base font-bold text-slate-900">Exam Success Milestone Checklist</h2>
            </div>
            <p className="text-xs text-slate-500">
              GoPrep-inspired benchmark criteria to guarantee target band achievement.
            </p>
          </div>
          <span className="text-xs font-semibold text-slate-400">Week #{checklist.weekNumber}</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Mocks Completed */}
          <div className="p-4 rounded-xl border border-slate-100 bg-slate-50 space-y-2">
            <div className="flex justify-between text-xs font-semibold text-slate-800">
              <span>Full Mock Simulations</span>
              <span>
                {checklist.mocksDone} / {checklist.mocksTarget} completed
              </span>
            </div>
            <div className="w-full h-2 bg-slate-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-slate-900 rounded-full"
                style={{ width: `${mockProgress}%` }}
              />
            </div>
          </div>

          {/* Essays Written */}
          <div className="p-4 rounded-xl border border-slate-100 bg-slate-50 space-y-2">
            <div className="flex justify-between text-xs font-semibold text-slate-800">
              <span>Academic Essays AI-Evaluated</span>
              <span>
                {checklist.essaysDone} / {checklist.essaysTarget} submitted
              </span>
            </div>
            <div className="w-full h-2 bg-slate-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-amber-500 rounded-full"
                style={{ width: `${essayProgress}%` }}
              />
            </div>
          </div>

          {/* Speaking Sessions */}
          <div className="p-4 rounded-xl border border-slate-100 bg-slate-50 space-y-2">
            <div className="flex justify-between text-xs font-semibold text-slate-800">
              <span>Speaking Recordings Assessed</span>
              <span>
                {checklist.speakingDone} / {checklist.speakingTarget} recorded
              </span>
            </div>
            <div className="w-full h-2 bg-slate-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-rose-500 rounded-full"
                style={{ width: `${speakingProgress}%` }}
              />
            </div>
          </div>

          {/* Tasks Done */}
          <div className="p-4 rounded-xl border border-slate-100 bg-slate-50 space-y-2">
            <div className="flex justify-between text-xs font-semibold text-slate-800">
              <span>Adaptive Roadmap Tasks</span>
              <span>
                {completedTasks} / {totalTasks} executed
              </span>
            </div>
            <div className="w-full h-2 bg-slate-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-emerald-500 rounded-full"
                style={{ width: `${taskCompletionPct}%` }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
