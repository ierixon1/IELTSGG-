import React, { useState, useEffect } from 'react';
import { WritingTaskData, WritingGradingResult, TextAnnotation } from '../types';
import { requestWritingGrading } from '../services/api';
import { 
  PenTool, 
  Clock, 
  Sparkles, 
  AlertTriangle, 
  CheckCircle2, 
  BarChart2, 
  FileText, 
  RefreshCw,
  Info,
  ChevronRight,
  Lightbulb
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { CdiHtmlViewer } from './common/CdiHtmlViewer';

interface WritingSessionProps {
  task1Data: WritingTaskData;
  task2Data: WritingTaskData;
  onRecordScore?: (taskNumber: 1 | 2, band: number) => void;
  onBackToMocks?: () => void;
}

export const WritingSession: React.FC<WritingSessionProps> = ({
  task1Data,
  task2Data,
  onRecordScore,
  onBackToMocks,
}) => {
  const [selectedTask, setSelectedTask] = useState<1 | 2>(2);
  const [essayText, setEssayText] = useState<string>('');
  const [isGrading, setIsGrading] = useState<boolean>(false);
  const [result, setResult] = useState<WritingGradingResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [selectedAnnotation, setSelectedAnnotation] = useState<TextAnnotation | null>(null);

  // Timer state (recommended: Task 1 = 20m, Task 2 = 40m)
  const [secondsRemaining, setSecondsRemaining] = useState<number>(40 * 60);
  const [isTimerRunning, setIsTimerRunning] = useState<boolean>(false);

  const activeTaskData = selectedTask === 1 ? task1Data : task2Data;

  useEffect(() => {
    // Reset timer when switching task
    const totalSecs = (selectedTask === 1 ? 20 : 40) * 60;
    setSecondsRemaining(totalSecs);
    setIsTimerRunning(false);
    setResult(null);
    setSelectedAnnotation(null);
  }, [selectedTask]);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    if (isTimerRunning && secondsRemaining > 0) {
      interval = setInterval(() => {
        setSecondsRemaining((prev) => Math.max(0, prev - 1));
      }, 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isTimerRunning, secondsRemaining]);

  const words = essayText.trim().split(/\s+/).filter((w) => w.length > 0);
  const wordCount = words.length;
  const minRequired = activeTaskData.minWordCount;
  const isUnderLength = wordCount < minRequired && wordCount > 0;

  const formatTimer = (totalSeconds: number) => {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const handleGrade = async () => {
    if (wordCount === 0) {
      setErrorMsg('Please write or paste your response before submitting for AI assessment.');
      return;
    }

    setIsGrading(true);
    setErrorMsg(null);
    setSelectedAnnotation(null);

    try {
      const grading = await requestWritingGrading({
        taskType: selectedTask === 1 ? 'task1' : 'task2',
        prompt: `${activeTaskData.title}\n${activeTaskData.prompt}`,
        essay: essayText,
      });

      setResult(grading);
      onRecordScore?.(selectedTask, grading.band_overall);

      if (grading.band_overall >= 7.0) {
        confetti({
          particleCount: 80,
          spread: 70,
          origin: { y: 0.6 },
        });
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to grade writing.');
    } finally {
      setIsGrading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Header & Task Switcher */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-2xl border border-ink-200 shadow-sm">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-warning-50 text-warning-500 flex items-center justify-center font-bold">
            <PenTool className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-ink-900">Academic Writing Evaluation</h1>
            <p className="text-xs text-ink-500">
              Official 4-criteria AI analysis with inline annotation in under 15 seconds.
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          <div className="inline-flex p-1 bg-ink-100 rounded-xl">
            <button
              id="btn-switch-task1"
              onClick={() => setSelectedTask(1)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                selectedTask === 1
                  ? 'bg-white text-ink-900 shadow-sm'
                  : 'text-ink-600 hover:text-ink-900'
              }`}
            >
              Task 1 (Report, 150w)
            </button>
            <button
              id="btn-switch-task2"
              onClick={() => setSelectedTask(2)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                selectedTask === 2
                  ? 'bg-white text-ink-900 shadow-sm'
                  : 'text-ink-600 hover:text-ink-900'
              }`}
            >
              Task 2 (Essay, 250w)
            </button>
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

      {/* Main Workspace (Split View: Prompt & Chart on Left, Editor on Right) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Prompt & Visual Data */}
        <div className="lg:col-span-5 space-y-4">
          <div className="bg-white p-5 rounded-2xl border border-ink-200 shadow-sm space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-warning-700 bg-warning-50 px-2.5 py-1 rounded-md border border-warning-50">
                Writing Task {selectedTask}
              </span>
              <span className="text-xs text-ink-500 font-medium">
                Rec: {selectedTask === 1 ? '20' : '40'} minutes
              </span>
            </div>

            <h2 className="text-base font-bold text-ink-900 leading-snug">
              {activeTaskData.title}
            </h2>

            {activeTaskData.htmlContent ? (
              <div className="bg-ink-50 p-4 rounded-xl border border-ink-100">
                <CdiHtmlViewer id={`writing-task-html-${selectedTask}`} html={activeTaskData.htmlContent} />
              </div>
            ) : /<[a-z][\s\S]*>/i.test(activeTaskData.prompt) ? (
              <div className="bg-ink-50 p-4 rounded-xl border border-ink-100">
                <CdiHtmlViewer id={`writing-task-html-${selectedTask}`} html={activeTaskData.prompt} />
              </div>
            ) : (
              <div className="text-xs text-ink-700 bg-ink-50 p-4 rounded-xl border border-ink-100 whitespace-pre-line leading-relaxed font-normal">
                {activeTaskData.prompt}
              </div>
            )}

            {/* Task 1 Chart Data Presentation */}
            {selectedTask === 1 && activeTaskData.chartDataSummary && (
              <div className="p-4 bg-ink-900 text-ink-100 rounded-xl space-y-2 text-xs">
                <div className="flex items-center space-x-2 font-bold text-warning-500">
                  <BarChart2 className="w-4 h-4" />
                  <span>{activeTaskData.chartDescription || 'Data Summary'}</span>
                </div>
                <pre className="font-mono text-[11px] text-ink-300 leading-relaxed overflow-x-auto whitespace-pre-wrap">
                  {activeTaskData.chartDataSummary}
                </pre>
              </div>
            )}

            {/* Sample Band 9 Excerpt hint */}
            {activeTaskData.sampleBand9Excerpt && (
              <div className="p-3 bg-success-50 border border-success-50 rounded-xl text-xs text-success-700 space-y-1">
                <div className="flex items-center space-x-1.5 font-bold text-success-700">
                  <Lightbulb className="w-3.5 h-3.5 text-success-500" />
                  <span>Examiner Sample Overview (Band 9 Excerpt):</span>
                </div>
                <p className="italic text-success-700 font-serif leading-relaxed">
                  "{activeTaskData.sampleBand9Excerpt}"
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Writing Editor & Word Counter */}
        <div className="lg:col-span-7 space-y-4">
          <div className="bg-white p-5 rounded-2xl border border-ink-200 shadow-sm space-y-4">
            {/* Editor Toolbar */}
            <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-ink-100">
              {/* Word Count Indicator */}
              <div className="flex items-center space-x-3">
                <div
                  className={`px-3 py-1 rounded-lg text-xs font-bold transition-all ${
                    wordCount >= minRequired
                      ? 'bg-success-50 text-success-700'
                      : wordCount > 0
                      ? 'bg-warning-50 text-warning-700'
                      : 'bg-ink-100 text-ink-600'
                  }`}
                >
                  {wordCount} / {minRequired} words minimum
                </div>

                {isUnderLength && (
                  <span className="text-[11px] text-warning-500 flex items-center space-x-1 font-medium">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    <span>Under length ({minRequired - wordCount} words needed)</span>
                  </span>
                )}
              </div>

              {/* Timer Controls */}
              <div className="flex items-center space-x-2">
                <div className="flex items-center space-x-1 text-xs font-mono font-bold text-ink-700 bg-ink-100 px-2.5 py-1 rounded-md">
                  <Clock className="w-3.5 h-3.5 text-ink-500" />
                  <span>{formatTimer(secondsRemaining)}</span>
                </div>
                <button
                  id="btn-toggle-writing-timer"
                  onClick={() => setIsTimerRunning(!isTimerRunning)}
                  className="text-xs px-2.5 py-1 rounded-md border border-ink-200 hover:bg-ink-50 text-ink-600 font-semibold"
                >
                  {isTimerRunning ? 'Pause' : 'Start Timer'}
                </button>
              </div>
            </div>

            {/* Textarea */}
            <textarea
              id="textarea-essay-input"
              rows={16}
              value={essayText}
              onChange={(e) => setEssayText(e.target.value)}
              placeholder={`Type or paste your IELTS Writing Task ${selectedTask} response here...\n\nStructure tip:\n- Introduction (Paraphrase prompt + Overview/Thesis)\n- Body Paragraph 1 (Main trend / Arguments with evidence)\n- Body Paragraph 2 (Secondary trend / Counterargument)\n${selectedTask === 2 ? '- Conclusion (Restate position)' : ''}`}
              className="w-full p-4 rounded-xl border border-ink-200 text-ink-900 text-sm font-sans leading-relaxed focus:outline-none focus:ring-2 focus:ring-ink-900 resize-y"
            />

            {errorMsg && (
              <div className="p-3 rounded-xl bg-danger-50 border border-danger-50 text-xs text-danger-700 flex items-center space-x-2">
                <AlertTriangle className="w-4 h-4 shrink-0 text-danger-500" />
                <span>{errorMsg}</span>
              </div>
            )}

            {/* Action buttons */}
            <div className="flex items-center justify-between pt-2">
              <button
                id="btn-clear-essay"
                onClick={() => {
                  if (confirm('Clear essay draft?')) setEssayText('');
                }}
                className="text-xs text-ink-400 hover:text-ink-600 font-medium"
              >
                Clear Draft
              </button>

              <button
                id="btn-submit-writing-grade"
                onClick={handleGrade}
                disabled={isGrading || wordCount === 0}
                className="inline-flex items-center space-x-2 px-6 py-2.5 rounded-xl bg-ink-900 hover:bg-ink-800 disabled:bg-ink-300 text-white font-semibold text-sm transition-all shadow-md cursor-pointer"
              >
                {isGrading ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin text-white" />
                    <span>Analyzing Band & Criteria...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4 text-warning-500" />
                    <span>Evaluate with AI Examiner</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* AI Grading Results Display (Structured Breakdown) */}
      {result && (
        <div className="bg-white p-6 sm:p-8 rounded-3xl border border-ink-200 shadow-lg space-y-6">
          {/* Header Band Score */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-6 border-b border-ink-100 gap-4">
            <div className="space-y-1">
              <span className="text-xs font-bold uppercase tracking-wider text-success-700 bg-success-50 px-2.5 py-1 rounded-md border border-success-50">
                Official Multi-Criteria Verdict
              </span>
              <h2 className="text-xl font-extrabold text-ink-900">
                Writing Task {selectedTask} Band Assessment
              </h2>
              <p className="text-xs text-ink-500">
                Evaluated against official Cambridge/IDP IELTS Band Descriptors.
              </p>
            </div>

            <div className="flex items-center space-x-4 bg-ink-50 p-4 rounded-2xl border border-ink-200 shrink-0">
              <div className="text-right">
                <div className="text-xs font-semibold text-ink-500">Overall Score</div>
                <div className="text-xs text-ink-400 font-mono">{result.word_count} words</div>
              </div>
              <div className="w-14 h-14 rounded-2xl bg-success-500 text-white flex items-center justify-center font-extrabold text-2xl shadow-md">
                {result.band_overall.toFixed(1)}
              </div>
            </div>
          </div>

          {/* General Examiner Commentary */}
          <div className="bg-ink-50 p-4 rounded-xl border border-ink-200 text-xs text-ink-800 leading-relaxed">
            <span className="font-bold text-ink-900">Examiner Summary: </span>
            {result.general_commentary}
          </div>

          {/* 4 Criteria Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {result.criteria.map((crit, idx) => (
              <div
                key={crit.name || idx}
                className="p-4 rounded-xl border border-ink-200 bg-white space-y-2.5 shadow-sm"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-ink-700 uppercase tracking-wider">
                    {crit.name.replace('_', ' ')}
                  </span>
                  <span className="text-sm font-extrabold px-2 py-0.5 rounded-md bg-ink-900 text-white">
                    {crit.band.toFixed(1)}
                  </span>
                </div>

                <p className="text-xs text-ink-600 leading-relaxed">{crit.justification}</p>

                {crit.improvement_tips && crit.improvement_tips.length > 0 && (
                  <div className="pt-2 border-t border-ink-100">
                    <div className="text-[11px] font-bold text-warning-700 mb-1">To reach next band:</div>
                    <ul className="text-[11px] text-ink-600 space-y-1 list-disc list-inside">
                      {crit.improvement_tips.slice(0, 2).map((tip, tIdx) => (
                        <li key={tIdx}>{tip}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Annotated Text & Error Highlights */}
          {result.annotated_text && result.annotated_text.length > 0 && (
            <div className="space-y-3 pt-4 border-t border-ink-100">
              <div className="flex items-center space-x-2">
                <h3 className="text-sm font-bold text-ink-900">
                  Targeted Annotations & Corrections ({result.annotated_text.length})
                </h3>
                <span className="text-xs text-ink-400">
                  Click any card to inspect examiner recommendation
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {result.annotated_text.map((ann, aIdx) => (
                  <div
                    key={aIdx}
                    onClick={() => setSelectedAnnotation(ann)}
                    className={`p-3.5 rounded-xl border transition-all cursor-pointer ${
                      selectedAnnotation === ann
                        ? 'border-brand-600 bg-brand-50/40 ring-1 ring-brand-600'
                        : 'border-ink-200 hover:border-ink-300 bg-white'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-danger-50 text-danger-700 border border-danger-50">
                        {ann.issue_type}
                      </span>
                      <span className="text-[10px] text-ink-400">Tap to expand</span>
                    </div>

                    <div className="text-xs font-serif text-ink-800 bg-danger-50/50 p-1.5 rounded border border-danger-50 mb-2">
                      "{ann.span}"
                    </div>

                    <div className="text-xs text-ink-600 mb-2">{ann.comment}</div>

                    <div className="text-xs font-semibold text-success-700 bg-success-50 p-2 rounded-lg border border-success-50 flex items-center space-x-1.5">
                      <CheckCircle2 className="w-3.5 h-3.5 text-success-500 shrink-0" />
                      <span>Suggested: "{ann.suggestion}"</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
