import React, { useState, useEffect } from 'react';
import { ReadingData, ReadingPassage } from '../types';
import { checkAnswer, readingRawToBand } from '../utils/ieltsScoring';
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
import { CdiHtmlViewer } from './common/CdiHtmlViewer';

interface ReadingSessionProps {
  readingData: ReadingData;
  onRecordScore?: (band: number, rawScore: number) => void;
  onBackToMocks?: () => void;
}

export const ReadingSession: React.FC<ReadingSessionProps> = ({
  readingData,
  onRecordScore,
  onBackToMocks,
}) => {
  const [activePassageIndex, setActivePassageIndex] = useState<number>(0);
  const [userAnswers, setUserAnswers] = useState<Record<string, string>>({});
  const [isSubmitted, setIsSubmitted] = useState<boolean>(false);

  // 60-minute standard reading timer
  const [secondsRemaining, setSecondsRemaining] = useState<number>(60 * 60);
  const [isTimerRunning, setIsTimerRunning] = useState<boolean>(true);

  const currentPassage = readingData.passages[activePassageIndex];

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    if (isTimerRunning && secondsRemaining > 0 && !isSubmitted) {
      timer = setInterval(() => {
        setSecondsRemaining((prev) => Math.max(0, prev - 1));
      }, 1000);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [isTimerRunning, secondsRemaining, isSubmitted]);

  const formatTimer = (totalSeconds: number) => {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const handleAnswerChange = (questionId: string, value: string) => {
    setUserAnswers((prev) => ({
      ...prev,
      [questionId]: value,
    }));
  };

  const allQuestions = readingData.passages.flatMap((p) => p.questions);
  const correctCount = allQuestions.filter((q) => checkAnswer(userAnswers[q.id] || '', q.correctAnswer)).length;
  // Scaled to 40 questions Academic standard
  const scaledScore = Math.round((correctCount / allQuestions.length) * 40);
  const band = readingRawToBand(scaledScore);

  const handleSubmit = () => {
    setIsSubmitted(true);
    setIsTimerRunning(false);
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
            <h1 className="text-lg font-bold text-ink-900">Academic Reading Module</h1>
            <p className="text-xs text-ink-500">
              Passage navigation with True/False/Not Given & multiple choice verification.
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          {/* Timer */}
          <div className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-ink-100 font-mono text-xs font-bold text-ink-700">
            <Clock className="w-3.5 h-3.5 text-ink-500" />
            <span>{formatTimer(secondsRemaining)}</span>
          </div>

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
                Passage {p.passageNumber}
              </button>
            ))}
          </div>

          {onBackToMocks && (
            <button
              onClick={onBackToMocks}
              className="px-3 py-1.5 text-xs text-ink-600 hover:text-ink-900 font-medium"
            >
              Back to Hub
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
              Reading Passage {currentPassage.passageNumber}
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
                Questions for Passage {currentPassage.passageNumber}
              </h3>
              <p className="text-[11px] text-ink-500">
                Answer all questions according to the information given in the text.
              </p>
            </div>
            <span className="text-xs text-ink-400 font-mono">
              {currentPassage.questions.length} questions
            </span>
          </div>

          <div className="space-y-4">
            {currentPassage.questions.map((q) => {
              const isCorrect = isSubmitted && checkAnswer(userAnswers[q.id] || '', q.correctAnswer);

              return (
                <div
                  key={q.id}
                  className={`p-4 rounded-xl border transition-all ${
                    isSubmitted
                      ? isCorrect
                        ? 'border-success-500 bg-success-50/40'
                        : 'border-danger-500 bg-danger-50/40'
                      : 'border-ink-200 bg-white'
                  }`}
                >
                  <div className="flex items-start space-x-3">
                    <span className="w-5 h-5 rounded-full bg-ink-100 text-ink-700 text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">
                      {q.questionNumber}
                    </span>

                    <div className="space-y-2.5 flex-1">
                      <p className="text-xs font-semibold text-ink-900">{q.prompt}</p>

                      {/* Options or Input */}
                      {q.options && q.options.length > 0 ? (
                        <div className="space-y-1.5">
                          {q.options.map((opt, oIdx) => (
                            <label
                              key={oIdx}
                              className={`flex items-center space-x-2 p-2 rounded-lg border text-xs cursor-pointer transition-all ${
                                userAnswers[q.id] === opt
                                  ? 'border-brand-600 bg-brand-50/60 font-semibold text-ink-900'
                                  : 'border-ink-200 hover:bg-ink-50 text-ink-700'
                              }`}
                            >
                              <input
                                type="radio"
                                name={q.id}
                                value={opt}
                                checked={userAnswers[q.id] === opt}
                                onChange={(e) => handleAnswerChange(q.id, e.target.value)}
                                disabled={isSubmitted}
                                className="accent-brand-600"
                              />
                              <span>{opt}</span>
                            </label>
                          ))}
                        </div>
                      ) : (
                        <input
                          type="text"
                          value={userAnswers[q.id] || ''}
                          onChange={(e) => handleAnswerChange(q.id, e.target.value)}
                          disabled={isSubmitted}
                          placeholder="Type word(s) from passage..."
                          className="w-full p-2 rounded-lg border border-ink-200 text-xs text-ink-900 focus:outline-none focus:ring-2 focus:ring-brand-600 font-medium"
                        />
                      )}

                      {/* Explanation if submitted */}
                      {isSubmitted && (
                        <div className="pt-2 border-t border-ink-200/60 text-xs space-y-1">
                          <div className="flex items-center space-x-1 font-bold">
                            {isCorrect ? (
                              <span className="text-success-700 flex items-center space-x-1">
                                <CheckCircle2 className="w-3.5 h-3.5 text-success-500" />
                                <span>Correct!</span>
                              </span>
                            ) : (
                              <span className="text-danger-700 flex items-center space-x-1">
                                <XCircle className="w-3.5 h-3.5 text-danger-500" />
                                <span>
                                  Incorrect. Key:{' '}
                                  {Array.isArray(q.correctAnswer)
                                    ? q.correctAnswer.join(' / ')
                                    : q.correctAnswer}
                                </span>
                              </span>
                            )}
                          </div>
                          {q.explanation && (
                            <p className="text-[11px] text-ink-600 leading-relaxed">
                              {q.explanation}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Submission bar */}
          <div className="pt-4 border-t border-ink-100 flex items-center justify-between">
            {!isSubmitted ? (
              <button
                id="btn-submit-reading"
                onClick={handleSubmit}
                className="inline-flex items-center space-x-2 px-6 py-2.5 rounded-xl bg-ink-900 hover:bg-ink-800 text-white font-semibold text-xs transition-all shadow-md ml-auto cursor-pointer"
              >
                <span>Submit & Calculate Reading Band</span>
                <ChevronRight className="w-4 h-4" />
              </button>
            ) : (
              <div className="w-full flex items-center justify-between bg-brand-50 border border-brand-200 p-3.5 rounded-xl">
                <div>
                  <span className="text-[10px] font-bold text-brand-800 uppercase tracking-wider">
                    Reading Band Score
                  </span>
                  <div className="text-xs text-ink-800 font-semibold mt-0.5">
                    {correctCount} / {allQuestions.length} correct
                  </div>
                </div>
                <div className="text-xl font-black text-brand-700">Band {band.toFixed(1)}</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
