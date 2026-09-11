import React, { useState, useEffect, useRef } from 'react';
import { AnswerValue, ListeningData, ListeningPart, QuestionBody, SittingQuestion } from '../types';
import { checkQuestionAnswer, objectiveSectionScore } from '../utils/ieltsScoring';
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
import { AnswerVerdict, QuestionBlock, groupQuestions } from './common/QuestionBlock';

interface PracticeProps {
  examMode?: false;
  listeningData: ListeningData;
  onRecordScore?: (band: number, rawScore: number) => void;
  onBackToMocks?: () => void;
}

/**
 * Inside a full exam: the questions carry no keys, nothing is read aloud in
 * place of a recording, the transcript is not offered, and nothing is marked
 * here — the exam session marks the submitted answers on the server.
 */
interface ExamProps {
  examMode: true;
  listeningData: ListeningData<SittingQuestion>;
  /** Answers already stored by the session, so a reload does not lose them. */
  initialAnswers: Record<string, AnswerValue>;
  /** Whether the session has already recorded this section's submission. */
  submitted: boolean;
  onAnswersChange: (answers: Record<string, AnswerValue>) => void;
  onSubmitAnswers: () => void;
}

type ListeningSessionProps = PracticeProps | ExamProps;

export const ListeningSession: React.FC<ListeningSessionProps> = (props) => {
  const exam = props.examMode === true ? props : null;
  const practice = props.examMode === true ? null : props;
  const examMode = exam !== null;
  const parts: ListeningPart<QuestionBody>[] = props.listeningData.parts;
  const t = useT();
  const [activePartIndex, setActivePartIndex] = useState<number>(0);
  const [userAnswers, setUserAnswers] = useState<Record<string, AnswerValue>>(() => exam?.initialAnswers ?? {});
  const [submittedHere, setSubmittedHere] = useState<boolean>(false);
  const isSubmitted = submittedHere || Boolean(exam?.submitted);
  const [showTranscript, setShowTranscript] = useState<boolean>(false);

  // Audio Playback state (Speech Synthesis & Simulated Stream)
  const [isPlayingAudio, setIsPlayingAudio] = useState<boolean>(false);
  const [audioProgress, setAudioProgress] = useState<number>(0);
  const synthUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const progressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const currentPart = parts[activePartIndex];

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

  const handleAnswerChange = (questionId: string, value: AnswerValue) => {
    const next = { ...userAnswers, [questionId]: value };
    setUserAnswers(next);
    exam?.onAnswersChange(next);
  };

  // Practice marks here, across all parts. An exam has no keys to mark with.
  const practiceQuestions = practice ? practice.listeningData.parts.flatMap((p) => p.questions) : [];
  const practiceById = new Map(practiceQuestions.map((question) => [question.id, question]));
  /**
   * Marked once per question, so the same verdict drives the score, the number
   * marker and the feedback line.
   */
  const results: Record<string, boolean> = Object.fromEntries(
    practiceQuestions.map((q) => [q.id, checkQuestionAnswer(q, userAnswers[q.id])]),
  );
  const { correct: correctCount, band } = objectiveSectionScore('listening', practiceQuestions, userAnswers);
  const questionTotal = parts.reduce((sum, part) => sum + part.questions.length, 0);

  const handleSubmit = () => {
    setSubmittedHere(true);
    stopAudio();
    if (exam) {
      exam.onSubmitAnswers();
      return;
    }
    practice?.onRecordScore?.(band, correctCount);

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
            {parts.map((p, idx) => (
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
            {currentPart.audioUrl ? (
              // The recording itself. Nothing synthetic stands in for it.
              <audio
                key={currentPart.audioUrl}
                id={`listening-audio-part-${currentPart.partNumber}`}
                controls
                preload="metadata"
                src={currentPart.audioUrl}
                className="h-9 max-w-xs"
              />
            ) : examMode ? (
              <span
                id={`listening-audio-missing-${currentPart.partNumber}`}
                className="rounded-xl bg-danger-500/20 px-3 py-2 text-xs font-bold text-danger-50"
              >
                {t('listening.audioMissing')}
              </span>
            ) : (
              // Practice material without a recording: reading the script aloud is
              // offered as exactly that, never labelled as the audio.
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
                    <span>{t('listening.readAloud')}</span>
                  </>
                )}
              </button>
            )}

            {!examMode && (
              <button
                id="btn-toggle-transcript"
                onClick={() => setShowTranscript(!showTranscript)}
                className="inline-flex items-center space-x-1.5 px-3 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-xs font-semibold text-ink-300 transition-all cursor-pointer"
              >
                <FileText className="w-3.5 h-3.5" />
                <span>{showTranscript ? t('listening.hideScript') : t('listening.viewScript')}</span>
              </button>
            )}
          </div>
        </div>

        {/* Progress of the read-aloud script; a recording has its own controls. */}
        {!currentPart.audioUrl && !examMode && (
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
        )}

        {/* Transcript dropdown */}
        {showTranscript && !examMode && (
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
          {groupQuestions(currentPart.questions).map((group) => (
            <QuestionBlock
              key={group.key}
              group={group}
              answers={userAnswers}
              disabled={isSubmitted}
              onChange={handleAnswerChange}
              groupName={`listening-${currentPart.partNumber}`}
              results={isSubmitted && !examMode ? results : undefined}
              renderFeedback={(rendered, isCorrect) => {
                const question = practiceById.get(rendered.id);
                if (!question) return null;
                return (
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
                );
              }}
            />
          ))}
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
          ) : examMode ? (
            <p id="listening-answers-submitted" className="w-full rounded-xl border border-ink-200 bg-ink-50 p-4 text-sm font-semibold text-ink-700">
              {t('exam.answersSubmitted')}
            </p>
          ) : (
            <div className="w-full flex items-center justify-between bg-success-50 border border-success-50 p-4 rounded-xl">
              <div>
                <span className="text-xs font-bold text-success-700 uppercase tracking-wider">
                  {t('listening.resultTitle')}
                </span>
                <div className="text-sm text-ink-800 font-semibold mt-0.5 tabular">
                  {t('session.raw', { correct: correctCount, total: questionTotal })}
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
