import React, { useState, useEffect, useRef } from 'react';
import { SpeakingData, SpeakingGradingResult, CriterionFeedback } from '../types';
import { requestSpeakingGrading } from '../services/api';
import { AudioVolumeDetector, blobToBase64 } from '../utils/audioAnalyzer';
import { 
  Mic, 
  MicOff, 
  Square, 
  Clock, 
  Sparkles, 
  AlertCircle, 
  CheckCircle2, 
  Activity, 
  RotateCcw,
  Volume2,
  FileEdit,
  Zap,
  Play
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { CdiHtmlViewer } from './common/CdiHtmlViewer';

interface SpeakingSessionProps {
  speakingData: SpeakingData;
  onRecordScore?: (band: number) => void;
  onBackToMocks?: () => void;
}

export const SpeakingSession: React.FC<SpeakingSessionProps> = ({
  speakingData,
  onRecordScore,
  onBackToMocks,
}) => {
  const [activePart, setActivePart] = useState<1 | 2 | 3>(2);
  const [prepSecondsLeft, setPrepSecondsLeft] = useState<number>(60);
  const [isPrepping, setIsPrepping] = useState<boolean>(false);
  const [cueNotes, setCueNotes] = useState<string>('');

  // Audio Recording states
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [recordingSeconds, setRecordingSeconds] = useState<number>(0);
  const [volumeLevel, setVolumeLevel] = useState<number>(0);
  const [isSpeakingLive, setIsSpeakingLive] = useState<boolean>(false);
  const [longPausesCount, setLongPausesCount] = useState<number>(0);

  // Fallback text input if user microphone is unavailable
  const [transcriptDraft, setTranscriptDraft] = useState<string>('');

  // Grading states
  const [isGrading, setIsGrading] = useState<boolean>(false);
  const [result, setResult] = useState<SpeakingGradingResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const volumeDetectorRef = useRef<AudioVolumeDetector | null>(null);
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordedBlobRef = useRef<Blob | null>(null);

  const partData = speakingData.parts.find((p) => p.partNumber === activePart) || speakingData.parts[0];

  // Part 2 Prep timer
  useEffect(() => {
    let prepInterval: ReturnType<typeof setInterval> | null = null;
    if (isPrepping && prepSecondsLeft > 0) {
      prepInterval = setInterval(() => {
        setPrepSecondsLeft((prev) => {
          if (prev <= 1) {
            setIsPrepping(false);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => {
      if (prepInterval) clearInterval(prepInterval);
    };
  }, [isPrepping, prepSecondsLeft]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopRecording();
    };
  }, []);

  const startPrepTimer = () => {
    setPrepSecondsLeft(60);
    setIsPrepping(true);
  };

  const startRecording = async () => {
    setErrorMsg(null);
    setResult(null);
    audioChunksRef.current = [];
    setRecordingSeconds(0);
    setLongPausesCount(0);

    try {
      const detector = new AudioVolumeDetector(0.025, 400);
      volumeDetectorRef.current = detector;

      let lastSilenceStart = 0;

      const stream = await detector.start({
        onVolumeUpdate: (vol, speaking) => {
          setVolumeLevel(vol);
          setIsSpeakingLive(speaking);
        },
        onSilenceThresholdReached: (silenceMs) => {
          // Count pause if > 2.0 seconds
          if (silenceMs > 2000 && performance.now() - lastSilenceStart > 2500) {
            lastSilenceStart = performance.now();
            setLongPausesCount((p) => p + 1);
          }
        },
      });

      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      mediaRecorder.onstop = () => {
        const fullBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        recordedBlobRef.current = fullBlob;
      };

      mediaRecorder.start(250);
      setIsRecording(true);

      timerIntervalRef.current = setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
      }, 1000);
    } catch (err: any) {
      console.error('Microphone error:', err);
      setErrorMsg(
        'Microphone access denied or unavailable. You can still test by typing your spoken response transcript below.'
      );
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
    if (volumeDetectorRef.current) {
      volumeDetectorRef.current.stop();
      volumeDetectorRef.current = null;
    }
    setIsRecording(false);
    setVolumeLevel(0);
    setIsSpeakingLive(false);
  };

  const handleGrade = async () => {
    setIsGrading(true);
    setErrorMsg(null);

    try {
      let audioBase64: string | undefined = undefined;
      if (recordedBlobRef.current && recordedBlobRef.current.size > 0) {
        audioBase64 = await blobToBase64(recordedBlobRef.current);
      }

      if (!audioBase64 && !transcriptDraft.trim()) {
        setErrorMsg('Please record your response or enter your spoken text before grading.');
        setIsGrading(false);
        return;
      }

      const clientMetrics = {
        durationSeconds: recordingSeconds || 60,
        wordsPerMinute: transcriptDraft ? Math.round((transcriptDraft.split(/\s+/).length / (recordingSeconds || 60)) * 60) : 130,
        pausesCount: longPausesCount,
        totalPauseDurationSeconds: Math.round(longPausesCount * 2.2),
      };

      const response = await requestSpeakingGrading({
        partNumber: activePart,
        topic: partData.topic,
        cueCard: partData.cueCard ? JSON.stringify(partData.cueCard) : undefined,
        audioBase64,
        transcriptProvided: transcriptDraft.trim() || undefined,
        clientMetrics,
      });

      setResult(response);
      onRecordScore?.(response.band_overall);

      if (response.band_overall >= 7.0) {
        confetti({
          particleCount: 80,
          spread: 70,
          origin: { y: 0.6 },
        });
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to grade speaking response.');
    } finally {
      setIsGrading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Header & Part Tabs */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-rose-50 text-rose-600 flex items-center justify-center font-bold">
            <Mic className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-slate-900">Academic Speaking Assessment</h1>
            <p className="text-xs text-slate-500">
              Live microphone capture with pause detection, audio AI transcription and band scoring.
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          <div className="inline-flex p-1 bg-slate-100 rounded-xl">
            <button
              id="btn-switch-sp-part1"
              onClick={() => {
                setActivePart(1);
                setResult(null);
              }}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                activePart === 1 ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Part 1 (Intro)
            </button>
            <button
              id="btn-switch-sp-part2"
              onClick={() => {
                setActivePart(2);
                setResult(null);
              }}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                activePart === 2 ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Part 2 (Cue Card)
            </button>
            <button
              id="btn-switch-sp-part3"
              onClick={() => {
                setActivePart(3);
                setResult(null);
              }}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                activePart === 3 ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Part 3 (Discussion)
            </button>
          </div>

          {onBackToMocks && (
            <button
              onClick={onBackToMocks}
              className="px-3 py-1.5 text-xs text-slate-600 hover:text-slate-900 font-medium"
            >
              Back to Hub
            </button>
          )}
        </div>
      </div>

      {/* Main Grid: Prompts/Cue Card on Left, Live Audio Station on Right */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Prompts & Prep Timer */}
        <div className="lg:col-span-5 space-y-4">
          <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-rose-700 bg-rose-50 px-2.5 py-1 rounded-md border border-rose-200">
                Speaking Part {activePart}
              </span>
              <span className="text-xs text-slate-500 font-medium">{partData.topic}</span>
            </div>

            {/* Optional HTML Visual or Context Prompt */}
            {partData.htmlContent && (
              <div className="p-4 rounded-xl border border-slate-200 bg-slate-50">
                <CdiHtmlViewer id={`speaking-html-part-${activePart}`} html={partData.htmlContent} />
              </div>
            )}

            {/* Part 2 Cue Card Display */}
            {activePart === 2 && partData.cueCard ? (
              <div className="space-y-4">
                <div className="p-4 rounded-xl border-2 border-dashed border-rose-200 bg-rose-50/40 space-y-3">
                  <div className="text-xs font-bold text-slate-900 uppercase tracking-wider">
                    Candidate Task Card:
                  </div>
                  <h3 className="text-sm font-bold text-slate-900">{partData.cueCard.topic}</h3>
                  <div className="text-xs text-slate-700 space-y-1">
                    <p className="font-semibold text-slate-800">You should say:</p>
                    <ul className="list-disc list-inside space-y-1 text-slate-600">
                      {partData.cueCard.points.map((pt, i) => (
                        <li key={i}>{pt}</li>
                      ))}
                    </ul>
                  </div>
                </div>

                {/* 1-Minute Prep Countdown & Notes */}
                <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-1.5 text-xs font-bold text-slate-800">
                      <Clock className="w-4 h-4 text-indigo-600" />
                      <span>1-Minute Preparation Time</span>
                    </div>
                    <span className="text-xs font-mono font-bold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded">
                      {prepSecondsLeft}s
                    </span>
                  </div>

                  {!isPrepping && prepSecondsLeft === 60 && (
                    <button
                      id="btn-start-prep-timer"
                      onClick={startPrepTimer}
                      className="w-full py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-lg shadow-sm"
                    >
                      Start 1-Min Preparation Countdown
                    </button>
                  )}

                  {isPrepping && (
                    <div className="text-xs text-indigo-800 animate-pulse font-medium">
                      Preparation time running... jot down key ideas and transition phrases below!
                    </div>
                  )}

                  <textarea
                    rows={4}
                    value={cueNotes}
                    onChange={(e) => setCueNotes(e.target.value)}
                    placeholder="Candidate scratchpad: Note down keywords, collocations, and story milestones..."
                    className="w-full p-2.5 text-xs rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-slate-900 bg-white"
                  />
                </div>
              </div>
            ) : (
              /* Part 1 or 3 Questions */
              <div className="space-y-3">
                <div className="text-xs font-bold text-slate-800">Examiner Questions:</div>
                <div className="space-y-2">
                  {partData.questions.map((q, idx) => (
                    <div
                      key={idx}
                      className="p-3 rounded-xl bg-slate-50 border border-slate-100 text-xs text-slate-800 leading-relaxed"
                    >
                      <span className="font-bold text-slate-500 mr-2">Q{idx + 1}.</span>
                      {q}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Audio Recording Station */}
        <div className="lg:col-span-7 space-y-4">
          <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-6">
            {/* Live Recording HUD */}
            <div className="text-center py-6 border rounded-2xl bg-slate-50 border-slate-200 space-y-4">
              <div className="flex items-center justify-center space-x-2">
                <span
                  className={`w-3 h-3 rounded-full ${
                    isRecording ? 'bg-rose-500 animate-ping' : 'bg-slate-300'
                  }`}
                />
                <span className="text-xs font-bold uppercase tracking-wider text-slate-600">
                  {isRecording ? 'Live Microphone Active' : 'Microphone Ready'}
                </span>
              </div>

              {/* Timer Display */}
              <div className="text-4xl font-extrabold font-mono text-slate-900 tracking-tight">
                {Math.floor(recordingSeconds / 60)
                  .toString()
                  .padStart(2, '0')}
                :{(recordingSeconds % 60).toString().padStart(2, '0')}
              </div>

              {/* Live Audio Level Meter */}
              <div className="max-w-xs mx-auto space-y-1.5">
                <div className="flex justify-between text-[10px] text-slate-400 font-mono">
                  <span>Input Volume</span>
                  <span className={isSpeakingLive ? 'text-emerald-600 font-bold' : ''}>
                    {isSpeakingLive ? 'VOICE DETECTED' : 'SILENCE'}
                  </span>
                </div>
                <div className="w-full h-3 bg-slate-200 rounded-full overflow-hidden p-0.5">
                  <div
                    className={`h-full rounded-full transition-all duration-75 ${
                      isSpeakingLive ? 'bg-emerald-500' : 'bg-slate-400'
                    }`}
                    style={{ width: `${Math.min(100, volumeLevel * 100)}%` }}
                  />
                </div>
              </div>

              {/* Metric live counter */}
              <div className="flex justify-center items-center space-x-6 text-xs text-slate-500 pt-2">
                <div>
                  <span className="font-bold text-slate-800">{longPausesCount}</span> long pauses (&gt;2s)
                </div>
                <div className="border-l border-slate-200 pl-6">
                  Target: <span className="font-bold text-slate-800">{activePart === 2 ? '120s' : '45-60s'}</span>
                </div>
              </div>

              {/* Controls */}
              <div className="flex items-center justify-center space-x-3 pt-2">
                {!isRecording ? (
                  <button
                    id="btn-start-speaking-recording"
                    onClick={startRecording}
                    className="inline-flex items-center space-x-2 px-6 py-3 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-sm shadow-md transition-all cursor-pointer"
                  >
                    <Mic className="w-4 h-4" />
                    <span>Start Recording</span>
                  </button>
                ) : (
                  <button
                    id="btn-stop-speaking-recording"
                    onClick={stopRecording}
                    className="inline-flex items-center space-x-2 px-6 py-3 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-sm shadow-md transition-all cursor-pointer"
                  >
                    <Square className="w-4 h-4 text-rose-400" />
                    <span>Stop Recording</span>
                  </button>
                )}
              </div>
            </div>

            {/* Optional Manual Transcript / Fallback Area */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold text-slate-700 flex items-center space-x-1">
                  <FileEdit className="w-3.5 h-3.5 text-slate-400" />
                  <span>Spoken Words or Transcript (Optional / Microphone Fallback)</span>
                </label>
                <span className="text-[11px] text-slate-400">
                  Audio is automatically transcribed by Gemini
                </span>
              </div>
              <textarea
                rows={3}
                value={transcriptDraft}
                onChange={(e) => setTranscriptDraft(e.target.value)}
                placeholder="If using text fallback or reviewing transcription, type your response here..."
                className="w-full p-3 text-xs rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-slate-900"
              />
            </div>

            {errorMsg && (
              <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-700 flex items-center space-x-2">
                <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
                <span>{errorMsg}</span>
              </div>
            )}

            {/* Submit Action */}
            <div className="flex justify-end pt-2">
              <button
                id="btn-submit-speaking-grade"
                onClick={handleGrade}
                disabled={isGrading || (recordingSeconds === 0 && !transcriptDraft.trim())}
                className="inline-flex items-center space-x-2 px-6 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 text-white font-semibold text-sm transition-all shadow-md cursor-pointer"
              >
                {isGrading ? (
                  <>
                    <Activity className="w-4 h-4 animate-spin text-white" />
                    <span>Grading Audio & Fluency...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4 text-rose-400" />
                    <span>Evaluate with AI Examiner</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Results Display */}
      {result && (
        <div className="bg-white p-6 sm:p-8 rounded-3xl border border-slate-200 shadow-lg space-y-6">
          {/* Overall Band header */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-6 border-b border-slate-100 gap-4">
            <div>
              <span className="text-xs font-bold uppercase tracking-wider text-rose-700 bg-rose-50 px-2.5 py-1 rounded-md border border-rose-200">
                Official Speaking Assessment
              </span>
              <h2 className="text-xl font-extrabold text-slate-900 mt-1">
                Speaking Part {activePart} Band Result
              </h2>
              <p className="text-xs text-slate-500">
                Transcribed and evaluated across the four official IELTS speaking descriptors.
              </p>
            </div>

            <div className="flex items-center space-x-4 bg-slate-50 p-4 rounded-2xl border border-slate-200 shrink-0">
              <div className="text-right">
                <div className="text-xs font-semibold text-slate-500">Overall Score</div>
                <div className="text-xs text-slate-400 font-mono">
                  {result.objective_metrics.wordsPerMinute} WPM
                </div>
              </div>
              <div className="w-14 h-14 rounded-2xl bg-rose-600 text-white flex items-center justify-center font-extrabold text-2xl shadow-md">
                {result.band_overall.toFixed(1)}
              </div>
            </div>
          </div>

          {/* Transcript verbatim */}
          <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200 space-y-2">
            <div className="text-xs font-bold text-slate-700 uppercase tracking-wider">
              Examiner Transcript Verbatim:
            </div>
            <p className="text-xs font-serif text-slate-900 leading-relaxed italic">
              "{result.transcript}"
            </p>
          </div>

          {/* Objective metrics card */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-slate-900 text-white p-4 rounded-2xl">
            <div>
              <div className="text-[10px] text-slate-400">Duration</div>
              <div className="text-base font-bold mt-0.5">{result.objective_metrics.durationSeconds}s</div>
            </div>
            <div>
              <div className="text-[10px] text-slate-400">Speaking Pace</div>
              <div className="text-base font-bold text-emerald-400 mt-0.5">
                {result.objective_metrics.wordsPerMinute} WPM
              </div>
            </div>
            <div>
              <div className="text-[10px] text-slate-400">Hesitation Pauses (&gt;2s)</div>
              <div className="text-base font-bold text-amber-400 mt-0.5">
                {result.objective_metrics.pausesCount} pauses
              </div>
            </div>
            <div>
              <div className="text-[10px] text-slate-400">Total Pause Time</div>
              <div className="text-base font-bold mt-0.5">
                {result.objective_metrics.totalPauseDurationSeconds}s
              </div>
            </div>
          </div>

          {/* 4 Criteria Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {Object.entries(result.criteria).map(([key, critVal]) => {
              const crit = critVal as CriterionFeedback;
              return (
                <div
                  key={key}
                  className="p-4 rounded-xl border border-slate-200 bg-white space-y-2 shadow-sm"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                      {key.replace('_', ' ')}
                    </span>
                    <span className="text-sm font-extrabold px-2 py-0.5 rounded-md bg-slate-900 text-white">
                      {crit.band.toFixed(1)}
                    </span>
                  </div>

                  {key === 'pronunciation' && (
                    <span className="text-[9px] text-amber-700 font-semibold bg-amber-50 px-1.5 py-0.5 rounded">
                      Approximate (AI Audio)
                    </span>
                  )}

                  <p className="text-xs text-slate-600 leading-relaxed">{crit.justification}</p>

                  {crit.improvement_tips && crit.improvement_tips.length > 0 && (
                    <div className="pt-2 border-t border-slate-100 text-[11px] text-slate-600">
                      <span className="font-bold text-rose-700 block mb-0.5">Focus:</span>
                      {crit.improvement_tips[0]}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Actionable Drills */}
          {result.actionable_drills && result.actionable_drills.length > 0 && (
            <div className="bg-rose-50/50 border border-rose-200 p-4 rounded-2xl space-y-2">
              <div className="flex items-center space-x-1.5 text-xs font-bold text-rose-900">
                <Zap className="w-4 h-4 text-rose-600" />
                <span>Examiner Prescribed Drills:</span>
              </div>
              <ul className="text-xs text-rose-950 space-y-1 list-disc list-inside">
                {result.actionable_drills.map((drill, dIdx) => (
                  <li key={dIdx}>{drill}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
