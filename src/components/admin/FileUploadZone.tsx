import React, { useRef, useState } from 'react';
import { Upload, Music, Image as ImageIcon, FileText, FileCode, CheckCircle2, AlertCircle, Loader2, X } from 'lucide-react';
import type { UploadedAssetSummary } from '../../types/asset';

interface FileUploadZoneProps {
  accept: string;
  category: 'audio' | 'image' | 'document' | 'html';
  label: string;
  description: string;
  onUploaded: (asset: UploadedAssetSummary) => void;
}

type Phase = 'idle' | 'sending' | 'processing' | 'done' | 'failed';

const PHASE_LABEL: Record<Phase, string> = {
  idle: 'Choose file',
  sending: 'Uploading',
  processing: 'Processing',
  done: 'Attached',
  failed: 'Failed',
};

/**
 * Uploads one file and reports what really happened to it.
 *
 * Progress used to be `15 → 45 → 90 → 100` around a single `fetch`, so a 30MB
 * audio file sat at 45% for its whole upload and read as a hang. `fetch` has no
 * upload-progress event, so this uses `XMLHttpRequest` and shows bytes actually
 * sent, then switches to an indeterminate "processing" state for the work the
 * server does — sniffing, sanitising, extracting text — where there is nothing
 * to measure.
 */
export const FileUploadZone: React.FC<FileUploadZoneProps> = ({
  accept,
  category,
  label,
  description,
  onUploaded,
}) => {
  const [phase, setPhase] = useState<Phase>('idle');
  const [percent, setPercent] = useState(0);
  const [uploadedName, setUploadedName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const requestRef = useRef<XMLHttpRequest | null>(null);

  const uploading = phase === 'sending' || phase === 'processing';

  const upload = (file: File) =>
    new Promise<UploadedAssetSummary>((resolve, reject) => {
      const form = new FormData();
      form.append('file', file);

      const request = new XMLHttpRequest();
      requestRef.current = request;
      request.open('POST', '/api/admin/upload');
      request.withCredentials = true;

      request.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        setPercent(Math.round((event.loaded / event.total) * 100));
        if (event.loaded === event.total) setPhase('processing');
      };
      request.upload.onload = () => setPhase('processing');

      request.onload = () => {
        let body: any = {};
        try {
          body = JSON.parse(request.responseText || '{}');
        } catch {
          /* Falls through to the status check below. */
        }
        if (request.status >= 200 && request.status < 300 && body?.file) resolve(body.file);
        else reject(new Error(body?.error || `Upload failed (HTTP ${request.status}).`));
      };
      request.onerror = () => reject(new Error('Network error during upload.'));
      request.onabort = () => reject(new Error('Upload cancelled.'));
      request.ontimeout = () => reject(new Error('Upload timed out.'));

      request.send(form);
    });

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Clear the input so the same file can be retried after a failure.
    event.target.value = '';
    if (!file) return;

    setError(null);
    setWarning(null);
    setUploadedName(null);
    setPercent(0);
    setPhase('sending');

    try {
      const asset = await upload(file);
      setPhase('done');
      setPercent(100);
      setUploadedName(asset.originalName);
      // A file can store perfectly well and still yield no text. Saying so beats
      // presenting an empty passage as a successful extraction.
      if (asset.extractionError) setWarning(asset.extractionError);
      onUploaded(asset);
    } catch (uploadError: any) {
      setPhase('failed');
      setError(uploadError?.message || 'File upload error.');
    } finally {
      requestRef.current = null;
    }
  };

  const icon = {
    audio: <Music className="w-5 h-5 text-brand-500" />,
    image: <ImageIcon className="w-5 h-5 text-success-500" />,
    html: <FileCode className="w-5 h-5 text-brand-600" />,
    document: <FileText className="w-5 h-5 text-warning-500" />,
  }[category];

  return (
    <div className="border border-dashed border-ink-300 rounded-xl p-4 bg-ink-50/70 hover:bg-ink-50 transition-colors">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center space-x-2">
          {icon}
          <span className="text-xs font-bold text-ink-800">{label}</span>
        </div>
        <span className="text-[10px] text-ink-400 font-medium">{accept}</span>
      </div>

      <p className="text-xs text-ink-500 mb-3">{description}</p>

      {error && (
        <div className="mb-3 p-2 rounded-lg bg-danger-50 border border-danger-50 flex items-start space-x-2 text-danger-700 text-xs">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {warning && !error && (
        <div className="mb-3 p-2 rounded-lg bg-warning-50 border border-warning-50 flex items-start space-x-2 text-warning-700 text-xs">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>{warning}</span>
        </div>
      )}

      {uploadedName && !error && (
        <div className="mb-3 p-2 rounded-lg bg-success-50 border border-success-50 flex items-center space-x-2 text-success-700 text-xs font-medium">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-success-500" />
          <span className="truncate">Attached: {uploadedName}</span>
        </div>
      )}

      {uploading && (
        <div className="mb-3">
          <div className="flex items-center justify-between text-[10px] font-semibold text-ink-500 mb-1">
            <span>{PHASE_LABEL[phase]}</span>
            <span className="tabular">{phase === 'sending' ? `${percent}%` : ''}</span>
          </div>
          <div className="w-full bg-ink-200 rounded-full h-1.5 overflow-hidden">
            <div
              className={
                phase === 'processing'
                  ? 'bg-ink-900 h-1.5 w-1/3 animate-pulse rounded-full'
                  : 'bg-ink-900 h-1.5 rounded-full transition-all duration-150'
              }
              style={phase === 'sending' ? { width: `${percent}%` } : undefined}
            />
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <label className="inline-flex items-center space-x-2 px-3 py-1.5 rounded-lg bg-white border border-ink-300 hover:border-ink-400 text-ink-700 text-xs font-semibold cursor-pointer shadow-2xs transition-colors">
          {uploading ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin text-ink-600" />
              <span>{PHASE_LABEL[phase]}…</span>
            </>
          ) : (
            <>
              <Upload className="w-3.5 h-3.5 text-ink-500" />
              <span>Choose File</span>
            </>
          )}
          <input
            type="file"
            accept={accept}
            disabled={uploading}
            onChange={handleFileChange}
            className="hidden"
          />
        </label>

        {phase === 'sending' && (
          <button
            type="button"
            onClick={() => requestRef.current?.abort()}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-ink-500 hover:text-danger-600"
          >
            <X className="w-3.5 h-3.5" />
            Cancel
          </button>
        )}
      </div>
    </div>
  );
};
