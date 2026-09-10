import React, { useState } from 'react';
import { Plus, Trash2, Edit3, Image as ImageIcon, CheckCircle2, FileCode, Eye, Code2 } from 'lucide-react';
import { AdminWritingMaterial } from '../../types/admin';
import { FileUploadZone } from './FileUploadZone';
import { CdiHtmlViewer } from '../common/CdiHtmlViewer';

interface AdminWritingEditorProps {
  initialData?: AdminWritingMaterial | null;
  onSave: (material: Partial<AdminWritingMaterial>) => Promise<void>;
  onCancel: () => void;
}

export const AdminWritingEditor: React.FC<AdminWritingEditorProps> = ({
  initialData,
  onSave,
  onCancel,
}) => {
  const [title, setTitle] = useState(initialData?.title || 'Academic Writing Test: Global Urbanization');
  const [module, setModule] = useState<'academic' | 'general'>(initialData?.module || 'academic');
  const [theme, setTheme] = useState(initialData?.theme || 'Urbanization');
  const [targetBand, setTargetBand] = useState(initialData?.targetBand || '7.5');
  // Read-only here on purpose. Publishing is a decision taken in the catalog,
  // against the publish gate, not a dropdown next to the title — an editor that
  // could publish is an editor that can publish something unfinished.
  const status = initialData?.status ?? 'draft';

  // Task 1
  const [task1Prompt, setTask1Prompt] = useState(
    initialData?.content.task.task1?.prompt ||
      'The chart below shows the percentage of the population living in cities across four regions between 1970 and 2020, with forecasts for 2040. Summarise the information by selecting and reporting the main features, and make comparisons where relevant.'
  );
  const [task1Html, setTask1Html] = useState<string>(
    initialData?.content.task.task1?.htmlContent || ''
  );
  const [task1Mode, setTask1Mode] = useState<'text' | 'html'>(
    initialData?.content.task.task1?.htmlContent ? 'html' : 'text'
  );
  const [task1ChartDescription, setTask1ChartDescription] = useState(
    initialData?.content.task.task1?.dataVisualizationDescription ||
      'Line graph showing urbanization rates in North America, Latin America, Europe, and Asia.'
  );
  const [task1ImageUrl, setTask1ImageUrl] = useState(initialData?.content.task1ImageUrl || '');

  // Task 2
  const [task2Prompt, setTask2Prompt] = useState(
    initialData?.content.task.task2?.prompt ||
      'In many countries, an increasing proportion of young graduates are unable to find employment commensurate with their degree qualifications. Discuss the causes of this issue and suggest pragmatic solutions that higher education institutes and governments could adopt.'
  );
  const [task2Html, setTask2Html] = useState<string>(
    initialData?.content.task.task2?.htmlContent || ''
  );
  const [task2Mode, setTask2Mode] = useState<'text' | 'html'>(
    initialData?.content.task.task2?.htmlContent ? 'html' : 'text'
  );
  const [task2Hints, setTask2Hints] = useState<string[]>(
    initialData?.content.task.task2?.band8VocabularyHints || [
      'structural unemployment',
      'mismatch of competencies',
      'tertiary curriculum reform',
      'vocational apprenticeships'
    ]
  );

  // Custom Grading Criteria (optional extension)
  const [taskResponseGuide, setTaskResponseGuide] = useState(
    initialData?.content.customGradingCriteria?.taskResponseGuide ||
      'Candidate must address both causes (technological obsolescence, credential inflation) and solutions (subsidies, dual apprenticeships).'
  );

  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const task = {
        task1: {
          taskType: module === 'academic' ? 'Task 1' : 'Task 1 General (Letter)',
          prompt: task1Prompt,
          htmlContent: task1Mode === 'html' ? task1Html : undefined,
          minimumWords: 150,
          timeMinutes: 20,
          dataVisualizationDescription: task1ChartDescription,
        },
        task2: {
          taskType: 'Task 2 Essay',
          prompt: task2Prompt,
          htmlContent: task2Mode === 'html' ? task2Html : undefined,
          minimumWords: 250,
          timeMinutes: 40,
          band8VocabularyHints: task2Hints.filter(h => h.trim().length > 0),
        },
      };

      await onSave({
        id: initialData?.id,
        title,
        section: 'writing',
        module,
        theme,
        targetBand,
        content: {
          task,
          task1ImageUrl,
          htmlContent: task1Html || task2Html || undefined,
          customGradingCriteria: {
            taskResponseGuide,
            lexicalKeyTerms: task2Hints,
          },
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
            {initialData ? 'Edit Writing Tasks' : 'Upload & Create Writing Exam Tasks'}
          </h3>
          <p className="text-xs text-ink-500">
            Upload Task 1 diagram/chart image, configure Task 2 essay prompt, and define scoring criteria.
          </p>
        </div>
        <div className="flex items-center space-x-2">
          <select
            value={module}
            onChange={(e) => setModule(e.target.value as any)}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-ink-300 bg-white"
          >
            <option value="academic">Academic Module (Graph / Report)</option>
            <option value="general">General Training Module (Letter)</option>
          </select>
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

      {/* Metadata */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <label className="block text-xs font-bold text-ink-700 mb-1">Writing Test Title</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full text-xs p-2.5 bg-ink-50 border border-ink-200 rounded-lg"
          />
        </div>
        <div>
          <label className="block text-xs font-bold text-ink-700 mb-1">Theme / Domain</label>
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

      {/* Task 1 Section */}
      <div className="p-4 bg-ink-50 rounded-xl border border-ink-200 space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-ink-900 uppercase tracking-wider">
            {module === 'academic' ? 'Task 1: Graphic / Report (150 words • 20 mins)' : 'Task 1: Letter (150 words • 20 mins)'}
          </span>
        </div>

        {/* Task 1 Diagram Upload */}
        {module === 'academic' && (
          <div className="space-y-2">
            <FileUploadZone
              accept=".png,.jpg,.jpeg,.webp"
              category="image"
              label="Upload Task 1 Diagram / Chart Image"
              description="Attach an official bar chart, line graph, pie chart, or process diagram."
              onUploaded={(file) => setTask1ImageUrl(file.url)}
            />

            {task1ImageUrl && (
              <div className="p-2.5 bg-white border border-ink-200 rounded-xl flex items-center space-x-3">
                <img
                  src={task1ImageUrl}
                  alt="Task 1 diagram preview"
                  className="w-24 h-16 object-contain rounded-lg border border-ink-100 bg-ink-50"
                />
                <div className="text-xs">
                  <div className="font-bold text-ink-800 flex items-center space-x-1">
                    <CheckCircle2 className="w-3.5 h-3.5 text-success-500" />
                    <span>Diagram Attached</span>
                  </div>
                  <span className="text-ink-500 truncate block max-w-sm">{task1ImageUrl}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Task 1 Prompt Format Mode */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="block text-[11px] font-bold text-ink-700">Task 1 Prompt Formulation</label>
            <div className="inline-flex p-0.5 bg-ink-200/70 rounded-lg text-xs">
              <button
                type="button"
                onClick={() => setTask1Mode('text')}
                className={`px-2.5 py-0.5 rounded-md font-semibold transition-all ${
                  task1Mode === 'text' ? 'bg-white text-ink-900 shadow-2xs' : 'text-ink-600'
                }`}
              >
                Plain Text
              </button>
              <button
                type="button"
                onClick={() => setTask1Mode('html')}
                className={`flex items-center space-x-1 px-2.5 py-0.5 rounded-md font-semibold transition-all ${
                  task1Mode === 'html' ? 'bg-brand-600 text-white shadow-2xs' : 'text-ink-600'
                }`}
              >
                <FileCode className="w-3 h-3" />
                <span>HTML (CDI)</span>
              </button>
            </div>
          </div>

          {task1Mode === 'text' ? (
            <textarea
              rows={3}
              value={task1Prompt}
              onChange={(e) => setTask1Prompt(e.target.value)}
              className="w-full text-xs p-2.5 bg-white border border-ink-200 rounded-lg focus:ring-2 focus:ring-ink-900"
            />
          ) : (
            <div className="space-y-2">
              <FileUploadZone
                accept=".html,.htm"
                category="html"
                label="Import Task 1 HTML Prompt (.html)"
                description="Upload an HTML snippet or formatted instructions for Task 1."
                onUploaded={(file) => {
                  if (file.extractedHtml) setTask1Html(file.extractedHtml);
                }}
              />
              <textarea
                rows={4}
                value={task1Html}
                onChange={(e) => setTask1Html(e.target.value)}
                placeholder="Paste HTML source for Task 1..."
                className="w-full text-xs p-2 font-mono bg-ink-900 text-success-500 rounded-lg border border-ink-700"
              />
              {task1Html && (
                <div className="p-3 bg-white rounded-lg border border-ink-200">
                  <div className="text-[10px] text-ink-400 font-bold uppercase mb-1">CDI Live Preview:</div>
                  <CdiHtmlViewer html={task1Html} />
                </div>
              )}
            </div>
          )}
        </div>

        <div>
          <label className="block text-[11px] font-bold text-ink-600 mb-1">Chart Data Visualization Description</label>
          <input
            type="text"
            value={task1ChartDescription}
            onChange={(e) => setTask1ChartDescription(e.target.value)}
            placeholder="Brief visual summary of axes, units, and data trends"
            className="w-full text-xs p-2.5 bg-white border border-ink-200 rounded-lg"
          />
        </div>
      </div>

      {/* Task 2 Section */}
      <div className="p-4 bg-ink-50 rounded-xl border border-ink-200 space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-ink-900 uppercase tracking-wider">
            Task 2: Discursive Essay (250 words • 40 mins)
          </span>
          <div className="inline-flex p-0.5 bg-ink-200/70 rounded-lg text-xs">
            <button
              type="button"
              onClick={() => setTask2Mode('text')}
              className={`px-2.5 py-0.5 rounded-md font-semibold transition-all ${
                task2Mode === 'text' ? 'bg-white text-ink-900 shadow-2xs' : 'text-ink-600'
              }`}
            >
              Plain Text
            </button>
            <button
              type="button"
              onClick={() => setTask2Mode('html')}
              className={`flex items-center space-x-1 px-2.5 py-0.5 rounded-md font-semibold transition-all ${
                task2Mode === 'html' ? 'bg-brand-600 text-white shadow-2xs' : 'text-ink-600'
              }`}
            >
              <FileCode className="w-3 h-3" />
              <span>HTML (CDI)</span>
            </button>
          </div>
        </div>

        {task2Mode === 'text' ? (
          <div>
            <label className="block text-[11px] font-bold text-ink-600 mb-1">Task 2 Essay Prompt</label>
            <textarea
              rows={3}
              value={task2Prompt}
              onChange={(e) => setTask2Prompt(e.target.value)}
              className="w-full text-xs p-2.5 bg-white border border-ink-200 rounded-lg focus:ring-2 focus:ring-ink-900"
            />
          </div>
        ) : (
          <div className="space-y-2">
            <FileUploadZone
              accept=".html,.htm"
              category="html"
              label="Import Task 2 HTML Prompt (.html)"
              description="Upload an HTML formatted article, case study, or discussion prompt."
              onUploaded={(file) => {
                if (file.extractedHtml) setTask2Html(file.extractedHtml);
              }}
            />
            <textarea
              rows={4}
              value={task2Html}
              onChange={(e) => setTask2Html(e.target.value)}
              placeholder="Paste HTML source for Task 2..."
              className="w-full text-xs p-2 font-mono bg-ink-900 text-success-500 rounded-lg border border-ink-700"
            />
            {task2Html && (
              <div className="p-3 bg-white rounded-lg border border-ink-200">
                <div className="text-[10px] text-ink-400 font-bold uppercase mb-1">CDI Live Preview:</div>
                <CdiHtmlViewer html={task2Html} />
              </div>
            )}
          </div>
        )}

        {/* Band 8 Vocabulary Hints */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="block text-[11px] font-bold text-ink-600">Band 8+ Lexical Vocabulary Hints</label>
            <button
              onClick={() => setTask2Hints([...task2Hints, ''])}
              className="text-xs text-brand-600 hover:text-brand-800 font-semibold flex items-center space-x-1"
            >
              <Plus className="w-3 h-3" />
              <span>Add Phrase</span>
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {task2Hints.map((h, idx) => (
              <div key={idx} className="flex items-center space-x-1.5">
                <input
                  type="text"
                  value={h}
                  onChange={(e) => {
                    const copy = [...task2Hints];
                    copy[idx] = e.target.value;
                    setTask2Hints(copy);
                  }}
                  className="flex-1 text-xs p-1.5 bg-white border border-ink-200 rounded"
                  placeholder="e.g. socioeconomic divide"
                />
                <button
                  onClick={() => setTask2Hints(task2Hints.filter((_, i) => i !== idx))}
                  className="text-ink-400 hover:text-danger-500 p-1"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Custom Grading Rubric Guide */}
        <div>
          <label className="block text-[11px] font-bold text-ink-600 mb-1">
            Custom Examiner Evaluation Guide (Fed into AI Grading System)
          </label>
          <textarea
            rows={2}
            value={taskResponseGuide}
            onChange={(e) => setTaskResponseGuide(e.target.value)}
            placeholder="Special rubric focus points (e.g. must explicitly discuss both government and personal duties)"
            className="w-full text-xs p-2 bg-white border border-ink-200 rounded-lg font-medium text-ink-700"
          />
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
          {saving ? 'Saving...' : 'Save Writing Tasks'}
        </button>
      </div>
    </div>
  );
};
