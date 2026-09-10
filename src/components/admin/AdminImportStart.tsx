import React, { useRef, useState } from 'react';
import { AlertCircle, FileCode, Loader2, Upload, Wand2 } from 'lucide-react';
import type { CdiImportResult } from '../../services/cdiImport/types';

interface AdminImportStartProps {
  onParsed: (result: CdiImportResult, sourceHtml: string, sourceAssetId?: string) => void;
  onCancel: () => void;
}

/**
 * Where an import begins: paste the page, or pick the file.
 *
 * Parsing happens on the server — there is one parser, and duplicating any of
 * it here would mean the review screen could show something the saved material
 * would not agree with. This screen sends the bytes and hands the result on.
 */
export const AdminImportStart: React.FC<AdminImportStartProps> = ({ onParsed, onCancel }) => {
  const [html, setHtml] = useState('');
  const [filename, setFilename] = useState<string | undefined>();
  const [analysing, setAnalysing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const readFile = async (file: File) => {
    setError(null);
    try {
      const text = await file.text();
      setHtml(text);
      setFilename(file.name);
    } catch {
      setError('That file could not be read as text.');
    }
  };

  const analyse = async () => {
    if (!html.trim()) {
      setError('Paste a page, or choose a file, first.');
      return;
    }
    setAnalysing(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/import/html', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html, filename }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error || 'The page could not be analysed.');

      onParsed(
        {
          parserVersion: body.parserVersion,
          detectedSection: body.detectedSection,
          title: body.title,
          normalizedHtml: body.material?.content?.htmlContent ?? '',
          normalizedText: '',
          questions: body.questions,
          unsupportedRegions: body.unsupportedRegions,
          assets: body.assets,
          diagnostics: body.diagnostics,
          transcript: body.transcript,
          stats: body.stats,
        },
        html,
        body.sourceAssetId,
      );
    } catch (analyseError: unknown) {
      setError(analyseError instanceof Error ? analyseError.message : 'The page could not be analysed.');
    } finally {
      setAnalysing(false);
    }
  };

  return (
    <div className="space-y-5" id="admin-import-start">
      <div className="border-b border-ink-200 pb-4">
        <h3 className="text-lg font-bold text-ink-900">Import a CDI page</h3>
        <p className="text-xs text-ink-500">
          Paste the page source, or choose the .html file. It is analysed and shown to you for
          review — nothing is saved until you confirm it.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="inline-flex items-center gap-2 rounded-lg border border-ink-300 bg-white px-3 py-2 text-xs font-semibold text-ink-700 hover:border-ink-400"
        >
          <Upload className="h-3.5 w-3.5 text-ink-500" />
          Choose .html file
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".html,.htm"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void readFile(file);
          }}
        />
        {filename && (
          <span className="inline-flex items-center gap-1.5 text-xs text-ink-600">
            <FileCode className="h-3.5 w-3.5 text-brand-500" />
            {filename}
          </span>
        )}
        {html && (
          <span className="font-mono text-[11px] text-ink-400">
            {html.length.toLocaleString()} characters
          </span>
        )}
      </div>

      <label className="block">
        <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-ink-500">
          Page source
        </span>
        <textarea
          id="import-html-source"
          rows={12}
          value={html}
          onChange={(event) => {
            setHtml(event.target.value);
            setFilename(undefined);
          }}
          placeholder="<!DOCTYPE html> …"
          className="mt-1 w-full rounded-lg border border-ink-200 bg-ink-50/60 p-3 font-mono text-[11px] leading-relaxed"
        />
      </label>

      {error && (
        <p className="flex items-start gap-2 rounded-lg border border-danger-500/30 bg-danger-50 p-3 text-xs text-danger-700">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}

      <div className="flex items-center justify-end gap-3 border-t border-ink-200 pt-4">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-4 py-2 text-xs font-semibold text-ink-600 hover:text-ink-900"
        >
          Cancel
        </button>
        <button
          id="btn-analyse-import"
          type="button"
          onClick={analyse}
          disabled={analysing || !html.trim()}
          className="inline-flex items-center gap-2 rounded-lg bg-ink-900 px-5 py-2 text-xs font-bold text-white hover:bg-ink-800 disabled:cursor-not-allowed disabled:bg-ink-300"
        >
          {analysing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
          {analysing ? 'Analysing…' : 'Analyse page'}
        </button>
      </div>
    </div>
  );
};
