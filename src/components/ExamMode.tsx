import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Award, Clock, Layers, ShieldAlert } from 'lucide-react';
import confetti from 'canvas-confetti';
import type { AnswerValue, MockAttempt } from '../types';
import { BUNDLE_SECTIONS, minutesKey, type BundleSection, type LearnerBundleSummary } from '../types/bundle';
import type { ExamClientEvent, ExamPaper, ExamSessionSummary, ExamSessionView } from '../types/examSession';
import { canFinishSection, currentSection, examResult, remainingSeconds, sectionReadiness, type MissingItem } from '../services/examRun';
import { fetchLearnerBundles } from '../services/publishedTests';
import {
  abandonExamSession,
  getExamSession,
  gradeExamSpeaking,
  gradeExamWriting,
  listExamSessions,
  openExamSession,
  sendExamEvents,
  sendExamEventsOnExit,
  type SessionCall,
} from '../services/examSessionClient';
import { GradingError } from '../services/api';
import { ListeningSession } from './ListeningSession';
import { ReadingSession } from './ReadingSession';
import { WritingSession } from './WritingSession';
import { SpeakingSession, type SpokenAnswer } from './SpeakingSession';
import { useT } from '../i18n';
import { Badge, Button, Card, cx } from './ui';

interface ExamModeProps {
  /** Called once, with the attempt the server stored, when a sitting ends. */
  onCompleteExam: (attempt: MockAttempt) => void;
  onExitExam: () => void;
}

/** Refusals the error screen can explain; anything else is shown as a configuration error. */
const EXPLAINED_CODES = [
  'bundle_not_found',
  'bundle_unpublished',
  'bundle_archived',
  'component_missing',
  'component_unpublished',
  'component_changed',
  'asset_unavailable',
  'invalid_bundle',
  'unauthorized',
  'network',
  'session_superseded',
  'session_closed',
] as const;
type ErrorCode = (typeof EXPLAINED_CODES)[number];
const errorCodeOf = (code: string): ErrorCode => (EXPLAINED_CODES as readonly string[]).includes(code) ? (code as ErrorCode) : 'invalid_bundle';

/** Codes that mean the sitting cannot go on at all, as opposed to one request failing. */
const FATAL_CODES = new Set<string>(EXPLAINED_CODES.filter((code) => code !== 'network'));

type Screen =
  | { kind: 'choose' }
  | { kind: 'loading'; bundleId: string }
  | { kind: 'error'; bundleId: string; code: ErrorCode; message: string }
  | { kind: 'sitting'; bundleId: string; paper: ExamPaper; view: ExamSessionView; resumed: boolean };

const clock = (seconds: number) =>
  `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;

/** How long typing may go unsent. Anything still pending is flushed before a submit, a finish, or leaving the page. */
const ANSWER_FLUSH_MS = 700;
const DRAFT_FLUSH_MS = 1500;

/**
 * The full exam: a published bundle, sat end to end through a server-held
 * exam session.
 *
 * This screen renders the session and sends it what the learner does. It holds
 * no answer key, keeps no clock that decides anything, and computes no band: the
 * server marks, times and records. The clock shown here counts down to the
 * deadline the server set, corrected by the server's own time, and when it
 * reaches zero the screen asks the server, which closes the section.
 *
 * Progress survives a reload: answers and essay drafts are stored as they are
 * typed, and reopening the exam resumes the same session, with the time spent
 * away counted — the clock does not stop because the page did.
 */
export const ExamMode: React.FC<ExamModeProps> = ({ onCompleteExam, onExitExam }) => {
  const t = useT();
  const [screen, setScreen] = useState<Screen>({ kind: 'choose' });
  const [bundles, setBundles] = useState<LearnerBundleSummary[] | null>(null);
  const [sessions, setSessions] = useState<ExamSessionSummary[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [focusLossCount, setFocusLossCount] = useState(0);
  const [showFocusWarning, setShowFocusWarning] = useState(false);

  const sessionIdRef = useRef<string | null>(null);
  const offsetRef = useRef(0);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingAnswers = useRef<Record<string, AnswerValue>>({});
  const pendingDrafts = useRef<Partial<Record<1 | 2, string>>>({});
  const answerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncing = useRef(false);
  const reported = useRef<string | null>(null);

  const loadCatalog = useCallback(() => {
    fetchLearnerBundles().then((load) => {
      if (load.ok) setBundles(load.bundles);
      else setListError(load.message);
    });
    listExamSessions().then((load) => {
      if (load.ok) setSessions(load.value.sessions);
    });
  }, []);

  useEffect(() => loadCatalog(), [loadCatalog]);

  const view = screen.kind === 'sitting' ? screen.view : null;
  const running = Boolean(view && view.status === 'active' && view.run.startedAt !== undefined);
  const serverNow = now + offsetRef.current;

  /** Takes a view the server returned as the truth, and resets the clock correction from it. */
  const adopt = useCallback((next: ExamSessionView) => {
    offsetRef.current = next.serverNow - Date.now();
    setNow(Date.now());
    setScreen((current) => (current.kind === 'sitting' && current.view.sessionId === next.sessionId ? { ...current, view: next } : current));
  }, []);

  const refuse = useCallback((bundleId: string, failure: Extract<SessionCall<unknown>, { ok: false }>) => {
    setScreen({ kind: 'error', bundleId, code: errorCodeOf(failure.code), message: failure.message });
  }, []);

  /** Pending typing, as events. Taking them clears them; a failed send puts them back. */
  const takePending = (): ExamClientEvent[] => {
    const events: ExamClientEvent[] = [];
    if (Object.keys(pendingAnswers.current).length > 0) {
      events.push({ type: 'answers', answers: pendingAnswers.current });
      pendingAnswers.current = {};
    }
    for (const task of [1, 2] as const) {
      const text = pendingDrafts.current[task];
      if (text !== undefined) events.push({ type: 'writing_draft', task, text });
    }
    pendingDrafts.current = {};
    return events;
  };

  const restorePending = (events: ExamClientEvent[]) => {
    for (const event of events) {
      if (event.type === 'answers') pendingAnswers.current = { ...event.answers, ...pendingAnswers.current };
      if (event.type === 'writing_draft' && pendingDrafts.current[event.task] === undefined) pendingDrafts.current[event.task] = event.text;
    }
  };

  /** Sends events in order, one request at a time, with whatever typing is still pending in front of them. */
  const send = useCallback(
    (events: ExamClientEvent[]): Promise<void> => {
      const run = async () => {
        const sessionId = sessionIdRef.current;
        if (!sessionId) return;
        const batch = [...takePending(), ...events];
        if (batch.length === 0) return;
        const result = await sendExamEvents(sessionId, batch);
        if (result.ok) {
          setSaveError(null);
          adopt(result.value);
          return;
        }
        if (FATAL_CODES.has(result.code)) {
          setScreen((current) => (current.kind === 'sitting' ? { kind: 'error', bundleId: current.bundleId, code: errorCodeOf(result.code), message: result.message } : current));
          return;
        }
        restorePending(batch);
        setSaveError(result.message);
      };
      queueRef.current = queueRef.current.then(run, run);
      return queueRef.current;
    },
    [adopt],
  );

  const queueAnswers = useCallback(
    (answers: Record<string, AnswerValue>) => {
      pendingAnswers.current = { ...pendingAnswers.current, ...answers };
      if (answerTimer.current) clearTimeout(answerTimer.current);
      answerTimer.current = setTimeout(() => void send([]), ANSWER_FLUSH_MS);
    },
    [send],
  );

  const queueDraft = useCallback(
    (task: 1 | 2, text: string) => {
      pendingDrafts.current = { ...pendingDrafts.current, [task]: text };
      if (draftTimer.current) clearTimeout(draftTimer.current);
      draftTimer.current = setTimeout(() => void send([]), DRAFT_FLUSH_MS);
    },
    [send],
  );

  // The on-screen clock. It decides nothing: at zero it asks the server, which closes the section.
  useEffect(() => {
    if (!running) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [running]);

  useEffect(() => {
    if (!view || !running || syncing.current) return;
    if (remainingSeconds(view.run, serverNow) > 0) return;
    syncing.current = true;
    void send([{ type: 'sync' }]).finally(() => {
      syncing.current = false;
    });
  }, [view, running, serverNow, send]);

  // Typing still pending when the page is hidden or unloaded is sent on the way out.
  useEffect(() => {
    if (!running) return;
    const flushOnExit = () => {
      const sessionId = sessionIdRef.current;
      if (sessionId) sendExamEventsOnExit(sessionId, takePending());
    };
    const onVisibility = () => {
      if (document.hidden) {
        flushOnExit();
        setFocusLossCount((count) => count + 1);
        setShowFocusWarning(true);
      }
    };
    window.addEventListener('pagehide', flushOnExit);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flushOnExit);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [running]);

  // Report the stored attempt exactly once.
  useEffect(() => {
    const attempt = view?.attempt;
    if (!view || view.status !== 'finished' || !view.attemptSaved || !attempt || reported.current === attempt.id) return;
    reported.current = attempt.id;
    onCompleteExam(attempt);
    if ((attempt.scores.overall ?? 0) >= 7) confetti({ particleCount: 120, spread: 80, origin: { y: 0.5 } });
  }, [view, onCompleteExam]);

  const openBundle = async (bundleId: string) => {
    setScreen({ kind: 'loading', bundleId });
    const opened = await openExamSession(bundleId);
    if (!opened.ok) {
      refuse(bundleId, opened);
      return;
    }
    sessionIdRef.current = opened.value.sessionId;
    offsetRef.current = opened.value.serverNow - Date.now();
    pendingAnswers.current = {};
    pendingDrafts.current = {};
    setSaveError(null);
    setNow(Date.now());
    setScreen({ kind: 'sitting', bundleId, paper: opened.value.paper, view: opened.value, resumed: opened.value.resumed });
  };

  const leave = async () => {
    const sessionId = sessionIdRef.current;
    if (sessionId) await abandonExamSession(sessionId);
    sessionIdRef.current = null;
    onExitExam();
  };

  /** Grades one Writing task through the session; a refusal reaches the screen as a `GradingError`. */
  const gradeWriting = async (task: 1 | 2, essay: string) => {
    await send([]);
    const sessionId = sessionIdRef.current;
    if (!sessionId) throw new GradingError('session_closed', 'The exam session is not open.');
    const graded = await gradeExamWriting(sessionId, task, essay);
    if (!graded.ok) {
      if (FATAL_CODES.has(graded.code) && screen.kind === 'sitting') refuse(screen.bundleId, graded);
      else void send([{ type: 'sync' }]);
      throw new GradingError(graded.code, graded.message, graded.details);
    }
    adopt(graded.value.view);
    return graded.value.result;
  };

  const gradeSpeaking = async (part: 1 | 2 | 3, answer: SpokenAnswer) => {
    await send([]);
    const sessionId = sessionIdRef.current;
    if (!sessionId) throw new GradingError('session_closed', 'The exam session is not open.');
    const graded = await gradeExamSpeaking(sessionId, part, answer);
    if (!graded.ok) {
      if (FATAL_CODES.has(graded.code) && screen.kind === 'sitting') refuse(screen.bundleId, graded);
      else void send([{ type: 'sync' }]);
      throw new GradingError(graded.code, graded.message, graded.details);
    }
    adopt(graded.value.view);
    return graded.value.result;
  };

  const retrySave = async () => {
    const sessionId = sessionIdRef.current;
    if (!sessionId || screen.kind !== 'sitting') return;
    const fresh = await getExamSession(sessionId);
    if (fresh.ok) adopt(fresh.value);
    else refuse(screen.bundleId, fresh);
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
          {bundles?.map((bundle) => {
            const inProgress = sessions.find((session) => session.bundleId === bundle.id && session.status === 'active');
            return (
              <Card
                key={bundle.id}
                className="space-y-3 p-5"
                data-bundle-id={bundle.id}
                data-available={String(bundle.available)}
                data-session-id={inProgress?.sessionId ?? ''}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="font-display text-base font-bold text-ink-900">{bundle.title}</h2>
                    {bundle.description && <p className="mt-1 text-xs text-ink-500">{bundle.description}</p>}
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    {inProgress && <Badge tone="brand">{t('exam.inProgress')}</Badge>}
                    <Badge tone="neutral">{bundle.module === 'general' ? 'GT' : 'AC'}</Badge>
                  </div>
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
                  {screen.kind === 'loading' && screen.bundleId === bundle.id ? t('exam.opening') : inProgress ? t('exam.resume') : t('exam.open')}
                </Button>
              </Card>
            );
          })}
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
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                sessionIdRef.current = null;
                setScreen({ kind: 'choose' });
                loadCatalog();
              }}
            >
              {t('exam.back')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const { paper, resumed } = screen;
  const current = screen.view;
  const run = current.run;
  const plan = run.plan;

  /* ------------------------------------------------------------- ready */
  if (run.startedAt === undefined) {
    return (
      <Card className="space-y-4 p-6 sm:p-8" id="exam-ready" data-session-id={current.sessionId}>
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
          <Button id="btn-start-exam" onClick={() => void send([{ type: 'start' }])}>
            {t('exam.start')}
          </Button>
          <Button variant="ghost" onClick={() => void leave()}>
            {t('exam.back')}
          </Button>
        </div>
      </Card>
    );
  }

  /* ---------------------------------------------------------- finished */
  if (current.status === 'finished' || run.finishedAt !== undefined) {
    const result = examResult(run);
    return (
      <div
        className="mx-auto max-w-3xl"
        id="exam-result"
        data-complete={String(result.complete)}
        data-session-id={current.sessionId}
        data-attempt-saved={String(current.attemptSaved)}
      >
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
              const status = run.sections[section].status;
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

          {current.attemptSaved ? (
            <p id="exam-attempt-saved" className="text-xs text-ink-500">
              {t('exam.attemptSaved')}
            </p>
          ) : (
            <div id="exam-attempt-not-saved" className="flex items-center justify-center gap-3 rounded-[var(--radius-control)] border border-warning-500/25 bg-warning-50 p-3 text-sm text-warning-700">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {t('exam.attemptNotSaved')}
              <Button size="sm" variant="secondary" onClick={() => void retrySave()}>
                {t('exam.retrySave')}
              </Button>
            </div>
          )}

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
  const section = currentSection(run);
  if (!section) {
    // Unreachable for a started, unfinished run; refuse rather than render a partial exam.
    return (
      <div id="exam-configuration-error" data-code="invalid_bundle" className="rounded-[var(--radius-card)] border border-danger-500/30 bg-danger-50 p-6 text-sm text-danger-700">
        {t('exam.errors.invalid_bundle.body')}
      </div>
    );
  }

  const sectionRun = run.sections[section.section];
  const readiness = sectionReadiness(run, section.section);
  const finish = canFinishSection(run, serverNow);
  const secondsLeft = remainingSeconds(run, serverNow);
  const index = run.currentIndex;
  // Keyed by session and section, so a resumed sitting mounts with what the server stored.
  const sessionKey = `${current.sessionId}-${section.section}`;

  return (
    <div className="space-y-6" id="exam-running" data-section={section.section} data-session-id={current.sessionId}>
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
            data-deadline={sectionRun.deadline}
            className="inline-flex items-center gap-1.5 rounded-[var(--radius-control)] bg-black/20 px-3 py-1.5 font-mono text-sm font-bold tabular"
            title={t('exam.timeLeft')}
          >
            <Clock className="h-4 w-4" />
            {clock(secondsLeft)}
          </span>
          <button
            id="btn-abort-exam"
            onClick={() => {
              if (window.confirm(t('exam.abortConfirm'))) void leave();
            }}
            className="rounded-[var(--radius-control)] bg-black/20 px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-black/30"
          >
            {t('exam.abort')}
          </button>
        </div>
      </div>

      {resumed && (
        <p id="exam-resumed" className="rounded-[var(--radius-card)] border border-brand-200 bg-brand-50 p-3 text-sm text-brand-800">
          {t('exam.resumedNotice')}
        </p>
      )}

      {saveError && (
        <p id="exam-save-error" className="rounded-[var(--radius-card)] border border-danger-500/30 bg-danger-50 p-3 text-sm text-danger-700">
          {t('exam.saveError', { message: saveError })}
        </p>
      )}

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

      <div key={sessionKey}>
        {section.section === 'listening' && (
          <ListeningSession
            examMode
            listeningData={paper.listening}
            initialAnswers={sectionRun.answers}
            submitted={sectionRun.submittedAt !== undefined}
            onAnswersChange={queueAnswers}
            onSubmitAnswers={() => void send([{ type: 'submit_answers' }])}
          />
        )}
        {section.section === 'reading' && (
          <ReadingSession
            examMode
            readingData={paper.reading}
            initialAnswers={sectionRun.answers}
            submitted={sectionRun.submittedAt !== undefined}
            onAnswersChange={queueAnswers}
            onSubmitAnswers={() => void send([{ type: 'submit_answers' }])}
          />
        )}
        {section.section === 'writing' && (
          <WritingSession
            examMode
            task1Data={paper.writing.task1}
            task2Data={paper.writing.task2}
            grade={gradeWriting}
            initialDrafts={sectionRun.drafts}
            gradedTasks={sectionRun.writing}
            onDraftChange={queueDraft}
          />
        )}
        {section.section === 'speaking' && (
          <SpeakingSession examMode speakingData={paper.speaking} grade={gradeSpeaking} gradedParts={sectionRun.speaking} />
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
        <Button id="btn-finish-section" disabled={!finish.allowed} onClick={() => void send([{ type: 'finish_section' }])}>
          {t('exam.finishSection', { name: sectionName(section.section) })}
        </Button>
      </Card>
    </div>
  );
};
