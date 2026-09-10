import React, { useEffect, useState } from 'react';
import { MockTest, SkillType, MockAttempt } from '../types';
import { calculateOverallBand } from '../utils/ieltsScoring';
import { ListeningSession } from './ListeningSession';
import { ReadingSession } from './ReadingSession';
import { WritingSession } from './WritingSession';
import { SpeakingSession } from './SpeakingSession';
import { AlertTriangle, Award, ShieldAlert } from 'lucide-react';
import confetti from 'canvas-confetti';
import { SittableTest, sectionAvailable } from '../services/publishedTests';
import { SectionUnavailable } from './common/SectionUnavailable';
import { useT } from '../i18n';
import { Badge, Button, Card, cx } from './ui';

interface ExamModeProps {
  mockTest: SittableTest;
  onCompleteExam: (attempt: MockAttempt) => void;
  onExitExam: () => void;
}

type SectionScores = Partial<Record<SkillType, number>>;

const SECTIONS: SkillType[] = ['listening', 'reading', 'writing', 'speaking'];

export const ExamMode: React.FC<ExamModeProps> = ({ mockTest, onCompleteExam, onExitExam }) => {
  const t = useT();
  const [currentSectionIndex, setCurrentSectionIndex] = useState(0);
  const [finalScores, setFinalScores] = useState<SectionScores | null>(null);
  const [focusLossCount, setFocusLossCount] = useState(0);
  const [showFocusWarning, setShowFocusWarning] = useState(false);
  const [scores, setScores] = useState<SectionScores>({});

  /**
   * Which of the four papers this test cannot supply.
   *
   * A full mock is scored as a whole, so a missing paper is not something to
   * work around: it would either be substituted — which is what this phase
   * removed — or silently skipped, leaving an overall band computed from three
   * sections and presented as four.
   */
  const unavailable = SECTIONS.filter((skill) => !sectionAvailable(mockTest, skill));
  const { listening, reading, speaking } = mockTest;
  const { task1, task2 } = mockTest.writing;

  if (unavailable.length > 0 || !listening || !reading || !speaking || !(task1 || task2)) {
    return (
      <div id="exam-configuration-error" className="space-y-3">
        {(unavailable.length > 0 ? unavailable : SECTIONS).map((skill) => (
          <SectionUnavailable
            key={skill}
            skill={skill}
            testTitle={mockTest.title}
            testId={mockTest.id}
            onBack={onExitExam}
            backLabel={t('exam.backToPlan')}
          />
        ))}
      </div>
    );
  }

  const activeSection = SECTIONS[currentSectionIndex];
  const isFinished = finalScores !== null;

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden && !isFinished) {
        setFocusLossCount((count) => count + 1);
        setShowFocusWarning(true);
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [isFinished]);

  /**
   * Builds the report from the scores passed in rather than from state: the
   * final section is recorded and the exam finishes in the same tick, so
   * reading `scores` here would drop the section just sat.
   */
  const finishExam = (completedScores: SectionScores) => {
    setFinalScores(completedScores);

    const overall = calculateOverallBand(completedScores);

    const attempt: MockAttempt = {
      id: `attempt-${Date.now()}`,
      testId: mockTest.id,
      date: new Date().toISOString().split('T')[0],
      isFullMock: true,
      scores: {
        overall,
        // Only sections that were actually sat carry a band, and the raw score
        // is left to the section that computed it.
        listening: completedScores.listening ? { band: completedScores.listening } : undefined,
        reading: completedScores.reading ? { band: completedScores.reading } : undefined,
        writing: completedScores.writing ? { band: completedScores.writing } : undefined,
        speaking: completedScores.speaking ? { band: completedScores.speaking } : undefined,
      },
      durationMinutes: 165,
    };

    onCompleteExam(attempt);

    if (overall >= 7.0) {
      confetti({ particleCount: 120, spread: 80, origin: { y: 0.5 } });
    }
  };

  const handleRecordSectionScore = (band: number) => {
    const nextScores: SectionScores = { ...scores, [activeSection]: band };
    setScores(nextScores);

    if (currentSectionIndex < SECTIONS.length - 1) {
      setCurrentSectionIndex((index) => index + 1);
    } else {
      finishExam(nextScores);
    }
  };

  if (isFinished) {
    const overallScore = calculateOverallBand(finalScores);

    return (
      <div className="mx-auto max-w-3xl">
        <Card className="space-y-6 p-8 text-center">
          <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-success-50 text-success-700">
            <Award className="h-8 w-8" />
          </span>

          <div>
            <Badge tone="success">{t('exam.doneEyebrow')}</Badge>
            <h1 className="mt-3 text-display-sm text-ink-900">{t('exam.doneTitle')}</h1>
            <p className="mt-1.5 text-sm text-ink-500">{t('exam.doneSubtitle')}</p>
          </div>

          <div className="es-ink-surface mx-auto max-w-sm space-y-1.5 rounded-[var(--radius-card)] p-6">
            <p className="text-[0.625rem] font-bold uppercase tracking-[0.12em] text-white/50">
              {t('exam.overall')}
            </p>
            <p className="font-mono text-display-lg font-bold tabular text-white">
              {overallScore.toFixed(1)}
            </p>
            <p className="text-xs text-white/45">{t('exam.roundingNote')}</p>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {SECTIONS.map((section) => {
              const band = finalScores[section];
              return (
                <div
                  key={section}
                  className="rounded-[var(--radius-control)] border border-ink-100 bg-ink-50 p-4"
                >
                  <p className="text-[0.625rem] font-bold uppercase tracking-[0.1em] text-ink-400">
                    {t(`skills.${section}`)}
                  </p>
                  <p
                    className={cx(
                      'mt-1 font-mono text-2xl font-bold tabular',
                      band === undefined ? 'text-ink-300' : 'text-ink-900',
                    )}
                  >
                    {band === undefined ? '—' : band.toFixed(1)}
                  </p>
                  {band === undefined && (
                    <p className="mt-0.5 text-[0.625rem] text-ink-400">{t('exam.notSat')}</p>
                  )}
                </div>
              );
            })}
          </div>

          {focusLossCount > 0 && (
            <p className="flex items-center justify-center gap-2 rounded-[var(--radius-control)] border border-warning-500/25 bg-warning-50 p-3 text-sm text-warning-700">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {t('exam.focusSummary', { count: focusLossCount })}
            </p>
          )}

          <div className="flex justify-center pt-2">
            <Button size="lg" onClick={onExitExam}>
              {t('exam.backToPlan')}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-3 rounded-[var(--radius-card)] bg-warning-500 p-4 text-white sm:flex-row sm:items-center">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-white/20">
            <ShieldAlert className="h-5 w-5" />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded bg-white/20 px-2 py-0.5 text-[0.6875rem] font-bold uppercase tracking-[0.1em]">
                {t('exam.banner')}
              </span>
              <span className="text-xs font-medium">
                {t('exam.section', {
                  current: currentSectionIndex + 1,
                  total: SECTIONS.length,
                  name: t(`skills.${activeSection}`),
                })}
              </span>
            </div>
            <p className="mt-1 text-xs text-white/85">{t('exam.lockdown')}</p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <div className="flex items-center gap-1.5">
            {SECTIONS.map((section, index) => (
              <span
                key={section}
                title={t(`skills.${section}`)}
                className={cx(
                  'h-2.5 w-2.5 rounded-full',
                  index === currentSectionIndex
                    ? 'bg-white'
                    : index < currentSectionIndex
                      ? 'bg-white/70'
                      : 'bg-white/25',
                )}
              />
            ))}
          </div>

          <button
            onClick={() => {
              if (window.confirm(t('exam.abortConfirm'))) onExitExam();
            }}
            className="rounded-[var(--radius-control)] bg-black/20 px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-black/30"
          >
            {t('exam.abort')}
          </button>
        </div>
      </div>

      {showFocusWarning && (
        <div className="flex flex-col justify-between gap-3 rounded-[var(--radius-card)] border border-danger-500/30 bg-danger-50 p-4 text-danger-700 sm:flex-row sm:items-center">
          <p className="flex items-start gap-2 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <strong>{t('exam.focusLostTitle')}.</strong> {t('exam.focusLostBody')}
            </span>
          </p>
          <Button variant="secondary" size="sm" onClick={() => setShowFocusWarning(false)}>
            {t('exam.acknowledge')}
          </Button>
        </div>
      )}

      {activeSection === 'listening' && (
        <ListeningSession
          listeningData={listening}
          onRecordScore={(band) => handleRecordSectionScore(band)}
        />
      )}

      {activeSection === 'reading' && (
        <ReadingSession
          readingData={reading}
          onRecordScore={(band) => handleRecordSectionScore(band)}
        />
      )}

      {activeSection === 'writing' && (
        <WritingSession
          task1Data={task1 ?? undefined}
          task2Data={task2 ?? undefined}
          onRecordScore={(_task, band) => handleRecordSectionScore(band)}
        />
      )}

      {activeSection === 'speaking' && (
        <SpeakingSession
          speakingData={speaking}
          onRecordScore={(band) => handleRecordSectionScore(band)}
        />
      )}
    </div>
  );
};
