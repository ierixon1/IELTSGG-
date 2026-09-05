import React, { useState } from 'react';
import { UserProfile, SkillType } from '../types';
import { Target, Calendar, Clock, AlertTriangle, ArrowRight, CheckCircle2 } from 'lucide-react';

interface OnboardingModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialProfile: UserProfile;
  onSave: (updatedProfile: UserProfile) => void;
}

export const OnboardingModal: React.FC<OnboardingModalProps> = ({
  isOpen,
  onClose,
  initialProfile,
  onSave,
}) => {
  const [currentLevel, setCurrentLevel] = useState<number>(initialProfile.currentLevel || 6.0);
  const [targetBand, setTargetBand] = useState<number>(initialProfile.targetBand || 7.5);
  const [examDate, setExamDate] = useState<string>(initialProfile.examDate || '');
  const [hoursPerWeek, setHoursPerWeek] = useState<number>(initialProfile.hoursPerWeek || 12);
  const [weakSection, setWeakSection] = useState<SkillType>(initialProfile.weakSection || 'writing');

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      ...initialProfile,
      currentLevel,
      targetBand,
      examDate: examDate || undefined,
      hoursPerWeek,
      weakSection,
      isOnboarded: true,
    });
    onClose();
  };

  const bandOptions = [5.5, 6.0, 6.5, 7.0, 7.5, 8.0, 8.5, 9.0];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm overflow-y-auto">
      <div className="bg-white rounded-2xl max-w-lg w-full p-6 sm:p-8 shadow-2xl border border-slate-100 my-8">
        <div className="flex items-center space-x-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold">
            <Target className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-slate-900">Personal IELTS Study Plan Setup</h2>
            <p className="text-xs text-slate-500">
              Calibrate your diagnostic baseline to generate an adaptive weekly study roadmap.
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Target & Current Level */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Current Level
              </label>
              <select
                id="select-current-level"
                value={currentLevel}
                onChange={(e) => setCurrentLevel(parseFloat(e.target.value))}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-800 bg-white focus:outline-none focus:ring-2 focus:ring-slate-900"
              >
                {bandOptions.map((band) => (
                  <option key={`curr-${band}`} value={band}>
                    Band {band.toFixed(1)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Target Band
              </label>
              <select
                id="select-target-band"
                value={targetBand}
                onChange={(e) => setTargetBand(parseFloat(e.target.value))}
                className="w-full rounded-lg border border-emerald-300 bg-emerald-50/50 px-3 py-2 text-sm font-bold text-emerald-900 focus:outline-none focus:ring-2 focus:ring-emerald-600"
              >
                {bandOptions.map((band) => (
                  <option key={`target-${band}`} value={band}>
                    Band {band.toFixed(1)} {band >= 7.5 ? '★' : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Weak Section */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-2">
              Primary Focus / Weakest Section
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {[
                { id: 'writing', label: 'Writing', desc: 'Task 1 & 2' },
                { id: 'speaking', label: 'Speaking', desc: 'Fluency & Pron' },
                { id: 'reading', label: 'Reading', desc: 'Timing & Headings' },
                { id: 'listening', label: 'Listening', desc: 'Multi-accents' },
              ].map((item) => (
                <button
                  type="button"
                  key={item.id}
                  id={`btn-select-weak-${item.id}`}
                  onClick={() => setWeakSection(item.id as SkillType)}
                  className={`p-3 rounded-xl text-left border transition-all ${
                    weakSection === item.id
                      ? 'border-indigo-600 bg-indigo-50/60 ring-1 ring-indigo-600'
                      : 'border-slate-200 hover:border-slate-300 bg-white'
                  }`}
                >
                  <div className="text-xs font-bold text-slate-900">{item.label}</div>
                  <div className="text-[10px] text-slate-500">{item.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Exam Date & Study Hours */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5 flex items-center space-x-1">
                <Calendar className="w-3.5 h-3.5 text-slate-400" />
                <span>Exam Date (Optional)</span>
              </label>
              <input
                id="input-exam-date"
                type="date"
                value={examDate}
                onChange={(e) => setExamDate(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-900"
              />
              <span className="text-[10px] text-slate-400 mt-1 block">
                Defaults to a rigorous 6-week schedule if blank.
              </span>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5 flex items-center space-x-1">
                <Clock className="w-3.5 h-3.5 text-slate-400" />
                <span>Available Hours / Week</span>
              </label>
              <div className="flex items-center space-x-2">
                <input
                  id="range-hours-per-week"
                  type="range"
                  min={4}
                  max={30}
                  step={2}
                  value={hoursPerWeek}
                  onChange={(e) => setHoursPerWeek(parseInt(e.target.value))}
                  className="flex-1 accent-slate-900"
                />
                <span className="text-xs font-bold text-slate-900 w-12 text-right">
                  {hoursPerWeek} hrs
                </span>
              </div>
              <span className="text-[10px] text-slate-400 mt-1 block">
                {hoursPerWeek < 8 ? 'Casual' : hoursPerWeek <= 16 ? 'Recommended' : 'Intensive'}
              </span>
            </div>
          </div>

          {/* Dynamic Recalculation Notice */}
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 flex items-start space-x-2.5 text-xs text-slate-600">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            <span>
              <strong>Dynamic Plan Rule:</strong> After each completed mock test, your plan will automatically recalculate. The section with your lowest score will automatically receive heavier weight and targeted remediation drills.
            </span>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end space-x-3 pt-2">
            {initialProfile.isOnboarded && (
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900"
              >
                Cancel
              </button>
            )}
            <button
              id="btn-submit-onboarding"
              type="submit"
              className="flex items-center space-x-2 px-5 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-semibold text-sm transition-all shadow-md"
            >
              <span>{initialProfile.isOnboarded ? 'Recalibrate Plan' : 'Generate My Adaptive Plan'}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
