import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Award, Clock, Layers, ShieldAlert } from 'lucide-react';
import confetti from 'canvas-confetti';
import type { MockAttempt } from '../types';
import { BUNDLE_SECTIONS, minutesKey, type BundleSection, type LearnerBundleSummary } from '../types/bundle';
import {
  buildExamPlan,
  canFinishSection,
  createExamRun,
  currentSection,
  examReducer,
  examResult,
  ExamPlanError,
  remainingSeconds,
  sectionReadiness,
  toExamAttempt,
  type ExamEvent,
  type ExamRunState,
  type MissingItem,
} from '../services/examRun';
import {
  fetchExamSitting,
  fetchLearnerBundles,
  sittingToAdaptedTest,
  type SittableTest,
  type SittingLoad,
} from '../services/publishedTests';
import { ListeningSession } from './ListeningSession';
import { ReadingSession } from './ReadingSession';
import { WritingSession } from './WritingSession';
import { SpeakingSession } from './SpeakingSession';
import { useT } from '../i18n';
import { Badge, Button, Card, cx } from './ui';

interface ExamModeProps {
  onCompleteExam: (attempt: MockAttempt) => void;
  onExitExam: () => void;
}

type ErrorCode = Extract<SittingLoad, { ok: false }>['code'];

type Screen =
  | { kind: 'choose' }
  | { kind: 'loading'; bundleId: string }
  | { kind: 'error'; bundleId: string; code: ErrorCode; message: string }
  | { kind: 'ready'; test: SittableTest; run: ExamRunState };

const clock = (seconds: number) =>
  `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;

/**
 * The full exam: a published bundle, sat end to end.
 *
 * Only a published bundle can be sat here, opened through the server, which
 * resolves it to exactly the materials it pinned or refuses with a reason. There
 * is no built-in test behind this screen and nothing is filled in when a
 * bundle cannot be opened: the learner is told what is wrong instead.
 *
 * Every rule of the sitting lives in `examRun`: which section is current, how
 * long it has, when it may end, what it scores. This component renders that
 * state and turns what the learner does into events.
 */
export const ExamMode: React.FC<ExamModeProps> = ({ onCompleteExam, onExitExam }) => {
  const t = useT();
  const [screen, setScreen] = useState<Screen>({ kind: 'choose' });
  const [bundles, setBundles] = useState<LearnerBundleSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [focusLossCount, setFocusLossCount] = useState(0);
  const [showFocusWarning, setShowFocusWarning] = useState(false);
  const reported = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchLearnerBundles().then((load) => {
      if (!active) return;
      if (load.ok) setBundles(load.bundles);
      else setListError(load.message);
    });
    return () => {
      active = false;
    };
  }, []);

  const run = screen.kind === 'ready' ? screen.run : null;
  const running = Boolean(run?.startedAt !== undefined && run?.finishedAt === undefined);

  const dispatch = useCallback((event: ExamEvent) => {
    setScreen((current) => (current.kind === 'ready' ? { ...current, run: examReducer(current.run, event) } : current));
  }, []);

  // One clock drives both the timer on screen and the section closing on time.
  useEffect(() => {
    if (!running) return;
    const interval = setInterval(() => {
      const moment = Date.now();
      setNow(moment);
      dispatch({ type: 'tick', now: moment });
    }, 1000);
    return () => clearInterval(interval);
  }, [running, dispatch]);

  useEffect(() => {
    if (!running) return;
    const onVisibility = () => {
      if (document.hidden) {
        setFocusLossCount((count) => count + 1);
        setShowFocusWarning(true);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [running]);

  // Report the finished attempt exactly once.
  useEffect(() => {
    if (!run || run.finishedAt === undefined || reported.current === run.attemptId) return;
    reported.current = run.attemptId;
    const attempt = toExamAttempt(run);
    onCompleteExam(attempt);
    if ((attempt.scores.overall ?? 0) >= 7) confetti({ particleCount: 120, spread: 80, origin: { y: 0.5 } });
  }, [run, onCompleteExam]);

  const openBundle = async (bundleId: string) => {
    setScreen({ kind: 'loading', bundleId });
    const load = await fetchExamSitting(bundleId);
    if (!load.ok) {
      setScreen({ kind: 'error', bundleId, code: load.code, message: load.message });
      return;
    }
    try {
      const plan = buildExamPlan(load.sitting);
      const adapted = sittingToAdaptedTest(load.sitting);
      if (adapted.missingSections.length > 0) {
        setScreen({ kind: 'error', bundleId, code: 'invalid_bundle', message: `Missing: ${adapted.missingSections.join(', ')}.` });
        return;
      }
      setScreen({ kind: 'ready', test: adapted.test, run: createExamRun(plan, `attempt-${crypto.randomUUID()}`) });
    } catch (error) {
      if (!(error instanceof ExamPlanError)) throw error;
      setScreen({ kind: 'error', bundleId, code: 'invalid_bundle', message: error.message });
    }
  };

  const describeMissing = (item: MissingItem) =>
    item.kind === 'answers'
      ? t('exam.missingAnswers')
      : item.kind === 'writing_task'
        ? t('exam.missingTask', { task: item.task })
        : t('exam.missingPart', { part: item.part });

  const sectionName = (section: BundleSection) => t(`skills.${section}`);

  /* ------------------------------------------------------------ choose */
  if (screen.kind === 'choose' || screen.kind === 'loading') {
    return (
      <div className="space-y-6" id="exam-bundle-catalog">
        <Card className="p-6 sm:p-8">
          <Badge tone="neutral">
            <Layers className="h-3 w-3" />
            {t('exam.chooseEyebrow')}
          </Badge>
          <h1 className="mt-3 text-display-sm text-ink-900">{t('exam.chooseTitle')}</h1>
          <p className="mt-2 text-sm text-ink-500">{t('exam.chooseSubtitle')}</p>
        </Card>

        {listError && (
          <p id="exam-list-error" className="rounded-[var(--radius-card)] border border-danger-500/30 bg-danger-50 p-4 text-sm text-danger-700">
            {t('exam.listError')} {listError}
          </p>
        )}
        {!listError && bundles === null && <p className="text-sm text-ink-500">{t('exam.loadingList')}</p>}
        {bundles?.length === 0 && (
          <p id="exam-no-bundles" className="text-sm text-ink-500">
            {t('exam.noExams')}
          </p>
        )}

        <div className="grid gap-3 md:grid-cols-2">
          {bundles?.map((bundle) => (
            <Card key={bundle.id} className="space-y-3 p-5" data-bundle-id={bundle.id} data-available={String(bundle.available)}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="font-display text-base font-bold text-ink-900">{bundle.title}</h2>
                  {bundle.description && <p className="mt-1 text-xs text-ink-500">{bundle.description}</p>}
                </div>
                <Badge tone="neutral">{bundle.module === 'general' ? 'GT' : 'AC'}</Badge>
              </div>
              <p className="text-xs text-ink-600">
                {t('exam.parts', { listening: bundle.parts.listening, reading: bundle.parts.reading })}
              </p>
              <p className="flex items-center gap-1.5 text-xs text-ink-600">
                <Clock className="h-3.5 w-3.5" />
                {t('exam.totalMinutes', { minutes: bundle.totalMinutes })} ·{' '}
                {bundle.timing.basis === 'ielts_reference' ? t('exam.timingReference') : t('exam.timingCustom')}
              </p>
              {!bundle.available && (
                <p className="text-xs font-semibold text-danger-700" data-problem={bundle.problem}>
                  {t('exam.unavailable')} — {t(`exam.errors.${bundle.problem ?? 'invalid_bundle'}.title`)}
                </p>
              )}
              <Button
                id={`btn-open-exam-${bundle.id}`}
                size="sm"
                disabled={screen.kind === 'loading'}
                onClick={() => void openBundle(bundle.id)}
              >
                {screen.kind === 'loading' && screen.bundleId === bundle.id ? t('exam.opening') : t('exam.open')}
              </Button>
            </Card>
          ))}
        </div>

        <Button variant="ghost" onClick={onExitExam}>
          {t('exam.backToPlan')}
        </Button>
      </div>
    );
  }

  /* ------------------------------------------------------------- error */
  if (screen.kind === 'error') {
    return (
      <div
        id="exam-configuration-error"
        data-code={screen.code}
        data-bundle-id={screen.bundleId}
        className="es-enter rounded-[var(--radius-card)] border border-danger-500/30 bg-danger-50 p-6"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-danger-600" />
          <div className="space-y-2">
            <h2 className="text-base font-bold text-danger-800">{t(`exam.errors.${screen.code}.title`)}</h2>
            <p className="text-sm leading-relaxed text-danger-700">{t(`exam.errors.${screen.code}.body`)}</p>
            <p className="text-xs text-danger-700">{screen.message}</p>
            <p className="font-mono text-[11px] text-danger-600">
              {screen.bundleId} · {screen.code}
            </p>
            <Button variant="secondary" size="sm" onClick={() => setScreen({ kind: 'choose' })}>
              {t('exam.back')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const { test } = screen;
  const state = screen.run;
  const plan = state.plan;

  /* ------------------------------------------------------------- ready */
  if (state.startedAt === undefined) {
    return (
      <Card className="space-y-4 p-6 sm:p-8" id="exam-ready">
        <Badge tone="neutral">{plan.bundleTitle}</Badge>
        <h1 className="text-display-sm text-ink-900">{t('exam.readyTitle')}</h1>
        <p className="text-sm text-ink-600">{t('exam.readyBody')}</p>
        <ul className="grid gap-2 sm:grid-cols-2">
          {BUNDLE_SECTIONS.map((section) => (
            <li key={section} data-section-minutes={section} className="rounded-[var(--radius-control)] border border-ink-100 bg-ink-50 px-3 py-2 text-sm text-ink-700">
              {t('exam.sectionMinutes', { name: sectionName(section), minutes: plan.timing[minutesKey(section)] })}
            </li>
          ))}
        </ul>
        <p className="text-xs text-ink-500">
          {plan.timing.basis === 'ielts_reference' ? t('exam.timingReference') : t('exam.timingCustom')} ·{' '}
          {plan.timing.allowEarlyFinish ? t('exam.earlyFinishAllowed') : t('exam.earlyFinishLocked')}
        </p>
        <div className="flex gap-2">
          <Button id="btn-start-exam" onClick={() => dispatch({ type: 'start', now: Date.now() })}>
            {t('exam.start')}
          </Button>
          <Button variant="ghost" onClick={() => setScreen({ kind: 'choose' })}>
            {t('exam.back')}
          </Button>
        </div>
      </Card>
    );
  }

  /* ---------------------------------------------------------- finished */
  if (state.finishedAt !== undefined) {
    const result = examResult(state);
    return (
      <div className="mx-auto max-w-3xl" id="exam-result" data-complete={String(result.complete)}>
        <Card className="space-y-6 p-8 text-center">
          <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-success-50 text-success-700">
            <Award className="h-8 w-8" />
          </span>
          <div>
            <Badge tone={result.complete ? 'success' : 'neutral'}>{t('exam.doneEyebrow')}</Badge>
            <h1 className="mt-3 text-display-sm text-ink-900">
              {result.complete ? t('exam.doneTitle') : t('exam.incompleteTitle')}
            </h1>
            <p className="mt-1.5 text-sm text-ink-500">{result.complete ? t('exam.doneSubtitle') : t('exam.incompleteBody')}</p>
          </div>

          {result.complete && result.overall !== undefined && (
            <div className="es-ink-surface mx-auto max-w-sm space-y-1.5 rounded-[var(--radius-card)] p-6" id="exam-overall">
              <p className="text-[0.625rem] font-bold uppercase tracking-[0.12em] text-white/50">{t('exam.overall')}</p>
              <p className="font-mono text-display-lg font-bold tabular text-white">{result.overall.toFixed(1)}</p>
              <p className="text-xs text-white/45">{t('exam.roundingNote')}</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {BUNDLE_SECTIONS.map((section) => {
              const band = result.bands[section];
              const status = state.sections[section].status;
              return (
                <div key={section} data-section-result={section} data-status={status} className="rounded-[var(--radius-control)] border border-ink-100 bg-ink-50 p-4">
                  <p className="text-[0.625rem] font-bold uppercase tracking-[0.1em] text-ink-400">{sectionName(section)}</p>
                  <p className={cx('mt-1 font-mono text-2xl font-bold tabular', band === undefined ? 'text-ink-300' : 'text-ink-900')}>
                    {band === undefined ? '—' : band.toFixed(1)}
                  </p>
                  {band === undefined && (
                    <p className="mt-0.5 text-[0.625rem] text-ink-400">{status === 'expired' ? t('exam.sectionExpired') : t('exam.notSat')}</p>
                  )}
                </div>
              );
            })}
          </div>

          {focusLossCount > 0 && (
            <p className="flex items-center justify-center gap-2 rounded-[var(--radius-control)] border border-warning-500/25 bg-warning-50 p-3 text-sm text-warning-700">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {t('exam.focusSummary', { count: focusLossCount })}
            </p>
          )}

          <div className="flex justify-center pt-2">
            <Button size="lg" onClick={onExitExam}>
              {t('exam.backToPlan')}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  /* ----------------------------------------------------------- running */
  const section = currentSection(state);
  if (!section || !test.listening || !test.reading || !test.speaking || !test.writing.task1 || !test.writing.task2) {
    // Unreachable once a plan was built from the sitting; refuse rather than render a partial exam.
    return (
      <div id="exam-configuration-error" data-code="invalid_bundle" className="rounded-[var(--radius-card)] border border-danger-500/30 bg-danger-50 p-6 text-sm text-danger-700">
        {t('exam.errors.invalid_bundle.body')}
      </div>
    );
  }

  const readiness = sectionReadiness(state, section.section);
  const finish = canFinishSection(state, now);
  const secondsLeft = remainingSeconds(state, now);
  const index = state.currentIndex;

  return (
    <div className="space-y-6" id="exam-running" data-section={section.section}>
      <div className="flex flex-col justify-between gap-3 rounded-[var(--radius-card)] bg-warning-500 p-4 text-white sm:flex-row sm:items-center">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-white/20">
            <ShieldAlert className="h-5 w-5" />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded bg-white/20 px-2 py-0.5 text-[0.6875rem] font-bold uppercase tracking-[0.1em]">{t('exam.banner')}</span>
              <span className="text-xs font-medium">
                {t('exam.section', { current: index + 1, total: plan.sections.length, name: sectionName(section.section) })}
              </span>
            </div>
            <p className="mt-1 text-xs text-white/85">{t('exam.lockdown')}</p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <span
            id="exam-section-clock"
            data-seconds-left={secondsLeft}
            data-section-duration={section.durationSeconds}
            className="inline-flex items-center gap-1.5 rounded-[var(--radius-control)] bg-black/20 px-3 py-1.5 font-mono text-sm font-bold tabular"
            title={t('exam.timeLeft')}
          >
            <Clock className="h-4 w-4" />
            {clock(secondsLeft)}
          </span>
          <button
            onClick={() => {
              if (window.confirm(t('exam.abortConfirm'))) onExitExam();
            }}
            className="rounded-[var(--radius-control)] bg-black/20 px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-black/30"
          >
            {t('exam.abort')}
          </button>
        </div>
      </div>

      {showFocusWarning && (
        <div className="flex flex-col justify-between gap-3 rounded-[var(--radius-card)] border border-danger-500/30 bg-danger-50 p-4 text-danger-700 sm:flex-row sm:items-center">
          <p className="flex items-start gap-2 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <strong>{t('exam.focusLostTitle')}.</strong> {t('exam.focusLostBody')}
            </span>
          </p>
          <Button variant="secondary" size="sm" onClick={() => setShowFocusWarning(false)}>
            {t('exam.acknowledge')}
          </Button>
        </div>
      )}

      <div key={section.section}>
        {section.section === 'listening' && (
          <ListeningSession
            listeningData={test.listening}
            examMode
            onAnswersChange={(answers) => Object.entries(answers).forEach(([questionId, value]) => dispatch({ type: 'answer', questionId, value }))}
            onSubmitAnswers={() => dispatch({ type: 'submit_answers', now: Date.now() })}
          />
        )}
        {section.section === 'reading' && (
          <ReadingSession
            readingData={test.reading}
            examMode
            onAnswersChange={(answers) => Object.entries(answers).forEach(([questionId, value]) => dispatch({ type: 'answer', questionId, value }))}
            onSubmitAnswers={() => dispatch({ type: 'submit_answers', now: Date.now() })}
          />
        )}
        {section.section === 'writing' && (
          <WritingSession
            task1Data={test.writing.task1}
            task2Data={test.writing.task2}
            examMode
            onTaskGraded={(task, band, essay) => dispatch({ type: 'writing_graded', task, band, essay })}
          />
        )}
        {section.section === 'speaking' && (
          <SpeakingSession
            speakingData={test.speaking}
            onPartGraded={(part, band, transcript) => dispatch({ type: 'speaking_graded', part, band, transcript })}
          />
        )}
      </div>

      <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between" id="exam-section-footer">
        <p className="text-sm text-ink-600" data-missing={readiness.missing.map((item) => item.kind).join(',')}>
          {!readiness.ready
            ? t('exam.finishBlocked', { items: readiness.missing.map(describeMissing).join(', ') })
            : !finish.allowed && finish.reason === 'early_finish_disabled'
              ? t('exam.earlyFinishDisabled')
              : ''}
        </p>
        <Button
          id="btn-finish-section"
          disabled={!finish.allowed}
          onClick={() => dispatch({ type: 'finish_section', now: Date.now() })}
        >
          {t('exam.finishSection', { name: sectionName(section.section) })}
        </Button>
      </Card>
    </div>
  );
};
