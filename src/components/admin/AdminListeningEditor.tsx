import React, { useState } from 'react';
import { Plus, Trash2, Headphones, CheckCircle2, Music } from 'lucide-react';
import { AdminListeningMaterial } from '../../types/admin';
import { Question, QuestionType } from '../../types';
import { FileUploadZone } from './FileUploadZone';

/**
 * The editor works on canonical questions directly rather than keeping its own
 * near-copy — the divergence that let `questionText` and a numeric `id` reach
 * storage in the first place.
 */
type ListeningEditorQuestion = Question;

/** A new row, numbered after the ones already there. */
const blankQuestion = (type: QuestionType, position: number): Question => ({
  id: `q${position}-${Math.random().toString(36).slice(2, 8)}`,
  questionNumber: position,
  type,
  prompt: '',
  // Deliberately empty: an answer key must never be invented, so the save is
  // refused until the author supplies one.
  correctAnswer: '',
  options: type === 'multiple_choice' ? ['A. ', 'B. ', 'C. ', 'D. '] : undefined,
});

interface AdminListeningEditorProps {
  initialData?: AdminListeningMaterial | null;
  onSave: (material: Partial<AdminListeningMaterial>) => Promise<void>;
  onCancel: () => void;
}

export const AdminListeningEditor: React.FC<AdminListeningEditorProps> = ({
  initialData,
  onSave,
  onCancel,
}) => {
  const [title, setTitle] = useState(initialData?.title || 'Listening Section 2: Campus Accommodation Tour');
  const [theme, setTheme] = useState(initialData?.theme || 'Education');
  const [targetBand, setTargetBand] = useState(initialData?.targetBand || '7.5');
  // Read-only here on purpose. Publishing is a decision taken in the catalog,
  // against the publish gate, not a dropdown next to the title — an editor that
  // could publish is an editor that can publish something unfinished.
  const status = initialData?.status ?? 'draft';

  const [sectionTitle, setSectionTitle] = useState(
    initialData?.content.section.title || 'Student Residence Orientation'
  );
  const [contextDescription, setContextDescription] = useState(
    initialData?.content.section.contextDescription ||
      'A residential warden introduces new international students to accommodation policies and security protocols.'
  );

  const [audioUrl, setAudioUrl] = useState(initialData?.content.audioUrl || '');
  const [audioAssetId, setAudioAssetId] = useState(initialData?.content.audioAssetId || '');
  const [sourceAssetId, setSourceAssetId] = useState(initialData?.content.sourceAssetId || '');
  const [audioFileName, setAudioFileName] = useState(initialData?.content.audioFileName || '');
  const [transcript, setTranscript] = useState(
    initialData?.content.transcript ||
      'Good morning everyone, welcome to Westgate Hall. Before you collect your room keys, I must outline a few fundamental regulations...'
  );

  const [questions, setQuestions] = useState<ListeningEditorQuestion[]>(
    initialData?.content.section.questions || [
      {
        id: 'sample-1',
        questionNumber: 1,
        type: 'form_completion',
        prompt: 'Main security desk operating hours: [ 1 ] AM to 10:00 PM',
        correctAnswer: '7:00',
        explanation: 'The speaker states the front desk opens at 7:00 AM sharp.',
      },
      {
        id: 'sample-2',
        questionNumber: 2,
        type: 'multiple_choice',
        prompt: 'Where can students securely store registered bicycles?',
        options: ['A. Basement compound B', 'B. Rear courtyard garden', 'C. Main foyer rack', 'D. Under the stairwell'],
        correctAnswer: 'A. Basement compound B',
        explanation: 'The officer confirms bicycles must be stored in basement compound B.',
      }
    ]
  );

  /** An imported CDI page, sanitised server-side, shown to the learner as-is. */
  const [htmlContent, setHtmlContent] = useState(initialData?.content.htmlContent || '');
  const [saving, setSaving] = useState(false);

  /** Keeps numbering contiguous after an add or a delete. */
  const renumber = (list: Question[]) =>
    list.map((question, index) => ({ ...question, questionNumber: index + 1 }));

  const addQuestion = (type: QuestionType) => {
    setQuestions(renumber([...questions, blankQuestion(type, questions.length + 1)]));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({
        id: initialData?.id,
        title,
        section: 'listening',
        module: 'academic',
        theme,
        targetBand,
        content: {
          section: {
            sectionNumber: 2,
            title: sectionTitle,
            contextDescription,
            audioTranscript: transcript,
            htmlContent: htmlContent || undefined,
            questions,
          },
          audioUrl: audioUrl || undefined,
          audioAssetId: audioAssetId || undefined,
          audioFileName: audioFileName || undefined,
          sourceAssetId: sourceAssetId || undefined,
          assetIds: [audioAssetId, sourceAssetId].filter(Boolean),
          transcript,
          htmlContent: htmlContent || undefined,
        },
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between border-b border-ink-200 pb-4">
        <div>
          <h3 className="text-lg font-bold text-ink-900">
            {initialData ? 'Edit Listening Section' : 'Create Listening Material'}
          </h3>
          <p className="text-xs text-ink-500">
            Upload audio (.mp3, .wav), configure section questions and auto-marking criteria.
          </p>
        </div>
        <div className="flex items-center space-x-2">
          <span
            id="editor-status-badge"
            data-status={status}
            className="rounded-lg border border-ink-300 bg-ink-50 px-3 py-1.5 text-xs font-semibold capitalize text-ink-600"
            title="Publishing happens in the material catalog, once the publish gate passes."
          >
            Status: {status}
          </span>
        </div>
      </div>

      {/* Audio Upload Zone */}
      <div className="space-y-3">
        <FileUploadZone
          accept=".html,.htm"
          category="html"
          label="Import the section as HTML (.html, .htm)"
          description="The page is sanitised on the server and shown to the learner exactly as written — tables, headings and gap numbering included."
          onUploaded={(asset) => {
            if (asset.extractedHtml) {
              setHtmlContent(asset.extractedHtml);
              setSectionTitle(asset.originalName.replace(/\.[^/.]+$/, ''));
              // Keep the untouched original so a later parser can re-read it.
              if (asset.sourceAssetId) setSourceAssetId(asset.sourceAssetId);
              if (asset.extractedText && !transcript.trim()) {
                setTranscript(asset.extractedText);
              }
            }
          }}
        />

        {htmlContent && (
          <p className="text-xs text-success-700">
            HTML imported — {htmlContent.length.toLocaleString()} characters. It will render in the
            player above the questions.
          </p>
        )}

        <FileUploadZone
          accept=".mp3,.wav,.ogg"
          category="audio"
          label="Official Listening Audio File (MP3 / WAV)"
          description="Upload pristine exam audio with authentic accents (British, Australian, North American)."
          onUploaded={(asset) => {
            // Store the learner-facing URL; the admin preview swaps in the
            // /api/admin/ prefix, which is the one an admin session can read.
            setAudioAssetId(asset.assetId);
            setAudioUrl(`/api/assets/${asset.assetId}`);
            setAudioFileName(asset.originalName);
          }}
        />

        {audioUrl && (
          <div className="p-3 bg-brand-50 border border-brand-200 rounded-xl flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Headphones className="w-4 h-4 text-brand-600" />
              <span className="text-xs font-bold text-brand-900">Audio Linked: {audioFileName || 'Uploaded Track'}</span>
            </div>
            <audio controls src={audioUrl} className="h-8 max-w-xs" />
          </div>
        )}
      </div>

      {/* Basic Metadata */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <label className="block text-xs font-bold text-ink-700 mb-1">Section Test Title</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full text-xs p-2.5 bg-ink-50 border border-ink-200 rounded-lg"
          />
        </div>
        <div>
          <label className="block text-xs font-bold text-ink-700 mb-1">Theme / Context</label>
          <input
            type="text"
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
            className="w-full text-xs p-2.5 bg-ink-50 border border-ink-200 rounded-lg"
          />
        </div>
        <div>
          <label className="block text-xs font-bold text-ink-700 mb-1">Target Band</label>
          <input
            type="text"
            value={targetBand}
            onChange={(e) => setTargetBand(e.target.value)}
            className="w-full text-xs p-2.5 bg-ink-50 border border-ink-200 rounded-lg"
          />
        </div>
      </div>

      {/* Transcript for Examiners */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="block text-xs font-bold text-ink-700">Audio Transcript (Teacher/Examiner Mode)</label>
          <span className="text-[10px] text-warning-500 font-semibold bg-warning-50 px-2 py-0.5 rounded">
            Hidden from student during initial test
          </span>
        </div>
        <textarea
          rows={5}
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
          className="w-full text-xs p-3 font-mono leading-relaxed bg-ink-50 border border-ink-200 rounded-xl"
          placeholder="Paste verbatim audio script here..."
        />
      </div>

      {/* Questions Builder */}
      <div className="p-4 bg-ink-50 rounded-xl border border-ink-200 space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-ink-900 uppercase tracking-wider">
            Listening Questions ({questions.length})
          </span>
          <div className="flex items-center space-x-1.5">
            <button
              onClick={() => addQuestion('form_completion')}
              className="text-[11px] bg-white border border-ink-200 hover:border-ink-400 px-2.5 py-1 rounded-md font-semibold text-ink-700 shadow-2xs"
            >
              + Form / Note Completion
            </button>
            <button
              onClick={() => addQuestion('multiple_choice')}
              className="text-[11px] bg-white border border-ink-200 hover:border-ink-400 px-2.5 py-1 rounded-md font-semibold text-ink-700 shadow-2xs"
            >
              + Multiple Choice
            </button>
            <button
              onClick={() => addQuestion('sentence_completion')}
              className="text-[11px] bg-white border border-ink-200 hover:border-ink-400 px-2.5 py-1 rounded-md font-semibold text-ink-700 shadow-2xs"
            >
              + Sentence Completion
            </button>
          </div>
        </div>

        <div className="space-y-3">
          {questions.map((q, idx) => (
            <div key={idx} className="p-3 bg-white rounded-lg border border-ink-200 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-ink-800">
                  Q{idx + 1} • <span className="uppercase text-[10px] text-ink-500 font-mono">{q.type.replace(/_/g, ' ')}</span>
                </span>
                <button
                  onClick={() => setQuestions(renumber(questions.filter((_, i) => i !== idx)))}
                  className="text-ink-400 hover:text-danger-500 p-1"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>

              <input
                type="text"
                value={q.prompt}
                onChange={(e) => {
                  const copy = [...questions];
                  copy[idx].prompt = e.target.value;
                  setQuestions(copy);
                }}
                className="w-full text-xs p-2 bg-ink-50 border border-ink-200 rounded-md font-medium"
                placeholder="Question / Note prompt"
              />

              {q.type === 'multiple_choice' && q.options && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                  {q.options.map((opt, optIdx) => (
                    <input
                      key={optIdx}
                      type="text"
                      value={opt}
                      onChange={(e) => {
                        const copy = [...questions];
                        copy[idx].options![optIdx] = e.target.value;
                        setQuestions(copy);
                      }}
                      className="text-xs p-1.5 bg-ink-50 border border-ink-200 rounded"
                      placeholder={`Option ${String.fromCharCode(65 + optIdx)}`}
                    />
                  ))}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                <div>
                  <label className="block text-[10px] font-bold text-success-700 uppercase">
                    Exact Correct Answer
                  </label>
                  <input
                    type="text"
                    value={q.correctAnswer}
                    onChange={(e) => {
                      const copy = [...questions];
                      copy[idx].correctAnswer = e.target.value;
                      setQuestions(copy);
                    }}
                    placeholder="e.g. 7:00 or Basement compound B"
                    className="w-full text-xs p-1.5 bg-success-50 border border-success-50 rounded font-semibold text-success-700"
                  />
                </div>

                <div>
                  <label className="block text-[10px] font-bold text-ink-500 uppercase">
                    Audio Timestamp / Justification
                  </label>
                  <input
                    type="text"
                    value={q.explanation || ''}
                    onChange={(e) => {
                      const copy = [...questions];
                      copy[idx].explanation = e.target.value;
                      setQuestions(copy);
                    }}
                    placeholder="e.g. Timestamp 01:45 - Speaker explicitly clarifies..."
                    className="w-full text-xs p-1.5 bg-ink-50 border border-ink-200 rounded text-ink-600"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Buttons */}
      <div className="flex items-center justify-end space-x-3 pt-4 border-t border-ink-200">
        <button
          onClick={onCancel}
          className="px-4 py-2 text-xs font-semibold text-ink-600 hover:text-ink-900 rounded-lg"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-5 py-2 text-xs font-bold bg-ink-900 hover:bg-ink-800 text-white rounded-lg shadow-sm"
        >
          {saving ? 'Saving...' : 'Save Listening Material'}
        </button>
      </div>
    </div>
  );
};
