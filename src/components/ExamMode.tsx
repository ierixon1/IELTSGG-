import React, { useState, useEffect } from 'react';
import { MockTest, SkillType, MockAttempt } from '../types';
import { calculateOverallBand } from '../utils/ieltsScoring';
import { ListeningSession } from './ListeningSession';
import { ReadingSession } from './ReadingSession';
import { WritingSession } from './WritingSession';
import { SpeakingSession } from './SpeakingSession';
import { 
  ShieldAlert, 
  Clock, 
  AlertTriangle, 
  CheckCircle2, 
  Award, 
  ArrowRight,
  RotateCcw
} from 'lucide-react';
import confetti from 'canvas-confetti';

interface ExamModeProps {
  mockTest: MockTest;
  onCompleteExam: (attempt: MockAttempt) => void;
  onExitExam: () => void;
}

export const ExamMode: React.FC<ExamModeProps> = ({
  mockTest,
  onCompleteExam,
  onExitExam,
}) => {
  const [currentSectionIndex, setCurrentSectionIndex] = useState<number>(0);
  const [isFinished, setIsFinished] = useState<boolean>(false);
  const [focusLossCount, setFocusLossCount] = useState<number>(0);
  const [showFocusWarning, setShowFocusWarning] = useState<boolean>(false);

  // Stored section scores
  const [scores, setScores] = useState<{
    listening?: number;
    reading?: number;
    writing?: number;
    speaking?: number;
  }>({});

  const sections: SkillType[] = ['listening', 'reading', 'writing', 'speaking'];
  const activeSection = sections[currentSectionIndex];

  // Detect tab focus change / blur (simulating lockdown integrity)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden && !isFinished) {
        setFocusLossCount((prev) => prev + 1);
        setShowFocusWarning(true);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isFinished]);

  const handleRecordSectionScore = (band: number) => {
    setScores((prev) => {
      const nextScores = { ...prev, [activeSection]: band };
      return nextScores;
    });

    if (currentSectionIndex < sections.length - 1) {
      setCurrentSectionIndex((prev) => prev + 1);
    } else {
      finishExam();
    }
  };

  const finishExam = () => {
    setIsFinished(true);
    const overall = calculateOverallBand(scores);

    const attempt: MockAttempt = {
      id: `attempt-${Date.now()}`,
      testId: mockTest.id,
      date: new Date().toISOString().split('T')[0],
      isFullMock: true,
      scores: {
        overall,
        listening: scores.listening ? { band: scores.listening, rawScore: 32 } : undefined,
        reading: scores.reading ? { band: scores.reading, rawScore: 31 } : undefined,
        writing: scores.writing ? { band: scores.writing } : undefined,
        speaking: scores.speaking ? { band: scores.speaking } : undefined,
      },
      durationMinutes: 165,
    };

    onCompleteExam(attempt);

    if (overall >= 7.0) {
      confetti({
        particleCount: 120,
        spread: 80,
        origin: { y: 0.5 },
      });
    }
  };

  const overallScore = calculateOverallBand(scores);

  if (isFinished) {
    return (
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="bg-white rounded-3xl p-8 border border-slate-200 shadow-xl text-center space-y-6">
          <div className="w-16 h-16 bg-emerald-100 text-emerald-700 rounded-2xl mx-auto flex items-center justify-center font-black text-2xl shadow-sm">
            <Award className="w-8 h-8" />
          </div>

          <div className="space-y-1">
            <span className="text-xs font-bold uppercase tracking-wider text-emerald-800 bg-emerald-50 px-3 py-1 rounded-full border border-emerald-200">
              Simulation Completed
            </span>
            <h1 className="text-2xl font-extrabold text-slate-900 mt-2">
              Official IELTS Academic Test Report
            </h1>
            <p className="text-xs text-slate-500">
              Completed under strict sequential time and tab monitoring rules.
            </p>
          </div>

          {/* Big Overall Band */}
          <div className="p-6 rounded-2xl bg-slate-900 text-white max-w-sm mx-auto space-y-2">
            <div className="text-xs uppercase font-bold text-slate-400">Overall Band Score</div>
            <div className="text-5xl font-extrabold text-emerald-400">{overallScore.toFixed(1)}</div>
            <p className="text-[11px] text-slate-400">
              Rounded according to the official IELTS averaging algorithm.
            </p>
          </div>

          {/* Breakdown Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2">
            {[
              { label: 'Listening', band: scores.listening || 6.5 },
              { label: 'Reading', band: scores.reading || 6.5 },
              { label: 'Writing', band: scores.writing || 6.5 },
              { label: 'Speaking', band: scores.speaking || 6.5 },
            ].map((s) => (
              <div key={s.label} className="p-4 rounded-xl border border-slate-200 bg-slate-50">
                <div className="text-[10px] uppercase font-bold text-slate-500">{s.label}</div>
                <div className="text-2xl font-extrabold text-slate-900 mt-1">
                  Band {s.band.toFixed(1)}
                </div>
              </div>
            ))}
          </div>

          {focusLossCount > 0 && (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-800 flex items-center justify-center space-x-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
              <span>
                Tab focus was lost <strong>{focusLossCount} time(s)</strong> during testing. In a real exam, this would prompt proctor intervention.
              </span>
            </div>
          )}

          <div className="pt-4 flex justify-center space-x-3">
            <button
              onClick={onExitExam}
              className="px-6 py-3 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs transition-all shadow-md"
            >
              Return to Adaptive Plan & Recalculate
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Strict Exam Lockdown HUD */}
      <div className="bg-amber-600 text-white p-4 rounded-2xl shadow-md flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center space-x-3">
          <div className="w-9 h-9 rounded-xl bg-white/20 flex items-center justify-center font-bold">
            <ShieldAlert className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className="text-xs font-black uppercase tracking-wider bg-white/20 px-2 py-0.5 rounded">
                Official Exam Mode Active
              </span>
              <span className="text-xs font-medium text-amber-100">
                Section {currentSectionIndex + 1} of 4: {activeSection.toUpperCase()}
              </span>
            </div>
            <p className="text-[11px] text-amber-100 mt-0.5">
              Lockdown active: Do not switch browser tabs or reload the session.
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          {/* Progress dots */}
          <div className="flex items-center space-x-1.5">
            {sections.map((s, idx) => (
              <div
                key={s}
                className={`w-3 h-3 rounded-full ${
                  idx === currentSectionIndex
                    ? 'bg-white ring-2 ring-amber-300'
                    : idx < currentSectionIndex
                    ? 'bg-emerald-300'
                    : 'bg-white/30'
                }`}
                title={s}
              />
            ))}
          </div>

          <button
            onClick={() => {
              if (confirm('Cancel and exit official exam mode? Progress will not be saved.')) {
                onExitExam();
              }
            }}
            className="text-xs text-amber-100 hover:text-white px-2.5 py-1 rounded bg-black/20 hover:bg-black/30 transition-colors font-medium"
          >
            Abort Exam
          </button>
        </div>
      </div>

      {/* Focus warning popover */}
      {showFocusWarning && (
        <div className="bg-rose-50 border border-rose-300 p-4 rounded-2xl text-xs text-rose-800 flex items-center justify-between shadow-lg animate-bounce">
          <div className="flex items-center space-x-2">
            <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
            <span>
              <strong>Warning: Window focus lost!</strong> On a real computerized IELTS exam, tab switching causes test invalidation.
            </span>
          </div>
          <button
            onClick={() => setShowFocusWarning(false)}
            className="text-xs font-bold text-rose-700 bg-rose-200/60 px-3 py-1 rounded-lg"
          >
            Acknowledge & Continue
          </button>
        </div>
      )}

      {/* Active Section Engine */}
      {activeSection === 'listening' && (
        <ListeningSession
          listeningData={mockTest.listening}
          onRecordScore={(band) => handleRecordSectionScore(band)}
        />
      )}

      {activeSection === 'reading' && (
        <ReadingSession
          readingData={mockTest.reading}
          onRecordScore={(band) => handleRecordSectionScore(band)}
        />
      )}

      {activeSection === 'writing' && (
        <WritingSession
          task1Data={mockTest.writing.task1}
          task2Data={mockTest.writing.task2}
          onRecordScore={(_task, band) => handleRecordSectionScore(band)}
        />
      )}

      {activeSection === 'speaking' && (
        <SpeakingSession
          speakingData={mockTest.speaking}
          onRecordScore={(band) => handleRecordSectionScore(band)}
        />
      )}
    </div>
  );
};
