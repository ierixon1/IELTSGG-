import React, { useState } from 'react';
import { Layers, Clock, CheckCircle2, AlertCircle, FileCheck } from 'lucide-react';
import { FullCdiBundle, AdminMaterial } from '../../types/admin';

interface AdminCdiBundleBuilderProps {
  initialData?: FullCdiBundle | null;
  materials: {
    listening: any[];
    reading: any[];
    writing: any[];
    speaking: any[];
  };
  onSave: (bundle: Partial<FullCdiBundle>) => Promise<void>;
  onCancel: () => void;
}

export const AdminCdiBundleBuilder: React.FC<AdminCdiBundleBuilderProps> = ({
  initialData,
  materials,
  onSave,
  onCancel,
}) => {
  const [title, setTitle] = useState(initialData?.title || 'Cambridge IELTS 19 Simulation (Full CDI Examination)');
  const [module, setModule] = useState<'academic' | 'general'>(initialData?.module || 'academic');
  const [targetBand, setTargetBand] = useState(initialData?.targetBand || '7.5');
  const [status, setStatus] = useState<'draft' | 'published'>(initialData?.status || 'published');
  const [description, setDescription] = useState(
    initialData?.description || 'Authentic 4-stage computer-delivered test with continuous official timings.'
  );

  // Selected Material IDs
  const [listeningId, setListeningId] = useState(initialData?.materials.listeningId || materials.listening[0]?.id || '');
  const [readingId, setReadingId] = useState(initialData?.materials.readingId || materials.reading[0]?.id || '');
  const [writingId, setWritingId] = useState(initialData?.materials.writingId || materials.writing[0]?.id || '');
  const [speakingId, setSpeakingId] = useState(initialData?.materials.speakingId || materials.speaking[0]?.id || '');

  // Timers
  const [listeningMinutes, setListeningMinutes] = useState(initialData?.timings.listeningMinutes || 30);
  const [readingMinutes, setReadingMinutes] = useState(initialData?.timings.readingMinutes || 60);
  const [writingMinutes, setWritingMinutes] = useState(initialData?.timings.writingMinutes || 60);
  const [speakingMinutes, setSpeakingMinutes] = useState(initialData?.timings.speakingMinutes || 15);

  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({
        id: initialData?.id,
        title,
        module,
        targetBand,
        status,
        description,
        timings: {
          listeningMinutes: Number(listeningMinutes),
          readingMinutes: Number(readingMinutes),
          writingMinutes: Number(writingMinutes),
          speakingMinutes: Number(speakingMinutes),
        },
        materials: {
          listeningId: listeningId || undefined,
          readingId: readingId || undefined,
          writingId: writingId || undefined,
          speakingId: speakingId || undefined,
        },
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between border-b border-slate-200 pb-4">
        <div>
          <h3 className="text-lg font-bold text-slate-900">
            {initialData ? 'Edit Full CDI Examination' : 'Assemble New Full CDI Test Bundle'}
          </h3>
          <p className="text-xs text-slate-500">
            Combine 1 Listening + 1 Reading + 1 Writing + 1 Speaking into a unified 4-skill mock test.
          </p>
        </div>
        <div className="flex items-center space-x-2">
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as any)}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-slate-300 bg-white"
          >
            <option value="published">Status: Published (Available to students)</option>
            <option value="draft">Status: Draft (Work in progress)</option>
          </select>
        </div>
      </div>

      {/* Header Info */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="sm:col-span-2">
          <label className="block text-xs font-bold text-slate-700 mb-1">CDI Test Bundle Title</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full text-xs p-2.5 bg-slate-50 border border-slate-200 rounded-lg font-medium"
          />
        </div>
        <div>
          <label className="block text-xs font-bold text-slate-700 mb-1">Module</label>
          <select
            value={module}
            onChange={(e) => setModule(e.target.value as any)}
            className="w-full text-xs p-2.5 bg-slate-50 border border-slate-200 rounded-lg font-semibold"
          >
            <option value="academic">Academic (AC)</option>
            <option value="general">General Training (GT)</option>
          </select>
        </div>
      </div>

      <div>
        <label className="block text-xs font-bold text-slate-700 mb-1">Brief Description for Candidates</label>
        <textarea
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full text-xs p-2.5 bg-slate-50 border border-slate-200 rounded-lg"
        />
      </div>

      {/* Slot Selection for 4 Skills */}
      <div className="p-5 bg-slate-50 rounded-2xl border border-slate-200 space-y-4">
        <span className="text-xs font-bold text-slate-900 uppercase tracking-wider block">
          Select Components (1 per Skill Domain)
        </span>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Listening Selection */}
          <div className="p-3.5 bg-white rounded-xl border border-slate-200 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-indigo-700 uppercase">1. Listening Section</span>
              <span className="text-[10px] text-slate-400 font-mono">Audio + Questions</span>
            </div>
            <select
              value={listeningId}
              onChange={(e) => setListeningId(e.target.value)}
              className="w-full text-xs p-2 bg-slate-50 border border-slate-200 rounded-lg font-medium"
            >
              <option value="">-- Choose Listening Material --</option>
              {materials.listening.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title} ({item.targetBand || 'Band 7+'})
                </option>
              ))}
            </select>
            <div className="flex items-center space-x-2 pt-1">
              <Clock className="w-3.5 h-3.5 text-slate-400" />
              <span className="text-[11px] text-slate-500">Duration:</span>
              <input
                type="number"
                value={listeningMinutes}
                onChange={(e) => setListeningMinutes(Number(e.target.value))}
                className="w-16 text-xs p-1 bg-slate-50 border border-slate-200 rounded font-semibold text-center"
              />
              <span className="text-[11px] text-slate-500">minutes</span>
            </div>
          </div>

          {/* Reading Selection */}
          <div className="p-3.5 bg-white rounded-xl border border-slate-200 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-emerald-700 uppercase">2. Reading Passage</span>
              <span className="text-[10px] text-slate-400 font-mono">Passage + 13-14 Qs</span>
            </div>
            <select
              value={readingId}
              onChange={(e) => setReadingId(e.target.value)}
              className="w-full text-xs p-2 bg-slate-50 border border-slate-200 rounded-lg font-medium"
            >
              <option value="">-- Choose Reading Material --</option>
              {materials.reading.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title} ({item.targetBand || 'Band 7+'})
                </option>
              ))}
            </select>
            <div className="flex items-center space-x-2 pt-1">
              <Clock className="w-3.5 h-3.5 text-slate-400" />
              <span className="text-[11px] text-slate-500">Duration:</span>
              <input
                type="number"
                value={readingMinutes}
                onChange={(e) => setReadingMinutes(Number(e.target.value))}
                className="w-16 text-xs p-1 bg-slate-50 border border-slate-200 rounded font-semibold text-center"
              />
              <span className="text-[11px] text-slate-500">minutes</span>
            </div>
          </div>

          {/* Writing Selection */}
          <div className="p-3.5 bg-white rounded-xl border border-slate-200 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-amber-700 uppercase">3. Writing Tasks (1 & 2)</span>
              <span className="text-[10px] text-slate-400 font-mono">400+ words</span>
            </div>
            <select
              value={writingId}
              onChange={(e) => setWritingId(e.target.value)}
              className="w-full text-xs p-2 bg-slate-50 border border-slate-200 rounded-lg font-medium"
            >
              <option value="">-- Choose Writing Material --</option>
              {materials.writing.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title} ({item.targetBand || 'Band 7+'})
                </option>
              ))}
            </select>
            <div className="flex items-center space-x-2 pt-1">
              <Clock className="w-3.5 h-3.5 text-slate-400" />
              <span className="text-[11px] text-slate-500">Duration:</span>
              <input
                type="number"
                value={writingMinutes}
                onChange={(e) => setWritingMinutes(Number(e.target.value))}
                className="w-16 text-xs p-1 bg-slate-50 border border-slate-200 rounded font-semibold text-center"
              />
              <span className="text-[11px] text-slate-500">minutes</span>
            </div>
          </div>

          {/* Speaking Selection */}
          <div className="p-3.5 bg-white rounded-xl border border-slate-200 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-rose-700 uppercase">4. Speaking Interview</span>
              <span className="text-[10px] text-slate-400 font-mono">Parts 1, 2, 3</span>
            </div>
            <select
              value={speakingId}
              onChange={(e) => setSpeakingId(e.target.value)}
              className="w-full text-xs p-2 bg-slate-50 border border-slate-200 rounded-lg font-medium"
            >
              <option value="">-- Choose Speaking Material --</option>
              {materials.speaking.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title} ({item.targetBand || 'Band 7+'})
                </option>
              ))}
            </select>
            <div className="flex items-center space-x-2 pt-1">
              <Clock className="w-3.5 h-3.5 text-slate-400" />
              <span className="text-[11px] text-slate-500">Duration:</span>
              <input
                type="number"
                value={speakingMinutes}
                onChange={(e) => setSpeakingMinutes(Number(e.target.value))}
                className="w-16 text-xs p-1 bg-slate-50 border border-slate-200 rounded font-semibold text-center"
              />
              <span className="text-[11px] text-slate-500">minutes</span>
            </div>
          </div>
        </div>
      </div>

      {/* Buttons */}
      <div className="flex items-center justify-end space-x-3 pt-4 border-t border-slate-200">
        <button
          onClick={onCancel}
          className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-900 rounded-lg"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-5 py-2 text-xs font-bold bg-slate-900 hover:bg-slate-800 text-white rounded-lg shadow-sm"
        >
          {saving ? 'Saving Bundle...' : 'Save CDI Exam Bundle'}
        </button>
      </div>
    </div>
  );
};
