import React, { useEffect, useState } from 'react';
import { UserProfile, SkillType } from '../types';
import { ArrowRight, Calendar, CheckCircle2, Clock, Target } from 'lucide-react';
import { useT } from '../i18n';
import { Button, cx } from './ui';

interface OnboardingModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialProfile: UserProfile;
  onSave: (updatedProfile: UserProfile) => void;
}

const BAND_OPTIONS = [5.5, 6.0, 6.5, 7.0, 7.5, 8.0, 8.5, 9.0];
const SKILLS: SkillType[] = ['writing', 'speaking', 'reading', 'listening'];

export const OnboardingModal: React.FC<OnboardingModalProps> = ({
  isOpen,
  onClose,
  initialProfile,
  onSave,
}) => {
  const t = useT();
  const [currentLevel, setCurrentLevel] = useState(initialProfile.currentLevel || 6.0);
  const [targetBand, setTargetBand] = useState(initialProfile.targetBand || 7.5);
  const [examDate, setExamDate] = useState(initialProfile.examDate || '');
  const [hoursPerWeek, setHoursPerWeek] = useState(initialProfile.hoursPerWeek || 12);
  const [weakSection, setWeakSection] = useState<SkillType>(initialProfile.weakSection || 'writing');

  // Escape closes the dialog, but only once the profile exists — a first-run
  // learner has nothing to go back to.
  useEffect(() => {
    if (!isOpen || !initialProfile.isOnboarded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, initialProfile.isOnboarded, onClose]);

  if (!isOpen) return null;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
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

  const pace =
    hoursPerWeek < 8 ? 'casual' : hoursPerWeek <= 16 ? 'recommended' : 'intensive';

  const fieldClass =
    'w-full rounded-[var(--radius-control)] border border-ink-200 bg-white px-3 py-2.5 text-sm font-semibold text-ink-800 outline-none focus:border-brand-400';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-ink-950/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
    >
      <div className="es-card my-8 w-full max-w-lg p-6 shadow-[var(--shadow-lg)] sm:p-8">
        <div className="mb-6 flex items-start gap-3.5">
          <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-brand-50 text-brand-600">
            <Target className="h-5 w-5" />
          </span>
          <div>
            <h2 id="onboarding-title" className="font-display text-xl font-bold text-ink-900">
              {t('onboarding.title')}
            </h2>
            <p className="mt-1 text-sm text-ink-500">{t('onboarding.subtitle')}</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="select-current-level"
                className="mb-1.5 block text-xs font-bold text-ink-700"
              >
                {t('onboarding.currentLevel')}
              </label>
              <select
                id="select-current-level"
                value={currentLevel}
                onChange={(event) => setCurrentLevel(parseFloat(event.target.value))}
                className={fieldClass}
              >
                {BAND_OPTIONS.map((band) => (
                  <option key={`curr-${band}`} value={band}>
                    {band.toFixed(1)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="select-target-band"
                className="mb-1.5 block text-xs font-bold text-ink-700"
              >
                {t('onboarding.targetBand')}
              </label>
              <select
                id="select-target-band"
                value={targetBand}
                onChange={(event) => setTargetBand(parseFloat(event.target.value))}
                className={cx(fieldClass, 'border-brand-300 bg-brand-50 text-brand-800')}
              >
                {BAND_OPTIONS.map((band) => (
                  <option key={`target-${band}`} value={band}>
                    {band.toFixed(1)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <span className="mb-2 block text-xs font-bold text-ink-700">
              {t('onboarding.focusLabel')}
            </span>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {SKILLS.map((skill) => (
                <button
                  type="button"
                  key={skill}
                  id={`btn-select-weak-${skill}`}
                  onClick={() => setWeakSection(skill)}
                  aria-pressed={weakSection === skill}
                  className={cx(
                    'rounded-[var(--radius-control)] border p-3 text-left transition-all',
                    weakSection === skill
                      ? 'border-brand-500 bg-brand-50'
                      : 'border-ink-200 bg-white hover:border-ink-300',
                  )}
                >
                  <span className="block text-xs font-bold text-ink-900">
                    {t(`skills.${skill}`)}
                  </span>
                  <span className="mt-0.5 block text-[0.6875rem] leading-tight text-ink-500">
                    {t(`onboarding.focus.${skill}`)}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="input-exam-date"
                className="mb-1.5 flex items-center gap-1.5 text-xs font-bold text-ink-700"
              >
                <Calendar className="h-3.5 w-3.5 text-ink-400" />
                {t('onboarding.examDate')}
              </label>
              <input
                id="input-exam-date"
                type="date"
                value={examDate}
                onChange={(event) => setExamDate(event.target.value)}
                className={fieldClass}
              />
              <span className="mt-1 block text-[0.6875rem] text-ink-400">
                {t('onboarding.examDateHint')}
              </span>
            </div>

            <div>
              <label
                htmlFor="range-hours-per-week"
                className="mb-1.5 flex items-center gap-1.5 text-xs font-bold text-ink-700"
              >
                <Clock className="h-3.5 w-3.5 text-ink-400" />
                {t('onboarding.hours')}
              </label>
              <div className="flex items-center gap-3">
                <input
                  id="range-hours-per-week"
                  type="range"
                  min={4}
                  max={30}
                  step={2}
                  value={hoursPerWeek}
                  onChange={(event) => setHoursPerWeek(parseInt(event.target.value, 10))}
                  className="flex-1 accent-[var(--color-brand-500)]"
                />
                <span className="w-14 text-right font-mono text-xs font-bold tabular text-ink-900">
                  {t('onboarding.hoursValue', { count: hoursPerWeek })}
                </span>
              </div>
              <span className="mt-1 block text-[0.6875rem] text-ink-400">
                {t(`onboarding.pace.${pace}`)}
              </span>
            </div>
          </div>

          <div className="flex items-start gap-2.5 rounded-[var(--radius-control)] bg-ink-50 p-3.5 text-sm text-ink-600">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success-500" />
            <span>{t('onboarding.rule')}</span>
          </div>

          <div className="flex items-center justify-end gap-3 pt-1">
            {initialProfile.isOnboarded && (
              <Button type="button" variant="ghost" onClick={onClose}>
                {t('common.cancel')}
              </Button>
            )}
            <Button id="btn-submit-onboarding" type="submit">
              {initialProfile.isOnboarded ? t('onboarding.resubmit') : t('onboarding.submit')}
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
};
