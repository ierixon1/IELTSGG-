import React, { useState } from 'react';
import { Upload, Music, Image as ImageIcon, FileText, FileCode, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';

interface FileUploadZoneProps {
  accept: string;
  category: 'audio' | 'image' | 'document' | 'html';
  label: string;
  description: string;
  adminToken: string;
  onUploaded: (fileData: { url: string; originalName: string; size: number; extractedText?: string; extractedHtml?: string }) => void;
}

export const FileUploadZone: React.FC<FileUploadZoneProps> = ({
  accept,
  category,
  label,
  description,
  adminToken,
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
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
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
        return <Music className="w-5 h-5 text-brand-500" />;
      case 'image':
        return <ImageIcon className="w-5 h-5 text-success-500" />;
      case 'html':
        return <FileCode className="w-5 h-5 text-brand-600" />;
      case 'document':
      default:
        return <FileText className="w-5 h-5 text-warning-500" />;
    }
  };

  return (
    <div className="border border-dashed border-ink-300 rounded-xl p-4 bg-ink-50/70 hover:bg-ink-50 transition-colors">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center space-x-2">
          {getIcon()}
          <span className="text-xs font-bold text-ink-800">{label}</span>
        </div>
        <span className="text-[10px] text-ink-400 font-medium">{accept}</span>
      </div>

      <p className="text-xs text-ink-500 mb-3">{description}</p>

      {error && (
        <div className="mb-3 p-2 rounded-lg bg-danger-50 border border-danger-50 flex items-center space-x-2 text-danger-700 text-xs">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {uploadedFile && !error && (
        <div className="mb-3 p-2 rounded-lg bg-success-50 border border-success-50 flex items-center space-x-2 text-success-700 text-xs font-medium">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-success-500" />
          <span className="truncate">Attached: {uploadedFile}</span>
        </div>
      )}

      {progress !== null && (
        <div className="w-full bg-ink-200 rounded-full h-1.5 mb-3 overflow-hidden">
          <div
            className="bg-ink-900 h-1.5 rounded-full transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      <label className="inline-flex items-center space-x-2 px-3 py-1.5 rounded-lg bg-white border border-ink-300 hover:border-ink-400 text-ink-700 text-xs font-semibold cursor-pointer shadow-2xs transition-colors">
        {uploading ? (
          <>
            <Loader2 className="w-3.5 h-3.5 animate-spin text-ink-600" />
            <span>Uploading...</span>
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
    </div>
  );
};
