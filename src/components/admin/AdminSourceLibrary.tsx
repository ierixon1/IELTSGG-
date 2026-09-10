import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  BookMarked,
  CheckCircle2,
  FileSearch,
  Loader2,
  Quote,
  Search,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import type { SourceChunk, StoredSource, StoredSourceSummary } from '../../types/source';
import type { RetrievalOutcome } from '../../services/sourceIngest/retrieve';
import type { ReviewState } from '../../services/cdiImport/review';
import { AdminBookToTest } from './AdminBookToTest';

interface AdminSourceLibraryProps {
  onToast: (message: string) => void;
  /** Hands a generated draft to the existing import review screen. */
  onOpenReview?: (state: ReviewState) => void;
  /** Materials changed outside the catalog, e.g. a generated draft was created. */
  onMaterialsChanged?: () => void;
}

interface SpanCheck {
  span: string;
  matches: boolean;
  provenance: {
    sourceId: string;
    sourceTitle: string;
    filename: string;
    sourceAssetId: string;
    extractorVersion: string;
    chunkerVersion: string;
    location: SourceChunk['location'];
  };
}

const STATUS_STYLES: Record<string, string> = {
  uploaded: 'bg-ink-100 text-ink-600',
  extracting: 'bg-brand-50 text-brand-700',
  chunking: 'bg-brand-50 text-brand-700',
  ready: 'bg-success-50 text-success-700',
  failed: 'bg-danger-50 text-danger-700',
};

/** "Chapter 1 › When to skim · p. 12" — the citation, in one line. */
export function citationOf(chunk: SourceChunk): string {
  const trail = chunk.location.path.join(' › ') || 'Untitled section';
  return chunk.location.page ? `${trail} · p. ${chunk.location.page}` : trail;
}

/**
 * The source library: put a textbook in, see what the pipeline made of it,
 * and search the passages it produced.
 *
 * This is an inspection screen, not an authoring one. Nothing here edits a
 * chunk or generates anything from it — the question it answers is whether a
 * book was read correctly, and the way to answer that is to search it and check
 * that what comes back is really on the page the citation names.
 */
export const AdminSourceLibrary: React.FC<AdminSourceLibraryProps> = ({ onToast, onOpenReview, onMaterialsChanged }) => {
  const [sources, setSources] = useState<StoredSourceSummary[]>([]);
  const [supported, setSupported] = useState<string[]>([]);
  const [selected, setSelected] = useState<StoredSource | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [title, setTitle] = useState('');

  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [outcome, setOutcome] = useState<RetrievalOutcome | null>(null);
  const [browse, setBrowse] = useState<SourceChunk[]>([]);
  const [chunkError, setChunkError] = useState<string | null>(null);
  const [spans, setSpans] = useState<Record<string, SpanCheck>>({});

  const fileRef = useRef<HTMLInputElement>(null);

  const loadList = async () => {
    const response = await fetch('/api/admin/sources', { credentials: 'same-origin' });
    if (response.ok) setSources((await response.json()).items ?? []);
  };

  const select = async (id: string) => {
    setOutcome(null);
    setBrowse([]);
    setChunkError(null);
    setSpans({});
    setQuery('');
    const response = await fetch(`/api/admin/sources/${encodeURIComponent(id)}`, {
      credentials: 'same-origin',
    });
    if (!response.ok) {
      setSelected(null);
      return;
    }
    const source: StoredSource = (await response.json()).item;
    setSelected(source);
    if (source.status !== 'ready') return;

    const chunks = await fetch(
      `/api/admin/sources/${encodeURIComponent(id)}/chunks?limit=5`,
      { credentials: 'same-origin' },
    );
    const body = await chunks.json();
    if (chunks.ok) setBrowse(body.items ?? []);
    else setChunkError(body.error ?? 'The passages could not be loaded.');
  };

  useEffect(() => {
    void loadList();
    void fetch('/api/admin/sources/supported', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : { extensions: [] }))
      .then((body) => setSupported(body.extensions ?? []));
  }, []);

  const upload = async (file: File) => {
    setUploading(true);
    setUploadError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      if (title.trim()) form.append('title', title.trim());
      const response = await fetch('/api/admin/sources', {
        method: 'POST',
        credentials: 'same-origin',
        body: form,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'The file could not be ingested.');

      const source: StoredSource = body.item;
      onToast(
        source.status === 'ready'
          ? `"${source.title}" is ready: ${source.stats.chunks} passages.`
          : `"${source.title}" failed: ${source.error}`,
      );
      setTitle('');
      await loadList();
      await select(source.id);
    } catch (error: unknown) {
      setUploadError(error instanceof Error ? error.message : 'The file could not be ingested.');
    } finally {
      setUploading(false);
    }
  };

  const search = async () => {
    if (!selected) return;
    setSearching(true);
    setChunkError(null);
    setSpans({});
    try {
      const response = await fetch(
        `/api/admin/sources/${encodeURIComponent(selected.id)}/chunks?q=${encodeURIComponent(query)}&limit=10`,
        { credentials: 'same-origin' },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'The search failed.');
      setOutcome(body.retrieval);
    } catch (error: unknown) {
      setChunkError(error instanceof Error ? error.message : 'The search failed.');
    } finally {
      setSearching(false);
    }
  };

  const inspect = async (chunk: SourceChunk) => {
    const response = await fetch(
      `/api/admin/sources/${encodeURIComponent(chunk.sourceId)}/chunks/${encodeURIComponent(chunk.id)}/source`,
      { credentials: 'same-origin' },
    );
    const body = await response.json();
    if (!response.ok) {
      onToast(body.error || 'The original span could not be read.');
      return;
    }
    setSpans((previous) => ({ ...previous, [chunk.id]: body }));
  };

  const remove = async (source: StoredSourceSummary) => {
    if (!confirm(`Delete "${source.title}" and all of its passages?`)) return;
    const response = await fetch(`/api/admin/sources/${encodeURIComponent(source.id)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    if (!response.ok) {
      onToast('The source could not be deleted.');
      return;
    }
    if (selected?.id === source.id) setSelected(null);
    await loadList();
  };

  const renderChunk = (chunk: SourceChunk, extra?: React.ReactNode) => {
    const span = spans[chunk.id];
    return (
      <li
        key={chunk.id}
        data-chunk-id={chunk.id}
        className="space-y-2 rounded-xl border border-ink-200 bg-white p-3"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="text-[11px] font-semibold text-ink-600" data-citation>
            {citationOf(chunk)}
          </p>
          <div className="flex items-center gap-2">
            {extra}
            <button
              type="button"
              id={`btn-inspect-${chunk.id}`}
              onClick={() => void inspect(chunk)}
              className="inline-flex items-center gap-1 rounded-lg border border-ink-200 px-2 py-1 text-[11px] font-semibold text-ink-600 hover:border-ink-300"
            >
              <Quote className="h-3 w-3" />
              Inspect source
            </button>
          </div>
        </div>
        <p className="whitespace-pre-line text-xs leading-relaxed text-ink-800">{chunk.text}</p>

        {span && (
          <div
            data-span-for={chunk.id}
            data-span-matches={String(span.matches)}
            className={`rounded-lg border p-2.5 text-[11px] ${
              span.matches
                ? 'border-success-500/30 bg-success-50 text-success-800'
                : 'border-danger-500/30 bg-danger-50 text-danger-800'
            }`}
          >
            <p className="font-bold">
              {span.matches
                ? 'Verified: this text is exactly the stored extraction at these offsets.'
                : 'Mismatch: the stored extraction at these offsets is not this text.'}
            </p>
            <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono">
              <dt>file</dt>
              <dd>{span.provenance.filename}</dd>
              <dt>original</dt>
              <dd>{span.provenance.sourceAssetId}</dd>
              <dt>page</dt>
              <dd>{span.provenance.location.page ?? 'not recorded by this format'}</dd>
              <dt>chars</dt>
              <dd>
                {span.provenance.location.charStart}–{span.provenance.location.charEnd}
              </dd>
              <dt>extractor</dt>
              <dd>{span.provenance.extractorVersion}</dd>
              <dt>chunker</dt>
              <dd>{span.provenance.chunkerVersion}</dd>
            </dl>
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]" id="admin-source-library">
      <div className="space-y-4">
        <div className="space-y-3 rounded-2xl border border-ink-200 bg-white p-4">
          <p className="text-sm font-bold text-ink-900">Add a textbook</p>
          <input
            id="source-title"
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Title (optional — the filename otherwise)"
            className="w-full rounded-lg border border-ink-200 px-3 py-2 text-xs"
          />
          <button
            type="button"
            id="btn-upload-source"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-ink-900 px-3 py-2 text-xs font-bold text-white hover:bg-ink-800 disabled:bg-ink-300"
          >
            {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            {uploading ? 'Ingesting…' : 'Choose file and ingest'}
          </button>
          <input
            ref={fileRef}
            id="source-file-input"
            type="file"
            accept={supported.join(',')}
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void upload(file);
            }}
          />
          <p className="text-[11px] text-ink-500" id="source-supported">
            Supported: {supported.join(', ') || '…'}. Scanned PDFs without a text layer are not
            supported.
          </p>
          {uploadError && (
            <p
              id="source-upload-error"
              className="rounded-lg border border-danger-500/30 bg-danger-50 p-2 text-xs text-danger-700"
            >
              {uploadError}
            </p>
          )}
        </div>

        <ul className="space-y-2" id="source-list">
          {sources.length === 0 && (
            <li className="rounded-xl border border-dashed border-ink-200 p-4 text-center text-xs text-ink-500">
              No textbooks ingested yet.
            </li>
          )}
          {sources.map((source) => (
            <li
              key={source.id}
              data-source-id={source.id}
              data-status={source.status}
              className={`rounded-xl border bg-white p-3 ${
                selected?.id === source.id ? 'border-brand-400' : 'border-ink-200'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <button
                  type="button"
                  onClick={() => void select(source.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <p className="truncate text-xs font-bold text-ink-900">{source.title}</p>
                  <p className="mt-0.5 truncate text-[11px] text-ink-500">{source.filename}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px]">
                    <span
                      data-status-badge={source.status}
                      className={`rounded-full px-2 py-0.5 font-bold ${STATUS_STYLES[source.status] ?? ''}`}
                    >
                      {source.status}
                    </span>
                    <span className="text-ink-500">{source.stats.chunks} passages</span>
                    {source.warningCount > 0 && (
                      <span className="text-warning-700">{source.warningCount} warnings</span>
                    )}
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => void remove(source)}
                  className="rounded-lg p-1 text-ink-400 hover:bg-danger-50 hover:text-danger-500"
                  title="Delete source"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="min-w-0 space-y-4">
        {!selected && (
          <div className="rounded-2xl border border-dashed border-ink-200 p-10 text-center text-xs text-ink-500">
            <BookMarked className="mx-auto mb-2 h-6 w-6 text-ink-300" />
            Select a textbook to see its ingestion report and search its passages.
          </div>
        )}

        {selected && (
          <div className="space-y-4" id="source-detail" data-source-id={selected.id}>
            <div className="rounded-2xl border border-ink-200 bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-bold text-ink-900">{selected.title}</p>
                  <p className="text-[11px] text-ink-500">
                    {selected.filename} · {selected.fileKind} · original {selected.sourceAssetId}
                  </p>
                </div>
                <span
                  id="source-status"
                  data-status={selected.status}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${STATUS_STYLES[selected.status] ?? ''}`}
                >
                  {selected.status === 'ready' ? (
                    <CheckCircle2 className="mr-1 inline h-3 w-3" />
                  ) : selected.status === 'failed' ? (
                    <XCircle className="mr-1 inline h-3 w-3" />
                  ) : null}
                  {selected.status}
                </span>
              </div>

              <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4" id="source-stats">
                {[
                  ['Passages', selected.stats.chunks],
                  ['Headings', selected.stats.headings],
                  ['Pages', selected.stats.pages ?? '—'],
                  ['Characters', selected.stats.characters.toLocaleString()],
                ].map(([label, value]) => (
                  <div key={String(label)} className="rounded-lg bg-ink-50 p-2">
                    <dt className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-500">{label}</dt>
                    <dd className="text-sm font-bold text-ink-900" data-stat={String(label).toLowerCase()}>
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>

              {selected.error && (
                <p
                  id="source-error"
                  className="mt-3 rounded-lg border border-danger-500/30 bg-danger-50 p-2.5 text-xs text-danger-700"
                >
                  {selected.error}
                </p>
              )}

              {selected.warnings.length > 0 && (
                <ul id="source-warnings" className="mt-3 space-y-1">
                  {selected.warnings.map((warning, index) => (
                    <li
                      key={`${warning.code}-${index}`}
                      className="flex items-start gap-1.5 text-[11px] text-warning-700"
                    >
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                      {warning.message}
                    </li>
                  ))}
                </ul>
              )}

              <p className="mt-3 text-[10px] text-ink-400">
                extractor {selected.extractorVersion} · chunker {selected.chunkerVersion}
              </p>
            </div>

            {selected.status === 'ready' && (
              <div className="space-y-3 rounded-2xl border border-ink-200 bg-white p-4">
                <form
                  className="flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void search();
                  }}
                >
                  <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-ink-400" />
                    <input
                      id="source-search-input"
                      type="text"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Search this textbook…"
                      className="w-full rounded-lg border border-ink-200 py-2 pl-8 pr-3 text-xs"
                    />
                  </div>
                  <button
                    id="btn-search-source"
                    type="submit"
                    disabled={searching}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-xs font-bold text-white hover:bg-brand-700 disabled:opacity-50"
                  >
                    {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSearch className="h-3.5 w-3.5" />}
                    Search
                  </button>
                </form>

                {chunkError && (
                  <p className="rounded-lg border border-danger-500/30 bg-danger-50 p-2 text-xs text-danger-700">
                    {chunkError}
                  </p>
                )}

                {outcome && outcome.status !== 'ok' && (
                  <div
                    id="retrieval-empty"
                    data-retrieval-status={outcome.status}
                    className="rounded-lg border border-ink-200 bg-ink-50 p-3 text-xs text-ink-700"
                  >
                    <p className="font-bold">
                      {outcome.status === 'no_match'
                        ? 'No passages match.'
                        : outcome.status === 'low_confidence'
                          ? 'Nothing matched strongly enough to show.'
                          : 'Nothing to search for.'}
                    </p>
                    <p className="mt-0.5">{outcome.reason}</p>
                  </div>
                )}

                {outcome && outcome.status === 'ok' && (
                  <div id="retrieval-results" data-retrieval-status="ok">
                    <p className="mb-2 text-[11px] text-ink-500">
                      {outcome.hits.length} passage{outcome.hits.length === 1 ? '' : 's'} for{' '}
                      <span className="font-mono">{outcome.terms.join(' ')}</span>
                    </p>
                    <ul className="space-y-2">
                      {outcome.hits.map((hit) =>
                        renderChunk(
                          hit.chunk,
                          <span
                            className="rounded bg-brand-50 px-1.5 py-0.5 font-mono text-[10px] text-brand-700"
                            title={`matched: ${hit.matchedTerms.join(', ')}`}
                            data-confidence={hit.confidence}
                          >
                            {Math.round(hit.confidence * 100)}%
                          </span>,
                        ),
                      )}
                    </ul>
                  </div>
                )}

                {!outcome && browse.length > 0 && (
                  <div id="source-browse">
                    <p className="mb-2 text-[11px] text-ink-500">
                      First {browse.length} of {selected.stats.chunks} passages, in reading order.
                    </p>
                    <ul className="space-y-2">{browse.map((chunk) => renderChunk(chunk))}</ul>
                  </div>
                )}
              </div>
            )}

            {selected.status === 'ready' && onOpenReview && (
              <AdminBookToTest
                source={selected}
                onOpenReview={onOpenReview}
                onToast={onToast}
                onDraftCreated={() => onMaterialsChanged?.()}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
};
