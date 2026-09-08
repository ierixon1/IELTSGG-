import React, { useState, useEffect, useRef } from 'react';
import { STANDALONE_SPEAK_OR_DIE_TOPICS } from '../data/mockBank';
import { AudioVolumeDetector } from '../utils/audioAnalyzer';
import { 
  Flame, 
  Play, 
  RotateCcw, 
  Volume2, 
  VolumeX, 
  Skull, 
  Trophy, 
  Zap, 
  AlertTriangle,
  Mic,
  ShieldCheck
} from 'lucide-react';
import confetti from 'canvas-confetti';

type Difficulty = 'easy' | 'medium' | 'hard' | 'extra_hard';

const DIFFICULTY_CONFIG: Record<Difficulty, { label: string; silenceLimitSecs: number; color: string }> = {
  easy: { label: 'Easy', silenceLimitSecs: 12, color: 'text-success-500 border-success-500' },
  medium: { label: 'Medium', silenceLimitSecs: 10, color: 'text-brand-500 border-brand-500' },
  hard: { label: 'Hard', silenceLimitSecs: 5, color: 'text-warning-500 border-warning-500' },
  extra_hard: { label: 'Extra Hard', silenceLimitSecs: 2.5, color: 'text-danger-500 border-danger-500' },
};

export const SpeakOrDieArcade: React.FC = () => {
  const [gameState, setGameState] = useState<'idle' | 'playing' | 'survived' | 'dead'>('idle');
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
  const [topicIndex, setTopicIndex] = useState<number>(0);

  // Audio & speech detection state
  const [volumeLevel, setVolumeLevel] = useState<number>(0);
  const [isSpeaking, setIsSpeaking] = useState<boolean>(false);
  const [consecutiveSilenceSecs, setConsecutiveSilenceSecs] = useState<number>(0);
  const [survivalTimeSecs, setSurvivalTimeSecs] = useState<number>(0);
  const [bestRecordSecs, setBestRecordSecs] = useState<number>(() => {
    const saved = localStorage.getItem('prepielts_sod_best');
    return saved ? parseFloat(saved) : 0;
  });

  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);

  const volumeDetectorRef = useRef<AudioVolumeDetector | null>(null);
  const gameLoopRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioFxCtxRef = useRef<AudioContext | null>(null);

  const currentTopic = STANDALONE_SPEAK_OR_DIE_TOPICS[topicIndex % STANDALONE_SPEAK_OR_DIE_TOPICS.length];
  const silenceLimit = DIFFICULTY_CONFIG[difficulty].silenceLimitSecs;
  const targetSurvivalSecs = 120; // 2 minutes standard IELTS Part 2

  // Web Audio sound synthesizer for sound effects
  const playBeep = (freq: number, type: OscillatorType = 'sine', duration = 0.1) => {
    if (!soundEnabled) return;
    try {
      if (!audioFxCtxRef.current) {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        audioFxCtxRef.current = new AudioCtx();
      }
      const ctx = audioFxCtxRef.current;
      if (ctx.state === 'suspended') ctx.resume();

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, ctx.currentTime);

      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start();
      osc.stop(ctx.currentTime + duration);
    } catch (e) {
      // audio context restriction
    }
  };

  const startGame = async () => {
    try {
      const detector = new AudioVolumeDetector(0.025, 300);
      volumeDetectorRef.current = detector;

      await detector.start({
        onVolumeUpdate: (vol, speaking) => {
          setVolumeLevel(vol);
          setIsSpeaking(speaking);
        },
      });

      setConsecutiveSilenceSecs(0);
      setSurvivalTimeSecs(0);
      setGameState('playing');

      playBeep(440, 'triangle', 0.2);
    } catch (err) {
      alert('Microphone access is required to play Speak or Die!');
    }
  };

  // Main game loop (100ms ticks)
  useEffect(() => {
    if (gameState === 'playing') {
      gameLoopRef.current = setInterval(() => {
        // Update survival time
        setSurvivalTimeSecs((prev) => {
          const next = prev + 0.1;
          if (next >= targetSurvivalSecs) {
            handleVictory();
            return targetSurvivalSecs;
          }
          return next;
        });

        // Update silence penalty
        setConsecutiveSilenceSecs((silence) => {
          if (isSpeaking) {
            // Speech immediately recovers life
            return Math.max(0, silence - 0.25);
          } else {
            const nextSilence = silence + 0.1;

            // Audio warning tick when reaching critical threshold
            if (nextSilence > silenceLimit * 0.6 && Math.floor(nextSilence * 10) % 5 === 0) {
              playBeep(300 + nextSilence * 60, 'sawtooth', 0.08);
            }

            if (nextSilence >= silenceLimit) {
              handleDeath();
              return silenceLimit;
            }
            return nextSilence;
          }
        });
      }, 100);
    }

    return () => {
      if (gameLoopRef.current) clearInterval(gameLoopRef.current);
    };
  }, [gameState, isSpeaking, silenceLimit]);

  const handleVictory = () => {
    setGameState('survived');
    stopMicrophone();
    playBeep(880, 'sine', 0.5);

    confetti({
      particleCount: 150,
      spread: 90,
      origin: { y: 0.5 },
    });

    if (120 > bestRecordSecs) {
      setBestRecordSecs(120);
      localStorage.setItem('prepielts_sod_best', '120');
    }
  };

  const handleDeath = () => {
    setGameState('dead');
    stopMicrophone();
    playBeep(120, 'sawtooth', 0.6);

    setSurvivalTimeSecs((finalSecs) => {
      if (finalSecs > bestRecordSecs) {
        setBestRecordSecs(Math.round(finalSecs));
        localStorage.setItem('prepielts_sod_best', Math.round(finalSecs).toString());
      }
      return finalSecs;
    });
  };

  const stopMicrophone = () => {
    if (volumeDetectorRef.current) {
      volumeDetectorRef.current.stop();
      volumeDetectorRef.current = null;
    }
    if (gameLoopRef.current) {
      clearInterval(gameLoopRef.current);
      gameLoopRef.current = null;
    }
    setVolumeLevel(0);
    setIsSpeaking(false);
  };

  const handleNextTopic = () => {
    setTopicIndex((prev) => prev + 1);
  };

  // Percentage of danger (0% = safe, 100% = saw strikes)
  const dangerRatio = Math.min(1, consecutiveSilenceSecs / silenceLimit);
  const sawPositionPercent = Math.round(dangerRatio * 85); // moves down from 0 to 85%

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Top Banner */}
      <div className="bg-gradient-to-r from-danger-700 via-ink-900 to-ink-900 text-white p-6 rounded-3xl border border-danger-700/40 shadow-xl flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center space-x-2">
            <span className="w-8 h-8 rounded-xl bg-danger-500 flex items-center justify-center font-bold text-white shadow-md">
              <Flame className="w-5 h-5 fill-current" />
            </span>
            <h1 className="text-xl font-extrabold tracking-tight">Speak or Die: Anti-Hesitation Arcade</h1>
          </div>
          <p className="text-xs text-ink-300">
            Overcome fear of silence in IELTS Speaking Part 2. Keep speaking or the saw descends!
          </p>
        </div>

        <div className="flex items-center space-x-3 bg-white/5 p-3 rounded-2xl border border-white/10 shrink-0">
          <Trophy className="w-5 h-5 text-warning-500" />
          <div>
            <div className="text-[10px] text-ink-400 uppercase font-semibold">Best Record</div>
            <div className="text-sm font-bold text-white">{bestRecordSecs.toFixed(1)}s / 120s</div>
          </div>
        </div>
      </div>

      {/* Cue Card Prompt & Controls */}
      <div className="bg-white p-6 rounded-2xl border border-ink-200 shadow-sm space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-ink-100">
          <div className="flex items-center space-x-2">
            <span className="text-xs font-bold uppercase tracking-wider text-danger-700 bg-danger-50 px-2.5 py-1 rounded-md border border-danger-50">
              Part 2 Cue Card
            </span>
            <button
              onClick={handleNextTopic}
              disabled={gameState === 'playing'}
              className="text-xs text-ink-500 hover:text-ink-800 font-semibold underline decoration-ink-300"
            >
              Shuffle Card
            </button>
          </div>

          {/* Difficulty selector */}
          <div className="flex items-center space-x-1.5">
            <span className="text-[11px] font-semibold text-ink-400 mr-1">Tolerance:</span>
            {(Object.keys(DIFFICULTY_CONFIG) as Difficulty[]).map((diff) => (
              <button
                key={diff}
                disabled={gameState === 'playing'}
                onClick={() => setDifficulty(diff)}
                className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all border ${
                  difficulty === diff
                    ? DIFFICULTY_CONFIG[diff].color + ' bg-ink-900 text-white'
                    : 'text-ink-500 border-ink-200 hover:bg-ink-50'
                }`}
              >
                {DIFFICULTY_CONFIG[diff].label} ({DIFFICULTY_CONFIG[diff].silenceLimitSecs}s)
              </button>
            ))}
          </div>
        </div>

        {/* The Selected Cue Card */}
        <div className="bg-ink-50 p-4 rounded-xl border border-ink-200 space-y-2">
          <h2 className="text-sm font-bold text-ink-900">{currentTopic.topic}</h2>
          <div className="text-xs text-ink-600">
            <span className="font-semibold text-ink-700">You should say: </span>
            {currentTopic.bulletPoints.join(' • ')}
          </div>
        </div>
      </div>

      {/* Main Arcade Stage */}
      <div className="bg-ink-950 text-white rounded-3xl p-6 sm:p-10 border border-ink-800 shadow-2xl relative overflow-hidden min-h-[380px] flex flex-col justify-between">
        {/* Top HUD: Survival Timer & Danger Meter */}
        <div className="flex items-center justify-between z-10">
          <div>
            <div className="text-[11px] text-ink-400 uppercase font-mono">Survival Time</div>
            <div className="text-3xl sm:text-4xl font-black font-mono text-success-500 tracking-tight">
              {survivalTimeSecs.toFixed(1)}s
              <span className="text-xs text-ink-500 font-normal ml-1">/ 120s</span>
            </div>
          </div>

          <div className="text-right">
            <div className="text-[11px] text-ink-400 uppercase font-mono">Silence Countdown</div>
            <div
              className={`text-2xl font-black font-mono ${
                consecutiveSilenceSecs > silenceLimit * 0.6 ? 'text-danger-500 animate-pulse' : 'text-ink-200'
              }`}
            >
              {(silenceLimit - consecutiveSilenceSecs).toFixed(1)}s left
            </div>
          </div>
        </div>

        {/* Center Arena: Interactive Mechanical Saw Blade & Avatar */}
        <div className="relative my-8 h-48 w-full max-w-md mx-auto flex flex-col items-center justify-center">
          {/* Warning Track */}
          <div className="absolute inset-y-0 w-1 bg-danger-700/40 rounded-full" />

          {/* The Spinning Saw Blade */}
          <div
            className="absolute transition-all duration-100 flex flex-col items-center z-20"
            style={{ top: `${sawPositionPercent}%` }}
          >
            {/* Saw Blade Graphic */}
            <div
              className={`w-16 h-16 rounded-full border-4 border-dashed border-danger-500 bg-danger-500/90 shadow-[0_0_20px_rgba(244,63,94,0.7)] flex items-center justify-center text-white ${
                gameState === 'playing' ? 'animate-spin' : ''
              }`}
            >
              <Zap className="w-8 h-8 fill-current" />
            </div>
            {consecutiveSilenceSecs > 1 && (
              <span className="text-[10px] font-mono font-bold text-danger-500 bg-black/80 px-1.5 py-0.5 rounded mt-1">
                SILENCE DANGER
              </span>
            )}
          </div>

          {/* The Candidate Avatar */}
          <div className="absolute bottom-2 flex flex-col items-center z-10">
            <div
              className={`w-14 h-14 rounded-2xl flex items-center justify-center text-2xl shadow-lg border-2 transition-transform ${
                isSpeaking
                  ? 'bg-success-500 border-success-500 scale-110'
                  : 'bg-ink-800 border-ink-700'
              }`}
            >
              {gameState === 'dead' ? '💀' : gameState === 'survived' ? '🏆' : isSpeaking ? '🗣️' : '🤐'}
            </div>
            <span className="text-[10px] text-ink-400 font-semibold mt-1">
              {isSpeaking ? 'SPEAKING' : 'SILENT'}
            </span>
          </div>
        </div>

        {/* Bottom Control Bar */}
        <div className="z-10 space-y-4">
          {/* Audio Volume Bar */}
          <div className="space-y-1 max-w-sm mx-auto">
            <div className="flex justify-between text-[10px] text-ink-400 font-mono">
              <span>Mic Voice Level</span>
              <span className={isSpeaking ? 'text-success-500 font-bold' : ''}>
                {isSpeaking ? 'VOICE SAFE' : 'PAUSED'}
              </span>
            </div>
            <div className="w-full h-2 bg-ink-800 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-75 ${
                  isSpeaking ? 'bg-success-500' : 'bg-ink-600'
                }`}
                style={{ width: `${Math.min(100, volumeLevel * 100)}%` }}
              />
            </div>
          </div>

          {/* Main Action Buttons */}
          <div className="flex items-center justify-center space-x-4 pt-2">
            {gameState === 'idle' && (
              <button
                id="btn-start-arcade"
                onClick={startGame}
                className="inline-flex items-center space-x-2 px-8 py-3.5 rounded-2xl bg-danger-500 hover:bg-danger-700 text-white font-extrabold text-sm shadow-xl transition-all cursor-pointer transform hover:scale-105"
              >
                <Mic className="w-4 h-4" />
                <span>Start Speaking Now</span>
              </button>
            )}

            {gameState === 'playing' && (
              <button
                id="btn-give-up-arcade"
                onClick={handleDeath}
                className="inline-flex items-center space-x-2 px-6 py-2.5 rounded-xl bg-ink-800 hover:bg-ink-700 text-ink-300 font-bold text-xs transition-all"
              >
                <Skull className="w-4 h-4 text-ink-400" />
                <span>Give Up</span>
              </button>
            )}

            {(gameState === 'dead' || gameState === 'survived') && (
              <div className="flex items-center space-x-3">
                <button
                  id="btn-restart-arcade"
                  onClick={startGame}
                  className="inline-flex items-center space-x-2 px-8 py-3.5 rounded-2xl bg-danger-500 hover:bg-danger-700 text-white font-extrabold text-sm shadow-xl transition-all cursor-pointer"
                >
                  <RotateCcw className="w-4 h-4" />
                  <span>Try Again (1-Click Restart)</span>
                </button>
                <button
                  onClick={handleNextTopic}
                  className="px-4 py-3.5 rounded-2xl bg-ink-800 hover:bg-ink-700 text-ink-200 font-bold text-xs"
                >
                  New Card
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Victory Overlay */}
        {gameState === 'survived' && (
          <div className="absolute inset-0 bg-success-700/90 backdrop-blur-sm z-30 flex flex-col items-center justify-center p-6 text-center space-y-4">
            <div className="w-16 h-16 rounded-2xl bg-success-500 text-white flex items-center justify-center text-3xl shadow-xl">
              🏆
            </div>
            <h2 className="text-2xl font-black text-white">Full 2-Minute Monologue Conquered!</h2>
            <p className="text-xs text-success-50 max-w-sm">
              You maintained continuous speech without freezing beyond the {silenceLimit}s limit! Your hesitation barrier is broken.
            </p>
            <button
              onClick={startGame}
              className="px-6 py-2.5 rounded-xl bg-white text-ink-900 font-bold text-xs shadow-lg hover:bg-success-50 transition-colors"
            >
              Play Again with Another Card
            </button>
          </div>
        )}

        {/* Death Overlay */}
        {gameState === 'dead' && (
          <div className="absolute inset-0 bg-danger-700/90 backdrop-blur-sm z-30 flex flex-col items-center justify-center p-6 text-center space-y-4">
            <div className="w-16 h-16 rounded-2xl bg-danger-500 text-white flex items-center justify-center text-3xl shadow-xl animate-bounce">
              ⚡
            </div>
            <h2 className="text-2xl font-black text-white tracking-wide uppercase">Hesitation Strike!</h2>
            <p className="text-xs text-danger-50 max-w-sm">
              Silence exceeded {silenceLimit} seconds! On the actual exam, this pause would drop your Fluency score.
              You survived <strong>{survivalTimeSecs.toFixed(1)} seconds</strong>.
            </p>
            <button
              onClick={startGame}
              className="px-6 py-2.5 rounded-xl bg-danger-500 hover:bg-danger-700 text-white font-bold text-xs shadow-lg transition-colors cursor-pointer"
            >
              Immediate Revenge (1-Click Restart)
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
