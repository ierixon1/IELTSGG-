import React, { useState } from 'react';
import { Plus, Trash2, BookOpen, CheckCircle2, FileText, FileCode, Eye, Code2, Sparkles } from 'lucide-react';
import { AdminReadingMaterial } from '../../types/admin';
import { FileUploadZone } from './FileUploadZone';
import { CdiHtmlViewer } from '../common/CdiHtmlViewer';

interface ReadingEditorQuestion {
  id: number;
  type: 'multiple_choice' | 'true_false_not_given' | 'fill_in_the_blank' | 'matching_headings';
  questionText: string;
  correctAnswer: string;
  explanation?: string;
  options?: string[];
}

interface AdminReadingEditorProps {
  initialData?: AdminReadingMaterial | null;
  onSave: (material: Partial<AdminReadingMaterial>) => Promise<void>;
  onCancel: () => void;
}

export const AdminReadingEditor: React.FC<AdminReadingEditorProps> = ({
  initialData,
  onSave,
  onCancel,
}) => {
  const [title, setTitle] = useState(initialData?.title || 'Academic Reading: Biofuels & Renewable Energies');
  const [module, setModule] = useState<'academic' | 'general'>(initialData?.module || 'academic');
  const [theme, setTheme] = useState(initialData?.theme || 'Renewable Energy');
  const [targetBand, setTargetBand] = useState(initialData?.targetBand || '7.5');
  const [status, setStatus] = useState<'draft' | 'published'>(initialData?.status || 'published');

  const [passageTitle, setPassageTitle] = useState(
    initialData?.content.passage.title || 'The Geopolitics of Algal Biofuels'
  );
  const [passageText, setPassageText] = useState(
    initialData?.content.passage.text ||
      'In recent decades, the search for sustainable aviation fuel has spurred interest in microalgae-based biofuels. Unlike terrestrial biomass crops such as corn or soy, algae do not compete directly with arable land dedicated to agricultural food production.\n\nFurthermore, photosynthetic efficiency in aquatic photo-bioreactors can yield up to ten times more lipids per hectare than standard oilseed crops. However, capital expenditure remains the primary deterrent for commercial scale deployment.'
  );

  const [htmlContent, setHtmlContent] = useState<string>(
    initialData?.content.passage.htmlContent || initialData?.content.htmlContent || ''
  );
  const [editorMode, setEditorMode] = useState<'text' | 'html'>(
    (initialData?.content.passage.htmlContent || initialData?.content.htmlContent) ? 'html' : 'text'
  );
  const [showLiveHtmlPreview, setShowLiveHtmlPreview] = useState<boolean>(true);

  const [questions, setQuestions] = useState<ReadingEditorQuestion[]>(
    initialData?.content.passage.questions || [
      {
        id: 1,
        type: 'true_false_not_given',
        questionText: 'Microalgae production requires fertile farmland used for standard food crops.',
        correctAnswer: 'FALSE',
        explanation: 'The text notes algae do not compete with arable land dedicated to food.',
      },
      {
        id: 2,
        type: 'multiple_choice',
        questionText: 'What is highlighted as the main obstacle to commercial adoption of algae fuels?',
        options: [
          'Insufficient lipid productivity',
          'Excessive upfront capital costs',
          'Lack of photosynthetic efficiency',
          'Opposition from airline carriers'
        ],
        correctAnswer: 'Excessive upfront capital costs',
        explanation: 'Text specifies that capital expenditure remains the primary deterrent.',
      }
    ]
  );

  const [saving, setSaving] = useState(false);

  const addQuestion = (type: ReadingEditorQuestion['type']) => {
    const nextId = questions.length + 1;
    const newQ: ReadingEditorQuestion = {
      id: nextId,
      type,
      questionText: 'New Question Prompt...',
      correctAnswer: type === 'true_false_not_given' ? 'TRUE' : '',
      explanation: 'Detailed rationale for score verification.',
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
        section: 'reading',
        module,
        status,
        theme,
        targetBand,
        content: {
          passage: {
            passageNumber: 1,
            title: passageTitle,
            text: passageText,
            htmlContent: editorMode === 'html' ? htmlContent : undefined,
            questions,
          },
          htmlContent: editorMode === 'html' ? htmlContent : undefined,
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
            {initialData ? 'Edit Reading Material' : 'Upload & Create Reading Passage'}
          </h3>
          <p className="text-xs text-slate-500">
            Upload text documents (.txt, .docx, .pdf) or paste passage text with question benchmarks.
          </p>
        </div>
        <div className="flex items-center space-x-2">
          <select
            value={module}
            onChange={(e) => setModule(e.target.value as any)}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-slate-300 bg-white"
          >
            <option value="academic">Academic Module</option>
            <option value="general">General Training Module</option>
          </select>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as any)}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-slate-300 bg-white"
          >
            <option value="published">Status: Published</option>
            <option value="draft">Status: Draft</option>
          </select>
        </div>
      </div>

      {/* Upload Zone Section: Text Documents + Native HTML */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* File Upload Zone for Text Documents */}
        <FileUploadZone
          accept=".txt,.docx,.pdf"
          category="document"
          label="Import Text Document (.txt, .docx, .pdf)"
          description="Extracts raw text and automatically populates the text passage editor below."
          onUploaded={(file) => {
            if (file.extractedText) {
              setPassageText(file.extractedText);
              setPassageTitle(file.originalName.replace(/\.[^/.]+$/, ''));
              setEditorMode('text');
            }
          }}
        />

        {/* File Upload Zone for HTML Files (CDI Native) */}
        <FileUploadZone
          accept=".html,.htm"
          category="html"
          label="Import HTML Passage (.html, .htm) — CDI Native"
          description="Sanitizes and renders HTML formatting (tables, headings, citations) in the CDI player."
          onUploaded={(file) => {
            if (file.extractedHtml) {
              setHtmlContent(file.extractedHtml);
              setEditorMode('html');
              setPassageTitle(file.originalName.replace(/\.[^/.]+$/, ''));
              if (file.extractedText) {
                setPassageText(file.extractedText);
              }
            }
          }}
        />
      </div>

      {/* Metadata */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <label className="block text-xs font-bold text-slate-700 mb-1">Passage Display Title</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full text-xs p-2.5 bg-slate-50 border border-slate-200 rounded-lg"
          />
        </div>
        <div>
          <label className="block text-xs font-bold text-slate-700 mb-1">Theme / Academic Topic</label>
          <input
            type="text"
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
            className="w-full text-xs p-2.5 bg-slate-50 border border-slate-200 rounded-lg"
          />
        </div>
        <div>
          <label className="block text-xs font-bold text-slate-700 mb-1">Target Band</label>
          <input
            type="text"
            value={targetBand}
            onChange={(e) => setTargetBand(e.target.value)}
            className="w-full text-xs p-2.5 bg-slate-50 border border-slate-200 rounded-lg"
          />
        </div>
      </div>

      {/* Passage Format Mode Selector */}
      <div className="border border-slate-200 rounded-2xl overflow-hidden bg-white shadow-2xs">
        <div className="flex items-center justify-between px-4 py-3 bg-slate-50 border-b border-slate-200">
          <div className="flex items-center space-x-2">
            <span className="text-xs font-bold text-slate-800">Passage Content Mode:</span>
            <div className="inline-flex p-0.5 bg-slate-200/70 rounded-lg text-xs">
              <button
                type="button"
                onClick={() => setEditorMode('text')}
                className={`px-3 py-1 rounded-md font-semibold transition-all ${
                  editorMode === 'text'
                    ? 'bg-white text-slate-900 shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Plain Text
              </button>
              <button
                type="button"
                onClick={() => setEditorMode('html')}
                className={`flex items-center space-x-1.5 px-3 py-1 rounded-md font-semibold transition-all ${
                  editorMode === 'html'
                    ? 'bg-indigo-600 text-white shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <FileCode className="w-3.5 h-3.5" />
                <span>HTML (CDI Native)</span>
              </button>
            </div>
          </div>

          {editorMode === 'html' && (
            <div className="flex items-center space-x-2">
              <span className="text-[11px] text-emerald-700 font-semibold bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200 flex items-center space-x-1">
                <CheckCircle2 className="w-3 h-3" />
                <span>XSS Sanitized</span>
              </span>
              <button
                type="button"
                onClick={() => setShowLiveHtmlPreview(!showLiveHtmlPreview)}
                className="flex items-center space-x-1 text-xs text-indigo-600 hover:text-indigo-800 font-semibold bg-indigo-50 hover:bg-indigo-100 px-2.5 py-1 rounded-lg transition-colors cursor-pointer"
              >
                {showLiveHtmlPreview ? (
                  <>
                    <Code2 className="w-3.5 h-3.5" />
                    <span>View / Edit HTML Source</span>
                  </>
                ) : (
                  <>
                    <Eye className="w-3.5 h-3.5" />
                    <span>Live CDI Preview</span>
                  </>
                )}
              </button>
            </div>
          )}
        </div>

        <div className="p-4 space-y-3">
          {editorMode === 'text' ? (
            <div className="space-y-2">
              <textarea
                rows={8}
                value={passageText}
                onChange={(e) => setPassageText(e.target.value)}
                className="w-full text-xs p-3 font-serif leading-relaxed bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:ring-2 focus:ring-slate-900"
                placeholder="Paste or write the plain text reading passage here..."
              />
              <div className="text-[11px] text-slate-400 text-right">
                Word count: {passageText.trim() ? passageText.trim().split(/\s+/).length : 0} words
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {showLiveHtmlPreview ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span className="font-semibold text-slate-700 flex items-center space-x-1.5">
                      <Eye className="w-3.5 h-3.5 text-indigo-600" />
                      <span>Live Candidate Simulation Preview:</span>
                    </span>
                    <span>{htmlContent.length} characters</span>
                  </div>

                  {htmlContent.trim() ? (
                    <div className="p-5 bg-white rounded-xl border border-slate-200 shadow-2xs max-h-96 overflow-y-auto">
                      <CdiHtmlViewer html={htmlContent} />
                    </div>
                  ) : (
                    <div className="p-8 text-center bg-slate-50 rounded-xl border border-dashed border-slate-300 text-xs text-slate-500">
                      No HTML content uploaded yet. Upload an .html file above or switch to "View / Edit HTML Source" to paste markup.
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <label className="block text-xs font-bold text-slate-700">
                    HTML Source Markup (Sanitized upon save & upload)
                  </label>
                  <textarea
                    rows={10}
                    value={htmlContent}
                    onChange={(e) => setHtmlContent(e.target.value)}
                    className="w-full text-xs p-3 font-mono leading-relaxed bg-slate-900 text-emerald-400 rounded-xl border border-slate-700 focus:ring-2 focus:ring-indigo-500"
                    placeholder="Paste valid HTML markup here (e.g. <h2>Passage Header</h2><p>Article body...</p><table>...</table>)..."
                  />
                  <div className="flex justify-between text-[11px] text-slate-400">
                    <span>Includes safe formatting: headers, tables, lists, blockquotes, images</span>
                    <span>{htmlContent.length} chars</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Questions Builder */}
      <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <span className="text-xs font-bold text-slate-900 uppercase tracking-wider">
            Questions ({questions.length})
          </span>
          <div className="flex items-center space-x-1.5 overflow-x-auto">
            <button
              onClick={() => addQuestion('multiple_choice')}
              className="text-[11px] bg-white border border-slate-200 hover:border-slate-400 px-2.5 py-1 rounded-md font-semibold text-slate-700 shadow-2xs"
            >
              + Multiple Choice
            </button>
            <button
              onClick={() => addQuestion('true_false_not_given')}
              className="text-[11px] bg-white border border-slate-200 hover:border-slate-400 px-2.5 py-1 rounded-md font-semibold text-slate-700 shadow-2xs"
            >
              + True / False / NG
            </button>
            <button
              onClick={() => addQuestion('fill_in_the_blank')}
              className="text-[11px] bg-white border border-slate-200 hover:border-slate-400 px-2.5 py-1 rounded-md font-semibold text-slate-700 shadow-2xs"
            >
              + Fill in the Blank
            </button>
            <button
              onClick={() => addQuestion('matching_headings')}
              className="text-[11px] bg-white border border-slate-200 hover:border-slate-400 px-2.5 py-1 rounded-md font-semibold text-slate-700 shadow-2xs"
            >
              + Matching Headings
            </button>
          </div>
        </div>

        <div className="space-y-3">
          {questions.map((q, idx) => (
            <div key={idx} className="p-3 bg-white rounded-lg border border-slate-200 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-800">
                  Q{idx + 1} • <span className="uppercase text-[10px] text-slate-500 font-mono">{q.type.replace(/_/g, ' ')}</span>
                </span>
                <button
                  onClick={() => setQuestions(questions.filter((_, i) => i !== idx))}
                  className="text-slate-400 hover:text-rose-600 p-1"
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
                className="w-full text-xs p-2 bg-slate-50 border border-slate-200 rounded-md font-medium"
                placeholder="Question text"
              />

              {/* Options for Multiple Choice */}
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
                      className="text-xs p-1.5 bg-slate-50 border border-slate-200 rounded"
                      placeholder={`Option ${String.fromCharCode(65 + optIdx)}`}
                    />
                  ))}
                </div>
              )}

              {/* Correct Answer field */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                <div>
                  <label className="block text-[10px] font-bold text-emerald-700 uppercase">
                    Official Correct Answer (Auto-grading)
                  </label>
                  {q.type === 'true_false_not_given' ? (
                    <select
                      value={q.correctAnswer}
                      onChange={(e) => {
                        const copy = [...questions];
                        copy[idx].correctAnswer = e.target.value;
                        setQuestions(copy);
                      }}
                      className="w-full text-xs p-1.5 bg-emerald-50 border border-emerald-200 rounded font-semibold text-emerald-900"
                    >
                      <option value="TRUE">TRUE</option>
                      <option value="FALSE">FALSE</option>
                      <option value="NOT GIVEN">NOT GIVEN</option>
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={q.correctAnswer}
                      onChange={(e) => {
                        const copy = [...questions];
                        copy[idx].correctAnswer = e.target.value;
                        setQuestions(copy);
                      }}
                      placeholder="e.g. Excessive upfront capital costs"
                      className="w-full text-xs p-1.5 bg-emerald-50 border border-emerald-200 rounded font-semibold text-emerald-900"
                    />
                  )}
                </div>

                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase">
                    Explanation / Text Citation
                  </label>
                  <input
                    type="text"
                    value={q.explanation || ''}
                    onChange={(e) => {
                      const copy = [...questions];
                      copy[idx].explanation = e.target.value;
                      setQuestions(copy);
                    }}
                    placeholder="Why this answer is verified by Cambridge IELTS"
                    className="w-full text-xs p-1.5 bg-slate-50 border border-slate-200 rounded text-slate-600"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Action Buttons */}
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
          {saving ? 'Saving...' : 'Save Reading Material'}
        </button>
      </div>
    </div>
  );
};
