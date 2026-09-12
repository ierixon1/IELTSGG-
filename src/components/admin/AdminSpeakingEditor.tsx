import React, { useState } from 'react';
import { Plus, Trash2, Mic, CheckCircle2, Volume2 } from 'lucide-react';
import { AdminSpeakingMaterial } from '../../types/admin';
import { FileUploadZone } from './FileUploadZone';

interface AdminSpeakingEditorProps {
  initialData?: AdminSpeakingMaterial | null;
  onSave: (material: Partial<AdminSpeakingMaterial>) => Promise<void>;
  onCancel: () => void;
}

export const AdminSpeakingEditor: React.FC<AdminSpeakingEditorProps> = ({
  initialData,
  onSave,
  onCancel,
}) => {
  const [title, setTitle] = useState(initialData?.title || 'Academic Speaking: Technology & Society');
  const [theme, setTheme] = useState(initialData?.theme || 'Technology');
  const [targetBand, setTargetBand] = useState(initialData?.targetBand || '7.5');
  // Read-only here on purpose. Publishing is a decision taken in the catalog,
  // against the publish gate, not a dropdown next to the title — an editor that
  // could publish is an editor that can publish something unfinished.
  const status = initialData?.status ?? 'draft';

  // Part 1
  const [part1Topic, setPart1Topic] = useState(
    initialData?.content.speakingSession.part1.topic || 'Digital Habits & Smart Devices'
  );
  const [part1Questions, setPart1Questions] = useState<string[]>(
    initialData?.content.speakingSession.part1.questions || [
      'How much time do you spend using smart devices every day?',
      'Do you think technology makes our communication easier or more superficial?',
      'What is an app you could not live without?'
    ]
  );

  // Part 2
  const [cueCardTopic, setCueCardTopic] = useState(
    initialData?.content.speakingSession.part2.cueCardTopic ||
      'Describe a piece of technology you find difficult to use'
  );
  const [cueCardBullets, setCueCardBullets] = useState<string[]>(
    initialData?.content.speakingSession.part2.bulletPoints || [
      'What it is and when you acquired it',
      'What you use it for',
      'Why you find it complicated or challenging',
      'And explain how you manage to use it anyway'
    ]
  );

  // Part 3
  const [part3Questions, setPart3Questions] = useState<string[]>(
    initialData?.content.speakingSession.part3.questions || [
      'Do you believe artificial intelligence will replace human teachers in the future?',
      'How has social media transformed the way younger people express opinions?',
      'Should governments introduce age limits for smartphone ownership?'
    ]
  );

  // Audio Model Answers
  const [audioModels, setAudioModels] = useState<any[]>(
    initialData?.content.audioModelAnswers || []
  );

  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({
        id: initialData?.id,
        // The revision this editor opened: the save is refused if the material changed since.
        updatedAt: initialData?.updatedAt,
        title,
        section: 'speaking',
        module: 'academic',
        theme,
        targetBand,
        content: {
          speakingSession: {
            part1: {
              topic: part1Topic,
              questions: part1Questions.filter(q => q.trim().length > 0),
            },
            part2: {
              cueCardTopic,
              bulletPoints: cueCardBullets.filter(b => b.trim().length > 0),
            },
            part3: {
              questions: part3Questions.filter(q => q.trim().length > 0),
            },
          },
          audioModelAnswers: audioModels,
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
            {initialData ? 'Edit Speaking Material' : 'Create New Speaking Material'}
          </h3>
          <p className="text-xs text-ink-500">
            Configure Cue Cards, Part 1/3 questions, and audio benchmark demonstrations.
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

      {/* Basic Settings */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <label className="block text-xs font-bold text-ink-700 mb-1">Material Title</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full text-xs p-2.5 bg-ink-50 border border-ink-200 rounded-lg focus:bg-white"
          />
        </div>
        <div>
          <label className="block text-xs font-bold text-ink-700 mb-1">Theme / Domain</label>
          <input
            type="text"
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
            className="w-full text-xs p-2.5 bg-ink-50 border border-ink-200 rounded-lg focus:bg-white"
          />
        </div>
        <div>
          <label className="block text-xs font-bold text-ink-700 mb-1">Target Band Benchmark</label>
          <input
            type="text"
            value={targetBand}
            onChange={(e) => setTargetBand(e.target.value)}
            className="w-full text-xs p-2.5 bg-ink-50 border border-ink-200 rounded-lg focus:bg-white"
          />
        </div>
      </div>

      {/* Part 1 */}
      <div className="p-4 bg-ink-50 rounded-xl border border-ink-200 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-ink-900 uppercase tracking-wider">
            Part 1: Introduction & Interview
          </span>
          <button
            onClick={() => setPart1Questions([...part1Questions, ''])}
            className="text-xs text-brand-600 hover:text-brand-800 font-semibold flex items-center space-x-1"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Question</span>
          </button>
        </div>
        <input
          type="text"
          value={part1Topic}
          placeholder="Topic name (e.g. Work, Studies, Hometown)"
          onChange={(e) => setPart1Topic(e.target.value)}
          className="w-full text-xs p-2 bg-white border border-ink-200 rounded-lg font-semibold"
        />
        <div className="space-y-2">
          {part1Questions.map((q, idx) => (
            <div key={idx} className="flex items-center space-x-2">
              <span className="text-xs text-ink-400 font-mono w-5">{idx + 1}.</span>
              <input
                type="text"
                value={q}
                onChange={(e) => {
                  const copy = [...part1Questions];
                  copy[idx] = e.target.value;
                  setPart1Questions(copy);
                }}
                className="flex-1 text-xs p-2 bg-white border border-ink-200 rounded-lg"
                placeholder="Question text"
              />
              <button
                onClick={() => setPart1Questions(part1Questions.filter((_, i) => i !== idx))}
                className="p-1.5 text-ink-400 hover:text-danger-500 rounded-md"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Part 2: Cue Card */}
      <div className="p-4 bg-ink-50 rounded-xl border border-ink-200 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-ink-900 uppercase tracking-wider">
            Part 2: Long Turn (Cue Card)
          </span>
          <button
            onClick={() => setCueCardBullets([...cueCardBullets, ''])}
            className="text-xs text-brand-600 hover:text-brand-800 font-semibold flex items-center space-x-1"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Bullet Point</span>
          </button>
        </div>
        <input
          type="text"
          value={cueCardTopic}
          placeholder="Cue Card Prompt (Describe a...)"
          onChange={(e) => setCueCardTopic(e.target.value)}
          className="w-full text-xs p-2.5 bg-white border border-ink-200 rounded-lg font-semibold text-ink-900"
        />
        <div className="space-y-2">
          <label className="block text-[11px] font-bold text-ink-500">Prompts & Guidelines (You should say):</label>
          {cueCardBullets.map((b, idx) => (
            <div key={idx} className="flex items-center space-x-2">
              <span className="text-xs text-ink-400">•</span>
              <input
                type="text"
                value={b}
                onChange={(e) => {
                  const copy = [...cueCardBullets];
                  copy[idx] = e.target.value;
                  setCueCardBullets(copy);
                }}
                className="flex-1 text-xs p-2 bg-white border border-ink-200 rounded-lg"
              />
              <button
                onClick={() => setCueCardBullets(cueCardBullets.filter((_, i) => i !== idx))}
                className="p-1.5 text-ink-400 hover:text-danger-500 rounded-md"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Part 3: Two-way Discussion */}
      <div className="p-4 bg-ink-50 rounded-xl border border-ink-200 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-ink-900 uppercase tracking-wider">
            Part 3: Discussion Questions
          </span>
          <button
            onClick={() => setPart3Questions([...part3Questions, ''])}
            className="text-xs text-brand-600 hover:text-brand-800 font-semibold flex items-center space-x-1"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Question</span>
          </button>
        </div>
        <div className="space-y-2">
          {part3Questions.map((q, idx) => (
            <div key={idx} className="flex items-center space-x-2">
              <span className="text-xs text-ink-400 font-mono w-5">{idx + 1}.</span>
              <input
                type="text"
                value={q}
                onChange={(e) => {
                  const copy = [...part3Questions];
                  copy[idx] = e.target.value;
                  setPart3Questions(copy);
                }}
                className="flex-1 text-xs p-2 bg-white border border-ink-200 rounded-lg"
                placeholder="Abstract/in-depth debate question"
              />
              <button
                onClick={() => setPart3Questions(part3Questions.filter((_, i) => i !== idx))}
                className="p-1.5 text-ink-400 hover:text-danger-500 rounded-md"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Optional Audio Model Answer */}
      <div className="p-4 bg-ink-50 rounded-xl border border-ink-200 space-y-3">
        <div className="flex items-center space-x-2">
          <Volume2 className="w-4 h-4 text-brand-600" />
          <span className="text-xs font-bold text-ink-900">Attach Audio Model Answer (Optional Benchmark)</span>
        </div>
        <FileUploadZone
          accept=".mp3,.wav,.ogg"
          category="audio"
          label="Audio Recording of Band 8-9 Model Answer"
          description="Upload an official audio sample so students can listen to pronunciation and fluency standards."
          onUploaded={(file) => {
            setAudioModels([
              ...audioModels,
              {
                part: 'part2',
                audioUrl: file.url,
                modelBand: 8.5,
                transcript: 'Examiner audio demonstration',
              },
            ]);
          }}
        />
        {audioModels.length > 0 && (
          <div className="text-xs text-success-700 bg-success-50 p-2 rounded-lg border border-success-50 flex items-center space-x-2">
            <CheckCircle2 className="w-4 h-4 text-success-500" />
            <span>{audioModels.length} audio model answer(s) attached.</span>
          </div>
        )}
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
          {saving ? 'Saving...' : 'Save Material'}
        </button>
      </div>
    </div>
  );
};
