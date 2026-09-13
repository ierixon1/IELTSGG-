import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SpeakingData, SpeakingGradingResult, CriterionFeedback } from '../types';
import { GradingError, requestSpeakingGrading } from '../services/api';
import { AudioVolumeDetector, blobToBase64 } from '../utils/audioAnalyzer';
import { analyseLexis } from '../utils/textMetrics';
import { halfBandAverage } from '../utils/ieltsScoring';
import {
  Activity,
  AlertCircle,
  ArrowRight,
  Check,
  Clock,
  FileEdit,
  Mic,
  Play,
  RotateCcw,
  Sparkles,
  Square,
  Upload,
  X,
  Zap,
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { useT } from '../i18n';
import { Badge, Button, Card, LexisPanel, Progress, cx } from './ui';
import { CdiHtmlViewer } from './common/CdiHtmlViewer';
import { GradingStatus } from './exam/GradingStatus';
import type { LearnerGradingView } from '../types/examSession';

interface PracticeProps {
  examMode?: false;
  speakingData: SpeakingData;
  onRecordScore?: (band: number) => void;
  /** Feeds the vocabulary deck with the words the answer leaned on. */
  onGraded?: (transcript: string) => void;
  onBackToMocks?: () => void;
}

/** One spoken answer, as the grader receives it. */
export interface SpokenAnswer {
  audioBase64?: string;
  mimeType?: string;
  transcriptProvided?: string;
  clientMetrics?: { durationSeconds: number; pausesCount?: number; totalPauseDurationSeconds?: number | null };
}

/**
 * Inside a full exam: each part is submitted to the exam session, which stores
 * it at once and grades it separately against the pinned part; a submitted part
 * is final, and no band is shown until the exam is over.
 */
interface ExamProps {
  examMode: true;
  speakingData: SpeakingData;
  /** Submits one part. Rejects with a `GradingError` when the session does not accept it. */
  submit: (part: 1 | 2 | 3, answer: SpokenAnswer) => Promise<void>;
  /** Parts the session has accepted, with where each one's grading stands. */
  gradedParts: Partial<Record<1 | 2 | 3, { transcript: string; grading: LearnerGradingView }>>;
  /** Asks for a failed grading to run again. */
  onRetryGrading: (part: 1 | 2 | 3) => void;
}

type SpeakingSessionProps = PracticeProps | ExamProps;

type PartNumber = 1 | 2 | 3;

const PARTS: PartNumber[] = [1, 2, 3];

/** The server rejects a base64 payload beyond this; stop it at the picker. */
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

/** How long a strong answer runs, per part, in seconds. */
const TARGET_SECONDS: Record<PartNumber, number> = { 1: 60, 2: 120, 3: 60 };

const CRITERION_ORDER = [
  'fluency_coherence',
  'lexical_resource',
  'grammatical_range',
  'pronunciation',
] as const;

/**
 * Speech metrics we can stand behind.
 *
 * `durationSeconds` and the pause figures come from the recorder itself;
 * `wordsPerMinute` is derived from the returned transcript against that
 * measured duration. When a learner types their answer instead of recording,
 * there is nothing to measure and this is `null` — the UI then says so rather
 * than showing a plausible-looking guess.
 */
interface MeasuredMetrics {
  durationSeconds: number;
  /**
   * Pause figures exist only for a live recording: the analyser measures
   * silence as it happens and cannot recover it from a finished file.
   */
  pauseCount: number | null;
  pauseSeconds: number | null;
  source: 'recording' | 'upload';
}

interface PartAttempt {
  result: SpeakingGradingResult;
  metrics: MeasuredMetrics | null;
  wordsPerMinute: number | null;
}

/**
 * Turns a refused grading request into something a learner can act on. The
 * server never returns a band it cannot justify, so "no score" has to explain
 * itself.
 */
function describeGradingError(error: unknown, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (error instanceof GradingError) {
    if (error.code === 'ai_not_configured') return t('grading.errors.ai_not_configured');
    if (error.code === 'ai_unavailable') return t('grading.errors.ai_unavailable');
    if (error.code === 'quota_exceeded') return t('grading.errors.quota_exceeded');
    if (error.code === 'grading_timeout') return t('grading.errors.grading_timeout');
    if (error.code === 'already_submitted') return t('grading.errors.already_submitted');
    if (error.code === 'section_closed') return t('grading.errors.section_closed');
    if (error.code === 'too_short') {
      return t('grading.errors.too_short_speaking', {
        seconds: Number(error.details?.minimumSeconds ?? 10),
        words: Number(error.details?.minimumWords ?? 15),
      });
    }
  }
  return t('grading.errors.unknown');
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

export const SpeakingSession: React.FC<SpeakingSessionProps> = (props) => {
  const { speakingData } = props;
  const exam = props.examMode === true ? props : null;
  const practice = props.examMode === true ? null : props;
  const t = useT();

  // An exam resumes at the first part the session has not recorded.
  const [activePart, setActivePart] = useState<PartNumber>(() => PARTS.find((part) => !exam?.gradedParts[part]) ?? 3);
  const [attempts, setAttempts] = useState<Partial<Record<PartNumber, PartAttempt>>>({});
  const [showSummary, setShowSummary] = useState(false);

  // Part 2 preparation
  const [prepSecondsLeft, setPrepSecondsLeft] = useState(60);
  const [isPrepping, setIsPrepping] = useState(false);
  const [cueNotes, setCueNotes] = useState('');

  // Recording
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [volumeLevel, setVolumeLevel] = useState(0);
  const [isSpeakingLive, setIsSpeakingLive] = useState(false);
  const [livePauseCount, setLivePauseCount] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  const [transcriptDraft, setTranscriptDraft] = useState('');
  const [isGrading, setIsGrading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const volumeDetectorRef = useRef<AudioVolumeDetector | null>(null);
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordedBlobRef = useRef<Blob | null>(null);
  const measuredRef = useRef<MeasuredMetrics | null>(null);
  const playbackRef = useRef<HTMLAudioElement | null>(null);

  const partData =
    speakingData.parts.find((part) => part.partNumber === activePart) || speakingData.parts[0];

  const currentAttempt = attempts[activePart];
  const gradedCount = PARTS.filter((part) => attempts[part]).length;
  const partLocked = Boolean(exam?.gradedParts[activePart]);
  const partDone = (part: PartNumber) => Boolean(exam ? exam.gradedParts[part] : attempts[part]);

  /* --- Recording lifecycle ------------------------------------------------ */

  const teardownRecorder = useCallback(() => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (volumeDetectorRef.current) {
      volumeDetectorRef.current.stop();
      volumeDetectorRef.current = null;
    }
  }, []);

  // Release the microphone and the object URL when the screen goes away.
  useEffect(
    () => () => {
      teardownRecorder();
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    },
    // The cleanup deliberately runs on unmount only; `audioUrl` is read via
    // closure at that moment, and stale-URL revocation is handled on replace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    if (!isPrepping || prepSecondsLeft <= 0) return;

    const interval = setInterval(() => {
      setPrepSecondsLeft((prev) => {
        if (prev <= 1) {
          setIsPrepping(false);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [isPrepping, prepSecondsLeft]);

  /** Clears everything tied to one part so the next one starts clean. */
  const resetPartWorkspace = useCallback(() => {
    teardownRecorder();
    setIsRecording(false);
    setRecordingSeconds(0);
    setVolumeLevel(0);
    setIsSpeakingLive(false);
    setLivePauseCount(0);
    setTranscriptDraft('');
    setCueNotes('');
    setErrorMsg(null);
    setPrepSecondsLeft(60);
    setIsPrepping(false);
    recordedBlobRef.current = null;
    measuredRef.current = null;
    audioChunksRef.current = [];
    setAudioUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return null;
    });
  }, [teardownRecorder]);

  const startRecording = async () => {
    setErrorMsg(null);
    audioChunksRef.current = [];
    setRecordingSeconds(0);
    setLivePauseCount(0);
    measuredRef.current = null;
    setAudioUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return null;
    });

    try {
      const detector = new AudioVolumeDetector();
      volumeDetectorRef.current = detector;

      let lastCountedPauseAt = 0;

      const stream = await detector.start({
        onVolumeUpdate: (volume, speaking) => {
          setVolumeLevel(volume);
          setIsSpeakingLive(speaking);
        },
        onSilenceThresholdReached: (silenceMs) => {
          // The live counter is only a HUD hint; the authoritative count comes
          // from the detector's own measurement when recording stops.
          if (silenceMs > 2000 && performance.now() - lastCountedPauseAt > 2500) {
            lastCountedPauseAt = performance.now();
            setLivePauseCount((count) => count + 1);
          }
        },
      });

      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        recordedBlobRef.current = blob;
        setAudioUrl((previous) => {
          if (previous) URL.revokeObjectURL(previous);
          return blob.size > 0 ? URL.createObjectURL(blob) : null;
        });
      };

      mediaRecorder.start(250);
      setIsRecording(true);

      timerIntervalRef.current = setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
      }, 1000);
    } catch (error) {
      console.error('Microphone error:', error);
      setErrorMsg(t('speaking.micError'));
    }
  };

  const stopRecording = () => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }

    const detector = volumeDetectorRef.current;
    if (detector) {
      detector.stop();
      const pauses = detector.getPauseStats();
      measuredRef.current = {
        durationSeconds: recordingSeconds,
        pauseCount: pauses.count,
        pauseSeconds: Math.round(pauses.totalMs / 1000),
        source: 'recording',
      };
      volumeDetectorRef.current = null;
    }

    setIsRecording(false);
    setVolumeLevel(0);
    setIsSpeakingLive(false);
  };

  /**
   * Reads a chosen audio file into the same slot a recording would fill.
   * Duration comes from the decoded media, so pace stays honest; pause data
   * is unavailable and is reported as such.
   */
  const handleAudioFile = async (file: File) => {
    setErrorMsg(null);

    if (file.size > MAX_AUDIO_BYTES) {
      setErrorMsg(t('speaking.fileTooLarge', { limit: Math.round(MAX_AUDIO_BYTES / (1024 * 1024)) }));
      return;
    }

    teardownRecorder();
    setIsRecording(false);
    recordedBlobRef.current = file;

    const url = URL.createObjectURL(file);
    setAudioUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return url;
    });

    const probe = new Audio(url);
    const duration = await new Promise<number>((resolve) => {
      probe.addEventListener('loadedmetadata', () =>
        resolve(Number.isFinite(probe.duration) ? Math.round(probe.duration) : 0),
      );
      probe.addEventListener('error', () => resolve(0));
    });

    setRecordingSeconds(duration);
    setLivePauseCount(0);
    measuredRef.current = {
      durationSeconds: duration,
      pauseCount: null,
      pauseSeconds: null,
      source: 'upload',
    };
  };

  /* --- Grading ------------------------------------------------------------ */

  const handleGrade = async () => {
    const hasAudio = Boolean(recordedBlobRef.current && recordedBlobRef.current.size > 0);
    const typed = transcriptDraft.trim();

    if (!hasAudio && !typed) {
      setErrorMsg(t('speaking.needInput'));
      return;
    }

    setIsGrading(true);
    setErrorMsg(null);

    try {
      const audioBase64 = hasAudio ? await blobToBase64(recordedBlobRef.current!) : undefined;
      // A live recording is always webm; an uploaded file can be anything, and
      // the model needs to be told which it is getting.
      const mimeType = hasAudio ? recordedBlobRef.current!.type || 'audio/webm' : undefined;
      const measured = hasAudio ? measuredRef.current : null;

      const answer: SpokenAnswer = {
        ...(audioBase64 ? { audioBase64 } : {}),
        ...(mimeType ? { mimeType } : {}),
        ...(typed ? { transcriptProvided: typed } : {}),
        // Only genuinely measured values are sent; the examiner prompt should
        // not be reasoning about numbers we invented.
        ...(measured
          ? {
              clientMetrics: {
                durationSeconds: measured.durationSeconds,
                ...(measured.pauseCount !== null
                  ? { pausesCount: measured.pauseCount, totalPauseDurationSeconds: measured.pauseSeconds }
                  : {}),
              },
            }
          : {}),
      };

      if (exam) {
        // Stored by the session as soon as it is accepted; grading follows on its own,
        // and the band stays with the session until the exam is over.
        await exam.submit(activePart, answer);
        if (activePart < 3) goToPart((activePart + 1) as PartNumber);
        return;
      }

      const response = await requestSpeakingGrading({
        partNumber: activePart,
        topic: partData.topic,
        cueCard: partData.cueCard ? JSON.stringify(partData.cueCard) : undefined,
        ...answer,
      });

      const transcript = response.transcript || typed;
      const wordsPerMinute =
        measured && measured.durationSeconds > 0 && transcript
          ? Math.round((countWords(transcript) / measured.durationSeconds) * 60)
          : null;

      setAttempts((previous) => ({
        ...previous,
        [activePart]: { result: response, metrics: measured, wordsPerMinute },
      }));

      practice?.onRecordScore?.(response.band_overall);
      if (transcript) practice?.onGraded?.(transcript);

      if (response.band_overall >= 7.0) {
        confetti({ particleCount: 80, spread: 70, origin: { y: 0.6 } });
      }
    } catch (error) {
      setErrorMsg(describeGradingError(error, t));
    } finally {
      setIsGrading(false);
    }
  };

  const goToPart = (part: PartNumber) => {
    resetPartWorkspace();
    setShowSummary(false);
    setActivePart(part);
  };

  const overallBand = useMemo(() => {
    const graded = PARTS.map((part) => attempts[part]).filter(Boolean) as PartAttempt[];
    if (graded.length === 0) return null;
    return halfBandAverage(graded.map((attempt) => attempt.result.band_overall));
  }, [attempts]);

  /* --- Render ------------------------------------------------------------- */

  const targetSeconds = TARGET_SECONDS[activePart];
  const canGrade = !isGrading && !isRecording && !partLocked && (Boolean(audioUrl) || transcriptDraft.trim());

  return (
    <div className="space-y-6">
      <Card className="flex flex-col justify-between gap-5 p-5 sm:flex-row sm:items-center">
        <div className="flex items-center gap-3.5">
          <span className="inline-flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] bg-speaking-tint text-speaking-ink">
            <Mic className="h-5 w-5" />
          </span>
          <div>
            <h1 className="font-display text-lg font-bold text-ink-900">{t('speaking.title')}</h1>
            <p className="text-sm text-ink-500">{t('speaking.subtitle')}</p>
          </div>
        </div>

        {practice?.onBackToMocks && (
          <Button variant="ghost" size="sm" onClick={practice.onBackToMocks}>
            {t('speaking.backToHub')}
          </Button>
        )}
      </Card>

      {/* Interview stepper — the spine of the whole screen. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:gap-3">
        {PARTS.map((part) => {
          const done = partDone(part);
          const active = part === activePart && !showSummary;
          return (
            <button
              key={part}
              id={`btn-switch-sp-part${part}`}
              onClick={() => goToPart(part)}
              className={cx(
                'flex flex-1 items-center gap-3 rounded-[var(--radius-control)] border px-4 py-3 text-left transition-all',
                active
                  ? 'border-ink-900 bg-ink-900 text-white'
                  : 'border-ink-200 bg-white text-ink-600 hover:border-ink-300',
              )}
            >
              <span
                className={cx(
                  'flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-mono text-xs font-bold tabular',
                  done
                    ? 'bg-success-500 text-white'
                    : active
                      ? 'bg-white/15 text-white'
                      : 'bg-ink-100 text-ink-500',
                )}
              >
                {done ? <Check className="h-3.5 w-3.5" /> : part}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold">
                  {t(`speaking.steps.part${part}`)}
                </span>
                {!exam && attempts[part] && (
                  <span className={cx('font-mono text-xs tabular', active ? 'text-white/70' : 'text-ink-400')}>
                    {t('common.band')} {attempts[part]!.result.band_overall.toFixed(1)}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      {showSummary ? (
        <InterviewSummary
          attempts={attempts}
          overallBand={overallBand}
          gradedCount={gradedCount}
          onRestart={() => {
            setAttempts({});
            goToPart(1);
          }}
        />
      ) : (
        <>
          <div className="grid gap-6 lg:grid-cols-12">
            {/* Prompt column */}
            <div className="space-y-4 lg:col-span-5">
              <Card className="space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <Badge tone="speaking">{t('speaking.partLabel', { number: activePart })}</Badge>
                  <span className="truncate text-sm text-ink-500">{partData.topic}</span>
                </div>

                {partData.htmlContent && (
                  <div className="rounded-[var(--radius-control)] border border-ink-100 bg-ink-50 p-4">
                    <CdiHtmlViewer
                      id={`speaking-html-part-${activePart}`}
                      html={partData.htmlContent}
                    />
                  </div>
                )}

                {activePart === 2 && partData.cueCard ? (
                  <div className="space-y-4">
                    <div className="rounded-[var(--radius-control)] border-2 border-dashed border-brand-200 bg-brand-50/50 p-4">
                      <p className="text-[0.6875rem] font-bold uppercase tracking-[0.1em] text-brand-700">
                        {t('speaking.cueCardTitle')}
                      </p>
                      <h3 className="mt-2 font-display text-base font-bold text-ink-900">
                        {partData.cueCard.topic}
                      </h3>
                      <p className="mt-3 text-sm font-semibold text-ink-700">
                        {t('speaking.cueCardSay')}
                      </p>
                      <ul className="mt-1.5 list-inside list-disc space-y-1 text-sm text-ink-600">
                        {partData.cueCard.points.map((point, index) => (
                          <li key={index}>{point}</li>
                        ))}
                      </ul>
                    </div>

                    <div className="space-y-3 rounded-[var(--radius-control)] bg-ink-50 p-4">
                      <div className="flex items-center justify-between">
                        <span className="inline-flex items-center gap-1.5 text-sm font-bold text-ink-800">
                          <Clock className="h-4 w-4 text-brand-500" />
                          {t('speaking.prepTitle')}
                        </span>
                        <span className="rounded bg-white px-2 py-0.5 font-mono text-xs font-bold tabular text-brand-700">
                          {prepSecondsLeft}s
                        </span>
                      </div>

                      {!isPrepping && prepSecondsLeft === 60 && (
                        <Button
                          id="btn-start-prep-timer"
                          size="sm"
                          fullWidth
                          onClick={() => {
                            setPrepSecondsLeft(60);
                            setIsPrepping(true);
                          }}
                        >
                          {t('speaking.prepStart')}
                        </Button>
                      )}

                      {isPrepping && (
                        <p className="text-sm text-brand-700">{t('speaking.prepRunning')}</p>
                      )}

                      <textarea
                        rows={4}
                        value={cueNotes}
                        onChange={(event) => setCueNotes(event.target.value)}
                        placeholder={t('speaking.notesPlaceholder')}
                        className="w-full rounded-[var(--radius-control)] border border-ink-200 bg-white p-3 text-sm outline-none focus:border-brand-400"
                      />
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-sm font-bold text-ink-800">{t('speaking.questionsTitle')}</p>
                    <ol className="space-y-2">
                      {partData.questions.map((question, index) => (
                        <li
                          key={index}
                          className="rounded-[var(--radius-control)] bg-ink-50 p-3 text-sm leading-relaxed text-ink-700"
                        >
                          <span className="mr-2 font-mono text-xs font-bold text-ink-400">
                            {index + 1}
                          </span>
                          {question}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </Card>
            </div>

            {/* Recording column */}
            <div className="space-y-4 lg:col-span-7">
              <Card className="space-y-6">
                <div className="rounded-[var(--radius-card)] bg-ink-50 px-5 py-7 text-center">
                  <div className="flex items-center justify-center gap-2">
                    <span
                      className={cx(
                        'h-2.5 w-2.5 rounded-full',
                        isRecording ? 'animate-pulse bg-danger-500' : 'bg-ink-300',
                      )}
                    />
                    <span className="text-[0.6875rem] font-bold uppercase tracking-[0.12em] text-ink-500">
                      {isRecording ? t('speaking.recorder.live') : t('speaking.recorder.ready')}
                    </span>
                  </div>

                  <p className="mt-3 font-mono text-display-lg font-bold tabular text-ink-900">
                    {formatClock(recordingSeconds)}
                  </p>

                  <div className="mx-auto mt-5 max-w-xs">
                    <div className="mb-1.5 flex justify-between text-[0.6875rem] text-ink-400">
                      <span>{t('speaking.recorder.inputLevel')}</span>
                      <span className={isSpeakingLive ? 'font-bold text-success-700' : ''}>
                        {isSpeakingLive
                          ? t('speaking.recorder.voice')
                          : t('speaking.recorder.silence')}
                      </span>
                    </div>
                    <div className="h-2.5 w-full overflow-hidden rounded-[var(--radius-pill)] bg-ink-200">
                      <div
                        className={cx(
                          'h-full rounded-[var(--radius-pill)] transition-[width] duration-75',
                          isSpeakingLive ? 'bg-success-500' : 'bg-ink-400',
                        )}
                        style={{ width: `${Math.min(100, volumeLevel * 100)}%` }}
                      />
                    </div>
                  </div>

                  <div className="mt-5 flex items-center justify-center gap-5 text-xs text-ink-500">
                    <span className="tabular">
                      {t('speaking.recorder.pauses', { count: livePauseCount })}
                    </span>
                    <span className="border-l border-ink-200 pl-5 tabular">
                      {t('speaking.recorder.target', { seconds: targetSeconds })}
                    </span>
                  </div>

                  <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                    {!isRecording ? (
                      <Button id="btn-start-speaking-recording" onClick={startRecording}>
                        {audioUrl ? (
                          <RotateCcw className="h-4 w-4" />
                        ) : (
                          <Mic className="h-4 w-4" />
                        )}
                        {audioUrl
                          ? t('speaking.recorder.rerecord')
                          : t('speaking.recorder.start')}
                      </Button>
                    ) : (
                      <Button
                        id="btn-stop-speaking-recording"
                        variant="secondary"
                        onClick={stopRecording}
                      >
                        <Square className="h-4 w-4 text-danger-500" />
                        {t('speaking.recorder.stop')}
                      </Button>
                    )}

                    {audioUrl && !isRecording && (
                      <Button
                        variant="secondary"
                        onClick={() => playbackRef.current?.play()}
                        id="btn-play-speaking-recording"
                      >
                        <Play className="h-4 w-4" />
                        {t('speaking.recorder.play')}
                      </Button>
                    )}

                    {!isRecording && (
                      <label
                        className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-[var(--radius-control)] border border-ink-200 bg-white px-5 text-sm font-semibold text-ink-800 transition-colors hover:border-ink-300 hover:bg-ink-50"
                        id="label-upload-speaking-audio"
                      >
                        <Upload className="h-4 w-4" />
                        {t('speaking.recorder.upload')}
                        <input
                          type="file"
                          accept="audio/*"
                          className="sr-only"
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) handleAudioFile(file);
                            event.target.value = '';
                          }}
                        />
                      </label>
                    )}
                  </div>

                  {audioUrl && (
                    <audio ref={playbackRef} src={audioUrl} controls className="mx-auto mt-5 w-full max-w-sm" />
                  )}
                </div>

                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label
                      htmlFor="speaking-transcript-fallback"
                      className="inline-flex items-center gap-1.5 text-sm font-bold text-ink-700"
                    >
                      <FileEdit className="h-3.5 w-3.5 text-ink-400" />
                      {t('speaking.fallbackLabel')}
                    </label>
                    <span className="text-xs text-ink-400">{t('speaking.fallbackHint')}</span>
                  </div>
                  <textarea
                    id="speaking-transcript-fallback"
                    rows={3}
                    value={transcriptDraft}
                    onChange={(event) => setTranscriptDraft(event.target.value)}
                    placeholder={t('speaking.fallbackPlaceholder')}
                    className="w-full rounded-[var(--radius-control)] border border-ink-200 p-3 text-sm outline-none focus:border-brand-400"
                  />
                </div>

                {errorMsg && (
                  <div className="flex items-start gap-2 rounded-[var(--radius-control)] border border-danger-500/25 bg-danger-50 p-3 text-sm text-danger-700">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{errorMsg}</span>
                  </div>
                )}

                {exam && exam.gradedParts[activePart] && (
                  <div id={`speaking-part-submitted-${activePart}`}>
                    <GradingStatus
                      id={`speaking-grading-${activePart}`}
                      label={t('grading.exam.item.speaking', { n: activePart })}
                      grading={exam.gradedParts[activePart]!.grading}
                      onRetry={() => exam.onRetryGrading(activePart)}
                    />
                  </div>
                )}

                <div className="flex flex-wrap justify-end gap-3">
                  <Button
                    id="btn-submit-speaking-grade"
                    onClick={handleGrade}
                    disabled={!canGrade}
                  >
                    {isGrading ? (
                      <>
                        <Activity className="h-4 w-4 animate-spin" />
                        {exam ? t('grading.exam.submitting') : t('speaking.grading')}
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-4 w-4" />
                        {exam ? t('grading.exam.submitAnswer') : currentAttempt ? t('speaking.regrade') : t('speaking.grade')}
                      </>
                    )}
                  </Button>
                </div>
              </Card>
            </div>
          </div>

          {currentAttempt && !exam && (
            <PartResult
              part={activePart}
              attempt={currentAttempt}
              onNext={
                activePart < 3
                  ? () => goToPart((activePart + 1) as PartNumber)
                  : () => setShowSummary(true)
              }
              nextLabel={activePart < 3 ? t('speaking.next') : t('speaking.finish')}
            />
          )}
        </>
      )}
    </div>
  );
};

/* --- Per-part result ------------------------------------------------------- */

const PartResult: React.FC<{
  part: PartNumber;
  attempt: PartAttempt;
  onNext: () => void;
  nextLabel: string;
}> = ({ part, attempt, onNext, nextLabel }) => {
  const t = useT();
  const { result, metrics, wordsPerMinute } = attempt;

  return (
    <Card className="space-y-6 p-6 sm:p-8">
      <div className="flex flex-col justify-between gap-4 border-b border-ink-100 pb-6 sm:flex-row sm:items-center">
        <div>
          <Badge tone="speaking">{t('speaking.partLabel', { number: part })}</Badge>
          <h2 className="mt-2.5 text-display-sm text-ink-900">
            {t('speaking.result.title', { number: part })}
          </h2>
        </div>

        <div className="flex shrink-0 items-center gap-4 rounded-[var(--radius-card)] bg-ink-50 px-5 py-4">
          <span className="text-[0.625rem] font-bold uppercase tracking-[0.12em] text-ink-400">
            {t('speaking.result.overall')}
          </span>
          <span className="flex h-14 w-14 items-center justify-center rounded-[var(--radius-control)] bg-brand-500 font-mono text-2xl font-bold tabular text-white">
            {result.band_overall.toFixed(1)}
          </span>
        </div>
      </div>

      <div className="rounded-[var(--radius-card)] bg-ink-50 p-4">
        <p className="text-[0.6875rem] font-bold uppercase tracking-[0.1em] text-ink-500">
          {t('speaking.result.transcript')}
        </p>
        <p className="mt-2 text-sm italic leading-relaxed text-ink-800">“{result.transcript}”</p>
      </div>

      {/* The same arithmetic as Writing, run over what the candidate actually said. */}
      <LexisPanel metrics={analyseLexis(result.transcript || '')} />

      {result.cue_card_coverage && result.cue_card_coverage.length > 0 && (
        <section className="rounded-[var(--radius-card)] border border-ink-100 p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-display text-sm font-bold text-ink-900">
              {t('speaking.result.coverageTitle')}
            </h3>
            <p className="text-xs text-ink-400">{t('speaking.result.coverageNote')}</p>
          </div>

          <ul className="mt-4 space-y-3">
            {result.cue_card_coverage.map((entry, index) => (
              <li key={index} className="flex items-start gap-3">
                <span
                  className={cx(
                    'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
                    entry.covered ? 'bg-success-50 text-success-700' : 'bg-danger-50 text-danger-700',
                  )}
                >
                  {entry.covered ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink-900">{entry.point}</p>
                  <p
                    className={cx(
                      'text-xs',
                      entry.covered ? 'text-success-700' : 'text-danger-700',
                    )}
                  >
                    {entry.covered ? t('speaking.result.covered') : t('speaking.result.missed')}
                  </p>
                  {entry.covered && entry.evidence && (
                    <p className="mt-1 text-sm italic leading-relaxed text-ink-500">
                      “{entry.evidence}”
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {metrics ? (
        <div>
          <div className="es-ink-surface grid grid-cols-2 gap-4 rounded-[var(--radius-card)] p-5 sm:grid-cols-4">
            <Metric label={t('speaking.result.duration')} value={`${metrics.durationSeconds}s`} />
            <Metric
              label={t('speaking.result.pace')}
              value={
                wordsPerMinute !== null
                  ? `${wordsPerMinute} ${t('speaking.result.paceUnit')}`
                  : '—'
              }
            />
            <Metric
              label={t('speaking.result.pauses')}
              value={metrics.pauseCount === null ? '—' : String(metrics.pauseCount)}
            />
            <Metric
              label={t('speaking.result.pauseTime')}
              value={metrics.pauseSeconds === null ? '—' : `${metrics.pauseSeconds}s`}
            />
          </div>
          <p className="mt-2 text-xs text-ink-400">
            {metrics.source === 'upload'
              ? t('speaking.result.uploadedNote')
              : t('speaking.result.measuredNote')}
          </p>
        </div>
      ) : (
        <p className="text-xs text-ink-400">{t('speaking.result.typedNote')}</p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {CRITERION_ORDER.map((key) => {
          const criterion = result.criteria[key] as CriterionFeedback | undefined;
          if (!criterion) return null;

          // Pronunciation cannot be read off a typed answer, so a band there
          // would be a number with nothing behind it.
          const unscorable = key === 'pronunciation' && !metrics;

          return (
            <div key={key} className="rounded-[var(--radius-card)] border border-ink-100 p-4">
              <div className="flex items-start justify-between gap-2">
                <span className="text-xs font-bold text-ink-700">
                  {t(`speaking.criteria.${key}`)}
                </span>
                <span
                  className={cx(
                    'rounded-md px-2 py-0.5 font-mono text-sm font-bold tabular',
                    unscorable ? 'bg-ink-100 text-ink-400' : 'bg-ink-900 text-white',
                  )}
                >
                  {unscorable ? '—' : criterion.band.toFixed(1)}
                </span>
              </div>

              {key === 'pronunciation' && (
                <Badge tone={unscorable ? 'neutral' : 'warning'} className="mt-2">
                  {unscorable
                    ? t('speaking.result.noAudioPronunciation')
                    : t('speaking.result.approximate')}
                </Badge>
              )}

              {!unscorable && (
                <p className="mt-2.5 text-sm leading-relaxed text-ink-600">
                  {criterion.justification}
                </p>
              )}

              {!unscorable && criterion.improvement_tips?.[0] && (
                <div className="mt-3 border-t border-ink-100 pt-3">
                  <p className="text-[0.6875rem] font-bold uppercase tracking-[0.08em] text-brand-600">
                    {t('speaking.result.focus')}
                  </p>
                  <p className="mt-1 text-sm text-ink-600">{criterion.improvement_tips[0]}</p>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {result.actionable_drills?.length > 0 && (
        <div className="rounded-[var(--radius-card)] border border-brand-200 bg-brand-50 p-4">
          <p className="inline-flex items-center gap-1.5 text-sm font-bold text-brand-800">
            <Zap className="h-4 w-4" />
            {t('speaking.result.drills')}
          </p>
          <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-brand-900">
            {result.actionable_drills.map((drill, index) => (
              <li key={index}>{drill}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex justify-end">
        <Button onClick={onNext}>
          {nextLabel}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </Card>
  );
};

const Metric: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <p className="text-[0.625rem] uppercase tracking-[0.1em] text-white/50">{label}</p>
    <p className="mt-1 font-mono text-lg font-bold tabular text-white">{value}</p>
  </div>
);

/* --- Interview summary ----------------------------------------------------- */

const InterviewSummary: React.FC<{
  attempts: Partial<Record<PartNumber, PartAttempt>>;
  overallBand: number | null;
  gradedCount: number;
  onRestart: () => void;
}> = ({ attempts, overallBand, gradedCount, onRestart }) => {
  const t = useT();

  return (
    <Card className="space-y-6 p-6 sm:p-8">
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-display-sm text-ink-900">{t('speaking.summary.title')}</h2>
          <p className="mt-1.5 text-sm text-ink-500">{t('speaking.summary.body')}</p>
          {gradedCount < 3 && (
            <p className="mt-1.5 text-xs text-warning-700">
              {t('speaking.summary.incomplete', { done: gradedCount })}
            </p>
          )}
        </div>

        <div className="es-ink-surface flex shrink-0 items-center gap-4 rounded-[var(--radius-card)] px-6 py-5">
          <div>
            <p className="text-[0.625rem] font-bold uppercase tracking-[0.12em] text-white/50">
              {t('speaking.summary.overall')}
            </p>
            <p className="mt-1 font-mono text-display-md font-bold tabular text-white">
              {overallBand !== null ? overallBand.toFixed(1) : '—'}
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {PARTS.map((part) => {
          const attempt = attempts[part];
          return (
            <div
              key={part}
              className="rounded-[var(--radius-card)] border border-ink-100 bg-ink-50 p-4"
            >
              <p className="text-[0.6875rem] font-bold uppercase tracking-[0.1em] text-ink-400">
                {t('speaking.summary.partBand', { number: part })}
              </p>
              <p
                className={cx(
                  'mt-1.5 font-mono text-display-sm font-bold tabular',
                  attempt ? 'text-ink-900' : 'text-ink-300',
                )}
              >
                {attempt ? attempt.result.band_overall.toFixed(1) : '—'}
              </p>
              {attempt && (
                <div className="mt-3">
                  <Progress value={attempt.result.band_overall / 9} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-xs leading-relaxed text-ink-400">{t('speaking.summary.estimatedNote')}</p>

      <div className="flex justify-end">
        <Button variant="secondary" onClick={onRestart}>
          <RotateCcw className="h-4 w-4" />
          {t('speaking.summary.restart')}
        </Button>
      </div>
    </Card>
  );
};
