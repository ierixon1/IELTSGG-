import React, { useState, useEffect } from 'react';
import { AnswerValue, ReadingData, ReadingPassage } from '../types';
import { checkQuestionAnswer, objectiveSectionScore } from '../utils/ieltsScoring';
import { 
  BookOpen, 
  Clock, 
  CheckCircle2, 
  XCircle, 
  HelpCircle, 
  ChevronRight,
  Info,
  Maximize2
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { useT } from '../i18n';
import { CdiHtmlViewer } from './common/CdiHtmlViewer';
import { AnswerVerdict, QuestionBlock, groupQuestions } from './common/QuestionBlock';

interface ReadingSessionProps {
  readingData: ReadingData;
  onRecordScore?: (band: number, rawScore: number) => void;
  onBackToMocks?: () => void;
  /**
   * Inside a full exam: nothing is read aloud in place of a recording, the
   * transcript is not offered, and marks are not shown until the exam is over.
   */
  examMode?: boolean;
  /** Every answer change, so the exam engine holds the answers a timer may have to mark. */
  onAnswersChange?: (answers: Record<string, AnswerValue>) => void;
  /** The learner submitted this section's answers. */
  onSubmitAnswers?: () => void;
}

export const ReadingSession: React.FC<ReadingSessionProps> = ({
  readingData,
  onRecordScore,
  onBackToMocks,
  examMode = false,
  onAnswersChange,
  onSubmitAnswers,
}) => {
  const t = useT();
  const [activePassageIndex, setActivePassageIndex] = useState<number>(0);
  const [userAnswers, setUserAnswers] = useState<Record<string, AnswerValue>>({});
  const [isSubmitted, setIsSubmitted] = useState<boolean>(false);

  // Practice shows the time spent, not a countdown from an assumed paper length.
  // Inside an exam the section clock belongs to the exam screen, from the bundle.
  const [secondsElapsed, setSecondsElapsed] = useState<number>(0);
  const [isTimerRunning, setIsTimerRunning] = useState<boolean>(!examMode);

  const currentPassage = readingData.passages[activePassageIndex];

  useEffect(() => {
    if (!isTimerRunning || isSubmitted) return;
    const timer = setInterval(() => setSecondsElapsed((prev) => prev + 1), 1000);
    return () => clearInterval(timer);
  }, [isTimerRunning, isSubmitted]);

  const formatTimer = (totalSeconds: number) => {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const handleAnswerChange = (questionId: string, value: AnswerValue) => {
    const next = { ...userAnswers, [questionId]: value };
    setUserAnswers(next);
    onAnswersChange?.(next);
  };

  const allQuestions = readingData.passages.flatMap((p) => p.questions);
  /**
   * Marked once per question, so the same verdict drives the score, the number
   * marker and the feedback line. Marking is per question type: a multi-select
   * compares as a set, and a choice accepts its option's label as well as its
   * full text.
   */
  const results: Record<string, boolean> = Object.fromEntries(
    allQuestions.map((q) => [q.id, checkQuestionAnswer(q, userAnswers[q.id])]),
  );
  const { correct: correctCount, band } = objectiveSectionScore('reading', allQuestions, userAnswers);

  const handleSubmit = () => {
    setIsSubmitted(true);
    setIsTimerRunning(false);
    if (examMode) {
      onSubmitAnswers?.();
      return;
    }
    onRecordScore?.(band, correctCount);

    if (band >= 7.0) {
      confetti({
        particleCount: 80,
        spread: 70,
        origin: { y: 0.6 },
      });
    }
  };

  return (
    <div className="space-y-6">
      {/* Header & Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-2xl border border-ink-200 shadow-sm">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center font-bold">
            <BookOpen className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-ink-900">{t('reading.title')}</h1>
            <p className="text-xs text-ink-500">{t('reading.subtitle')}</p>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          {/* Time spent, in practice only */}
          {!examMode && (
            <div
              id="reading-time-spent"
              title={t('reading.timeSpent')}
              className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-ink-100 font-mono text-xs font-bold text-ink-700"
            >
              <Clock className="w-3.5 h-3.5 text-ink-500" />
              <span>{formatTimer(secondsElapsed)}</span>
            </div>
          )}

          {/* Passages Tab Switcher */}
          <div className="inline-flex p-1 bg-ink-100 rounded-xl">
            {readingData.passages.map((p, idx) => (
              <button
                key={p.passageNumber}
                id={`btn-read-passage-${p.passageNumber}`}
                onClick={() => setActivePassageIndex(idx)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  activePassageIndex === idx
                    ? 'bg-white text-ink-900 shadow-sm'
                    : 'text-ink-600 hover:text-ink-900'
                }`}
              >
                {t('reading.passage', { number: p.passageNumber })}
              </button>
            ))}
          </div>

          {onBackToMocks && (
            <button
              onClick={onBackToMocks}
              className="px-3 py-1.5 text-xs text-ink-600 hover:text-ink-900 font-medium"
            >
              {t('session.backToHub')}
            </button>
          )}
        </div>
      </div>

      {/* Split Screen Container (Left: Passage, Right: Questions) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Academic Passage */}
        <div className="lg:col-span-6 bg-white p-6 rounded-2xl border border-ink-200 shadow-sm space-y-4 max-h-[750px] overflow-y-auto">
          <div className="border-b border-ink-100 pb-3">
            <span className="text-[10px] font-bold uppercase tracking-wider text-brand-700 bg-brand-50 px-2 py-0.5 rounded border border-brand-200">
              {t('reading.passageLabel', { number: currentPassage.passageNumber })}
            </span>
            <h2 className="text-base font-extrabold text-ink-900 mt-2 leading-snug">
              {currentPassage.title}
            </h2>
            {currentPassage.subheading && (
              <p className="text-xs text-ink-500 italic mt-1 font-serif">
                {currentPassage.subheading}
              </p>
            )}
          </div>

          {currentPassage.htmlContent ? (
            <CdiHtmlViewer id={`reading-passage-html-${currentPassage.passageNumber}`} html={currentPassage.htmlContent} />
          ) : /<[a-z][\s\S]*>/i.test(currentPassage.content) ? (
            <CdiHtmlViewer id={`reading-passage-html-${currentPassage.passageNumber}`} html={currentPassage.content} />
          ) : (
            <div className="text-xs text-ink-800 font-serif leading-relaxed space-y-3 whitespace-pre-line">
              {currentPassage.content}
            </div>
          )}
        </div>

        {/* Right Column: Interactive Questions */}
        <div className="lg:col-span-6 bg-white p-6 rounded-2xl border border-ink-200 shadow-sm space-y-6 max-h-[750px] overflow-y-auto">
          <div className="flex items-center justify-between pb-3 border-b border-ink-100">
            <div>
              <h3 className="text-sm font-bold text-ink-900">
                {t('reading.questionsTitle', { number: currentPassage.passageNumber })}
              </h3>
              <p className="text-[11px] text-ink-500">{t('reading.questionsHint')}</p>
            </div>
            <span className="text-xs text-ink-400 font-mono tabular">
              {t('reading.questionCount', { count: currentPassage.questions.length })}
            </span>
          </div>

          <div className="space-y-4">
            {groupQuestions(currentPassage.questions).map((group) => (
              <QuestionBlock
                key={group.key}
                group={group}
                answers={userAnswers}
                disabled={isSubmitted}
                onChange={handleAnswerChange}
                groupName={`reading-${currentPassage.passageNumber}`}
                results={isSubmitted && !examMode ? results : undefined}
                renderFeedback={(question, isCorrect) => (
                  <AnswerVerdict
                    question={question}
                    correct={isCorrect}
                    correctLabel={t('session.correct')}
                    incorrectLabel={t('session.incorrect', {
                      answers: Array.isArray(question.correctAnswer)
                        ? question.correctAnswer.join(' / ')
                        : question.correctAnswer,
                    })}
                  />
                )}
              />
            ))}
          </div>

          {/* Submission bar */}
          <div className="pt-4 border-t border-ink-100 flex items-center justify-between">
            {!isSubmitted ? (
              <button
                id="btn-submit-reading"
                onClick={handleSubmit}
                className="inline-flex items-center space-x-2 px-6 py-2.5 rounded-xl bg-ink-900 hover:bg-ink-800 text-white font-semibold text-xs transition-all shadow-md ml-auto cursor-pointer"
              >
                <span>{t('session.submit')}</span>
                <ChevronRight className="w-4 h-4" />
              </button>
            ) : examMode ? (
              <p id="reading-answers-submitted" className="w-full rounded-xl border border-ink-200 bg-ink-50 p-3.5 text-xs font-semibold text-ink-700">
                {t('exam.answersSubmitted')}
              </p>
            ) : (
              <div className="w-full flex items-center justify-between bg-brand-50 border border-brand-200 p-3.5 rounded-xl">
                <div>
                  <span className="text-[10px] font-bold text-brand-800 uppercase tracking-wider">
                    {t('reading.resultTitle')}
                  </span>
                  <div className="text-xs text-ink-800 font-semibold mt-0.5 tabular">
                    {t('session.raw', { correct: correctCount, total: allQuestions.length })}
                  </div>
                </div>
                <div className="font-mono text-xl font-bold tabular text-brand-700">{band.toFixed(1)}</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
