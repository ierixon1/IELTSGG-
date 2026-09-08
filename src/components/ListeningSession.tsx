import React, { useState, useEffect, useRef } from 'react';
import { ListeningData, ListeningPart } from '../types';
import { checkAnswer, listeningRawToBand } from '../utils/ieltsScoring';
import { 
  Headphones, 
  Play, 
  Pause, 
  RotateCcw, 
  Volume2, 
  CheckCircle2, 
  XCircle, 
  HelpCircle, 
  FileText,
  Sparkles,
  ChevronRight,
  Info
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { useT } from '../i18n';
import { CdiHtmlViewer } from './common/CdiHtmlViewer';
import { QuestionField, QuestionInstruction } from './common/QuestionField';

interface ListeningSessionProps {
  listeningData: ListeningData;
  onRecordScore?: (band: number, rawScore: number) => void;
  onBackToMocks?: () => void;
}

export const ListeningSession: React.FC<ListeningSessionProps> = ({
  listeningData,
  onRecordScore,
  onBackToMocks,
}) => {
  const t = useT();
  const [activePartIndex, setActivePartIndex] = useState<number>(0);
  const [userAnswers, setUserAnswers] = useState<Record<string, string>>({});
  const [isSubmitted, setIsSubmitted] = useState<boolean>(false);
  const [showTranscript, setShowTranscript] = useState<boolean>(false);

  // Audio Playback state (Speech Synthesis & Simulated Stream)
  const [isPlayingAudio, setIsPlayingAudio] = useState<boolean>(false);
  const [audioProgress, setAudioProgress] = useState<number>(0);
  const synthUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const progressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const currentPart = listeningData.parts[activePartIndex];

  // Stop speech when changing part
  useEffect(() => {
    stopAudio();
    setShowTranscript(false);
    setAudioProgress(0);
  }, [activePartIndex]);

  const toggleAudio = () => {
    if (isPlayingAudio) {
      stopAudio();
    } else {
      playAudio();
    }
  };

  const playAudio = () => {
    if (!('speechSynthesis' in window)) {
      alert(t('listening.noSpeech'));
      return;
    }

    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(currentPart.transcript);
    utterance.rate = 0.95;

    // Pick accent voice if available
    const voices = window.speechSynthesis.getVoices();
    if (currentPart.accent === 'British') {
      const gbVoice = voices.find(v => v.lang.includes('en-GB') || v.name.includes('UK') || v.name.includes('British'));
      if (gbVoice) utterance.voice = gbVoice;
    } else if (currentPart.accent === 'Australian') {
      const auVoice = voices.find(v => v.lang.includes('en-AU') || v.name.includes('Australia'));
      if (auVoice) utterance.voice = auVoice;
    } else {
      const usVoice = voices.find(v => v.lang.includes('en-US') || v.name.includes('US'));
      if (usVoice) utterance.voice = usVoice;
    }

    utterance.onend = () => {
      setIsPlayingAudio(false);
      setAudioProgress(100);
      if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);
    };

    utterance.onerror = () => {
      setIsPlayingAudio(false);
      if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);
    };

    synthUtteranceRef.current = utterance;
    window.speechSynthesis.speak(utterance);
    setIsPlayingAudio(true);

    // Approximate duration progress animation
    const words = currentPart.transcript.split(/\s+/).length;
    const estSeconds = Math.max(20, Math.round(words / 2.2));
    let elapsed = 0;

    if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);
    progressIntervalRef.current = setInterval(() => {
      elapsed += 1;
      const pct = Math.min(99, Math.round((elapsed / estSeconds) * 100));
      setAudioProgress(pct);
    }, 1000);
  };

  const stopAudio = () => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
    setIsPlayingAudio(false);
  };

  const handleAnswerChange = (questionId: string, value: string) => {
    setUserAnswers((prev) => ({
      ...prev,
      [questionId]: value,
    }));
  };

  // Calculate results across all parts
  const allQuestions = listeningData.parts.flatMap((p) => p.questions);
  const correctCount = allQuestions.filter((q) => checkAnswer(userAnswers[q.id] || '', q.correctAnswer)).length;
  // Extrapolate to 40 questions scale if needed
  const scaledScore = Math.round((correctCount / allQuestions.length) * 40);
  const band = listeningRawToBand(scaledScore);

  const handleSubmit = () => {
    setIsSubmitted(true);
    stopAudio();
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
      {/* Header & Section Navigation */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-2xl border border-ink-200 shadow-sm">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-success-50 text-success-500 flex items-center justify-center font-bold">
            <Headphones className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-ink-900">{t('listening.title')}</h1>
            <p className="text-xs text-ink-500">{t('listening.subtitle')}</p>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          <div className="inline-flex p-1 bg-ink-100 rounded-xl">
            {listeningData.parts.map((p, idx) => (
              <button
                key={p.partNumber}
                id={`btn-listen-part-${p.partNumber}`}
                onClick={() => setActivePartIndex(idx)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  activePartIndex === idx
                    ? 'bg-white text-ink-900 shadow-sm'
                    : 'text-ink-600 hover:text-ink-900'
                }`}
              >
                {t('listening.part', { number: p.partNumber })}
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

      {/* Audio Controller Bar */}
      <div className="bg-ink-900 text-white p-5 rounded-2xl shadow-md space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center space-x-2">
              <span className="text-xs font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-success-500/20 text-success-500 border border-success-500/30">
                {t('listening.accent', { name: currentPart.accent })}
              </span>
              <span className="text-xs text-ink-400 font-medium">{t('listening.part', { number: currentPart.partNumber })}</span>
            </div>
            <h2 className="text-sm font-bold text-white">{currentPart.title}</h2>
          </div>

          {/* Controls */}
          <div className="flex items-center space-x-3">
            <button
              id="btn-toggle-listening-audio"
              onClick={toggleAudio}
              className="inline-flex items-center space-x-2 px-4 py-2 rounded-xl bg-success-500 hover:bg-success-500 text-ink-950 font-bold text-xs transition-all shadow-md cursor-pointer"
            >
              {isPlayingAudio ? (
                <>
                  <Pause className="w-3.5 h-3.5 fill-current" />
                  <span>{t('listening.pause')}</span>
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>{t('listening.play')}</span>
                </>
              )}
            </button>

            <button
              id="btn-toggle-transcript"
              onClick={() => setShowTranscript(!showTranscript)}
              className="inline-flex items-center space-x-1.5 px-3 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-xs font-semibold text-ink-300 transition-all cursor-pointer"
            >
              <FileText className="w-3.5 h-3.5" />
              <span>{showTranscript ? t('listening.hideScript') : t('listening.viewScript')}</span>
            </button>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="space-y-1">
          <div className="flex justify-between text-[10px] text-ink-400 font-mono">
            <span>{t('listening.track', { name: currentPart.audioDescription })}</span>
            <span>{audioProgress}%</span>
          </div>
          <div className="w-full h-1.5 bg-ink-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-success-500 transition-all duration-300"
              style={{ width: `${audioProgress}%` }}
            />
          </div>
        </div>

        {/* Transcript dropdown */}
        {showTranscript && (
          <div className="mt-3 p-4 rounded-xl bg-ink-800/80 border border-ink-700 text-xs text-ink-300 font-serif leading-relaxed whitespace-pre-line max-h-60 overflow-y-auto">
            <div className="font-bold text-success-500 mb-1 font-sans">{t('listening.transcript')}</div>
            {currentPart.transcript}
          </div>
        )}

        {/* HTML Scenario / Visual Material */}
        {currentPart.htmlContent && (
          <div className="mt-3 p-4 rounded-xl bg-ink-800/90 border border-ink-700 text-ink-200">
            <CdiHtmlViewer id={`listening-html-part-${currentPart.partNumber}`} html={currentPart.htmlContent} />
          </div>
        )}
      </div>

      {/* Questions Form */}
      <div className="bg-white p-6 sm:p-8 rounded-2xl border border-ink-200 shadow-sm space-y-6">
        <div className="flex items-center justify-between pb-4 border-b border-ink-100">
          <div>
            <h3 className="text-base font-bold text-ink-900">
              {t('listening.questionsTitle', { count: currentPart.questions.length })}
            </h3>
            <p className="text-xs text-ink-500">{t('listening.questionsHint')}</p>
          </div>
          <div className="text-xs text-ink-400">
            {t('session.answered', { count: Object.keys(userAnswers).length })}
          </div>
        </div>

        <div className="space-y-4">
          {currentPart.questions.map((q) => {
            const isCorrect = isSubmitted && checkAnswer(userAnswers[q.id] || '', q.correctAnswer);
            const isWrong = isSubmitted && !isCorrect;

            return (
              <React.Fragment key={q.id}>
              {q.instruction && <QuestionInstruction text={q.instruction} />}
              <div
                className={`p-4 rounded-xl border transition-all ${
                  isSubmitted
                    ? isCorrect
                      ? 'border-success-500 bg-success-50/40'
                      : 'border-danger-500 bg-danger-50/40'
                    : 'border-ink-200 bg-white'
                }`}
              >
                <div className="flex items-start space-x-3">
                  <span className="w-6 h-6 rounded-full bg-ink-100 text-ink-700 text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">
                    {q.questionNumber}
                  </span>

                  <div className="space-y-3 flex-1">
                    <p className="text-sm font-semibold text-ink-900">{q.prompt}</p>

                    <QuestionField
                      question={q}
                      value={userAnswers[q.id] || ''}
                      disabled={isSubmitted}
                      onChange={(value) => handleAnswerChange(q.id, value)}
                      groupName={`listening-${currentPart.partNumber}`}
                    />

                    {/* Results Feedback */}
                    {isSubmitted && (
                      <div className="pt-2 border-t border-ink-200/60 space-y-1 text-xs">
                        <div className="flex items-center space-x-1.5 font-bold">
                          {isCorrect ? (
                            <span className="text-success-700 flex items-center space-x-1">
                              <CheckCircle2 className="w-4 h-4 text-success-500" />
                              <span>{t('session.correct')}</span>
                            </span>
                          ) : (
                            <span className="text-danger-700 flex items-center space-x-1">
                              <XCircle className="w-4 h-4 text-danger-500" />
                              <span>
                                {t('session.incorrect', {
                                  answers: Array.isArray(q.correctAnswer)
                                    ? q.correctAnswer.join(' / ')
                                    : q.correctAnswer,
                                })}
                              </span>
                            </span>
                          )}
                        </div>
                        {q.explanation && (
                          <p className="text-ink-600 text-[11px] leading-relaxed">
                            <strong>{t('session.explanation')}:</strong> {q.explanation}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
              </React.Fragment>
            );
          })}
        </div>

        {/* Action Button & Results Card */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-4 border-t border-ink-100">
          {!isSubmitted ? (
            <button
              id="btn-submit-listening"
              onClick={handleSubmit}
              className="inline-flex items-center space-x-2 px-6 py-2.5 rounded-xl bg-ink-900 hover:bg-ink-800 text-white font-semibold text-sm transition-all shadow-md ml-auto"
            >
              <span>{t('session.submit')}</span>
              <ChevronRight className="w-4 h-4" />
            </button>
          ) : (
            <div className="w-full flex items-center justify-between bg-success-50 border border-success-50 p-4 rounded-xl">
              <div>
                <span className="text-xs font-bold text-success-700 uppercase tracking-wider">
                  {t('listening.resultTitle')}
                </span>
                <div className="text-sm text-ink-800 font-semibold mt-0.5 tabular">
                  {t('session.raw', { correct: correctCount, total: allQuestions.length })}
                </div>
              </div>
              <div className="flex items-center space-x-3">
                <div className="text-right">
                  <div className="text-xs text-ink-500 font-medium">{t('session.conversion')}</div>
                  <div className="font-mono text-xl font-bold tabular text-success-700">{band.toFixed(1)}</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
