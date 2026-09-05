import React, { useState } from 'react';
import { Upload, Music, Image as ImageIcon, FileText, FileCode, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';

interface FileUploadZoneProps {
  accept: string;
  category: 'audio' | 'image' | 'document' | 'html';
  label: string;
  description: string;
  onUploaded: (fileData: { url: string; originalName: string; size: number; extractedText?: string; extractedHtml?: string }) => void;
}

export const FileUploadZone: React.FC<FileUploadZoneProps> = ({
  accept,
  category,
  label,
  description,
  onUploaded,
}) => {
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [uploadedFile, setUploadedFile] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    setUploading(true);
    setProgress(15);

    try {
      const formData = new FormData();
      formData.append('file', file);

      setProgress(45);
      const res = await fetch('/api/admin/upload', {
        credentials: 'same-origin', method: 'POST',
        headers: {
        },
        body: formData,
      });

      setProgress(90);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to upload file.');
      }

      setProgress(100);
      setUploadedFile(data.file.originalName);
      onUploaded({
        url: data.file.url,
        originalName: data.file.originalName,
        size: data.file.size,
        extractedText: data.file.extractedText,
        extractedHtml: data.file.extractedHtml,
      });
    } catch (err: any) {
      setError(err.message || 'File upload error.');
    } finally {
      setUploading(false);
      setTimeout(() => setProgress(null), 1200);
    }
  };

  const getIcon = () => {
    switch (category) {
      case 'audio':
        return <Music className="w-5 h-5 text-indigo-500" />;
      case 'image':
        return <ImageIcon className="w-5 h-5 text-emerald-500" />;
      case 'html':
        return <FileCode className="w-5 h-5 text-blue-600" />;
      case 'document':
      default:
        return <FileText className="w-5 h-5 text-amber-500" />;
    }
  };

  return (
    <div className="border border-dashed border-slate-300 rounded-xl p-4 bg-slate-50/70 hover:bg-slate-50 transition-colors">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center space-x-2">
          {getIcon()}
          <span className="text-xs font-bold text-slate-800">{label}</span>
        </div>
        <span className="text-[10px] text-slate-400 font-medium">{accept}</span>
      </div>

      <p className="text-xs text-slate-500 mb-3">{description}</p>

      {error && (
        <div className="mb-3 p-2 rounded-lg bg-rose-50 border border-rose-200 flex items-center space-x-2 text-rose-700 text-xs">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {uploadedFile && !error && (
        <div className="mb-3 p-2 rounded-lg bg-emerald-50 border border-emerald-200 flex items-center space-x-2 text-emerald-800 text-xs font-medium">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-emerald-600" />
          <span className="truncate">Attached: {uploadedFile}</span>
        </div>
      )}

      {progress !== null && (
        <div className="w-full bg-slate-200 rounded-full h-1.5 mb-3 overflow-hidden">
          <div
            className="bg-slate-900 h-1.5 rounded-full transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      <label className="inline-flex items-center space-x-2 px-3 py-1.5 rounded-lg bg-white border border-slate-300 hover:border-slate-400 text-slate-700 text-xs font-semibold cursor-pointer shadow-2xs transition-colors">
        {uploading ? (
          <>
            <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-600" />
            <span>Uploading...</span>
          </>
        ) : (
          <>
            <Upload className="w-3.5 h-3.5 text-slate-500" />
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
    </div>
  );
};
