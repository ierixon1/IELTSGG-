import React, { useState, useEffect } from 'react';
import { AnswerValue, QuestionBody, ReadingData, ReadingPassage, SittingQuestion } from '../types';
import type { PracticeMarking } from '../types/practice';
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

/**
 * Practice: the questions arrive without keys, and a submission is marked by
 * the server, which returns the verdicts, correct answers and explanations
 * shown once the learner has submitted.
 */
interface ModuleProps {
  /** Academic or General Training: the Reading texts differ (ielts.org Reading test format), so the screen says which it is. */
  module: 'academic' | 'general';
}

interface PracticeProps extends ModuleProps {
  examMode?: false;
  readingData: ReadingData<SittingQuestion>;
  mark: (answers: Record<string, AnswerValue>) => Promise<PracticeMarking>;
  onRecordScore?: (band: number, rawScore: number) => void;
  onBackToMocks?: () => void;
}

/**
 * Inside a full exam: the questions carry no keys and nothing is marked here —
 * the exam session marks the submitted answers on the server, and marks are not
 * shown until the exam is over.
 */
interface ExamProps extends ModuleProps {
  examMode: true;
  readingData: ReadingData<SittingQuestion>;
  /** Answers already stored by the session, so a reload does not lose them. */
  initialAnswers: Record<string, AnswerValue>;
  /** Whether the session has already recorded this section's submission. */
  submitted: boolean;
  onAnswersChange: (answers: Record<string, AnswerValue>) => void;
  onSubmitAnswers: () => void;
}

type ReadingSessionProps = PracticeProps | ExamProps;

export const ReadingSession: React.FC<ReadingSessionProps> = (props) => {
  const exam = props.examMode === true ? props : null;
  const practice = props.examMode === true ? null : props;
  const examMode = exam !== null;
  const passages: ReadingPassage<QuestionBody>[] = props.readingData.passages;
  const t = useT();
  const [activePassageIndex, setActivePassageIndex] = useState<number>(0);
  const [userAnswers, setUserAnswers] = useState<Record<string, AnswerValue>>(() => exam?.initialAnswers ?? {});
  const [submittedHere, setSubmittedHere] = useState<boolean>(false);
  const isSubmitted = submittedHere || Boolean(exam?.submitted);

  // Practice shows the time spent, not a countdown from an assumed paper length.
  // Inside an exam the section clock belongs to the exam screen, from the bundle.
  const [secondsElapsed, setSecondsElapsed] = useState<number>(0);
  const [isTimerRunning, setIsTimerRunning] = useState<boolean>(!examMode);

  const currentPassage = passages[activePassageIndex];

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
    exam?.onAnswersChange(next);
  };

  // Practice marking comes back from the server; nothing on this screen can mark.
  const [marking, setMarking] = useState<PracticeMarking | null>(null);
  const [isMarking, setIsMarking] = useState(false);
  const [markingError, setMarkingError] = useState<string | null>(null);
  /** One verdict per question, so the score, the number marker and the feedback line agree. */
  const results: Record<string, boolean> | undefined = marking
    ? Object.fromEntries(Object.entries(marking.results).map(([id, feedback]) => [id, feedback.correct]))
    : undefined;

  const handleSubmit = async () => {
    if (exam) {
      setSubmittedHere(true);
      setIsTimerRunning(false);
      exam.onSubmitAnswers();
      return;
    }
    if (!practice || isMarking) return;
    setIsMarking(true);
    setMarkingError(null);
    try {
      const marked = await practice.mark(userAnswers);
      setMarking(marked);
      setSubmittedHere(true);
      setIsTimerRunning(false);
      practice.onRecordScore?.(marked.band, marked.correct);
      if (marked.band >= 7.0) {
        confetti({
          particleCount: 80,
          spread: 70,
          origin: { y: 0.6 },
        });
      }
    } catch (error) {
      setMarkingError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsMarking(false);
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
            <p className="text-xs text-ink-500" id="reading-subtitle">
              {t(props.module === 'general' ? 'reading.subtitleGeneral' : 'reading.subtitle')}
            </p>
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
            {passages.map((p, idx) => (
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

          {practice?.onBackToMocks && (
            <button
              onClick={practice.onBackToMocks}
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
                renderFeedback={(rendered, isCorrect) => {
                  const feedback = marking?.results[rendered.id];
                  if (!feedback) return null;
                  return (
                    <AnswerVerdict
                      feedback={feedback}
                      correct={isCorrect}
                      correctLabel={t('session.correct')}
                      incorrectLabel={t('session.incorrect', { answers: feedback.answers.join(' / ') })}
                    />
                  );
                }}
              />
            ))}
          </div>

          {/* Submission bar */}
          <div className="pt-4 border-t border-ink-100 flex items-center justify-between">
            {!isSubmitted ? (
              <>
                {markingError && (
                  <p id="reading-marking-error" role="alert" className="text-xs text-danger-700">
                    {markingError}
                  </p>
                )}
                <button
                  id="btn-submit-reading"
                  onClick={() => void handleSubmit()}
                  disabled={isMarking}
                  className="inline-flex items-center space-x-2 px-6 py-2.5 rounded-xl bg-ink-900 hover:bg-ink-800 text-white font-semibold text-xs transition-all shadow-md ml-auto cursor-pointer disabled:opacity-60"
                >
                  <span>{t('session.submit')}</span>
                  <ChevronRight className="w-4 h-4" />
                </button>
              </>
            ) : examMode ? (
              <p id="reading-answers-submitted" className="w-full rounded-xl border border-ink-200 bg-ink-50 p-3.5 text-xs font-semibold text-ink-700">
                {t('exam.answersSubmitted')}
              </p>
            ) : marking ? (
              <div id="reading-practice-result" className="w-full flex items-center justify-between bg-brand-50 border border-brand-200 p-3.5 rounded-xl">
                <div>
                  <span className="text-[10px] font-bold text-brand-800 uppercase tracking-wider">
                    {t('reading.resultTitle')}
                  </span>
                  <div className="text-xs text-ink-800 font-semibold mt-0.5 tabular">
                    {t('session.raw', { correct: marking.correct, total: marking.total })}
                  </div>
                </div>
                <div className="font-mono text-xl font-bold tabular text-brand-700">{marking.band.toFixed(1)}</div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
};
