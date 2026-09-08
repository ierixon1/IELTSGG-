import React, { useEffect, useState } from 'react';
import { WritingTaskData, WritingGradingResult, TextAnnotation } from '../types';
import { requestWritingGrading } from '../services/api';
import {
  AlertTriangle,
  BarChart2,
  CheckCircle2,
  Clock,
  Lightbulb,
  PenTool,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { useT } from '../i18n';
import { Badge, Button, Card, cx } from './ui';
import { CdiHtmlViewer } from './common/CdiHtmlViewer';

interface WritingSessionProps {
  task1Data: WritingTaskData;
  task2Data: WritingTaskData;
  onRecordScore?: (taskNumber: 1 | 2, band: number) => void;
  onBackToMocks?: () => void;
}

/** Recommended minutes per task, as printed on the real paper. */
const TASK_MINUTES: Record<1 | 2, number> = { 1: 20, 2: 40 };

function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

export const WritingSession: React.FC<WritingSessionProps> = ({
  task1Data,
  task2Data,
  onRecordScore,
  onBackToMocks,
}) => {
  const t = useT();
  const [selectedTask, setSelectedTask] = useState<1 | 2>(2);
  const [essayText, setEssayText] = useState('');
  const [isGrading, setIsGrading] = useState(false);
  const [result, setResult] = useState<WritingGradingResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [selectedAnnotation, setSelectedAnnotation] = useState<TextAnnotation | null>(null);

  const [secondsRemaining, setSecondsRemaining] = useState(TASK_MINUTES[2] * 60);
  const [isTimerRunning, setIsTimerRunning] = useState(false);

  const activeTaskData = selectedTask === 1 ? task1Data : task2Data;

  useEffect(() => {
    setSecondsRemaining(TASK_MINUTES[selectedTask] * 60);
    setIsTimerRunning(false);
    setResult(null);
    setSelectedAnnotation(null);
  }, [selectedTask]);

  useEffect(() => {
    if (!isTimerRunning || secondsRemaining <= 0) return;
    const interval = setInterval(() => {
      setSecondsRemaining((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [isTimerRunning, secondsRemaining]);

  const wordCount = essayText.trim().split(/\s+/).filter(Boolean).length;
  const minRequired = activeTaskData.minWordCount;
  const isUnderLength = wordCount > 0 && wordCount < minRequired;

  const handleGrade = async () => {
    if (wordCount === 0) {
      setErrorMsg(t('writing.needText'));
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
        confetti({ particleCount: 80, spread: 70, origin: { y: 0.6 } });
      }
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : 'Failed to grade writing.');
    } finally {
      setIsGrading(false);
    }
  };

  const promptLooksLikeHtml = /<[a-z][\s\S]*>/i.test(activeTaskData.prompt);

  return (
    <div className="space-y-6">
      <Card className="flex flex-col justify-between gap-5 p-5 sm:flex-row sm:items-center">
        <div className="flex items-center gap-3.5">
          <span className="inline-flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] bg-writing-tint text-writing-ink">
            <PenTool className="h-5 w-5" />
          </span>
          <div>
            <h1 className="font-display text-lg font-bold text-ink-900">{t('writing.title')}</h1>
            <p className="text-sm text-ink-500">{t('writing.subtitle')}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-[var(--radius-control)] bg-ink-100 p-1">
            {([1, 2] as const).map((task) => (
              <button
                key={task}
                id={`btn-switch-task${task}`}
                onClick={() => setSelectedTask(task)}
                className={cx(
                  'rounded-lg px-3 py-1.5 text-xs font-bold transition-all',
                  selectedTask === task
                    ? 'bg-white text-ink-900 shadow-[var(--shadow-xs)]'
                    : 'text-ink-600 hover:text-ink-900',
                )}
              >
                {t(`writing.task${task}`)}
              </button>
            ))}
          </div>

          {onBackToMocks && (
            <Button variant="ghost" size="sm" onClick={onBackToMocks}>
              {t('writing.backToHub')}
            </Button>
          )}
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-12">
        {/* Prompt column */}
        <div className="space-y-4 lg:col-span-5">
          <Card className="space-y-4 p-5">
            <div className="flex items-center justify-between gap-3">
              <Badge tone="writing">{t('writing.taskLabel', { number: selectedTask })}</Badge>
              <span className="text-xs text-ink-500">
                {t('writing.recommended', { minutes: TASK_MINUTES[selectedTask] })}
              </span>
            </div>

            <h2 className="font-display text-base font-bold leading-snug text-ink-900">
              {activeTaskData.title}
            </h2>

            {activeTaskData.htmlContent ? (
              <div className="rounded-[var(--radius-control)] border border-ink-100 bg-ink-50 p-4">
                <CdiHtmlViewer
                  id={`writing-task-html-${selectedTask}`}
                  html={activeTaskData.htmlContent}
                />
              </div>
            ) : promptLooksLikeHtml ? (
              <div className="rounded-[var(--radius-control)] border border-ink-100 bg-ink-50 p-4">
                <CdiHtmlViewer
                  id={`writing-task-html-${selectedTask}`}
                  html={activeTaskData.prompt}
                />
              </div>
            ) : (
              <p className="whitespace-pre-line rounded-[var(--radius-control)] border border-ink-100 bg-ink-50 p-4 text-sm leading-relaxed text-ink-700">
                {activeTaskData.prompt}
              </p>
            )}

            {selectedTask === 1 && activeTaskData.chartDataSummary && (
              <div className="es-ink-surface space-y-2 rounded-[var(--radius-control)] p-4">
                <p className="flex items-center gap-2 text-sm font-bold text-brand-200">
                  <BarChart2 className="h-4 w-4" />
                  {activeTaskData.chartDescription || t('writing.dataSummary')}
                </p>
                <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-white/70">
                  {activeTaskData.chartDataSummary}
                </pre>
              </div>
            )}

            {activeTaskData.sampleBand9Excerpt && (
              <div className="rounded-[var(--radius-control)] border border-success-500/20 bg-success-50 p-3.5">
                <p className="flex items-center gap-1.5 text-xs font-bold text-success-700">
                  <Lightbulb className="h-3.5 w-3.5" />
                  {t('writing.sampleLabel')}
                </p>
                <p className="mt-1.5 text-sm italic leading-relaxed text-success-700">
                  “{activeTaskData.sampleBand9Excerpt}”
                </p>
              </div>
            )}
          </Card>
        </div>

        {/* Editor column */}
        <div className="space-y-4 lg:col-span-7">
          <Card className="space-y-4 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 pb-3">
              <div className="flex flex-wrap items-center gap-3">
                <span
                  className={cx(
                    'rounded-[var(--radius-control)] px-3 py-1 text-xs font-bold tabular',
                    wordCount >= minRequired
                      ? 'bg-success-50 text-success-700'
                      : wordCount > 0
                        ? 'bg-warning-50 text-warning-700'
                        : 'bg-ink-100 text-ink-600',
                  )}
                >
                  {t('writing.wordCount', { count: wordCount, min: minRequired })}
                </span>

                {isUnderLength && (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-warning-700">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    {t('writing.underLength', { count: minRequired - wordCount })}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-md bg-ink-100 px-2.5 py-1 font-mono text-xs font-bold tabular text-ink-700">
                  <Clock className="h-3.5 w-3.5 text-ink-500" />
                  {formatClock(secondsRemaining)}
                </span>
                <Button
                  id="btn-toggle-writing-timer"
                  variant="secondary"
                  size="sm"
                  onClick={() => setIsTimerRunning((running) => !running)}
                >
                  {isTimerRunning ? t('writing.pauseTimer') : t('writing.startTimer')}
                </Button>
              </div>
            </div>

            <textarea
              id="textarea-essay-input"
              rows={16}
              value={essayText}
              onChange={(event) => setEssayText(event.target.value)}
              placeholder={t('writing.placeholder')}
              className="w-full resize-y rounded-[var(--radius-control)] border border-ink-200 p-4 text-sm leading-relaxed text-ink-900 outline-none focus:border-brand-400"
            />

            {errorMsg && (
              <div className="flex items-start gap-2 rounded-[var(--radius-control)] border border-danger-500/25 bg-danger-50 p-3 text-sm text-danger-700">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{errorMsg}</span>
              </div>
            )}

            <div className="flex items-center justify-between pt-1">
              <Button
                id="btn-clear-essay"
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (window.confirm(t('writing.clearConfirm'))) setEssayText('');
                }}
              >
                {t('writing.clearDraft')}
              </Button>

              <Button
                id="btn-submit-writing-grade"
                onClick={handleGrade}
                disabled={isGrading || wordCount === 0}
              >
                {isGrading ? (
                  <>
                    <RefreshCw className="h-4 w-4 animate-spin" />
                    {t('writing.grading')}
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4" />
                    {t('writing.grade')}
                  </>
                )}
              </Button>
            </div>
          </Card>
        </div>
      </div>

      {result && (
        <Card className="space-y-6 p-6 sm:p-8">
          <div className="flex flex-col justify-between gap-4 border-b border-ink-100 pb-6 sm:flex-row sm:items-center">
            <div>
              <Badge tone="brand">{t('writing.result.eyebrow')}</Badge>
              <h2 className="mt-2.5 text-display-sm text-ink-900">
                {t('writing.result.title', { number: selectedTask })}
              </h2>
              <p className="mt-1.5 max-w-xl text-xs leading-relaxed text-ink-400">
                {t('writing.result.note')}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-4 rounded-[var(--radius-card)] bg-ink-50 px-5 py-4">
              <div className="text-right">
                <p className="text-[0.625rem] font-bold uppercase tracking-[0.12em] text-ink-400">
                  {t('writing.result.band')}
                </p>
                <p className="mt-0.5 font-mono text-xs tabular text-ink-400">
                  {t('writing.result.words', { count: result.word_count })}
                </p>
              </div>
              <span className="flex h-14 w-14 items-center justify-center rounded-[var(--radius-control)] bg-brand-500 font-mono text-2xl font-bold tabular text-white">
                {result.band_overall.toFixed(1)}
              </span>
            </div>
          </div>

          <div className="rounded-[var(--radius-card)] bg-ink-50 p-4 text-sm leading-relaxed text-ink-800">
            <span className="font-bold text-ink-900">{t('writing.result.summary')}: </span>
            {result.general_commentary}
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {result.criteria.map((criterion, index) => (
              <div
                key={criterion.name || index}
                className="rounded-[var(--radius-card)] border border-ink-100 p-4"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-xs font-bold text-ink-700">
                    {t(`writing.criteria.${criterion.name}`)}
                  </span>
                  <span className="rounded-md bg-ink-900 px-2 py-0.5 font-mono text-sm font-bold tabular text-white">
                    {criterion.band.toFixed(1)}
                  </span>
                </div>

                <p className="mt-2.5 text-sm leading-relaxed text-ink-600">
                  {criterion.justification}
                </p>

                {criterion.improvement_tips?.length > 0 && (
                  <div className="mt-3 border-t border-ink-100 pt-3">
                    <p className="text-[0.6875rem] font-bold uppercase tracking-[0.08em] text-brand-600">
                      {t('writing.result.nextBand')}
                    </p>
                    <ul className="mt-1 list-inside list-disc space-y-1 text-sm text-ink-600">
                      {criterion.improvement_tips.slice(0, 2).map((tip, tipIndex) => (
                        <li key={tipIndex}>{tip}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ))}
          </div>

          {result.annotated_text?.length > 0 && (
            <div className="space-y-3 border-t border-ink-100 pt-5">
              <div className="flex flex-wrap items-baseline gap-2">
                <h3 className="font-display text-base font-bold text-ink-900">
                  {t('writing.result.annotations', { count: result.annotated_text.length })}
                </h3>
                <span className="text-xs text-ink-400">{t('writing.result.annotationsHint')}</span>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                {result.annotated_text.map((annotation, index) => (
                  <button
                    key={index}
                    onClick={() => setSelectedAnnotation(annotation)}
                    className={cx(
                      'rounded-[var(--radius-card)] border p-4 text-left transition-all',
                      selectedAnnotation === annotation
                        ? 'border-brand-500 bg-brand-50/50'
                        : 'border-ink-100 bg-white hover:border-ink-300',
                    )}
                  >
                    <Badge tone="danger">{annotation.issue_type}</Badge>

                    <p className="mt-2.5 rounded border border-danger-500/20 bg-danger-50 p-2 text-sm italic text-ink-800">
                      “{annotation.span}”
                    </p>

                    <p className="mt-2 text-sm text-ink-600">{annotation.comment}</p>

                    <p className="mt-2.5 flex items-start gap-1.5 rounded-lg bg-success-50 p-2.5 text-sm font-semibold text-success-700">
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>
                        {t('writing.result.suggested')}: “{annotation.suggestion}”
                      </span>
                    </p>
                  </button>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
};
