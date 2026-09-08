import React, { useState } from 'react';
import { Plus, Trash2, Headphones, CheckCircle2, Music } from 'lucide-react';
import { AdminListeningMaterial } from '../../types/admin';
import { FileUploadZone } from './FileUploadZone';

interface ListeningEditorQuestion {
  id: number;
  type: 'form_completion' | 'multiple_choice' | 'sentence_completion';
  questionText: string;
  correctAnswer: string;
  explanation?: string;
  options?: string[];
}

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
  const [status, setStatus] = useState<'draft' | 'published'>(initialData?.status || 'published');

  const [sectionTitle, setSectionTitle] = useState(
    initialData?.content.section.title || 'Student Residence Orientation'
  );
  const [contextDescription, setContextDescription] = useState(
    initialData?.content.section.contextDescription ||
      'A residential warden introduces new international students to accommodation policies and security protocols.'
  );

  const [audioUrl, setAudioUrl] = useState(initialData?.content.audioUrl || '');
  const [audioFileName, setAudioFileName] = useState(initialData?.content.audioFileName || '');
  const [transcript, setTranscript] = useState(
    initialData?.content.transcript ||
      'Good morning everyone, welcome to Westgate Hall. Before you collect your room keys, I must outline a few fundamental regulations...'
  );

  const [questions, setQuestions] = useState<ListeningEditorQuestion[]>(
    initialData?.content.section.questions || [
      {
        id: 1,
        type: 'form_completion',
        questionText: 'Main security desk operating hours: [ 1 ] AM to 10:00 PM',
        correctAnswer: '7:00',
        explanation: 'The speaker states the front desk opens at 7:00 AM sharp.',
      },
      {
        id: 2,
        type: 'multiple_choice',
        questionText: 'Where can students securely store registered bicycles?',
        options: ['Basement compound B', 'Rear courtyard garden', 'Main foyer rack', 'Under the stairwell'],
        correctAnswer: 'Basement compound B',
        explanation: 'The officer confirms bicycles must be stored in basement compound B.',
      }
    ]
  );

  /** An imported CDI page, sanitised server-side, shown to the learner as-is. */
  const [htmlContent, setHtmlContent] = useState(initialData?.content.htmlContent || '');
  const [saving, setSaving] = useState(false);

  const addQuestion = (type: ListeningEditorQuestion['type']) => {
    const nextId = questions.length + 1;
    const newQ: ListeningEditorQuestion = {
      id: nextId,
      type,
      questionText: 'Fill in or answer prompt...',
      correctAnswer: '',
      explanation: 'Official Cambridge standard explanation.',
      options: type === 'multiple_choice' ? ['Option A', 'Option B', 'Option C', 'Option D'] : undefined,
    };
    setQuestions([...questions, newQ]);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({
        id: initialData?.id,
        title,
        section: 'listening',
        module: 'academic',
        status,
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
          audioUrl: audioUrl || '/audio/mock_listening_demo.mp3',
          audioFileName: audioFileName || 'official_recording.mp3',
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
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as any)}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-ink-300 bg-white"
          >
            <option value="published">Status: Published</option>
            <option value="draft">Status: Draft</option>
          </select>
        </div>
      </div>

      {/* Audio Upload Zone */}
      <div className="space-y-3">
        <FileUploadZone
          accept=".html,.htm"
          category="html"
          label="Import the section as HTML (.html, .htm)"
          description="The page is sanitised on the server and shown to the learner exactly as written — tables, headings and gap numbering included."
          onUploaded={(file) => {
            if (file.extractedHtml) {
              setHtmlContent(file.extractedHtml);
              setSectionTitle(file.originalName.replace(/\.[^/.]+$/, ''));
              if (file.extractedText && !transcript.trim()) {
                setTranscript(file.extractedText);
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
          onUploaded={(file) => {
            setAudioUrl(file.url);
            setAudioFileName(file.originalName);
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
                  onClick={() => setQuestions(questions.filter((_, i) => i !== idx))}
                  className="text-ink-400 hover:text-danger-500 p-1"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>

              <input
                type="text"
                value={q.questionText}
                onChange={(e) => {
                  const copy = [...questions];
                  copy[idx].questionText = e.target.value;
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
