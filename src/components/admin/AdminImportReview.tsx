import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Code2,
  Eye,
  FileWarning,
  Image as ImageIcon,
  Loader2,
  Save,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { AnswerValue, Question, QuestionType } from '../../types';
import { CANONICAL_QUESTION_TYPES } from '../../schemas/question';
import { QuestionBlock, groupQuestions } from '../common/QuestionBlock';
import {
  ReviewDecision,
  ReviewQuestion,
  ReviewState,
  applyCorrection,
  attachAsset,
  blockingReasons,
  includedQuestions,
  isQuestionReady,
  phaseFor,
  questionProblems,
  setClassification,
  setDecision,
  sourceFragment,
  toSavePayload,
} from '../../services/cdiImport/review';
import { FileUploadZone } from './FileUploadZone';
import { cx } from '../ui';

/**
 * Reviewing what the importer understood, before any of it becomes content.
 *
 * This is a validation surface, not an editor for the page. The imported HTML
 * is evidence and stays exactly as it arrived; what is edited here is the
 * canonical question the parser produced from it. Every row shows the parser's
 * own verdict alongside the current state, so a question that needed a human
 * still reads as one after it has been fixed.
 *
 * The preview uses the learner's own components. A separate preview renderer
 * would only prove that the preview works — the whole point is to see the
 * runtime the student will meet.
 */

interface AdminImportReviewProps {
  state: ReviewState;
  onChange: (state: ReviewState) => void;
  onSaveDraft: (payload: NonNullable<ReturnType<typeof toSavePayload>>) => Promise<void>;
  onCancel: () => void;
  /** Records a reviewer decision about a flagged generated question. */
  onReviewGenerated?: (generatedQuestionId: string, decision: 'confirmed' | 'rejected', note: string) => Promise<void>;
}

const STATUS_TONES: Record<string, string> = {
  parsed: 'bg-success-50 text-success-700 border-success-500/30',
  needs_review: 'bg-warning-50 text-warning-700 border-warning-500/30',
  unsupported: 'bg-danger-50 text-danger-700 border-danger-500/30',
};

const PHASE_LABEL: Record<string, string> = {
  parsing: 'Analysing',
  ready: 'Ready to save',
  needs_review: 'Needs review',
  blocked: 'Blocked',
  saved: 'Saved',
};

const StatusPill: React.FC<{ status: string; children?: React.ReactNode }> = ({ status, children }) => (
  <span
    className={cx(
      'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em]',
      STATUS_TONES[status] ?? 'bg-ink-100 text-ink-600 border-ink-200',
    )}
  >
    {children ?? status.replace(/_/g, ' ')}
  </span>
);

const Stat: React.FC<{ label: string; value: React.ReactNode; tone?: string }> = ({
  label,
  value,
  tone,
}) => (
  <div className="rounded-xl border border-ink-200 bg-white px-3 py-2">
    <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-ink-400">{label}</div>
    <div className={cx('mt-0.5 font-mono text-lg font-bold tabular', tone ?? 'text-ink-900')}>
      {value}
    </div>
  </div>
);

const VERDICT_TONE: Record<string, string> = {
  valid: 'parsed',
  needs_review: 'needs_review',
  rejected: 'unsupported',
};

interface VerdictLike {
  status: string;
  evaluated: boolean;
  reasons: Array<{ code: string; message: string }>;
}

const dimensionLabel = (verdict: VerdictLike | undefined, fallback: string) =>
  !verdict ? fallback.replace(/_/g, ' ') : !verdict.evaluated ? 'not evaluated' : verdict.status.replace(/_/g, ' ');

/**
 * Why machine validation said what it said about one generated question, and
 * the one place a person can decide otherwise.
 *
 * Everything above the decision controls is the machine's record, shown as it
 * was written at generation time and not editable here. The decision is a
 * separate, attributed entry; it never rewrites the verdict above it.
 */
const GenerationVerdictPanel: React.FC<{
  question: ReviewQuestion;
  state: ReviewState;
  onReviewGenerated?: (generatedQuestionId: string, decision: 'confirmed' | 'rejected', note: string) => Promise<void>;
}> = ({ question, state, onReviewGenerated }) => {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const record = state.generationRecord;
  const id = question.draft.provenance?.generatedQuestionId ?? question.draft.id;
  const entry = record?.questions.find((item) => item.generatedQuestionId === id);
  if (!record || !entry) return null;
  // The question's own stamp; the generation record carries the same for every question it produced.
  const provenance = question.draft.provenance;

  const citation = (chunkId: string) => {
    const chunk = record.chunks.find((item) => item.chunkId === chunkId);
    if (!chunk) return chunkId;
    const trail = chunk.path.join(' › ') || 'untitled section';
    return `Section ${chunk.label ?? '?'} · ${trail}${chunk.page ? ` · p. ${chunk.page}` : ''}`;
  };
  const decisions = (state.generationReviews ?? []).filter((item) => item.generatedQuestionId === entry.generatedQuestionId);
  const dimensions: Array<[string, VerdictLike | undefined]> = [
    ['grounding', entry.groundingVerdict],
    ['quality', entry.qualityVerdict],
  ];

  const decide = async (decision: 'confirmed' | 'rejected') => {
    if (!onReviewGenerated) return;
    setBusy(true);
    setError(null);
    try {
      await onReviewGenerated(entry.generatedQuestionId, decision, note);
      setNote('');
    } catch (decisionError: unknown) {
      setError(decisionError instanceof Error ? decisionError.message : 'The decision could not be recorded.');
    } finally {
      setBusy(false);
    }
  };

  const evidenceBlock = (title: string, items: Array<{ chunkId: string; quote: string }>, empty: string, kind: string) => (
    <div data-evidence-kind={kind}>
      <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-ink-500">{title}</div>
      {items.length === 0 ? (
        <p className="mt-0.5 text-[11px] italic text-ink-400">{empty}</p>
      ) : (
        <ul className="mt-0.5 space-y-1">
          {items.map((item) => (
            <li key={`${item.chunkId}-${item.quote}`} className="text-[11px] text-ink-700">
              “{item.quote}”
              <span className="ml-1 font-mono text-[10px] text-ink-400">{citation(item.chunkId)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <div
      data-generation-verdicts={entry.generatedQuestionId}
      data-final={entry.status}
      data-grounding={entry.groundingVerdict?.status ?? entry.status}
      data-quality={entry.qualityVerdict?.status ?? entry.status}
      className="space-y-2.5 rounded-lg border border-brand-200 bg-brand-50/40 p-2.5"
    >
      <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-ink-600">
        Machine verdict — recorded at generation, not editable
      </div>
      <p
        className="font-mono text-[10px] text-ink-500"
        data-question-versions
        data-generator-version={provenance?.generatorVersion ?? record.generatorVersion}
        data-prompt-version={provenance?.promptVersion ?? record.promptVersion}
        data-model={provenance?.model ?? record.model}
        data-model-version={provenance?.modelVersion ?? record.modelVersion ?? ''}
      >
        produced by {provenance?.generatorVersion ?? record.generatorVersion} · prompt{' '}
        {provenance?.promptVersion ?? record.promptVersion} · {provenance?.model ?? record.model}
        {(provenance?.modelVersion ?? record.modelVersion) ? ` (${provenance?.modelVersion ?? record.modelVersion})` : ''}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusPill status={VERDICT_TONE[entry.status]}>final: {entry.status.replace(/_/g, ' ')}</StatusPill>
        {dimensions.map(([name, verdict]) => (
          <StatusPill key={name} status={VERDICT_TONE[verdict?.status ?? entry.status]}>
            {name}: {dimensionLabel(verdict, entry.status)}
          </StatusPill>
        ))}
      </div>

      {dimensions.map(([name, verdict]) =>
        verdict && verdict.reasons.length > 0 ? (
          <div key={name} data-dimension={name}>
            <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-ink-500">
              {name === 'grounding' ? 'Source grounding — why' : 'IELTS quality — why'}
            </div>
            <ul className="mt-0.5 space-y-1 text-[11px] text-ink-700">
              {verdict.reasons.map((reason) => (
                <li key={`${reason.code}-${reason.message}`} data-reason-code={reason.code}>
                  <span className="font-mono text-[10px] text-ink-400">{reason.code}</span> {reason.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null,
      )}
      {!entry.groundingVerdict && entry.reasons.length > 0 && (
        <ul className="space-y-1 text-[11px] text-ink-700">
          {entry.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}

      {evidenceBlock(
        'Question evidence — what the question is about',
        entry.questionEvidence.length > 0 ? entry.questionEvidence : entry.evidence,
        'None cited.',
        'question',
      )}
      {evidenceBlock(
        'Answer evidence — what establishes the answer',
        entry.answerEvidence,
        'None cited. A NOT GIVEN answer has no answer evidence by definition.',
        'answer',
      )}
      {entry.distractorEvidence.length > 0 && (
        <div data-evidence-kind="distractor">
          <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-ink-500">
            Distractor evidence — the model's own account, not trusted by validation
          </div>
          <ul className="mt-0.5 space-y-1 text-[11px] text-ink-700">
            {entry.distractorEvidence.map((item) => (
              <li key={item.option}>
                <b>{item.option}</b> — {item.reason ?? 'no reason given'}
                {item.quote ? <span className="text-ink-500"> (“{item.quote}”)</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      {decisions.length > 0 && (
        <div data-review-history>
          <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-ink-500">Reviewer decisions</div>
          <ul className="mt-0.5 space-y-1 text-[11px] text-ink-700">
            {decisions.map((item) => (
              <li key={item.reviewId} data-review-decision={item.decision} data-review-current={String(item.current)}>
                <b>{item.decision === 'confirmed' ? 'Confirmed' : 'Flag upheld'}</b> by {item.reviewer.displayName || item.reviewer.username} ({item.reviewer.username}) at{' '}
                <span className="font-mono">{item.reviewedAt}</span> — “{item.note}”. Machine verdict at the time: {item.machineVerdict.status.replace(/_/g, ' ')}.{' '}
                {!item.inDraft ? (
                  <span className="text-ink-500">The question is not in the saved draft.</span>
                ) : item.current ? (
                  <span className="text-success-700">Covers the question as saved.</span>
                ) : (
                  <span className="text-danger-700">Lapsed — the question changed after this decision.</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {entry.status === 'needs_review' &&
        (state.materialId && onReviewGenerated ? (
          <div className="space-y-1.5" data-confirm-panel>
            <textarea
              data-confirm-note
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="What did you check against the source? Required."
              className="w-full rounded-lg border border-ink-200 p-2 text-xs"
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                data-confirm-action="confirmed"
                disabled={busy || note.trim().length < 10}
                onClick={() => void decide('confirmed')}
                className="inline-flex items-center gap-1 rounded-lg bg-success-600 px-2.5 py-1 text-[11px] font-bold text-white disabled:opacity-50"
              >
                <ShieldCheck className="h-3 w-3" />
                Confirm against the source
              </button>
              <button
                type="button"
                data-confirm-action="rejected"
                disabled={busy || note.trim().length < 10}
                onClick={() => void decide('rejected')}
                className="rounded-lg border border-ink-300 px-2.5 py-1 text-[11px] font-semibold text-ink-700 disabled:opacity-50"
              >
                Uphold the flag
              </button>
            </div>
            <p className="text-[10px] text-ink-500">
              Recorded with your name and the time. It does not change the machine verdict, and it lapses if
              this question is edited afterwards. Save the draft first if you have changed it here.
            </p>
            {error && <p className="text-[11px] text-danger-700">{error}</p>}
          </div>
        ) : (
          <p className="text-[11px] text-ink-500">Save this draft before recording a decision on this question.</p>
        ))}
      {entry.status === 'rejected' && (
        <p className="text-[11px] text-danger-700">A question rejected by validation cannot be promoted.</p>
      )}
    </div>
  );
};

/** One row: what the parser said, what it is now, and how to change it. */
const QuestionRow: React.FC<{
  question: ReviewQuestion;
  state: ReviewState;
  onChange: (state: ReviewState) => void;
  onReviewGenerated?: (generatedQuestionId: string, decision: 'confirmed' | 'rejected', note: string) => Promise<void>;
}> = ({ question, state, onChange, onReviewGenerated }) => {
  // Anything the parser could not finish opens on arrival. A review screen
  // whose purpose is not hiding parser errors must not fold them away by
  // default; a clean row stays collapsed so the ones needing attention stand out.
  const [open, setOpen] = useState(
    question.originalStatus !== 'parsed' || question.originalAnswerStatus !== 'extracted',
  );
  const [showSource, setShowSource] = useState(false);
  const problems = questionProblems(question);
  const ready = isQuestionReady(question);
  const draft = question.draft;

  const correct = (patch: Parameters<typeof applyCorrection>[2]) =>
    onChange(applyCorrection(state, question.key, patch));

  const decide = (decision: ReviewDecision) => onChange(setDecision(state, question.key, decision));

  return (
    <div
      className={cx(
        'rounded-xl border bg-white',
        question.decision === 'exclude'
          ? 'border-ink-200 opacity-60'
          : ready
            ? 'border-ink-200'
            : 'border-warning-500/40',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-start gap-3 p-3.5 text-left"
      >
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink-100 font-mono text-xs font-bold tabular text-ink-700">
          {draft.questionNumber ?? question.questionNumber ?? '?'}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            {/* The parser's verdict, kept visible after a correction. */}
            <StatusPill status={question.originalStatus} />
            {question.edited && <StatusPill status="edited">edited</StatusPill>}
            {question.originalAnswerStatus !== 'extracted' && (
              <StatusPill status="needs_review">
                key {question.originalAnswerStatus}
              </StatusPill>
            )}
            <span className="font-mono text-[10px] text-ink-400">
              {draft.type ?? question.detectedAs ?? 'unknown'}
            </span>
          </span>
          <span className="mt-1 block truncate text-sm text-ink-800">
            {draft.prompt || <em className="text-ink-400">No prompt was read</em>}
          </span>
          {problems.length > 0 && (
            <span className="mt-1 block text-[11px] text-warning-700">{problems[0]}</span>
          )}
        </span>

        <ChevronDown
          className={cx('mt-1 h-4 w-4 shrink-0 text-ink-400 transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div className="space-y-3 border-t border-ink-100 p-3.5">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-ink-500">Type</span>
              <select
                value={draft.type ?? ''}
                onChange={(event) => correct({ type: event.target.value as QuestionType })}
                className="mt-1 w-full rounded-lg border border-ink-200 bg-white p-2 text-xs"
              >
                <option value="">— choose —</option>
                {CANONICAL_QUESTION_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-ink-500">
                Question number
              </span>
              <input
                type="number"
                min={1}
                value={draft.questionNumber ?? ''}
                onChange={(event) => correct({ questionNumber: Number(event.target.value) })}
                className="mt-1 w-full rounded-lg border border-ink-200 p-2 text-xs"
              />
            </label>
          </div>

          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-ink-500">Prompt</span>
            <textarea
              rows={2}
              value={draft.prompt ?? ''}
              onChange={(event) => correct({ prompt: event.target.value })}
              className="mt-1 w-full rounded-lg border border-ink-200 p-2 text-xs"
            />
          </label>

          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-ink-500">
              Instruction (rubric)
            </span>
            <textarea
              rows={2}
              value={draft.instruction ?? ''}
              onChange={(event) => correct({ instruction: event.target.value })}
              className="mt-1 w-full rounded-lg border border-ink-200 p-2 text-xs"
            />
          </label>

          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-ink-500">
              Options — one per line
            </span>
            <textarea
              rows={3}
              value={(draft.options ?? []).join('\n')}
              onChange={(event) =>
                correct({ options: event.target.value.split('\n').filter((line) => line.trim()) })
              }
              className="mt-1 w-full rounded-lg border border-ink-200 p-2 font-mono text-xs"
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-ink-500">
                Correct answer
                {question.originalAnswerStatus !== 'extracted' && (
                  <span className="ml-1 font-normal normal-case text-warning-700">
                    {state.generationRecord ? '— validation could not establish one' : '— the parser could not read one'}
                  </span>
                )}
              </span>
              <input
                type="text"
                value={
                  Array.isArray(draft.correctAnswer)
                    ? draft.correctAnswer.join(', ')
                    : (draft.correctAnswer ?? '')
                }
                onChange={(event) => {
                  const raw = event.target.value;
                  correct({
                    correctAnswer: raw.includes(',')
                      ? raw.split(',').map((part) => part.trim()).filter(Boolean)
                      : raw,
                  });
                }}
                className="mt-1 w-full rounded-lg border border-ink-200 p-2 text-xs"
              />
            </label>

            <label className="block">
              <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-ink-500">
                Also accept — comma separated
              </span>
              <input
                type="text"
                value={(draft.acceptableAnswers ?? []).join(', ')}
                onChange={(event) =>
                  correct({
                    acceptableAnswers: event.target.value
                      .split(',')
                      .map((part) => part.trim())
                      .filter(Boolean),
                  })
                }
                className="mt-1 w-full rounded-lg border border-ink-200 p-2 text-xs"
              />
            </label>
          </div>

          {problems.length > 0 && (
            <ul className="space-y-1 rounded-lg border border-warning-500/30 bg-warning-50 p-2.5 text-[11px] text-warning-700">
              {problems.map((problem, index) => (
                <li key={index}>{problem}</li>
              ))}
            </ul>
          )}

          {question.diagnostics.length > 0 && (
            <div className="rounded-lg border border-ink-200 bg-ink-50/60 p-2.5">
              <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-ink-500">
                {state.generationRecord ? 'What validation reported' : 'What the parser reported'}
              </div>
              <ul className="mt-1 space-y-1 text-[11px] text-ink-600">
                {question.diagnostics.map((diagnostic, index) => (
                  <li key={index}>
                    <span className="font-mono text-[10px] text-ink-400">{diagnostic.code}</span>{' '}
                    {diagnostic.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <GenerationVerdictPanel question={question} state={state} onReviewGenerated={onReviewGenerated} />

          <div className="flex flex-wrap items-center gap-2">
            {(['include', 'mark_unsupported', 'exclude'] as ReviewDecision[]).map((decision) => (
              <button
                key={decision}
                type="button"
                onClick={() => decide(decision)}
                className={cx(
                  'rounded-lg border px-2.5 py-1 text-[11px] font-semibold',
                  question.decision === decision
                    ? 'border-ink-900 bg-ink-900 text-white'
                    : 'border-ink-200 text-ink-600 hover:border-ink-400',
                )}
              >
                {decision === 'include'
                  ? 'Include'
                  : decision === 'mark_unsupported'
                    ? 'Mark unsupported'
                    : 'Exclude'}
              </button>
            ))}

            <button
              type="button"
              onClick={() => setShowSource(!showSource)}
              className="ml-auto inline-flex items-center gap-1 rounded-lg border border-ink-200 px-2.5 py-1 text-[11px] font-semibold text-ink-600 hover:border-ink-400"
            >
              <Code2 className="h-3 w-3" />
              {showSource ? 'Hide source' : 'Show source'}
            </button>
          </div>

          {showSource && (
            <div>
              <div className="mb-1 font-mono text-[10px] text-ink-400">
                original HTML, bytes {question.sourceRange.start}–{question.sourceRange.end}
              </div>
              {/* Shown as text, never rendered: this is evidence, not markup. */}
              <pre className="max-h-56 overflow-auto rounded-lg border border-ink-200 bg-ink-900 p-2.5 font-mono text-[10px] leading-relaxed text-ink-100">
                {sourceFragment(state, question)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export const AdminImportReview: React.FC<AdminImportReviewProps> = ({
  state,
  onChange,
  onSaveDraft,
  onCancel,
  onReviewGenerated,
}) => {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewAnswers, setPreviewAnswers] = useState<Record<string, AnswerValue>>({});

  const generated = Boolean(state.generationRecord);
  const phase = phaseFor(state);
  const blockers = blockingReasons(state);
  const ready = useMemo<Question[]>(() => includedQuestions(state), [state]);
  const missingAssets = state.assets.filter((asset) => !asset.assetId);

  const counts = {
    detected: state.questions.length,
    parsed: state.questions.filter((question) => question.originalStatus === 'parsed').length,
    needsReview: state.questions.filter((question) => question.originalStatus === 'needs_review').length,
    unsupported: state.questions.filter((question) => question.originalStatus === 'unsupported').length,
  };

  const handleSave = async () => {
    const payload = toSavePayload(state);
    if (!payload) {
      setError(generated ? 'This draft is not ready to save yet.' : 'This import is not ready to save yet.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSaveDraft(payload);
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save the draft.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6" id="admin-import-review">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-200 pb-4">
        <div>
          {/* One review system, two kinds of material: say which this is. */}
          <span
            data-review-kind={generated ? 'generated' : 'imported'}
            className={cx(
              'mb-1 inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em]',
              generated ? 'border-brand-200 bg-brand-50 text-brand-700' : 'border-ink-200 bg-ink-50 text-ink-600',
            )}
          >
            {generated ? 'Generated draft' : 'Imported material'}
          </span>
          <h3 className="text-lg font-bold text-ink-900">
            {generated ? 'Review generated draft' : 'Review imported material'}
          </h3>
          <p className="text-xs text-ink-500">
            {generated
              ? 'Book → Test output: what validation established from the source, and what it could not. Nothing is published from here.'
              : 'What the parser understood, and what it could not. Nothing is saved until you confirm it.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill status={phase === 'ready' ? 'parsed' : phase === 'blocked' ? 'unsupported' : 'needs_review'}>
            {PHASE_LABEL[phase]}
          </StatusPill>
          {!generated && <span className="font-mono text-[10px] text-ink-400">parser {state.parserVersion}</span>}
        </div>
      </div>

      {state.generationRecord && (
        <dl
          data-generation-versions
          data-generator-version={state.generationRecord.generatorVersion}
          data-prompt-version={state.generationRecord.promptVersion}
          data-model={state.generationRecord.model}
          data-model-version={state.generationRecord.modelVersion ?? ''}
          className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-lg bg-ink-50 p-2.5 font-mono text-[10px] text-ink-600"
        >
          <dt>generator</dt>
          <dd>{state.generationRecord.generatorVersion}</dd>
          <dt>prompt</dt>
          <dd>{state.generationRecord.promptVersion}</dd>
          <dt>model</dt>
          <dd>{state.generationRecord.model}</dd>
          <dt>model version</dt>
          <dd>{state.generationRecord.modelVersion ?? 'not reported by the provider'}</dd>
          <dt>generation</dt>
          <dd>
            {state.generationRecord.generationId} · {state.generationRecord.generatedAt}
          </dd>
          {state.generationRecord.requestId && (
            <>
              <dt>request</dt>
              <dd>
                {state.generationRecord.requestId}
                {state.generationRecord.attempts
                  ? ` · ${state.generationRecord.attempts} model call${state.generationRecord.attempts === 1 ? '' : 's'}`
                  : ''}
              </dd>
            </>
          )}
          <dt>source</dt>
          <dd>
            {state.generationRecord.source.title} ({state.generationRecord.source.sourceId})
          </dd>
        </dl>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Detected" value={counts.detected} />
        <Stat label={generated ? 'Valid' : 'Parsed'} value={counts.parsed} tone="text-success-700" />
        <Stat label="Needs review" value={counts.needsReview} tone="text-warning-700" />
        <Stat label={generated ? 'Rejected' : 'Unsupported'} value={counts.unsupported} tone="text-danger-700" />
      </div>

      {blockers.length > 0 && (
        <div className="rounded-xl border border-danger-500/30 bg-danger-50 p-4">
          <div className="flex items-center gap-2 text-sm font-bold text-danger-700">
            <FileWarning className="h-4 w-4" />
            {generated ? 'This draft cannot be saved yet' : 'This import cannot be saved yet'}
          </div>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-danger-700">
            {blockers.map((reason, index) => (
              <li key={index}>{reason}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Classification — proposed by the parser, decided by the admin. */}
      <section className="space-y-3 rounded-2xl border border-ink-200 bg-ink-50/50 p-4">
        <h4 className="text-xs font-bold uppercase tracking-[0.1em] text-ink-700">
          Classification — required before saving
        </h4>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-ink-500">Title</span>
            <input
              id="import-title"
              type="text"
              value={state.classification.title}
              onChange={(event) => onChange(setClassification(state, { title: event.target.value }))}
              className="mt-1 w-full rounded-lg border border-ink-200 p-2 text-xs"
            />
          </label>

          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-ink-500">Section</span>
            <select
              id="import-section"
              value={state.classification.section ?? ''}
              onChange={(event) =>
                onChange(
                  setClassification(state, {
                    section: (event.target.value || null) as 'reading' | 'listening' | null,
                  }),
                )
              }
              className="mt-1 w-full rounded-lg border border-ink-200 bg-white p-2 text-xs"
            >
              <option value="">— choose —</option>
              <option value="reading">Reading</option>
              <option value="listening">Listening</option>
            </select>
          </label>

          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-ink-500">Module</span>
            <select
              id="import-module"
              value={state.classification.module ?? ''}
              onChange={(event) =>
                onChange(
                  setClassification(state, {
                    module: (event.target.value || null) as 'academic' | 'general' | null,
                  }),
                )
              }
              className="mt-1 w-full rounded-lg border border-ink-200 bg-white p-2 text-xs"
            >
              <option value="">— choose —</option>
              <option value="academic">Academic</option>
              <option value="general">General Training</option>
            </select>
          </label>

          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-ink-500">
              {state.classification.section === 'reading' ? 'Passage number' : 'Section number'}
            </span>
            <input
              type="number"
              min={1}
              max={4}
              value={state.classification.part ?? ''}
              onChange={(event) =>
                onChange(setClassification(state, { part: Number(event.target.value) || null }))
              }
              className="mt-1 w-full rounded-lg border border-ink-200 p-2 text-xs"
            />
          </label>

          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-ink-500">Theme</span>
            <input
              type="text"
              value={state.classification.theme}
              onChange={(event) => onChange(setClassification(state, { theme: event.target.value }))}
              className="mt-1 w-full rounded-lg border border-ink-200 p-2 text-xs"
            />
          </label>

          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-ink-500">
              Target band
            </span>
            <input
              type="text"
              value={state.classification.targetBand}
              onChange={(event) =>
                onChange(setClassification(state, { targetBand: event.target.value }))
              }
              className="mt-1 w-full rounded-lg border border-ink-200 p-2 text-xs"
            />
          </label>
        </div>
      </section>

      {/* Assets the page needs but does not contain. */}
      {missingAssets.length > 0 && (
        <section className="space-y-3 rounded-2xl border border-warning-500/30 bg-warning-50 p-4">
          <h4 className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.1em] text-warning-700">
            <ImageIcon className="h-3.5 w-3.5" />
            {missingAssets.length} file(s) the page needs but does not contain
          </h4>
          {missingAssets.map((asset) => (
            <div key={asset.originalSrc} className="space-y-2 rounded-lg border border-warning-500/20 bg-white p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-mono text-[11px] text-ink-700">{asset.originalSrc}</span>
                <StatusPill status={asset.origin === 'external' ? 'unsupported' : 'needs_review'}>
                  {asset.origin}
                </StatusPill>
              </div>
              {asset.origin === 'external' && (
                <p className="text-[11px] text-warning-700">
                  An external address is not imported as a trusted file. Upload the file itself to
                  attach it.
                </p>
              )}
              <FileUploadZone
                accept={asset.kind === 'audio' ? '.mp3,.wav,.ogg' : '.png,.jpg,.jpeg,.webp'}
                category={asset.kind}
                label={`Attach the ${asset.kind}`}
                description="Stored through the normal asset pipeline, then linked to the questions that need it."
                onUploaded={(uploaded) => onChange(attachAsset(state, asset.originalSrc, uploaded.assetId))}
              />
            </div>
          ))}
        </section>
      )}

      {/* Page-level diagnostics, never hidden. */}
      {state.diagnostics.length > 0 && (
        <details className="rounded-2xl border border-ink-200 bg-white p-4">
          <summary className="cursor-pointer text-xs font-bold uppercase tracking-[0.1em] text-ink-700">
            {generated ? 'Generation diagnostics' : 'Parser diagnostics'} ({state.diagnostics.length})
          </summary>
          <ul className="mt-2 space-y-1 text-[11px] text-ink-600">
            {state.diagnostics.map((diagnostic, index) => (
              <li key={index}>
                <span className="font-mono text-[10px] text-ink-400">{diagnostic.code}</span>{' '}
                {diagnostic.message}
              </li>
            ))}
          </ul>
        </details>
      )}

      {state.unsupportedRegions.length > 0 && (
        <div className="rounded-2xl border border-danger-500/25 bg-danger-50/60 p-4">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.1em] text-danger-700">
            <AlertTriangle className="h-3.5 w-3.5" />
            Constructs this importer does not handle
          </div>
          <ul className="mt-2 space-y-1 text-[11px] text-danger-700">
            {state.unsupportedRegions.map((region, index) => (
              <li key={index}>
                <strong>{region.construct}</strong> — {region.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <section className="space-y-2">
        <h4 className="text-xs font-bold uppercase tracking-[0.1em] text-ink-700">
          Questions ({state.questions.length})
        </h4>
        {state.questions.map((question) => (
          <QuestionRow
            key={question.key}
            question={question}
            state={state}
            onChange={onChange}
            onReviewGenerated={onReviewGenerated}
          />
        ))}
      </section>

      {/* The learner's own renderer, not a stand-in for it. */}
      <section className="space-y-3 rounded-2xl border border-ink-200 bg-white p-4" id="import-learner-preview">
        <h4 className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.1em] text-ink-700">
          <Eye className="h-3.5 w-3.5" />
          Learner preview — {ready.length} question(s) that will be saved
        </h4>
        <p className="text-[11px] text-ink-500">
          Rendered with the components a student sees, so what looks right here is what they get.
        </p>
        {ready.length === 0 ? (
          <p className="rounded-lg border border-dashed border-ink-300 p-6 text-center text-xs text-ink-400">
            No question is complete enough to preview yet.
          </p>
        ) : (
          <div className="space-y-4">
            {groupQuestions(ready).map((group) => (
              <QuestionBlock
                key={group.key}
                group={group}
                answers={previewAnswers}
                disabled={false}
                onChange={(id, value) => setPreviewAnswers((prev) => ({ ...prev, [id]: value }))}
                groupName="import-preview"
              />
            ))}
          </div>
        )}
      </section>

      {error && (
        <p className="rounded-lg border border-danger-500/30 bg-danger-50 p-3 text-xs text-danger-700">
          {error}
        </p>
      )}

      <div className="flex items-center justify-end gap-3 border-t border-ink-200 pt-4">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold text-ink-600 hover:text-ink-900"
        >
          <X className="h-3.5 w-3.5" />
          {generated ? 'Close without saving' : 'Discard import'}
        </button>
        <button
          id="btn-save-import-draft"
          type="button"
          onClick={handleSave}
          disabled={saving || blockers.length > 0}
          className={cx(
            'inline-flex items-center gap-2 rounded-lg px-5 py-2 text-xs font-bold text-white',
            blockers.length > 0 ? 'cursor-not-allowed bg-ink-300' : 'bg-ink-900 hover:bg-ink-800',
          )}
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          {saving ? 'Saving…' : 'Save as draft'}
        </button>
      </div>
    </div>
  );
};

/** Small helper used by the dashboard's import entry point. */
export const ImportReadyBadge: React.FC<{ state: ReviewState }> = ({ state }) => (
  <StatusPill status={phaseFor(state) === 'ready' ? 'parsed' : 'needs_review'}>
    {PHASE_LABEL[phaseFor(state)]}
    <Check className="h-3 w-3" />
  </StatusPill>
);
