import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, FileText, Loader2, Sparkles, XCircle } from 'lucide-react';
import type { Question } from '../../types';
import type { SourceLocation, StoredSource } from '../../types/source';
import type { StoredGenerationRecord } from '../../schemas/material';
import type { ReviewState } from '../../services/cdiImport/review';
import { loadGeneratedReview } from './generatedReview';
import { GENERATABLE_TYPES, MAX_GENERATED_QUESTIONS, type GeneratableType } from '../../services/bookToTest/types';

interface AdminBookToTestProps {
  source: StoredSource;
  onOpenReview: (state: ReviewState) => void;
  onToast: (message: string) => void;
  /** Called once a draft exists, so the material catalog can show it. */
  onDraftCreated?: (materialId: string) => void;
}

interface VerdictView {
  status: 'valid' | 'needs_review' | 'rejected';
  evaluated: boolean;
  reasons: Array<{ code: string; message: string }>;
}

interface GeneratedQuestionView {
  generatedQuestionId: string;
  status: 'valid' | 'needs_review' | 'rejected';
  groundingVerdict?: VerdictView;
  qualityVerdict?: VerdictView;
  questionEvidence?: Array<{ chunkId: string; quote: string }>;
  answerEvidence?: Array<{ chunkId: string; quote: string }>;
  reasons: string[];
  question?: Question;
  /** What the model returned; kept for questions that did not become part of the draft. */
  candidate?: Record<string, unknown>;
  evidence: Array<{ chunkId: string; quote: string }>;
  chunkIds: string[];
}

interface RetrievedView {
  chunkId: string;
  label?: string;
  heading?: string;
  location: SourceLocation;
  confidence: number;
  matchedTerms: string[];
}

interface GenerationView {
  status: 'draft_created' | 'all_rejected';
  requestId?: string;
  attempts?: number;
  /** The request had already produced this draft; nothing new was generated. */
  replayed?: boolean;
  materialId?: string;
  materialStatus?: string;
  generation: StoredGenerationRecord;
  retrieved: RetrievedView[];
  questions: GeneratedQuestionView[];
}

interface GenerationFailure {
  error: string;
  code: string;
  failureClass?: string;
  reason?: string;
  attempts?: number;
  model?: string;
  worthRetrying?: boolean;
  retrieval?: { status: string; reason?: string; terms?: string[] };
}

interface RunView {
  runId: string;
  requestId: string;
  startedAt: string;
  durationMs: number;
  outcome: 'draft_created' | 'all_rejected' | 'failed';
  failure?: { code: string; failureClass?: string; message: string; reason?: string };
  modelCalled: boolean;
  model?: string;
  modelVersion?: string;
  attempts: number;
  request: { topic: string; questionType: string; count: number };
  materialId?: string;
}

const TYPE_LABELS: Record<GeneratableType, string> = {
  multiple_choice: 'Multiple choice',
  true_false_not_given: 'True / False / Not Given',
  matching_headings: 'Matching headings',
  short_answer: 'Short answer',
  sentence_completion: 'Sentence completion',
};

/** A short name for each failure the endpoint reports; the message underneath says what happened. */
const FAILURE_TITLE: Record<string, string> = {
  model_unavailable: 'Model unavailable',
  generation_timeout: 'Generation timed out',
  quota_exceeded: 'Model quota exceeded',
  invalid_model_response: 'Invalid model response',
  model_configuration_error: 'Model configuration error',
  model_failed: 'Model call failed',
  no_relevant_source: 'Nothing relevant in the source',
  not_enough_sections: 'Not enough relevant sections',
  generation_in_progress: 'Already running',
  request_id_reused: 'Request id reused',
  all_rejected: 'Every question was rejected',
  draft_blocked: 'Draft could not be formed',
  network: 'Server unreachable',
};

const STATUS_STYLE: Record<GeneratedQuestionView['status'], string> = {
  valid: 'border-success-500/30 bg-success-50 text-success-800',
  needs_review: 'border-warning-500/40 bg-warning-50 text-warning-800',
  rejected: 'border-danger-500/30 bg-danger-50 text-danger-800',
};

const STATUS_LABEL: Record<GeneratedQuestionView['status'], string> = {
  valid: 'Valid — answer found in the source',
  needs_review: 'Needs review — not established from the source, or not a sound IELTS question',
  rejected: 'Rejected — will not enter the material',
};

const citation = (location: SourceLocation) => {
  const trail = location.path.join(' › ') || 'Untitled section';
  return location.page ? `${trail} · p. ${location.page}` : trail;
};

/**
 * Book → Test: turn retrieved passages of a textbook into a draft Reading
 * material, and show exactly what that draft rests on.
 *
 * The screen reports three things and hides none of them: which chunks the model
 * was given, what it returned, and what validation made of each question. It
 * never offers to publish. The only way forward is the existing review screen.
 *
 * Each deliberate press of Generate is one request with its own id. A second
 * press while that request is out sends nothing; generating again after the
 * answer was lost resends the same id, which the server answers with the draft
 * it already made rather than a second one.
 */
export const AdminBookToTest: React.FC<AdminBookToTestProps> = ({
  source,
  onOpenReview,
  onToast,
  onDraftCreated,
}) => {
  const [topic, setTopic] = useState('');
  const [questionType, setQuestionType] = useState<GeneratableType>('short_answer');
  const [count, setCount] = useState(3);
  const [module, setModule] = useState<'academic' | 'general'>('academic');
  const [targetBand, setTargetBand] = useState('');
  const [generating, setGenerating] = useState(false);
  const [opening, setOpening] = useState(false);
  const [failure, setFailure] = useState<GenerationFailure | null>(null);
  const [result, setResult] = useState<GenerationView | null>(null);
  const [runs, setRuns] = useState<RunView[]>([]);
  const [runsError, setRunsError] = useState<string | null>(null);

  const inFlight = useRef(false);
  /** The request whose answer is still owed, with the settings it was made with. */
  const unanswered = useRef<{ requestId: string; settings: string } | null>(null);

  const loadRuns = useCallback(async () => {
    try {
      const response = await fetch(`/api/admin/sources/${encodeURIComponent(source.id)}/generation-runs?limit=8`, {
        credentials: 'same-origin',
      });
      const body = await response.json();
      if (!response.ok) {
        setRunsError(body.error || 'The generation log could not be read.');
        return;
      }
      setRuns(Array.isArray(body.runs) ? (body.runs as RunView[]) : []);
      setRunsError(null);
    } catch {
      setRunsError('The generation log could not be read.');
    }
  }, [source.id]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  const generate = async () => {
    // A second click while a request is out would be a second request for the same thing.
    if (inFlight.current) return;
    inFlight.current = true;

    const settings = JSON.stringify([source.id, topic.trim(), questionType, count, module, targetBand.trim()]);
    const requestId =
      unanswered.current?.settings === settings ? unanswered.current.requestId : crypto.randomUUID();
    unanswered.current = { requestId, settings };

    setGenerating(true);
    setFailure(null);
    setResult(null);
    try {
      const response = await fetch(`/api/admin/sources/${encodeURIComponent(source.id)}/generate`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, topic, questionType, count, module, targetBand }),
      });
      const body = await response.json();
      // Only "still running" leaves this request's outcome open; every other answer settles it.
      if (body.code !== 'generation_in_progress') unanswered.current = null;

      if (response.status === 201 || response.status === 200 || body.code === 'all_rejected') {
        setResult(body as GenerationView);
        if (body.code === 'all_rejected') setFailure({ error: body.error, code: body.code });
        else if (body.replayed) onToast('This request had already created a draft. No new draft was created.');
        else {
          onToast('Draft created. It is not published.');
          if (body.materialId) onDraftCreated?.(body.materialId);
        }
        return;
      }
      setFailure({
        error: body.error || 'Generation failed.',
        code: body.code || String(response.status),
        failureClass: body.failureClass,
        reason: body.reason,
        attempts: body.attempts,
        model: body.model,
        worthRetrying: body.worthRetrying,
        retrieval: body.retrieval,
      });
    } catch {
      // No answer arrived, so a draft may exist. The request id is kept: generating
      // again with the same settings asks for that draft instead of a new one.
      setFailure({
        error: 'The server could not be reached. Generating again with the same settings will not create a second draft.',
        code: 'network',
      });
    } finally {
      inFlight.current = false;
      setGenerating(false);
      void loadRuns();
    }
  };

  const openReview = async (materialId: string) => {
    setOpening(true);
    try {
      onOpenReview(await loadGeneratedReview(materialId));
    } catch (error: unknown) {
      onToast(error instanceof Error ? error.message : 'The draft could not be opened.');
    } finally {
      setOpening(false);
    }
  };

  const summary = result?.generation.summary;

  return (
    <div className="space-y-4 rounded-2xl border border-brand-200 bg-white p-4" id="book-to-test-panel">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-brand-600" />
        <p className="text-sm font-bold text-ink-900">Book → Test</p>
        <span className="text-[11px] text-ink-500">Reading only · one material · grounded in retrieved passages</span>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="sm:col-span-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-500">Topic or instruction</span>
          <input
            id="btt-topic"
            type="text"
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            placeholder="e.g. scanning for dates and proper nouns"
            className="mt-1 w-full rounded-lg border border-ink-200 px-3 py-2 text-xs"
          />
        </label>
        <label>
          <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-500">Question type</span>
          <select
            id="btt-type"
            value={questionType}
            onChange={(event) => setQuestionType(event.target.value as GeneratableType)}
            className="mt-1 w-full rounded-lg border border-ink-200 px-2 py-2 text-xs"
          >
            {GENERATABLE_TYPES.map((type) => (
              <option key={type} value={type}>
                {TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-500">Questions</span>
          <input
            id="btt-count"
            type="number"
            min={1}
            max={MAX_GENERATED_QUESTIONS}
            value={count}
            onChange={(event) => setCount(Number(event.target.value))}
            className="mt-1 w-full rounded-lg border border-ink-200 px-3 py-2 text-xs"
          />
        </label>
        <label>
          <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-500">Module</span>
          <select
            id="btt-module"
            value={module}
            onChange={(event) => setModule(event.target.value as 'academic' | 'general')}
            className="mt-1 w-full rounded-lg border border-ink-200 px-2 py-2 text-xs"
          >
            <option value="academic">Academic</option>
            <option value="general">General Training</option>
          </select>
        </label>
        <label>
          <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-500">Target band (optional)</span>
          <input
            id="btt-band"
            type="text"
            value={targetBand}
            onChange={(event) => setTargetBand(event.target.value)}
            placeholder="e.g. 7.0"
            className="mt-1 w-full rounded-lg border border-ink-200 px-3 py-2 text-xs"
          />
        </label>
      </div>

      <button
        id="btn-generate"
        type="button"
        disabled={generating || !topic.trim()}
        onClick={() => void generate()}
        className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-xs font-bold text-white hover:bg-brand-700 disabled:opacity-50"
      >
        {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
        {generating ? 'Retrieving and generating…' : 'Generate'}
      </button>

      {failure && (
        <div
          id="btt-error"
          data-code={failure.code}
          data-failure-class={failure.failureClass ?? ''}
          data-attempts={failure.attempts ?? ''}
          data-model={failure.model ?? ''}
          className="rounded-lg border border-danger-500/30 bg-danger-50 p-3 text-xs text-danger-800"
        >
          <p className="flex items-center gap-1.5 font-bold">
            <XCircle className="h-3.5 w-3.5" />
            {FAILURE_TITLE[failure.code] ?? 'Generation failed'}
          </p>
          <p className="mt-1">{failure.error}</p>
          <p className="mt-1 font-mono text-[10px]">
            code: {failure.code}
            {failure.failureClass ? ` · class: ${failure.failureClass}` : ''}
            {failure.reason ? ` · reason: ${failure.reason}` : ''}
            {failure.attempts ? ` · attempts: ${failure.attempts}` : ''}
            {failure.model ? ` · model: ${failure.model}` : ''}
          </p>
          {failure.worthRetrying === false && (
            <p className="mt-1 font-semibold">Trying again will not help until the configuration is fixed.</p>
          )}
          {failure.retrieval?.reason && <p className="mt-1">Retrieval: {failure.retrieval.reason}</p>}
        </div>
      )}

      {result && summary && (
        <div id="btt-result" data-status={result.status} data-replayed={String(Boolean(result.replayed))} className="space-y-3">
          {result.replayed && (
            <p id="btt-replayed" className="rounded-lg border border-brand-200 bg-brand-50 p-2 text-[11px] font-semibold text-brand-800">
              This request had already produced a draft. It is shown again; nothing new was generated.
            </p>
          )}
          <div id="btt-summary" className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="rounded-full bg-success-50 px-2 py-0.5 font-bold text-success-700" data-count="valid">
              {summary.valid} valid
            </span>
            <span className="rounded-full bg-warning-50 px-2 py-0.5 font-bold text-warning-800" data-count="needs_review">
              {summary.needsReview} need review
            </span>
            <span className="rounded-full bg-danger-50 px-2 py-0.5 font-bold text-danger-700" data-count="rejected">
              {summary.rejected} rejected
            </span>
            <span className="text-ink-500">
              {summary.returned} returned of {summary.requested} requested
            </span>
            {!summary.complete && (
              <span className="flex items-center gap-1 font-semibold text-warning-800" id="btt-incomplete">
                <AlertTriangle className="h-3 w-3" /> incomplete generation
              </span>
            )}
          </div>

          <dl
            className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-lg bg-ink-50 p-2.5 font-mono text-[10px] text-ink-600"
            id="btt-provenance"
            data-generator-version={result.generation.generatorVersion}
            data-prompt-version={result.generation.promptVersion}
            data-model={result.generation.model}
            data-model-version={result.generation.modelVersion ?? ''}
            data-attempts={result.generation.attempts ?? ''}
          >
            <dt>model</dt>
            <dd>{result.generation.model}</dd>
            <dt>model version</dt>
            <dd>{result.generation.modelVersion ?? 'not reported by the provider'}</dd>
            <dt>generator</dt>
            <dd>{result.generation.generatorVersion}</dd>
            <dt>prompt</dt>
            <dd>{result.generation.promptVersion}</dd>
            <dt>generation</dt>
            <dd>{result.generation.generationId}</dd>
            <dt>generated</dt>
            <dd>{result.generation.generatedAt}</dd>
            {result.generation.requestId && (
              <>
                <dt>request</dt>
                <dd>
                  {result.generation.requestId}
                  {result.generation.attempts
                    ? ` · ${result.generation.attempts} model call${result.generation.attempts === 1 ? '' : 's'}`
                    : ''}
                </dd>
              </>
            )}
            <dt>source</dt>
            <dd>
              {result.generation.source.title} ({result.generation.source.sourceId})
            </dd>
          </dl>

          <div id="btt-sources">
            <p className="mb-1 text-[11px] font-bold text-ink-700">
              Passages given to the model ({result.retrieved.length}) — nothing else was in the prompt
            </p>
            <ul className="space-y-1">
              {result.retrieved.map((item) => (
                <li
                  key={item.chunkId}
                  data-retrieved-chunk={item.chunkId}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-ink-200 px-2.5 py-1.5 text-[11px]"
                >
                  <span className="rounded bg-ink-100 px-1.5 font-bold">Section {item.label ?? '—'}</span>
                  <span className="text-ink-700">{citation(item.location)}</span>
                  <span className="font-mono text-[10px] text-ink-400">{item.chunkId}</span>
                  <span className="ml-auto rounded bg-brand-50 px-1.5 font-mono text-[10px] text-brand-700">
                    {Math.round(item.confidence * 100)}%
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <ul className="space-y-2" id="btt-questions">
            {result.questions.map((item, index) => {
              const shown = item.question ?? {
                prompt: typeof item.candidate?.prompt === 'string' ? item.candidate.prompt : '(not in the draft)',
                correctAnswer:
                  typeof item.candidate?.correctAnswer === 'string' ? item.candidate.correctAnswer : '(not in the draft)',
                options: Array.isArray(item.candidate?.options) ? (item.candidate.options as string[]) : undefined,
              };
              return (
                <li
                  key={item.generatedQuestionId}
                  data-generated-question={item.generatedQuestionId}
                  data-status={item.status}
                  className={`space-y-1.5 rounded-xl border p-3 text-xs ${STATUS_STYLE[item.status]}`}
                >
                  <p className="flex items-center gap-1.5 text-[11px] font-bold">
                    {item.status === 'valid' ? (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    ) : item.status === 'needs_review' ? (
                      <AlertTriangle className="h-3.5 w-3.5" />
                    ) : (
                      <XCircle className="h-3.5 w-3.5" />
                    )}
                    {item.question ? `Q${item.question.questionNumber}` : `#${index + 1}`} · {STATUS_LABEL[item.status]}
                  </p>
                  <p className="font-semibold text-ink-900">{shown.prompt}</p>
                  {shown.options && (
                    <ul className="list-inside list-disc text-ink-700">
                      {shown.options.map((option) => (
                        <li key={option}>{option}</li>
                      ))}
                    </ul>
                  )}
                  <p className="text-ink-700">
                    Answer: <span className="font-mono font-bold">{String(shown.correctAnswer)}</span>
                  </p>
                  <p className="flex flex-wrap gap-2 text-[10px] font-bold uppercase tracking-[0.06em]" data-dimensions>
                    <span data-grounding={item.groundingVerdict?.status ?? item.status}>
                      grounding: {!item.groundingVerdict ? item.status.replace(/_/g, ' ') : item.groundingVerdict.evaluated ? item.groundingVerdict.status.replace(/_/g, ' ') : 'not evaluated'}
                    </span>
                    <span data-quality={item.qualityVerdict?.status ?? item.status}>
                      quality: {!item.qualityVerdict ? item.status.replace(/_/g, ' ') : item.qualityVerdict.evaluated ? item.qualityVerdict.status.replace(/_/g, ' ') : 'not evaluated'}
                    </span>
                  </p>
                  {item.groundingVerdict || item.qualityVerdict ? (
                    <ul className="space-y-0.5" data-reasons>
                      {[...(item.groundingVerdict?.reasons ?? []), ...(item.qualityVerdict?.reasons ?? [])].map((reason) => (
                        <li key={`${reason.code}-${reason.message}`} data-reason-code={reason.code}>
                          <span className="font-mono text-[10px] opacity-70">{reason.code}</span> {reason.message}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    item.reasons.length > 0 && (
                      <ul className="list-inside list-disc" data-reasons>
                        {item.reasons.map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                    )
                  )}
                  {(item.answerEvidence ?? item.evidence).length > 0 && (
                    <div className="space-y-1 rounded-lg bg-white/70 p-2 text-ink-700" data-answer-evidence>
                      <p className="text-[10px] font-bold uppercase tracking-[0.06em] text-ink-500">Answer evidence</p>
                      {(item.answerEvidence ?? item.evidence).map((evidence) => (
                        <p key={`${evidence.chunkId}-${evidence.quote}`}>
                          <FileText className="mr-1 inline h-3 w-3" />“{evidence.quote}”
                          <span className="ml-1 font-mono text-[10px] text-ink-400">{evidence.chunkId}</span>
                        </p>
                      ))}
                    </div>
                  )}
                  {(item.questionEvidence ?? []).length > 0 && (
                    <div className="space-y-1 rounded-lg bg-white/50 p-2 text-ink-600" data-question-evidence>
                      <p className="text-[10px] font-bold uppercase tracking-[0.06em] text-ink-500">Question evidence</p>
                      {(item.questionEvidence ?? []).map((evidence) => (
                        <p key={`q-${evidence.chunkId}-${evidence.quote}`}>“{evidence.quote}”</p>
                      ))}
                    </div>
                  )}
                  {item.question?.provenance && (
                    <p className="font-mono text-[10px] text-ink-500" data-provenance>
                      chunks {item.question.provenance.chunkIds.join(', ')}
                      {item.question.provenance.pages.length > 0
                        ? ` · pages ${item.question.provenance.pages.join(', ')}`
                        : ' · page not recorded by this format'}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>

          {result.materialId ? (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-ink-200 bg-ink-50 p-3">
              <p className="text-xs text-ink-700">
                Draft <span className="font-mono">{result.materialId}</span> {result.replayed ? 'already exists' : 'created'} with
                status <b>{result.materialStatus}</b>. It is not published.
              </p>
              <button
                id="btn-open-generated-review"
                type="button"
                disabled={opening}
                onClick={() => void openReview(result.materialId as string)}
                className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-ink-900 px-3 py-1.5 text-xs font-bold text-white hover:bg-ink-800 disabled:opacity-50"
              >
                {opening && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Open draft in review
              </button>
            </div>
          ) : (
            <p className="text-xs font-semibold text-danger-700" id="btt-no-draft">
              No draft was created.
            </p>
          )}
        </div>
      )}

      <div id="btt-runs" className="space-y-1.5 border-t border-ink-100 pt-3">
        <p className="flex items-center gap-1.5 text-[11px] font-bold text-ink-700">
          <Clock className="h-3.5 w-3.5" /> Recent generation runs for this source
        </p>
        {runsError ? (
          <p className="text-[11px] text-danger-700">{runsError}</p>
        ) : runs.length === 0 ? (
          <p className="text-[11px] text-ink-500">No generation has been run from this source yet.</p>
        ) : (
          <ul className="space-y-1">
            {runs.map((run) => (
              <li
                key={run.runId}
                data-run-outcome={run.outcome}
                data-run-code={run.failure?.code ?? ''}
                data-run-class={run.failure?.failureClass ?? ''}
                data-run-attempts={run.attempts}
                data-run-model={run.model ?? ''}
                className="rounded-lg border border-ink-200 px-2.5 py-1.5 text-[11px] text-ink-700"
              >
                <span className="font-mono text-[10px] text-ink-500">{run.startedAt}</span>{' '}
                <b
                  className={
                    run.outcome === 'draft_created'
                      ? 'text-success-700'
                      : run.outcome === 'all_rejected'
                        ? 'text-warning-800'
                        : 'text-danger-700'
                  }
                >
                  {run.outcome === 'draft_created' ? 'draft created' : run.failure?.code ?? run.outcome}
                </b>
                {run.failure?.failureClass ? ` · ${run.failure.failureClass}` : ''}
                {' · '}
                {run.modelCalled
                  ? `${run.attempts} model call${run.attempts === 1 ? '' : 's'} · ${run.model ?? 'model not recorded'}${run.modelVersion ? ` (${run.modelVersion})` : ''}`
                  : 'model not called'}
                {` · ${run.request.questionType} × ${run.request.count} · “${run.request.topic}” · ${Math.round(run.durationMs / 100) / 10} s`}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
