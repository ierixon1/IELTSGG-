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

/** One row: what the parser said, what it is now, and how to change it. */
const QuestionRow: React.FC<{
  question: ReviewQuestion;
  state: ReviewState;
  onChange: (state: ReviewState) => void;
}> = ({ question, state, onChange }) => {
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
                    — the parser could not read one
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
                What the parser reported
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
}) => {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewAnswers, setPreviewAnswers] = useState<Record<string, AnswerValue>>({});

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
      setError('This import is not ready to save yet.');
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
          <h3 className="text-lg font-bold text-ink-900">Review imported material</h3>
          <p className="text-xs text-ink-500">
            What the parser understood, and what it could not. Nothing is saved until you confirm it.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill status={phase === 'ready' ? 'parsed' : phase === 'blocked' ? 'unsupported' : 'needs_review'}>
            {PHASE_LABEL[phase]}
          </StatusPill>
          <span className="font-mono text-[10px] text-ink-400">parser {state.parserVersion}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Detected" value={counts.detected} />
        <Stat label="Parsed" value={counts.parsed} tone="text-success-700" />
        <Stat label="Needs review" value={counts.needsReview} tone="text-warning-700" />
        <Stat label="Unsupported" value={counts.unsupported} tone="text-danger-700" />
      </div>

      {blockers.length > 0 && (
        <div className="rounded-xl border border-danger-500/30 bg-danger-50 p-4">
          <div className="flex items-center gap-2 text-sm font-bold text-danger-700">
            <FileWarning className="h-4 w-4" />
            This import cannot be saved yet
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
            Parser diagnostics ({state.diagnostics.length})
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
          <QuestionRow key={question.key} question={question} state={state} onChange={onChange} />
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
          Discard import
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
